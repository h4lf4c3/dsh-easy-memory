/**
 * 人类侧 /memory 命令：查看、增删改、手动晋升、沉淀、导入与开关。
 *
 * 命令只是薄薄一层参数解析，真正的读写仍然复用工具层的同一批函数，
 * 所以命令行与模型工具不会出现两套语义。
 */

import { join } from 'node:path'

import { JOURNAL_DIR, PROMOTION_LEDGER_FILE } from './constants.js'
import { resolveTarget, requireKind, visibleScopes } from './entry.js'
import { matchesQuery } from './search.js'
import { addEntry, forgetEntries, storeOf, updateEntry } from './store.js'
import { normalizeText, textOf } from './util.js'

/** /memory 的用法文本。 */
const COMMAND_HELP = [
  '/memory show              查看全局与项目记忆',
  '/memory add <文本>        写入项目记忆（默认 fact）',
  '/memory add --global <文本>  写入全局记忆',
  '/memory add --kind preference <文本>  指定分类',
  '/memory forget <id|关键词>  删除匹配的记忆',
  '/memory edit <id> <新文本>  就地改写一条记忆',
  '/memory promote <id>      把一条项目记忆手动晋升为全局记忆',
  '/memory promotions        查看全局晋升账本（候选与已晋升）',
  '/memory distill           立即对上一轮对话做一次记忆沉淀',
  '/memory shards            列出项目记忆的归档分片',
  '/memory import <多行文本>   把其他 AI 导出的记忆逐行导入全局记忆',
  '/memory on | off          开启或关闭记忆',
  '/memory path              显示各存储目录与记忆面板入口',
  '/memory help              显示本帮助',
].join('\n')

/** 解析 /memory 的参数行。 */
function parseOptions(rest) {
  const options = { scope: 'workspace', kind: 'fact' }
  let text = rest
  for (;;) {
    const trimmed = text.replace(/^\s+/, '')
    if (trimmed.startsWith('--global')) {
      options.scope = 'global'
      text = trimmed.slice('--global'.length)
      continue
    }
    if (trimmed.startsWith('--workspace')) {
      options.scope = 'workspace'
      text = trimmed.slice('--workspace'.length)
      continue
    }
    const kindMatch = /^--kind\s+(\S+)/.exec(trimmed)
    if (kindMatch !== null) {
      options.kind = kindMatch[1]
      text = trimmed.slice(kindMatch[0].length)
      continue
    }
    text = trimmed
    break
  }
  return { options, text: text.replace(/^\s+/, '') }
}

/**
 * 创建 /memory 命令定义。
 * @param {object} rt - cfg、globalDir、globalTitle、statePath、memoryOn、
 *   workspaceRootOf、workspaceDirOf、titleFor、saveRuntimeState、writeEntry、
 *   distillTurn、lastTurnOf、loadLedger、saveLedger、promoteToGlobal、
 *   removeFromWorkspaces、promotionStats。
 */
