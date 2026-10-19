/**
 * 模型侧工具：memory_write / memory_search / memory_forget / memory_status。
 *
 * 工具定义直接书写 Harness 强制的 JSON Schema 子集，不导入 defineTool：
 * 插件安装在 profile 的 node_modules 下，不能假定宿主安装目录的
 * `@deepseek-ai/*` 包对其可解析，所以每个 execute 自行校验参数。
 */

import { DISTILL_SCOPES, INJECT_SCOPES, KINDS, SCOPES } from './constants.js'
import { ENTRY_SCHEMA, entryView, requireAgent, requireKind, requireScope, requireText, optionalTags, resolveTarget, visibleScopes } from './entry.js'
import { searchAcross, matchesQuery } from './search.js'
import { forgetEntries } from './store.js'

/**
 * 注册四个记忆工具。
 * @param {object} rt - ctx、cfg、memoryOn、writeEntry、promotionStats、
 *   globalDir、titleFor、workspaceRootOf、workspaceDirOf、storeOf。
 */
export function registerTools(rt) {
  const { ctx, cfg } = rt

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
        if (!rt.memoryOn()) throw new Error('memory is disabled; run /memory on to enable it')
        const agent = requireAgent(exec)
        const scope = requireScope(args?.scope)
        const kind = requireKind(args?.kind)
        const text = requireText(args?.text, 'text')
        const target = resolveTarget(rt, agent, scope)
        const result = await rt.writeEntry(
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
          visibleScopes(rt, agent, scope),
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
        if (!rt.memoryOn()) throw new Error('memory is disabled; run /memory on to enable it')
        const agent = requireAgent(exec)
        const id = typeof args?.id === 'string' && args.id !== '' ? args.id : undefined
        const query = typeof args?.query === 'string' && args.query.trim() !== '' ? args.query : undefined
        if (id === undefined && query === undefined) {
          throw new Error('memory_forget requires either id or query')
        }
        const scope = args?.scope === undefined ? undefined : requireScope(args.scope)
        const terms = query === undefined ? [] : query.toLowerCase().split(/\s+/).filter((t) => t !== '')
        const removed = []
        for (const { scope: hitScope, dir, store } of visibleScopes(rt, agent, scope)) {
          if (store === undefined) continue
          const victims = await forgetEntries(
            dir,
            rt.titleFor(dir),
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
        const globalStore = rt.storeOf(rt.globalDir)
        const root = rt.workspaceRootOf(agent)
        const dir = rt.workspaceDirOf(root)
        const wsStore = dir === undefined ? undefined : rt.storeOf(dir)
        const promotions = await rt.promotionStats()
        return {
          enabled: rt.memoryOn(),
          configEnabled: cfg.enabled,
          globalDir: rt.globalDir,
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
}
