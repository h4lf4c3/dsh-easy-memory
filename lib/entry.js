/**
 * 条目视图与参数校验：工具、命令、HTTP 三个入口共用同一套规则。
 */

import { KINDS, SCOPES } from './constants.js'

/** 一条记忆在工具输出里的统一形状。 */
export function entryView(entry, scope, dir, archived) {
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
export const ENTRY_SCHEMA = {
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

/** 校验 kind 取值。 */
export function requireKind(value) {
  if (typeof value !== 'string' || !KINDS.includes(value)) {
    throw new Error(`kind must be one of ${KINDS.join('/')}; got ${JSON.stringify(value)}`)
  }
  return value
}

/** 校验 scope 取值。 */
export function requireScope(value) {
  if (typeof value !== 'string' || !SCOPES.includes(value)) {
    throw new Error(`scope must be one of ${SCOPES.join('/')}; got ${JSON.stringify(value)}`)
  }
  return value
}

/** 校验字符串参数。 */
export function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

/** 校验标签数组。 */
export function optionalTags(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('tags must be an array of strings')
  return value.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim())
}

/** 需要 agent 上下文的调用统一从这里取 agent。 */
export function requireAgent(exec) {
  if (exec?.agent === undefined) throw new Error('memory tools require an agent Session')
  return exec.agent
}

/** 把一次调用解析成 (scope, dir, title)。 */
export function resolveTarget(rt, agent, scope) {
  if (scope === 'global') return { scope, dir: rt.globalDir, title: rt.globalTitle, root: undefined }
  const root = agent === undefined ? undefined : rt.workspaceRootOf(agent)
  const dir = rt.workspaceDirOf(root)
  if (dir === undefined) {
    throw new Error(
      'scope "workspace" needs a session working directory, and none is available; pass scope "global" instead',
    )
  }
  return { scope, dir, title: rt.titleFor(dir), root }
}

/** 收集当前可见的 store 列表。 */
export function visibleScopes(rt, agent, requested) {
  const list = []
  if (requested === undefined || requested === 'global') {
    list.push({ scope: 'global', dir: rt.globalDir, store: rt.storeOf(rt.globalDir) })
  }
  if (requested === undefined || requested === 'workspace') {
    const root = agent === undefined ? undefined : rt.workspaceRootOf(agent)
    const dir = rt.workspaceDirOf(root)
    if (dir !== undefined) list.push({ scope: 'workspace', dir, store: rt.storeOf(dir) })
  }
  return list
}
