/**
 * 常量：目录/文件名、分类、枚举、默认配置与提示词。
 *
 * 这里是整个插件唯一的「字面量集中地」；其余模块只引用这些名字，
 * 不再各自重复写字符串。
 */

/** 插件日志前缀。 */
export const TAG = '[dsh-easy-memory]'

/** 记忆条目的四个分类，与 WorkBuddy 文档列出的抽取范围一一对应。 */
export const KINDS = ['fact', 'preference', 'relationship', 'followup']

/** 分类的中文标签，用于生成人类可读的 memory.md 与记忆面板。 */
export const KIND_LABELS = {
  fact: '事实信息',
  preference: '偏好习惯',
  relationship: '人物关系',
  followup: '跟进事项',
}

/** 作用域取值。 */
export const SCOPES = ['global', 'workspace']

/** 注入范围取值。 */
export const INJECT_SCOPES = ['both', 'global', 'workspace']

/** 自动沉淀的目标作用域取值。 */
export const DISTILL_SCOPES = ['workspace', 'global', 'both', 'off']

/** system-prompt section 的名字；agent 作用域下注册同名 section 会遮蔽全局那条。 */
export const SECTION_NAME = 'easy-memory'

/** 主索引文件名。 */
export const MEMORY_FILE = 'memory.json'
/** 人类可读视图文件名。 */
export const VIEW_FILE = 'memory.md'
/** 运行期开关文件名。 */
export const STATE_FILE = 'state.json'
/** 全局晋升账本文件名；放在全局记忆目录里，所以跨工作区共享。 */
export const PROMOTION_LEDGER_FILE = 'promotion.json'
/** 晋升模式取值：move 把条目搬进全局，copy 则在两边各留一份。 */
export const PROMOTE_MODES = ['move', 'copy']
/** 分片目录名。 */
export const SHARD_DIR = 'shards'
/** 对话摘要目录名。 */
export const JOURNAL_DIR = 'journal'
/** 存储格式版本。 */
export const STORE_VERSION = 2

/** 记忆面板使用的 HTTP 前缀。 */
export const HTTP_PREFIX = '/dsh-easy-memory'

/** 自动沉淀的提示词。 */
export const DISTILL_SYSTEM = [
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
export const DEFAULTS = {
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