export function createMemoryCommand(rt) {
  const { cfg, globalDir, globalTitle } = rt

  /** 渲染 /memory show 的正文。 */
  function renderShow(agent) {
    const lines = []
    const globalStore = storeOf(globalDir)
    lines.push(
      `全局记忆 ${globalDir} —— 活动区 ${globalStore === undefined ? 0 : globalStore.entries.length} 条，分片 ${globalStore === undefined ? 0 : globalStore.shards.length} 个`,
    )
    for (const entry of globalStore?.entries.slice(0, 50) ?? []) {
      lines.push(`  [${entry.kind}] ${entry.id}  ${entry.text}`)
    }
    const root = agent === undefined ? undefined : rt.workspaceRootOf(agent)
    const dir = rt.workspaceDirOf(root)
    if (dir === undefined) {
      lines.push('项目记忆：当前会话没有可用工作目录。')
    } else {
      const store = storeOf(dir)
      lines.push(
        `项目记忆 ${dir} —— 活动区 ${store === undefined ? 0 : store.entries.length} 条，分片 ${store === undefined ? 0 : store.shards.length} 个`,
      )
      for (const entry of store?.entries.slice(0, 50) ?? []) {
        lines.push(`  [${entry.kind}] ${entry.id}  ${entry.text}`)
      }
    }
    if (cfg.journal && dir !== undefined) lines.push(`对话摘要：${join(dir, JOURNAL_DIR)}`)
    lines.push(`记忆状态：${rt.memoryOn() ? '已开启' : '已关闭'}；自动沉淀：${cfg.autoDistill}；注入范围：${cfg.scope}`)
    return lines.join('\n')
  }

  return {
    name: 'memory',
    description: '查看与维护 dsh-easy-memory 的长期记忆',
    input: {
      hint: 'show | add [--global] [--kind <kind>] <text> | forget <id|query> | edit <id> <text> | distill | shards | import <text> | on | off | path | help',
    },
    async handler(invocation) {
      try {
        const raw = String(invocation?.rawInput ?? '').trim()
        const verb = raw === '' ? 'show' : raw.split(/\s+/)[0]
        const rest = raw === '' ? '' : raw.slice(verb.length).replace(/^\s+/, '')
        const agent = invocation?.agent
        switch (verb) {
          case 'show':
          case 'list':
            return { kind: 'success', text: renderShow(agent) }
          case 'help':
            return { kind: 'success', text: COMMAND_HELP }
          case 'path': {
            const root = agent === undefined ? undefined : rt.workspaceRootOf(agent)
            const dir = rt.workspaceDirOf(root)
            return {
              kind: 'success',
              text: [
                `全局记忆目录：${globalDir}`,
                `项目记忆目录：${dir === undefined ? '(当前会话没有可用工作目录)' : dir}`,
                `对话摘要目录：${dir === undefined ? '(无)' : join(dir, JOURNAL_DIR)}`,
                `状态文件：${rt.statePath}`,
                '记忆面板：主页侧栏 → 记忆',
              ].join('\n'),
            }
          }
          case 'on':
            await rt.saveRuntimeState(true)
            return { kind: 'success', text: '记忆已开启。' }
          case 'off':
            await rt.saveRuntimeState(false)
            return { kind: 'success', text: '记忆已关闭：不再注入记忆，也不再写对话摘要与自动沉淀。' }
          case 'shards': {
            const store = storeOf(globalDir)
            const root = agent === undefined ? undefined : rt.workspaceRootOf(agent)
            const dir = rt.workspaceDirOf(root)
            const lines = [
              `全局 ${globalDir}：活动区日期 ${store === undefined ? '?' : store.activeDate}，分片 ${store === undefined ? 0 : store.shards.length} 个`,
            ]
            for (const shard of store?.shards ?? []) lines.push(`  ${shard.file}  ${shard.date}  ${shard.count} 条`)
            if (dir !== undefined) {
              const wsStore = storeOf(dir)
              lines.push(
                `项目 ${dir}：活动区日期 ${wsStore === undefined ? '?' : wsStore.activeDate}，分片 ${wsStore === undefined ? 0 : wsStore.shards.length} 个`,
              )
              for (const shard of wsStore?.shards ?? []) lines.push(`  ${shard.file}  ${shard.date}  ${shard.count} 条`)
            }
            return { kind: 'success', text: lines.join('\n') }
          }
          case 'distill': {
            const session = agent?.session
            if (session === undefined) return { kind: 'error', text: '当前会话不可用，无法沉淀。' }
            const result = await rt.distillTurn(session, rt.lastTurnOf(session))
            return {
              kind: 'success',
              text:
                result === undefined || result.skipped !== undefined
                  ? `本轮没有沉淀出新记忆（${result === undefined ? 'unknown' : result.skipped}）。`
                  : `已沉淀 ${result.saved} 条记忆。`,
            }
          }
          case 'add':
          case 'remember': {
            const { options, text } = parseOptions(rest)
            if (text.trim() === '') return { kind: 'error', text: `缺少记忆内容。\n${COMMAND_HELP}` }
            const kind = requireKind(options.kind)
            const target =
              options.scope === 'global'
                ? { dir: globalDir, title: globalTitle, root: undefined }
                : resolveTarget(rt, agent, 'workspace')
            const result = await rt.writeEntry(
              target,
              {
                kind,
                text,
                tags: [],
                source: { sessionId: agent === undefined ? '' : String(agent.id), at: Date.now(), via: 'command' },
              },
              target.root,
            )
            return {
              kind: 'success',
              text: `${result.deduped ? '已更新' : '已记录'}到 ${target.dir}：\n[${kind}] ${result.id}  ${text}`,
            }
          }
          case 'edit': {
            const space = rest.indexOf(' ')
            if (space <= 0) return { kind: 'error', text: `用法：/memory edit <id> <新文本>\n${COMMAND_HELP}` }
            const id = rest.slice(0, space).trim()
            const text = rest.slice(space + 1).trim()
            for (const { dir, store } of visibleScopes(rt, agent, undefined)) {
              if (store === undefined) continue
              const result = await updateEntry(dir, rt.titleFor(dir), id, { text }, cfg)
              if (result.found) return { kind: 'success', text: `已改写 ${id}。` }
            }
            return { kind: 'error', text: `没有找到活动区里的 ${id}。` }
          }
          case 'promote': {
            const id = rest.trim()
            if (id === '') return { kind: 'error', text: `用法：/memory promote <项目记忆的 id>\n${COMMAND_HELP}` }
            const root = agent === undefined ? undefined : rt.workspaceRootOf(agent)
            const dir = rt.workspaceDirOf(root)
            if (dir === undefined) return { kind: 'error', text: '当前会话没有可用工作目录。' }
            const entry = storeOf(dir)?.entries.find((item) => item.id === id)
            if (entry === undefined) return { kind: 'error', text: `项目记忆活动区里没有 ${id}。` }
            const ledger = await rt.loadLedger()
            const key = normalizeText(entry.text)
            const record = ledger.entries[key] ?? {
              key,
              kind: entry.kind,
              text: entry.text,
              workspaces: [],
              firstSeen: Date.now(),
              promoted: false,
            }
            if (typeof root === 'string' && root !== '' && !record.workspaces.includes(root)) {
              record.workspaces.push(root)
            }
            await rt.promoteToGlobal(record)
            ledger.entries[key] = record
            await rt.saveLedger()
            if (cfg.promoteMode === 'move') await rt.removeFromWorkspaces(record)
            return {
              kind: 'success',
              text: `已把 ${id} 晋升为全局记忆${cfg.promoteMode === 'move' ? '，并从项目记忆里移除' : '，项目记忆里保留副本'}。`,
            }
          }
          case 'promotions': {
            const stats = await rt.promotionStats()
            if (stats.candidates === 0) {
              return {
                kind: 'success',
                text: `晋升账本还是空的（${join(globalDir, PROMOTION_LEDGER_FILE)}）：还没有项目记忆在 ${cfg.promoteAfterWorkspaces} 个不同工作区里重复出现过。`,
              }
            }
            const records = stats.records.slice().sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
            const lines = [
              `晋升账本 ${join(globalDir, PROMOTION_LEDGER_FILE)}`,
              `候选 ${stats.candidates} 条，已晋升 ${stats.promoted} 条；判据是同一文本出现在 ${cfg.promoteAfterWorkspaces} 个不同工作区；模式 ${cfg.promoteMode}`,
              '',
            ]
            for (const record of records.slice(0, 40)) {
              lines.push(`${record.promoted ? '● 已晋升' : '○ 待观察'} (${record.kind}) ${record.text}`)
              lines.push(`    ${(record.workspaces ?? []).length} 个工作区：${(record.workspaces ?? []).join(' | ')}`)
            }
            return { kind: 'success', text: lines.join('\n') }
          }
          case 'forget':
          case 'delete': {
            const target = parseOptions(rest)
            const needle = target.text.trim()
            if (needle === '') return { kind: 'error', text: `缺少要删除的 id 或关键词。\n${COMMAND_HELP}` }
            const scopesList =
              target.options.scope === 'global'
                ? [{ scope: 'global', dir: globalDir, store: storeOf(globalDir) }]
                : visibleScopes(rt, agent, undefined)
            const terms = needle.toLowerCase().split(/\s+/).filter((t) => t !== '')
            let removed = 0
            for (const { dir, store } of scopesList) {
              if (store === undefined) continue
              const victims = await forgetEntries(
                dir,
                rt.titleFor(dir),
                (entry) => (entry.id === needle ? true : matchesQuery(entry, terms)),
                cfg,
              )
              removed += victims.length
            }
            return { kind: 'success', text: removed === 0 ? '没有匹配的记忆条目。' : `已删除 ${removed} 条记忆。` }
          }
          case 'import': {
            const lines = rest
              .split(/\r?\n/)
              .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
              .filter((line) => line !== '' && line.length > 1)
            if (lines.length === 0) return { kind: 'error', text: `没有可导入的内容。\n${COMMAND_HELP}` }
            let added = 0
            for (const line of lines.slice(0, 200)) {
              await addEntry(
                globalDir,
                globalTitle,
                { kind: 'fact', text: line, tags: ['imported'], source: { at: Date.now(), via: 'command-import' } },
                cfg,
              )
              added += 1
            }
            return { kind: 'success', text: `已导入 ${added} 条到全局记忆 ${globalDir}。` }
          }
          default:
            return { kind: 'error', text: `未知子命令 ${verb}。\n${COMMAND_HELP}` }
        }
      } catch (error) {
        return { kind: 'error', text: `memory 命令失败：${textOf(error)}` }
      }
    },
  }
}
