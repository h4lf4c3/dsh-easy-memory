/**
 * 每轮对话的落盘路径：journal 摘要 + 自动沉淀 + /memory distill 的入口。
 *
 * 这些处理只由 turn/end 事件触发，互相之间共享一个「同一时刻只沉淀一次」
 * 的互斥标记，所以放在同一个模块里。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DISTILL_SYSTEM, JOURNAL_DIR } from './constants.js'
import { parseDistilled } from './prompt.js'
import { blocksToText, clip, dateStamp, isoOf, log } from './util.js'

/**
 * 创建 turn 处理集合。
 * @param {object} rt - cfg、globalDir、globalTitle、workspaceRootOf、
 *   workspaceDirOf、titleFor、writeEntry。
 */
export function createTurnPipeline(rt) {
  const { cfg, globalDir, globalTitle } = rt

  /** 同一时刻只跑一次沉淀，避免并发模型调用。 */
  let distilling = false

  /** 抽取某一轮的对话文本。 */
  function turnTranscript(session, turn) {
    const users = []
    const assistants = []
    const total = typeof session?.seq === 'number' ? session.seq : 0
    let scanned = 0
    for (let seq = total - 1; seq >= 0 && scanned < 800; seq -= 1, scanned += 1) {
      const event = session.eventAt(seq)
      if (event === undefined || event === null) continue
      if (event.type === 'turn/start') {
        if (event.data?.turn === turn) break
        continue
      }
      if (event.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') continue
        const text = blocksToText(event.data.content)
        if (text !== '') users.unshift(text)
      } else if (event.type === 'assistant/message') {
        if (event.data?.turn !== turn) continue
        const text = blocksToText(event.data.message?.content)
        if (text !== '') assistants.unshift(text)
      }
    }
    return { users, assistants }
  }

  /** 把一轮对话摘要追加到工作区 journal。 */
  async function writeJournal(session, event, turn) {
    const root = rt.workspaceRootOf({ session })
    const dir = rt.workspaceDirOf(root)
    if (dir === undefined) return
    const { users, assistants } = turnTranscript(session, turn)
    if (users.length === 0 && assistants.length === 0) return
    const journalDir = join(dir, JOURNAL_DIR)
    await mkdir(journalDir, { recursive: true })
    const lines = [`### turn ${String(turn)} — ${isoOf(event.time)}`, '']
    for (const user of users) lines.push(`- user: ${clip(user, cfg.journalMaxChars)}`)
    for (const assistant of assistants) lines.push(`- assistant: ${clip(assistant, cfg.journalMaxChars)}`)
    lines.push('')
    await appendFile(join(journalDir, `${dateStamp(event.time)}.md`), `${lines.join('\n')}\n`, 'utf8')
  }

  /** 把抽取结果写进配置指定的作用域。 */
  async function applyDistilled(session, items) {
    const root = rt.workspaceRootOf({ session })
    const targets = []
    if (cfg.autoDistill === 'workspace' || cfg.autoDistill === 'both') {
      const dir = rt.workspaceDirOf(root)
      if (dir !== undefined) targets.push({ dir, title: rt.titleFor(dir), root })
    }
    if (cfg.autoDistill === 'global' || cfg.autoDistill === 'both') {
      targets.push({ dir: globalDir, title: globalTitle, root: undefined })
    }
    if (targets.length === 0) return { skipped: 'no-target' }
    const source = { sessionId: String(session?.id ?? ''), at: Date.now(), via: 'auto-distill' }
    let saved = 0
    for (const target of targets) {
      for (const item of items) {
        await rt.writeEntry(target, { kind: item.kind, text: item.text, tags: ['auto'], source }, target.root)
        saved += 1
      }
    }
    log(`auto-distill saved ${saved} entr${saved === 1 ? 'y' : 'ies'}`)
    return { saved }
  }

  /** 用当前请求所用的 provider/model 跑一次抽取。 */
  async function distillTurn(session, turn) {
    if (distilling) return { skipped: 'busy' }
    const llm = rt.ctx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return { skipped: 'no-llm' }
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const callConfig = header?.config
    if (callConfig === undefined || typeof callConfig.provider !== 'string' || typeof callConfig.model !== 'string') {
      return { skipped: 'no-route' }
    }
    const { users, assistants } = turnTranscript(session, turn)
    const transcript = [
      ...users.map((text) => `user: ${text}`),
      ...assistants.map((text) => `assistant: ${text}`),
    ].join('\n\n')
    if (transcript.length < cfg.distillMinChars) return { skipped: 'too-short' }

    distilling = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.distillTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      let reply = ''
      const stream = llm.stream({
        provider: callConfig.provider,
        model: callConfig.model,
        system: DISTILL_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: clip(transcript, cfg.distillMaxInputChars) }],
          },
        ],
        maxTokens: 1200,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') reply += chunk.text
      }
      const items = parseDistilled(reply, cfg.distillMaxEntries)
      if (items.length === 0) return { skipped: 'nothing-durable' }
      return await applyDistilled(session, items)
    } finally {
      clearTimeout(timer)
      distilling = false
    }
  }

  /** 找到会话里最后一个已结束的 turn 号，供 /memory distill 使用。 */
  function lastTurnOf(session) {
    const total = typeof session?.seq === 'number' ? session.seq : 0
    for (let seq = total - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq)
      if (event?.type === 'turn/end') return event.data?.turn
      if (event?.type === 'turn/start') return event.data?.turn
    }
    return undefined
  }

  return { turnTranscript, writeJournal, applyDistilled, distillTurn, lastTurnOf }
}
