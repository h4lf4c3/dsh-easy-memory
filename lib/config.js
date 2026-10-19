/**
 * 配置归一化：把 profile patch 里的松散 config 收敛成插件内部使用的强类型对象。
 */

import { DEFAULTS, DISTILL_SCOPES, INJECT_SCOPES, PROMOTE_MODES } from './constants.js'
import { boolOr, enumOr, positiveInt } from './util.js'

/** 合并用户配置与默认值。 */
export function normalizeConfig(raw) {
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
