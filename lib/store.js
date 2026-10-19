/**
 * 存储层：主索引（memory.json）+ 派生视图（memory.md）+ 分片（shards/）。
 *
 * 所有写操作都经过 withLock 串行化；内存缓存 stores 是进程级单例，
 * 外部直接编辑 memory.json 时由调用方重新 loadStore。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  KINDS,
  KIND_LABELS,
  MEMORY_FILE,
  SHARD_DIR,
  STORE_VERSION,
  VIEW_FILE,
} from './constants.js'
import {
  dateStamp,
  isEntry,
  isShard,
  isoOf,
  log,
  normalizeText,
  textOf,
  withLock,
  writeJsonAtomic,
} from './util.js'

/** 进程内缓存：目录 -> 已加载的 store。 */
export const stores = new Map()

/** 读取一个记忆目录到缓存；目录不存在视为空记忆。v1 单文件格式在这里就地升级。 */
export async function loadStore(dir) {
  const file = join(dir, MEMORY_FILE)
  let entries = []
  let shards = []
  let activeDate = dateStamp(Date.now())
  let error
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      if (Array.isArray(parsed.entries)) entries = parsed.entries.filter(isEntry)
      if (Array.isArray(parsed.shards)) shards = parsed.shards.filter(isShard)
      if (typeof parsed.activeDate === 'string' && parsed.activeDate !== '') activeDate = parsed.activeDate
    }
  } catch (cause) {
    if (cause === null || typeof cause !== 'object' || cause.code !== 'ENOENT') {
      error = textOf(cause)
      log(`failed to read ${file}: ${error}`)
    }
  }
  const previous = stores.get(dir)
  const store = {
    dir,
    entries,
    shards,
    activeDate,
    loadedAt: Date.now(),
    error,
    shardCache: previous === undefined ? new Map() : previous.shardCache,
  }
  stores.set(dir, store)
  return store
}

/** 从缓存取 store；未加载时启动一次后台加载。 */
export function storeOf(dir) {
  const cached = stores.get(dir)
  if (cached !== undefined) return cached
  if (typeof dir === 'string' && dir !== '') {
    void loadStore(dir).catch((error) => log(`background load failed: ${textOf(error)}`))
  }
  return undefined
}

