/**
 * 全局晋升：项目记忆进化成用户全局记忆。
 *
 * 判据是「同一条文本在多个不同工作区都出现过」。账本（promotion.json）
 * 放在全局目录里，所以跨工作区共享；超过上限时按「已晋升优先、其次最近」
 * 保留。所有写记忆的入口都应走 writeEntry，才能顺带记账。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PROMOTION_LEDGER_FILE, STORE_VERSION } from './constants.js'
import { addEntry, forgetEntries } from './store.js'
import { log, normalizeText, readJson, textOf, withLock, writeJsonAtomic } from './util.js'

/**
 * 创建晋升账本的操作集合。
 * @param {object} rt - 需要 cfg、globalDir、globalTitle、workspaceDirOf、titleFor。
 */
export function createPromotion(rt) {
  const { cfg, globalDir, globalTitle } = rt

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
      const wsDir = rt.workspaceDirOf(wsRoot)
      if (wsDir === undefined) continue
      await forgetEntries(
        wsDir,
        rt.titleFor(wsDir),
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

  /** 晋升账本的统计，供工具与记忆面板展示。 */
  async function promotionStats() {
    const ledger = await loadLedger()
    const records = Object.values(ledger.entries)
    return {
      candidates: records.length,
      promoted: records.filter((record) => record.promoted === true).length,
      records,
    }
  }

  return {
    loadLedger,
    saveLedger,
    promoteToGlobal,
    noteWorkspaceWrite,
    removeFromWorkspaces,
    writeEntry,
    promotionStats,
  }
}
