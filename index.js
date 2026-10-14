/**
 * dsh-easy-memory — DeepSeek Harness 宿主侧（Host）记忆插件。
 *
 * 三层能力：
 *   1. 用户全局记忆：<DSH_HOME>/easy-memory/，跟人走，可在设置页可视化增删改；
 *   2. 项目记忆：<工作区根>/.dshmem/，跟项目走，每次对话结束后由会话自己的模型
 *      自动沉淀新条目；
 *   3. 分片归档：项目记忆超过一天或超过容量上限时，旧条目被切到 shards/ 分片，
 *      主索引只保留最近的一批，注入时用主索引，检索时分片按需召回。
 *
 * 记忆在每次组装系统提示词时被注入；模型通过 memory_write / memory_search /
 * memory_forget / memory_status 读写；用户通过 /memory 命令或设置页维护。
 *
 * 工程约束：本文件只使用 Node 内置模块。插件安装在 profile 的 node_modules 下，
 * 宿主安装目录里的 @deepseek-ai/* 包是否对其可解析并不由本插件决定，因此工具定义
 * 直接书写 Harness 强制的 JSON Schema 子集，不导入 defineTool。代价是 defineTool
 * 自带的入参校验没有生效，每个 execute 自行校验参数。
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 插件名，供 loader 诊断使用。 */
export const name = 'dsh-easy-memory'

/** 本插件依赖的宿主服务；缺任意一个时插件保持不激活。webServer 与 llm 走可选获取。 */
export const inject = ['tools', 'systemPrompt', 'commands', 'workingDirectory']

const TAG = '[dsh-easy-memory]'

/** 记忆条目的四个分类，与 WorkBuddy 文档列出的抽取范围一一对应。 */
const KINDS = ['fact', 'preference', 'relationship', 'followup']

/** 分类的中文标签，用于生成人类可读的 memory.md 与设置页。 */
const KIND_LABELS = {
  fact: '事实信息',
  preference: '偏好习惯',
  relationship: '人物关系',
  followup: '跟进事项',
}

/** 作用域取值。 */
const SCOPES = ['global', 'workspace']

/** 注入范围取值。 */
const INJECT_SCOPES = ['both', 'global', 'workspace']

/** 自动沉淀的目标作用域取值。 */
const DISTILL_SCOPES = ['workspace', 'global', 'both', 'off']

/** system-prompt section 的名字；agent 作用域下注册同名 section 会遮蔽全局那条。 */
const SECTION_NAME = 'easy-memory'

/** 主索引文件名。 */
const MEMORY_FILE = 'memory.json'
/** 人类可读视图文件名。 */
const VIEW_FILE = 'memory.md'
/** 运行期开关文件名。 */
const STATE_FILE = 'state.json'
/** 全局晋升账本文件名；放在全局记忆目录里，所以跨工作区共享。 */
const PROMOTION_LEDGER_FILE = 'promotion.json'
/** 晋升模式取值：move 把条目搬进全局，copy 则在两边各留一份。 */
const PROMOTE_MODES = ['move', 'copy']
/** 分片目录名。 */
const SHARD_DIR = 'shards'
/** 对话摘要目录名。 */
const JOURNAL_DIR = 'journal'
/** 存储格式版本。 */
const STORE_VERSION = 2

/** 设置页使用的 HTTP 前缀。 */
const HTTP_PREFIX = '/dsh-easy-memory'

/** 自动沉淀的提示词。 */
const DISTILL_SYSTEM = [
  'You extract durable long-term memories from one conversation turn.',
  'Return ONLY a JSON array. Each item is {"kind": "...", "text": "..."}.',
  'kind is one of: fact, preference, relationship, followup.',
  'fact = stable information about the user or about this project.',
  'preference = a habit, taste, or working style.',
  'relationship = a person, role, or team relation.',
  'followup = something worth revisiting later.',
  'text is one self-contained sentence that still makes sense without the conversation.',
  'Never include secrets, credentials, tokens, or one-off task details.',
  'Return [] when nothing in the turn is durable.',
].join('\n')