/** 生成人类可读的 memory.md。 */
export function renderView(store, title, updatedAt) {
  const entries = store.entries
  const lines = [
    `# ${title}`,
    '',
    '> 本文件由 dsh-easy-memory 插件自动生成，是同目录 memory.json 的只读视图。',
    '> 手工修改本文件不会被插件读回；请用 memory_* 工具、/memory 命令或侧栏记忆面板维护记忆。',
    `> 最后更新：${isoOf(updatedAt)}`,
    `> 当前活动区：${store.activeDate}，${entries.length} 条；已归档分片：${store.shards.length} 个。`,
    '',
  ]
  for (const kind of KINDS) {
    const group = entries.filter((entry) => entry.kind === kind)
    if (group.length === 0) continue
    lines.push(`## ${KIND_LABELS[kind]} (${kind})`, '')
    for (const entry of group) {
      const tags = Array.isArray(entry.tags) && entry.tags.length > 0 ? ` \`#${entry.tags.join(' #')}\`` : ''
      lines.push(`- \`${entry.id}\` ${entry.text}${tags}`)
    }
    lines.push('')
  }
  if (entries.length === 0) lines.push('_(当前活动区暂无记忆条目)_', '')
  if (store.shards.length > 0) {
    lines.push('## 归档分片 shards', '')
    for (const shard of store.shards) {
      lines.push(`- \`${shard.file}\` ${shard.date} · ${String(shard.count ?? '?')} 条`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/** 把 store 落盘：memory.json 为权威数据，memory.md 为派生视图。 */
export async function persistStore(store, title) {
  await mkdir(store.dir, { recursive: true })
  const updatedAt = Date.now()
  await writeJsonAtomic(join(store.dir, MEMORY_FILE), {
    version: STORE_VERSION,
    updatedAt,
    activeDate: store.activeDate,
    entries: store.entries,
    shards: store.shards,
  })
  stores.set(store.dir, { ...store, loadedAt: updatedAt })
  try {
    await writeFile(join(store.dir, VIEW_FILE), renderView(store, title, updatedAt), 'utf8')
  } catch (error) {
    log(`failed to write ${VIEW_FILE}: ${textOf(error)}`)
  }
}

/** 判断当前活动区是否需要归档：跨天、超条数、超字节。 */
export function rollReason(store, cfg) {
  const today = dateStamp(Date.now())
  if (store.activeDate !== today) return 'date'
  if (store.entries.length > cfg.shardMaxEntries) return 'count'
  if (JSON.stringify(store.entries).length > cfg.shardMaxBytes) return 'bytes'
  return undefined
}

/**
 * 需要归档时把旧条目切进 shards/ 分片，主索引只留最近的 keepActiveEntries 条。
 * 归档结果立即落盘，避免调用方后续失败留下不一致的索引。
 */
export async function rollIfNeeded(store, cfg, title) {
  const reason = rollReason(store, cfg)
  if (reason === undefined) return store
  const sorted = store.entries.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const keep = sorted.slice(0, cfg.keepActiveEntries)
  const archived = sorted.slice(cfg.keepActiveEntries)
  const shards = store.shards.slice()
  if (archived.length > 0) {
    const date = store.activeDate
    const seq = shards.filter((shard) => shard.date === date).length + 1
    const file = join(SHARD_DIR, `${date}-${seq}.json`).replace(/\\/g, '/')
    await mkdir(join(store.dir, SHARD_DIR), { recursive: true })
    await writeJsonAtomic(join(store.dir, file), {
      version: STORE_VERSION,
      date,
      archivedAt: Date.now(),
      reason,
      entries: archived,
    })
    shards.push({ file, date, count: archived.length, createdAt: Date.now() })
  }
  const next = { ...store, entries: keep, shards, activeDate: dateStamp(Date.now()) }
  log(`rolled store ${store.dir} (${reason}): archived ${archived.length}, kept ${keep.length}`)
  await persistStore(next, title)
  return next
}

/** 读取一个分片的条目，结果缓存在 store.shardCache 里。 */
export async function shardEntries(store, shard) {
  const cache = store.shardCache
  if (cache.has(shard.file)) return cache.get(shard.file)
  let entries = []
  try {
    const raw = await readFile(join(store.dir, shard.file), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      entries = parsed.entries.filter(isEntry)
    }
  } catch (error) {
    log(`failed to read shard ${shard.file}: ${textOf(error)}`)
  }
  cache.set(shard.file, entries)
  return entries
}

/** 新增或更新一条记忆。 */
export async function addEntry(dir, title, input, cfg) {
  return withLock(dir, async () => {
    let store = stores.get(dir) ?? (await loadStore(dir))
    store = await rollIfNeeded(store, cfg, title)
    const text = String(input.text).replace(/\s+/g, ' ').trim()
    const entries = store.entries.slice()
    const key = normalizeText(text)
    const existingIndex = entries.findIndex(
      (entry) => entry.kind === input.kind && normalizeText(entry.text) === key,
    )
    const now = Date.now()
    if (existingIndex >= 0) {
      const existing = entries[existingIndex]
      entries[existingIndex] = {
        ...existing,
        text,
        tags: input.tags,
        updatedAt: now,
        hits: (typeof existing.hits === 'number' ? existing.hits : 0) + 1,
      }
      const next = { ...store, entries, loadedAt: now, error: undefined }
      await persistStore(next, title)
      return { id: entries[existingIndex].id, deduped: true, total: entries.length }
    }
    const entry = {
      id: `m-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      text,
      tags: input.tags,
      createdAt: now,
      updatedAt: now,
      hits: 1,
      source: input.source,
    }
    entries.unshift(entry)
    const next = { ...store, entries, loadedAt: now, error: undefined }
    await persistStore(next, title)
    return { id: entry.id, deduped: false, total: entries.length }
  })
}

/** 就地修改一条记忆。 */
export async function updateEntry(dir, title, id, patch, cfg) {
  return withLock(dir, async () => {
    let store = stores.get(dir) ?? (await loadStore(dir))
    store = await rollIfNeeded(store, cfg, title)
    const index = store.entries.findIndex((entry) => entry.id === id)
    if (index < 0) return { found: false }
    const entries = store.entries.slice()
    const current = entries[index]
    entries[index] = {
      ...current,
      kind: patch.kind === undefined ? current.kind : patch.kind,
      text: patch.text === undefined ? current.text : String(patch.text).replace(/\s+/g, ' ').trim(),
      tags: patch.tags === undefined ? current.tags : patch.tags,
      updatedAt: Date.now(),
    }
    const next = { ...store, entries, loadedAt: Date.now(), error: undefined }
    await persistStore(next, title)
    return { found: true, entry: entries[index] }
  })
}

/** 按条件删除记忆，返回被删掉的条目。 */
export async function forgetEntries(dir, title, predicate, cfg) {
  return withLock(dir, async () => {
    let store = stores.get(dir) ?? (await loadStore(dir))
    store = await rollIfNeeded(store, cfg, title)
    const removed = store.entries.filter(predicate)
    if (removed.length === 0) return []
    const kept = store.entries.filter((entry) => !predicate(entry))
    const next = { ...store, entries: kept, loadedAt: Date.now(), error: undefined }
    await persistStore(next, title)
    return removed
  })
}
