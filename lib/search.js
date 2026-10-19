/**
 * 检索：主索引先搜，归档分片按需读取。
 */

import { positiveInt } from './util.js'
import { shardEntries } from './store.js'

/** 判断条目是否命中查询词（全部词都得命中，空查询命中一切）。 */
export function matchesQuery(entry, terms) {
  if (terms.length === 0) return true
  const haystack = `${entry.text} ${entry.kind} ${Array.isArray(entry.tags) ? entry.tags.join(' ') : ''}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/**
 * 在若干 store 上做检索：先搜主索引，再按需读最近的分片。
 * @returns {Promise<{hits: Array, total: number, limit: number, scannedShards: number}>}
 */
export async function searchAcross(scopesList, options, cfg) {
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
    const recent = store.shards
      .slice()
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, cfg.searchShards)
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
