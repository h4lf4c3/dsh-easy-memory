/**
 * 记忆面板的后端接口：Client 半只认识同源 HTTP 路由，不认识宿主对象。
 *
 * 路由挂在 /dsh-easy-memory/* 下，一律只作用于全局记忆；项目记忆仍由
 * /memory 命令与 memory_* 工具维护。
 */

import { KINDS, HTTP_PREFIX } from './constants.js'
import { optionalTags, requireKind, requireText } from './entry.js'
import { addEntry, forgetEntries, storeOf, updateEntry } from './store.js'
import { textOf } from './util.js'

/** 汇总记忆面板需要的数据。调用前应先 await loadLedger() 以便带上晋升统计。 */
export async function settingsSummary(rt) {
  const { cfg, globalDir } = rt
  const globalStore = storeOf(globalDir)
  const ledger = await rt.loadLedger().catch(() => ({ entries: {} }))
  const records = Object.values(ledger.entries ?? {})
  return {
    ok: true,
    enabled: rt.memoryOn(),
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

/** 构造记忆面板的全部路由。 */
export function memoryRoutes(rt) {
  const { cfg, globalDir, globalTitle } = rt
  return [
    {
      path: `${HTTP_PREFIX}/summary`,
      handler: async (_req, res) => {
        await rt.loadLedger().catch(() => undefined)
        sendJson(res, 200, await settingsSummary(rt))
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
        await rt.saveRuntimeState(body.enabled)
        sendJson(res, 200, await settingsSummary(rt))
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
          sendJson(res, 200, { ...(await settingsSummary(rt)), added: result })
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
          sendJson(res, 200, await settingsSummary(rt))
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
          sendJson(res, 200, { ...(await settingsSummary(rt)), removed: removed.length })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: textOf(error) })
        }
      },
    },
  ]
}

/** 注册全部记忆面板路由；webServer 缺失时只跳过面板接口。 */
export function mountMemoryRoutes(rt) {
  const register = (webServer, effect) => {
    for (const route of memoryRoutes(rt)) {
      effect(() => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
    }
    rt.log(`memory panel API mounted at ${HTTP_PREFIX}/*`)
  }
  try {
    rt.ctx.inject(['webServer'], (webCtx) => {
      register(webCtx.webServer, (fn) => webCtx.effect(fn))
    })
  } catch (error) {
    rt.log(`ctx.inject failed, falling back to ctx.get: ${textOf(error)}`)
    try {
      const webServer = rt.ctx.get('webServer')
      if (webServer !== undefined && typeof webServer.register === 'function') {
        register(webServer, (fn) => rt.ctx.effect(fn))
      } else {
        rt.log('webServer is unavailable; the memory panel has no backend')
      }
    } catch (inner) {
      rt.log(`webServer registration failed: ${textOf(inner)}`)
    }
  }
}