/** 默认配置；cordis.patch.yml 里的 config 会覆盖这些值。 */
const DEFAULTS = {
  enabled: true,
  scope: 'both',
  globalDir: '',
  workspaceDirName: '.dshmem',
  sectionOrder: 500,
  maxEntriesInPrompt: 40,
  maxInjectChars: 4000,
  maxTextChars: 500,
  refreshMs: 15000,
  journal: true,
  journalMaxChars: 1200,
  shardMaxEntries: 200,
  shardMaxBytes: 131072,
  keepActiveEntries: 50,
  searchShards: 10,
  promoteEnabled: true,
  promoteAfterWorkspaces: 2,
  promoteMode: 'move',
  promotionLedgerMax: 2000,
  autoDistill: 'workspace',
  distillMinChars: 200,
  distillMaxInputChars: 12000,
  distillMaxEntries: 8,
  distillTimeoutMs: 60000,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 输出一行宿主日志。 */
function log(...args) {
  console.error(TAG, ...args)
}

/** 把任意异常压成一行可读文本。 */
function textOf(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/** 只保留有限正整数，否则回退默认值。 */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 只保留布尔值，否则回退默认值。 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 只保留枚举内的字符串，否则回退默认值。 */
function enumOr(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** 合并用户配置与默认值。 */
function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: boolOr(input.enabled, DEFAULTS.enabled),
    scope: enumOr(input.scope, INJECT_SCOPES, DEFAULTS.scope),
    globalDir: typeof input.globalDir === 'string' && input.globalDir !== '' ? input.globalDir : DEFAULTS.globalDir,
    workspaceDirName:
      typeof input.workspaceDirName === 'string' && input.workspaceDirName !== ''
        ? input.workspaceDirName
        : DEFAULTS.workspaceDirName,
    sectionOrder:
      typeof input.sectionOrder === 'number' && Number.isFinite(input.sectionOrder)
        ? input.sectionOrder
        : DEFAULTS.sectionOrder,
    maxEntriesInPrompt: positiveInt(input.maxEntriesInPrompt, DEFAULTS.maxEntriesInPrompt),
    maxInjectChars: positiveInt(input.maxInjectChars, DEFAULTS.maxInjectChars),
    maxTextChars: positiveInt(input.maxTextChars, DEFAULTS.maxTextChars),
    refreshMs: positiveInt(input.refreshMs, DEFAULTS.refreshMs),
    journal: boolOr(input.journal, DEFAULTS.journal),
    journalMaxChars: positiveInt(input.journalMaxChars, DEFAULTS.journalMaxChars),
    shardMaxEntries: positiveInt(input.shardMaxEntries, DEFAULTS.shardMaxEntries),
    shardMaxBytes: positiveInt(input.shardMaxBytes, DEFAULTS.shardMaxBytes),
    keepActiveEntries: positiveInt(input.keepActiveEntries, DEFAULTS.keepActiveEntries),
    searchShards: positiveInt(input.searchShards, DEFAULTS.searchShards),
    promoteEnabled: boolOr(input.promoteEnabled, DEFAULTS.promoteEnabled),
    promoteAfterWorkspaces: positiveInt(input.promoteAfterWorkspaces, DEFAULTS.promoteAfterWorkspaces),
    promoteMode: enumOr(input.promoteMode, PROMOTE_MODES, DEFAULTS.promoteMode),
    promotionLedgerMax: positiveInt(input.promotionLedgerMax, DEFAULTS.promotionLedgerMax),
    autoDistill: enumOr(input.autoDistill, DISTILL_SCOPES, DEFAULTS.autoDistill),
    distillMinChars: positiveInt(input.distillMinChars, DEFAULTS.distillMinChars),
    distillMaxInputChars: positiveInt(input.distillMaxInputChars, DEFAULTS.distillMaxInputChars),
    distillMaxEntries: positiveInt(input.distillMaxEntries, DEFAULTS.distillMaxEntries),
    distillTimeoutMs: positiveInt(input.distillTimeoutMs, DEFAULTS.distillTimeoutMs),
  }
}

/** 计算 DSH 主目录；与宿主注入的 DSH_HOME 保持一致。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 把 ContentBlock 数组压成纯文本。 */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 截断长文本，并在截断处标注。 */
function clip(text, limit) {
  if (typeof text !== 'string') return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`
}

/** 记忆文本的归一化形式，用于去重与匹配。 */
function normalizeText(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 时间戳的 ISO 形字符串。 */
function isoOf(time) {
  const value = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
  try {
    return new Date(value).toISOString()
  } catch {
    return 'unknown'
  }
}

/** 本地日期，用作分片与 journal 的日期键。 */
function dateStamp(time) {
  const value = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 判断一个已解析对象是不是记忆条目。 */
function isEntry(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    KINDS.includes(value.kind)
  )
}

/** 判断一个已解析对象是不是分片索引记录。 */
function isShard(value) {
  return value !== null && typeof value === 'object' && typeof value.file === 'string'
}

/** 原子写 JSON：先写临时文件再改名，改名失败则退回直接覆盖。 */
async function writeJsonAtomic(file, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, file)
  } catch {
    await writeFile(file, body, 'utf8')
  }
}

/** 读一个可能不存在的 JSON 文件。 */
async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** 每个目录一条串行链，避免并发写互相覆盖。 */
const locks = new Map()

/** 在指定 key 上串行执行 fn。 */
function withLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  locks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

// ---------------------------------------------------------------------------
// 存储层（主索引 + 分片）
// ---------------------------------------------------------------------------

/** 进程内缓存：目录 -> 已加载的 store。 */
const stores = new Map()

/** 读取一个记忆目录到缓存；目录不存在视为空记忆。v1 单文件格式在这里就地升级。 */
async function loadStore(dir) {
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
function storeOf(dir) {
  const cached = stores.get(dir)
  if (cached !== undefined) return cached
  if (typeof dir === 'string' && dir !== '') {
    void loadStore(dir).catch((error) => log(`background load failed: ${textOf(error)}`))
  }
  return undefined
}

/** 生成人类可读的 memory.md。 */
function renderView(store, title, updatedAt) {
  const entries = store.entries
  const lines = [
    `# ${title}`,
    '',
    '> 本文件由 dsh-easy-memory 插件自动生成，是同目录 memory.json 的只读视图。',
    '> 手工修改本文件不会被插件读回；请用 memory_* 工具、/memory 命令或设置页维护记忆。',
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
async function persistStore(store, title) {
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
function rollReason(store, cfg) {
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
async function rollIfNeeded(store, cfg, title) {
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
async function shardEntries(store, shard) {
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
async function addEntry(dir, title, input, cfg) {
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
async function updateEntry(dir, title, id, patch, cfg) {
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
async function forgetEntries(dir, title, predicate, cfg) {
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

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

/** 判断条目是否命中查询词（全部词都得命中，空查询命中一切）。 */
function matchesQuery(entry, terms) {
  if (terms.length === 0) return true
  const haystack = `${entry.text} ${entry.kind} ${Array.isArray(entry.tags) ? entry.tags.join(' ') : ''}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/**
 * 在若干 store 上做检索：先搜主索引，再按需读最近的分片。
 * @returns {Promise<{hits: Array, total: number, limit: number, scannedShards: number}>}
 */
async function searchAcross(scopesList, options, cfg) {
  const terms = String(options.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '')
  const kind = options.kind
  const limit = positiveInt(options.limit, 20)
  const hits = []
  let scannedShards = 0
  for (const { scope, dir, store } of scopesList) {
    if (store === undefined) continue
    for (const entry of store.entries) {
      if (kind !== undefined && entry.kind !== kind) continue
      if (!matchesQuery(entry, terms)) continue
      hits.push({ entry, scope, dir, archived: false })
    }
    if (store.shards.length === 0) continue
    const recent = store.shards.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, cfg.searchShards)
    for (const shard of recent) {
      scannedShards += 1
      const entries = await shardEntries(store, shard)
      for (const entry of entries) {
        if (kind !== undefined && entry.kind !== kind) continue
        if (!matchesQuery(entry, terms)) continue
        hits.push({ entry, scope, dir, archived: true })
      }
    }
  }
  hits.sort((a, b) => (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))
  return { hits, total: hits.length, limit, scannedShards }
}

// ---------------------------------------------------------------------------
// 提示词渲染
// ---------------------------------------------------------------------------

/** 按更新时间和条数上限挑出条目。 */
function selectForPrompt(entries, maxEntries) {
  return entries
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, maxEntries)
}

/** 渲染一个作用域的条目列表。 */
function renderEntries(entries, maxEntries, maxTextChars) {
  return selectForPrompt(entries, maxEntries).map(
    (entry) => `- (${entry.kind}) ${clip(entry.text, maxTextChars)}`,
  )
}

/** 渲染注入系统提示词的那段文本。 */
function renderSectionText(cfg, state, globalStore, workspace) {
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
function parseDistilled(reply, maxEntries) {
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

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 注册记忆插件。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} [rawConfig] - profile patch 里该行的 config。
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const globalDir = cfg.globalDir !== '' ? cfg.globalDir : join(dshHome(), 'easy-memory')
  const globalTitle = '用户全局记忆 / Global user memory'
  const runtimeState = { enabled: true, loaded: false }
  const statePath = join(globalDir, STATE_FILE)

  /** 记忆目录对应的展示标题；删改后重建 memory.md 时也要用它。 */
  function titleFor(dir) {
    return dir === globalDir ? globalTitle : `项目记忆 / Project memory (${dir})`
  }

  /** 读取运行期开关（/memory off 或设置页会写它）。 */
  async function loadRuntimeState() {
    const parsed = await readJson(statePath, undefined)
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.enabled === 'boolean') {
      runtimeState.enabled = parsed.enabled
    }
    runtimeState.loaded = true
    return runtimeState
  }

  /** 写运行期开关。 */
  async function saveRuntimeState(enabled) {
    runtimeState.enabled = enabled
    await mkdir(globalDir, { recursive: true })
    await writeJsonAtomic(statePath, { version: STORE_VERSION, enabled, updatedAt: Date.now() })
  }

  /** 记忆功能此刻是否生效（配置开关与运行期开关都要求开启）。 */
  function memoryOn() {
    return cfg.enabled && runtimeState.enabled
  }

  /** 工作区记忆目录。 */
  function workspaceDirOf(root) {
    if (typeof root !== 'string' || root === '') return undefined
    return join(root, cfg.workspaceDirName)
  }

  /** 取某个 agent 当前的工作目录。 */
  function workspaceRootOf(agent) {
    try {
      const session = agent?.session
      if (session !== undefined && ctx.workingDirectory !== undefined) {
        const dir = ctx.workingDirectory.get(session)
        if (typeof dir === 'string' && dir !== '') return dir
      }
    } catch (error) {
      log(`workingDirectory.get failed: ${textOf(error)}`)
    }
    try {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {
      /* header 不可读时按未知处理 */
    }
    return undefined
  }

  /** 预读某个 agent 工作区的记忆目录；该会话没有工作目录时什么也不做。 */
  async function preloadWorkspace(agent) {
    const dir = workspaceDirOf(workspaceRootOf(agent))
    if (dir === undefined) return
    await loadStore(dir)
  }

  /** 组装一次注入所需的全部状态。 */
  function snapshotFor(agent) {
    const globalStore = storeOf(globalDir)
    let workspace
    if (agent !== undefined) {
      const root = workspaceRootOf(agent)
      const dir = workspaceDirOf(root)
      if (dir !== undefined) workspace = { root, dir, store: storeOf(dir) }
    }
    return { globalStore, workspace }
  }

  /** 生成某个 agent 视角的注入文本；agent 为空时退化为全局视角。 */
  function textFor(agent) {
    if (!memoryOn()) return ''
    const { globalStore, workspace } = snapshotFor(agent)
    return renderSectionText(cfg, runtimeState, globalStore, workspace)
  }

  // --- 1) 全局 section：即使拿不到 agent 作用域也保证有记忆注入 ------------

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: cfg.sectionOrder,
      text: () => textFor(undefined),
    }),
  )

  // --- 2) 每个 agent 一条同名 section，遮蔽全局那条并带上工作区记忆 --------

  const agentDisposers = new Map()

  /** 释放某个 agent 的作用域注册。 */
  function releaseAgent(agent) {
    const dispose = agentDisposers.get(agent)
    if (dispose === undefined) return
    agentDisposers.delete(agent)
    try {
      dispose()
    } catch (error) {
      log(`failed to release agent scope: ${textOf(error)}`)
    }
  }

  ctx.effect(() =>
    ctx.on('agent/created', async ({ agent }) => {
      try {
        /*
         * 先把这个 agent 会用到的两份记忆读进缓存，再注册 section。
         * agent/created 的监听器会被 await，而 AgentLoop 会扣住排队中的输入，
         * 所以这一步保证了「重启后的第一次请求」也能看到记忆；
         * 否则首次组装会赶在异步读盘完成之前，注入出一个空的记忆段。
         */
        await Promise.all([loadStore(globalDir), preloadWorkspace(agent).catch(() => undefined)])
        const agentCtx = agent?.ctx
        if (agentCtx === undefined || typeof agentCtx.effect !== 'function') return
        const dispose = agentCtx.effect(() => {
          const prompt = agentCtx.get('systemPrompt')
          if (prompt === undefined || typeof prompt.section !== 'function') return () => {}
          return prompt.section({
            name: SECTION_NAME,
            order: cfg.sectionOrder,
            text: () => textFor(agent),
          })
        })
        agentDisposers.set(agent, dispose)
      } catch (error) {
        // agent/created 的监听器抛错会中断 agent 创建，因此这里必须吞掉异常。
        log(`failed to register per-agent memory section: ${textOf(error)}`)
      }
    }),
  )

  ctx.effect(() =>
    ctx.on('agent/disposed', ({ agent }) => {
      releaseAgent(agent)
    }),
  )

  ctx.effect(() => () => {
    for (const agent of [...agentDisposers.keys()]) releaseAgent(agent)
  })

  // --- 3) 周期刷新：外部编辑 memory.json 后无需重启，并检查跨天归档 --------

  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const store of [...stores.values()]) {
        const reason = rollReason(store, cfg)
        if (reason !== undefined) {
          void rollIfNeeded(store, cfg, titleFor(store.dir)).catch((error) =>
            log(`scheduled roll failed: ${textOf(error)}`),
          )
        } else {
          void loadStore(store.dir).catch((error) => log(`refresh failed: ${textOf(error)}`))
        }
      }
      void loadStore(globalDir).catch(() => undefined)
    }, cfg.refreshMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  // --- 4) turn 摘要写入工作区 journal -------------------------------------

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

  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      if (!memoryOn()) return
      const turn = event.data?.turn
      if (cfg.journal) {
        void writeJournal(session, event, turn).catch((error) => log(`journal write failed: ${textOf(error)}`))
      }
      if (cfg.autoDistill !== 'off') {
        void distillTurn(session, turn).catch((error) => log(`auto distill failed: ${textOf(error)}`))
      }
    }),
  )

  /** 把一轮对话摘要追加到工作区 journal。 */
  async function writeJournal(session, event, turn) {
    const root = workspaceRootOf({ session })
    const dir = workspaceDirOf(root)
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

  // --- 5) 每轮对话后自动沉淀项目记忆（由会话自己的模型完成抽取） -----------

  /** 同一时刻只跑一次沉淀，避免并发模型调用。 */
  let distilling = false

  /** 用当前请求所用的 provider/model 跑一次抽取。 */
  async function distillTurn(session, turn) {
    if (distilling) return { skipped: 'busy' }
    const llm = ctx.get('llm')
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

  /** 把抽取结果写进配置指定的作用域。 */
  async function applyDistilled(session, items) {
    const root = workspaceRootOf({ session })
    const targets = []
    if (cfg.autoDistill === 'workspace' || cfg.autoDistill === 'both') {
      const dir = workspaceDirOf(root)
      if (dir !== undefined) targets.push({ dir, title: titleFor(dir), root })
    }
    if (cfg.autoDistill === 'global' || cfg.autoDistill === 'both') {
      targets.push({ dir: globalDir, title: globalTitle, root: undefined })
    }
    if (targets.length === 0) return { skipped: 'no-target' }
    const source = { sessionId: String(session?.id ?? ''), at: Date.now(), via: 'auto-distill' }
    let saved = 0
    for (const target of targets) {
      for (const item of items) {
        await writeEntry(target, { kind: item.kind, text: item.text, tags: ['auto'], source }, target.root)
        saved += 1
      }
    }
    log(`auto-distill saved ${saved} entr${saved === 1 ? 'y' : 'ies'}`)
    return { saved }
  }

  // --- 全局晋升：项目记忆进化成用户全局记忆 --------------------------------

  /** 晋升账本缓存；key 是记忆文本的归一化形式。 */
  let ledgerCache

  /** 读晋升账本；文件不存在时返回空账本。 */
  async function loadLedger() {
    if (ledgerCache !== undefined) return ledgerCache
    const parsed = await readJson(join(globalDir, PROMOTION_LEDGER_FILE), undefined)
    const entries =
      parsed !== null && typeof parsed === 'object' && parsed.entries !== null && typeof parsed.entries === 'object'
        ? parsed.entries
        : {}
    ledgerCache = { version: STORE_VERSION, entries }
    return ledgerCache
  }

  /**
   * 把晋升账本落盘。
   * 每写一条项目记忆就登记一个候选，所以账本会随使用时间无限增长；
   * 超过 `promotionLedgerMax` 时按「已晋升优先、其次最近出现」保留，其余丢弃。
   */
  async function saveLedger() {
    const ledger = await loadLedger()
    const records = Object.values(ledger.entries)
    if (records.length > cfg.promotionLedgerMax) {
      const kept = records
        .sort(
          (a, b) =>
            (b.promoted === true ? 1 : 0) - (a.promoted === true ? 1 : 0) ||
            (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
        )
        .slice(0, cfg.promotionLedgerMax)
      ledger.entries = Object.fromEntries(kept.map((record) => [record.key, record]))
      log(`promotion ledger trimmed to ${kept.length} records`)
    }
    await mkdir(globalDir, { recursive: true })
    await writeJsonAtomic(join(globalDir, PROMOTION_LEDGER_FILE), {
      version: STORE_VERSION,
      updatedAt: Date.now(),
      entries: ledger.entries,
    })
  }

  /** 把一条账本记录写进全局记忆，并标记它已晋升。 */
  async function promoteToGlobal(record) {
    await addEntry(
      globalDir,
      globalTitle,
      {
        kind: record.kind,
        text: record.text,
        tags: ['promoted'],
        source: { at: Date.now(), via: 'promotion', workspaces: record.workspaces },
      },
      cfg,
    )
    record.promoted = true
    record.promotedAt = Date.now()
  }

  /**
   * 项目记忆写入后的账本登记：同一条文本在多个不同工作区都出现过，就晋升为全局记忆。
   * 判据选「跨工作区复现」的理由是：只属于某个项目的信息不会被写进别的项目。
   * @returns 本次触发晋升时返回账本记录，否则返回 undefined。
   */
  async function noteWorkspaceWrite(root, payload) {
    if (!cfg.promoteEnabled) return undefined
    if (typeof root !== 'string' || root === '') return undefined
    const text = String(payload.text).replace(/\s+/g, ' ').trim()
    const key = normalizeText(text)
    if (key === '') return undefined
    return withLock(`ledger:${globalDir}`, async () => {
      const ledger = await loadLedger()
      const now = Date.now()
      const record = ledger.entries[key] ?? {
        key,
        kind: payload.kind,
        text,
        workspaces: [],
        firstSeen: now,
        promoted: false,
      }
      record.kind = payload.kind
      record.text = text
      if (!record.workspaces.includes(root)) record.workspaces.push(root)
      record.lastSeen = now
      let promoted
      if (!record.promoted && record.workspaces.length >= cfg.promoteAfterWorkspaces) {
        await promoteToGlobal(record)
        promoted = record
        log(`promoted to global (seen in ${record.workspaces.length} workspaces): ${text}`)
      }
      ledger.entries[key] = record
      await saveLedger()
      return promoted
    })
  }

  /** 按 move 语义把一条已晋升的文本从所有登记过的工作区里移除。 */
  async function removeFromWorkspaces(record) {
    for (const wsRoot of record.workspaces ?? []) {
      const wsDir = workspaceDirOf(wsRoot)
      if (wsDir === undefined) continue
      await forgetEntries(
        wsDir,
        titleFor(wsDir),
        (entry) => entry.kind === record.kind && normalizeText(entry.text) === normalizeText(record.text),
        cfg,
      )
    }
  }

  /**
   * 所有记忆写入的统一入口：先落盘，再决定是否登记晋升候选。
   * @param target - resolveTarget 的结果，含 dir/title。
   * @param payload - addEntry 的入参。
   * @param root - 该写入所属的工作区根目录；全局写入传 undefined。
   */
  async function writeEntry(target, payload, root) {
    const result = await addEntry(target.dir, target.title, payload, cfg)
    if (target.dir !== globalDir) {
      try {
        const promoted = await noteWorkspaceWrite(root, payload)
        if (promoted !== undefined && cfg.promoteMode === 'move') await removeFromWorkspaces(promoted)
      } catch (error) {
        log(`promotion bookkeeping failed: ${textOf(error)}`)
      }
    }
    return result
  }

  /** 晋升账本的统计，供工具与设置页展示。 */
  async function promotionStats() {
    const ledger = await loadLedger()
    const records = Object.values(ledger.entries)
    return {
      candidates: records.length,
      promoted: records.filter((record) => record.promoted === true).length,
      records,
    }
  }

  // --- 模型侧工具 ---------------------------------------------------------

  /** 解析条目输出形状。 */
  function entryView(entry, scope, dir, archived) {
    return {
      id: entry.id,
      scope,
      kind: entry.kind,
      text: entry.text,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
      dir,
      archived: archived === true,
    }
  }

  /** 公共条目输出 schema 片段。 */
  const ENTRY_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'Stable memory id.' },
      scope: { type: 'string', enum: SCOPES, description: 'Which memory this entry belongs to.' },
      kind: { type: 'string', enum: KINDS, description: 'Memory category.' },
      text: { type: 'string', description: 'The remembered statement.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      updatedAt: { type: 'number', description: 'Epoch milliseconds of the last update.' },
      dir: { type: 'string', description: 'Directory holding the entry, empty when unknown.' },
      archived: { type: 'boolean', description: 'True when the entry lives in an archived shard.' },
    },
    required: ['id', 'scope', 'kind', 'text', 'tags', 'updatedAt', 'dir', 'archived'],
  }

  /** 把一次调用解析成 (scope, dir, title)。 */
  function resolveTarget(agent, scope) {
    if (scope === 'global') return { scope, dir: globalDir, title: globalTitle, root: undefined }
    const root = agent === undefined ? undefined : workspaceRootOf(agent)
    const dir = workspaceDirOf(root)
    if (dir === undefined) {
      throw new Error(
        'scope "workspace" needs a session working directory, and none is available; pass scope "global" instead',
      )
    }
    return { scope, dir, title: titleFor(dir), root }
  }

  /** 收集当前可见的 store 列表。 */
  function visibleScopes(agent, requested) {
    const list = []
    if (requested === undefined || requested === 'global') {
      list.push({ scope: 'global', dir: globalDir, store: storeOf(globalDir) })
    }
    if (requested === undefined || requested === 'workspace') {
      const root = agent === undefined ? undefined : workspaceRootOf(agent)
      const dir = workspaceDirOf(root)
      if (dir !== undefined) list.push({ scope: 'workspace', dir, store: storeOf(dir) })
    }
    return list
  }

  /** 校验 kind 取值。 */
  function requireKind(value) {
    if (typeof value !== 'string' || !KINDS.includes(value)) {
      throw new Error(`kind must be one of ${KINDS.join('/')}; got ${JSON.stringify(value)}`)
    }
    return value
  }

  /** 校验 scope 取值。 */
  function requireScope(value) {
    if (typeof value !== 'string' || !SCOPES.includes(value)) {
      throw new Error(`scope must be one of ${SCOPES.join('/')}; got ${JSON.stringify(value)}`)
    }
    return value
  }

  /** 校验字符串参数。 */
  function requireText(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${field} must be a non-empty string`)
    }
    return value
  }

  /** 校验标签数组。 */
  function optionalTags(value) {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) throw new Error('tags must be an array of strings')
    return value.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim())
  }

  /** 需要 agent 上下文的工具调用统一从这里取 agent。 */
  function requireAgent(exec) {
    if (exec?.agent === undefined) throw new Error(`${name} tools require an agent Session`)
    return exec.agent
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_write',
      description:
        'Record one durable memory entry: a fact, a user preference, a relationship, or a follow-up. Use scope "global" for things about the user that hold across every workspace, and scope "workspace" for things about the current project. Recording the same text twice updates the existing entry instead of duplicating it.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: SCOPES,
            description: 'global = user memory; workspace = current project memory (.dshmem).',
          },
          kind: {
            type: 'string',
            enum: KINDS,
            description:
              'fact (stable information) | preference (habits and tastes) | relationship (people and roles) | followup (things to revisit).',
          },
          text: {
            type: 'string',
            description: 'The memory as one self-contained sentence, written so it still makes sense later.',
          },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
        },
        required: ['scope', 'kind', 'text'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Id of the created or updated entry.' },
            scope: { type: 'string', enum: SCOPES },
            kind: { type: 'string', enum: KINDS },
            deduped: { type: 'boolean', description: 'True when an identical entry already existed.' },
            total: { type: 'integer', description: 'Entries now held by the active area of that store.' },
            dir: { type: 'string', description: 'Directory of the store that changed.' },
          },
          required: ['id', 'scope', 'kind', 'deduped', 'total', 'dir'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.deduped
              ? `Memory ${value.id} already existed; updated it in ${value.dir} (${value.total} active entries).`
              : `Saved memory ${value.id} in ${value.dir} (${value.total} active entries).`,
          },
        ],
      },
      async execute(args, exec) {
        if (!memoryOn()) throw new Error('memory is disabled; run /memory on to enable it')
        const agent = requireAgent(exec)
        const scope = requireScope(args?.scope)
        const kind = requireKind(args?.kind)
        const text = requireText(args?.text, 'text')
        const target = resolveTarget(agent, scope)
        const result = await writeEntry(
          target,
          { kind, text, tags: optionalTags(args?.tags), source: { sessionId: String(agent.id), at: Date.now() } },
          target.root,
        )
        return { id: result.id, scope, kind, deduped: result.deduped, total: result.total, dir: target.dir }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_search',
      description:
        'Search recorded memories by keywords. Every whitespace-separated term must appear in the text, kind, or tags. The search covers the active area and the archived shards. Omit query to list the most recently updated entries.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Whitespace-separated keywords; omit to list recent entries.' },
          scope: { type: 'string', enum: SCOPES, description: 'Limit the search to one scope; omit for both.' },
          kind: { type: 'string', enum: KINDS, description: 'Limit the search to one category.' },
          limit: { type: 'integer', description: 'Maximum entries to return; default 20.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entries: { type: 'array', items: ENTRY_SCHEMA },
            total: { type: 'integer', description: 'Entries matching across the searched scopes.' },
            returned: { type: 'integer', description: 'Entries actually returned.' },
            scannedShards: { type: 'integer', description: 'Archived shard files read during this search.' },
          },
          required: ['entries', 'total', 'returned', 'scannedShards'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.returned === 0
                ? 'No memory entry matched.'
                : value.entries
                    .map(
                      (entry) =>
                        `[${entry.scope}/${entry.kind}${entry.archived ? '/archived' : ''}] ${entry.id}: ${entry.text}`,
                    )
                    .join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        const agent = requireAgent(exec)
        const scope = args?.scope === undefined ? undefined : requireScope(args.scope)
        const kind = args?.kind === undefined ? undefined : requireKind(args.kind)
        const { hits, total, limit, scannedShards } = await searchAcross(
          visibleScopes(agent, scope),
          { query: args?.query, kind, limit: args?.limit },
          cfg,
        )
        const entries = hits
          .slice(0, limit)
          .map(({ entry, scope: hitScope, dir, archived }) => entryView(entry, hitScope, dir, archived))
        return { entries, total, returned: entries.length, scannedShards }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_forget',
      description:
        'Delete recorded memories from the active area. Pass id to delete one exact entry, or query to delete every entry whose text, kind, or tags contain all the given keywords. At least one of id and query is required, so an accidental call can never wipe a whole store.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact entry id to delete.' },
          query: { type: 'string', description: 'Keywords; every term must match for an entry to be deleted.' },
          scope: { type: 'string', enum: SCOPES, description: 'Limit the deletion to one scope; omit for both.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { removed: { type: 'array', items: ENTRY_SCHEMA } },
          required: ['removed'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.removed.length === 0
                ? 'Nothing matched, so nothing was deleted.'
                : `Deleted ${value.removed.length} entr${value.removed.length === 1 ? 'y' : 'ies'}:\n${value.removed
                    .map((entry) => `[${entry.scope}] ${entry.id}: ${entry.text}`)
                    .join('\n')}`,
          },
        ],
      },
      async execute(args, exec) {
        if (!memoryOn()) throw new Error('memory is disabled; run /memory on to enable it')
        const agent = requireAgent(exec)
        const id = typeof args?.id === 'string' && args.id !== '' ? args.id : undefined
        const query = typeof args?.query === 'string' && args.query.trim() !== '' ? args.query : undefined
        if (id === undefined && query === undefined) {
          throw new Error('memory_forget requires either id or query')
        }
        const scope = args?.scope === undefined ? undefined : requireScope(args.scope)
        const terms = query === undefined ? [] : query.toLowerCase().split(/\s+/).filter((t) => t !== '')
        const removed = []
        for (const { scope: hitScope, dir, store } of visibleScopes(agent, scope)) {
          if (store === undefined) continue
          const victims = await forgetEntries(
            dir,
            titleFor(dir),
            (entry) => (id !== undefined ? entry.id === id : matchesQuery(entry, terms)),
            cfg,
          )
          for (const entry of victims) removed.push(entryView(entry, hitScope, dir, false))
        }
        return { removed }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'memory_status',
      description:
        'Report where the memory stores live, how many active and archived entries each holds, and whether memory recording and auto-distillation are enabled.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            configEnabled: { type: 'boolean' },
            globalDir: { type: 'string' },
            globalCount: { type: 'integer' },
            globalShards: { type: 'integer' },
            workspaceRoot: { type: 'string', description: 'Empty when no working directory is known.' },
            workspaceDir: { type: 'string', description: 'Empty when no working directory is known.' },
            workspaceCount: { type: 'integer' },
            workspaceShards: { type: 'integer' },
            workspaceActiveDate: { type: 'string' },
            journal: { type: 'boolean' },
            autoDistill: { type: 'string', enum: DISTILL_SCOPES },
            scope: { type: 'string', enum: INJECT_SCOPES },
            promotionCandidates: { type: 'integer', description: 'Entries tracked by the global promotion ledger.' },
            promotionPromoted: { type: 'integer', description: 'Ledger records already promoted to global memory.' },
            promoteAfterWorkspaces: { type: 'integer', description: 'Distinct workspaces required before promotion.' },
          },
          required: [
            'enabled',
            'configEnabled',
            'globalDir',
            'globalCount',
            'globalShards',
            'workspaceRoot',
            'workspaceDir',
            'workspaceCount',
            'workspaceShards',
            'workspaceActiveDate',
            'journal',
            'autoDistill',
            'scope',
            'promotionCandidates',
            'promotionPromoted',
            'promoteAfterWorkspaces',
          ],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `memory enabled: ${value.enabled} (config enabled: ${value.configEnabled})`,
              `global: ${value.globalDir} (${value.globalCount} active, ${value.globalShards} shards)`,
              `workspace: ${value.workspaceDir === '' ? '(unknown)' : value.workspaceDir} (${value.workspaceCount} active, ${value.workspaceShards} shards, active date ${value.workspaceActiveDate})`,
              `inject scope: ${value.scope}; auto distill: ${value.autoDistill}; turn journal: ${value.journal}`,
              `promotion ledger: ${value.promotionCandidates} candidate(s), ${value.promotionPromoted} promoted (threshold ${value.promoteAfterWorkspaces} workspaces)`,
            ].join('\n'),
          },
        ],
      },
      async execute(_args, exec) {
        const agent = requireAgent(exec)
        const globalStore = storeOf(globalDir)
        const root = workspaceRootOf(agent)
        const dir = workspaceDirOf(root)
        const wsStore = dir === undefined ? undefined : storeOf(dir)
        const promotions = await promotionStats()
        return {
          enabled: memoryOn(),
          configEnabled: cfg.enabled,
          globalDir,
          globalCount: globalStore === undefined ? 0 : globalStore.entries.length,
          globalShards: globalStore === undefined ? 0 : globalStore.shards.length,
          workspaceRoot: root === undefined ? '' : root,
          workspaceDir: dir === undefined ? '' : dir,
          workspaceCount: wsStore === undefined ? 0 : wsStore.entries.length,
          workspaceShards: wsStore === undefined ? 0 : wsStore.shards.length,
          workspaceActiveDate: wsStore === undefined ? '' : wsStore.activeDate,
          journal: cfg.journal,
          autoDistill: cfg.autoDistill,
          scope: cfg.scope,
          promotionCandidates: promotions.candidates,
          promotionPromoted: promotions.promoted,
          promoteAfterWorkspaces: cfg.promoteAfterWorkspaces,
        }
      },
    }),
  )

  // --- 7) 人类侧 /memory 命令 ----------------------------------------------

  /** 渲染 /memory show 的正文。 */
  function renderShow(agent) {
    const lines = []
    const globalStore = storeOf(globalDir)
    lines.push(`全局记忆 ${globalDir} —— 活动区 ${globalStore === undefined ? 0 : globalStore.entries.length} 条，分片 ${globalStore === undefined ? 0 : globalStore.shards.length} 个`)
    for (const entry of globalStore?.entries.slice(0, 50) ?? []) {
      lines.push(`  [${entry.kind}] ${entry.id}  ${entry.text}`)
    }
    const root = agent === undefined ? undefined : workspaceRootOf(agent)
    const dir = workspaceDirOf(root)
    if (dir === undefined) {
      lines.push('项目记忆：当前会话没有可用工作目录。')
    } else {
      const store = storeOf(dir)
      lines.push(`项目记忆 ${dir} —— 活动区 ${store === undefined ? 0 : store.entries.length} 条，分片 ${store === undefined ? 0 : store.shards.length} 个`)
      for (const entry of store?.entries.slice(0, 50) ?? []) {
        lines.push(`  [${entry.kind}] ${entry.id}  ${entry.text}`)
      }
    }
    if (cfg.journal && dir !== undefined) lines.push(`对话摘要：${join(dir, JOURNAL_DIR)}`)
    lines.push(`记忆状态：${memoryOn() ? '已开启' : '已关闭'}；自动沉淀：${cfg.autoDistill}；注入范围：${cfg.scope}`)
    return lines.join('\n')
  }

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
    '/memory path              显示各存储目录与设置页入口',
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

  ctx.effect(() =>
    ctx.commands.register({
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
              const root = agent === undefined ? undefined : workspaceRootOf(agent)
              const dir = workspaceDirOf(root)
              return {
                kind: 'success',
                text: [
                  `全局记忆目录：${globalDir}`,
                  `项目记忆目录：${dir === undefined ? '(当前会话没有可用工作目录)' : dir}`,
                  `对话摘要目录：${dir === undefined ? '(无)' : join(dir, JOURNAL_DIR)}`,
                  `状态文件：${statePath}`,
                  '设置页：设置 → 记忆',
                ].join('\n'),
              }
            }
            case 'on':
              await saveRuntimeState(true)
              return { kind: 'success', text: '记忆已开启。' }
            case 'off':
              await saveRuntimeState(false)
              return { kind: 'success', text: '记忆已关闭：不再注入记忆，也不再写对话摘要与自动沉淀。' }
            case 'shards': {
              const store = storeOf(globalDir)
              const root = agent === undefined ? undefined : workspaceRootOf(agent)
              const dir = workspaceDirOf(root)
              const lines = [
                `全局 ${globalDir}：活动区日期 ${store === undefined ? '?' : store.activeDate}，分片 ${store === undefined ? 0 : store.shards.length} 个`,
              ]
              for (const shard of store?.shards ?? []) lines.push(`  ${shard.file}  ${shard.date}  ${shard.count} 条`)
              if (dir !== undefined) {
                const wsStore = storeOf(dir)
                lines.push(`项目 ${dir}：活动区日期 ${wsStore === undefined ? '?' : wsStore.activeDate}，分片 ${wsStore === undefined ? 0 : wsStore.shards.length} 个`)
                for (const shard of wsStore?.shards ?? []) lines.push(`  ${shard.file}  ${shard.date}  ${shard.count} 条`)
              }
              return { kind: 'success', text: lines.join('\n') }
            }
            case 'distill': {
              const session = agent?.session
              if (session === undefined) return { kind: 'error', text: '当前会话不可用，无法沉淀。' }
              const result = await distillTurn(session, lastTurnOf(session))
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
                  : resolveTarget(agent, 'workspace')
              const result = await writeEntry(
                target,
                { kind, text, tags: [], source: { sessionId: agent === undefined ? '' : String(agent.id), at: Date.now(), via: 'command' } },
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
              for (const { dir, store } of visibleScopes(agent, undefined)) {
                if (store === undefined) continue
                const result = await updateEntry(dir, titleFor(dir), id, { text }, cfg)
                if (result.found) return { kind: 'success', text: `已改写 ${id}。` }
              }
              return { kind: 'error', text: `没有找到活动区里的 ${id}。` }
            }
            case 'promote': {
              const id = rest.trim()
              if (id === '') return { kind: 'error', text: `用法：/memory promote <项目记忆的 id>\n${COMMAND_HELP}` }
              const root = agent === undefined ? undefined : workspaceRootOf(agent)
              const dir = workspaceDirOf(root)
              if (dir === undefined) return { kind: 'error', text: '当前会话没有可用工作目录。' }
              const entry = storeOf(dir)?.entries.find((item) => item.id === id)
              if (entry === undefined) return { kind: 'error', text: `项目记忆活动区里没有 ${id}。` }
              const ledger = await loadLedger()
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
              await promoteToGlobal(record)
              ledger.entries[key] = record
              await saveLedger()
              if (cfg.promoteMode === 'move') await removeFromWorkspaces(record)
              return {
                kind: 'success',
                text: `已把 ${id} 晋升为全局记忆${cfg.promoteMode === 'move' ? '，并从项目记忆里移除' : '，项目记忆里保留副本'}。`,
              }
            }
            case 'promotions': {
              const stats = await promotionStats()
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
                  : visibleScopes(agent, undefined)
              const terms = needle.toLowerCase().split(/\s+/).filter((t) => t !== '')
              let removed = 0
              for (const { dir, store } of scopesList) {
                if (store === undefined) continue
                const victims = await forgetEntries(
                  dir,
                  titleFor(dir),
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
    }),
  )

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

  // --- 8) 设置页的后端接口（写给 Client 半用的 HTTP 路由） ------------------

  /** 汇总设置页需要的数据。调用前应先 await loadLedger() 以便带上晋升统计。 */
  function settingsSummary() {
    const globalStore = storeOf(globalDir)
    const records = ledgerCache === undefined ? [] : Object.values(ledgerCache.entries)
    return {
      ok: true,
      enabled: memoryOn(),
      configEnabled: cfg.enabled,
      globalDir,
      activeDate: globalStore === undefined ? '' : globalStore.activeDate,
      autoDistill: cfg.autoDistill,
      journal: cfg.journal,
      scope: cfg.scope,
      kinds: KINDS,
      entries: globalStore === undefined ? [] : globalStore.entries,
      shards: globalStore === undefined ? [] : globalStore.shards,
      promotions: {
        candidates: records.length,
        promoted: records.filter((record) => record.promoted === true).length,
        threshold: cfg.promoteAfterWorkspaces,
        mode: cfg.promoteMode,
      },
    }
  }

  /** 读请求体里的 JSON；空体返回 {}，非法 JSON 返回 null。 */
  async function readJsonBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return null
    }
  }

  /** 回一个 JSON 响应。 */
  function sendJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  /** 设置页的服务端操作：一律只作用于全局记忆。 */
  const httpRoutes = [
    {
      path: `${HTTP_PREFIX}/summary`,
      handler: async (_req, res) => {
        await loadLedger().catch(() => undefined)
        sendJson(res, 200, settingsSummary())
      },
    },
    {
      path: `${HTTP_PREFIX}/toggle`,
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        if (body === null || typeof body.enabled !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'enabled must be a boolean' })
          return
        }
        await saveRuntimeState(body.enabled)
        sendJson(res, 200, settingsSummary())
      },
    },
    {
      path: `${HTTP_PREFIX}/add`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          if (body === null) {
            sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const kind = requireKind(body.kind)
          const text = requireText(body.text, 'text')
          const result = await addEntry(
            globalDir,
            globalTitle,
            { kind, text, tags: optionalTags(body.tags), source: { at: Date.now(), via: 'settings' } },
            cfg,
          )
          sendJson(res, 200, { ...settingsSummary(), added: result })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: textOf(error) })
        }
      },
    },
    {
      path: `${HTTP_PREFIX}/update`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          if (body === null || typeof body.id !== 'string') {
            sendJson(res, 400, { ok: false, error: 'id is required' })
            return
          }
          const patch = {}
          if (body.kind !== undefined) patch.kind = requireKind(body.kind)
          if (body.text !== undefined) patch.text = requireText(body.text, 'text')
          if (body.tags !== undefined) patch.tags = optionalTags(body.tags)
          const result = await updateEntry(globalDir, globalTitle, body.id, patch, cfg)
          if (!result.found) {
            sendJson(res, 404, { ok: false, error: 'no such entry in the global store' })
            return
          }
          sendJson(res, 200, settingsSummary())
        } catch (error) {
          sendJson(res, 400, { ok: false, error: textOf(error) })
        }
      },
    },
    {
      path: `${HTTP_PREFIX}/delete`,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          if (body === null || typeof body.id !== 'string' || body.id === '') {
            sendJson(res, 400, { ok: false, error: 'id is required' })
            return
          }
          const removed = await forgetEntries(globalDir, globalTitle, (entry) => entry.id === body.id, cfg)
          sendJson(res, 200, { ...settingsSummary(), removed: removed.length })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: textOf(error) })
        }
      },
    },
  ]

  /** 注册全部设置页路由。 */
  function mountRoutes(webServer, effect) {
    for (const route of httpRoutes) {
      effect(() => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
    }
    log(`settings API mounted at ${HTTP_PREFIX}/*`)
  }

  try {
    ctx.inject(['webServer'], (webCtx) => {
      mountRoutes(webCtx.webServer, (fn) => webCtx.effect(fn))
    })
  } catch (error) {
    log(`ctx.inject failed, falling back to ctx.get: ${textOf(error)}`)
    try {
      const webServer = ctx.get('webServer')
      if (webServer !== undefined && typeof webServer.register === 'function') {
        mountRoutes(webServer, (fn) => ctx.effect(fn))
      } else {
        log('webServer is unavailable; the settings page has no backend')
      }
    } catch (inner) {
      log(`webServer registration failed: ${textOf(inner)}`)
    }
  }

  // --- 9) 启动预热 ---------------------------------------------------------

  void loadRuntimeState()
    .then(() => loadStore(globalDir))
    .then(() => {
      log(
        `ready: global=${globalDir} workspaceDirName=${cfg.workspaceDirName} enabled=${memoryOn()} autoDistill=${cfg.autoDistill}`,
      )
    })
    .catch((error) => log(`startup failed: ${textOf(error)}`))
}
