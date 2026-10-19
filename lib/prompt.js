/**
 * 提示词渲染：把两个作用域的记忆拼成注入系统提示词的那一段文本。
 */

import { KINDS, SHARD_DIR } from './constants.js'
import { clip } from './util.js'

/** 按更新时间和条数上限挑出条目。 */
export function selectForPrompt(entries, maxEntries) {
  return entries
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, maxEntries)
}

/** 渲染一个作用域的条目列表。 */
export function renderEntries(entries, maxEntries, maxTextChars) {
  return selectForPrompt(entries, maxEntries).map(
    (entry) => `- (${entry.kind}) ${clip(entry.text, maxTextChars)}`,
  )
}

/** 渲染注入系统提示词的那段文本。 */
export function renderSectionText(cfg, state, globalStore, workspace) {
  if (!state.enabled) return ''
  const lines = ['## Long-term memory (dsh-easy-memory)', '']
  const includeGlobal = cfg.scope === 'both' || cfg.scope === 'global'
  const includeWorkspace = cfg.scope === 'both' || cfg.scope === 'workspace'

  if (includeGlobal) {
    const entries = globalStore === undefined ? [] : globalStore.entries
    lines.push('### User memory (global, follows the user across workspaces)')
    if (entries.length === 0) lines.push('- (empty)')
    else lines.push(...renderEntries(entries, cfg.maxEntriesInPrompt, cfg.maxTextChars))
    lines.push('')
  }

  if (includeWorkspace) {
    const store = workspace === undefined ? undefined : workspace.store
    const entries = store === undefined ? [] : store.entries
    lines.push(`### Project memory (workspace${workspace === undefined ? '' : `: ${workspace.dir}`})`)
    if (workspace === undefined) lines.push('- (project memory is not resolved for this prompt assembly)')
    else if (entries.length === 0) lines.push('- (empty)')
    else lines.push(...renderEntries(entries, cfg.maxEntriesInPrompt, cfg.maxTextChars))
    if (store !== undefined && store.shards.length > 0) {
      const archived = store.shards.reduce((sum, shard) => sum + (typeof shard.count === 'number' ? shard.count : 0), 0)
      lines.push(
        `- (${archived} older entries were archived into ${store.shards.length} shard file(s) under ${SHARD_DIR}/; they are not listed here but \`memory_search\` still reads them)`,
      )
    }
    lines.push('')
  }

  lines.push(
    '### How to use this memory',
    '- These entries were recorded earlier and may be stale or wrong; verify before relying on them for an important decision.',
    '- Before asking the user for something you might already know, call `memory_search`.',
    '- When you learn a durable fact, preference, relationship, or follow-up, call `memory_write`; use scope `global` for things about the user and scope `workspace` for things about this project.',
    '- Call `memory_forget` when the user asks you to forget something.',
    '- Never store credentials, tokens, or other secrets in memory.',
  )

  let text = lines.join('\n')
  if (text.length > cfg.maxInjectChars) {
    text = `${text.slice(0, cfg.maxInjectChars)}\n- (memory section truncated to ${cfg.maxInjectChars} characters)`
  }
  return text
}

/** 从模型回复里解析出记忆条目。 */
export function parseDistilled(reply, maxEntries) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)
  const body = (fenced === null ? reply : fenced[1]).trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    const out = []
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.text !== 'string' || !KINDS.includes(item.kind)) continue
      const text = item.text.replace(/\s+/g, ' ').trim()
      if (text === '') continue
      out.push({ kind: item.kind, text: clip(text, 500) })
      if (out.length >= maxEntries) break
    }
    return out
  } catch {
    return []
  }
}
