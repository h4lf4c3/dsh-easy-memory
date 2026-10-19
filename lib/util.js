/**
 * 小工具：日志、取值校验、文本处理、时间格式、原子读写与串行锁。
 *
 * 这些函数只依赖 Node 内置模块与常量，不接触宿主上下文，
 * 因此可以被偏好/存储/提示词/命令等所有模块共用。
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { KINDS, TAG } from './constants.js'

/** 输出一行宿主日志。 */
export function log(...args) {
  console.error(TAG, ...args)
}

/** 把任意异常压成一行可读文本。 */
export function textOf(error) {
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
export function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 只保留布尔值，否则回退默认值。 */
export function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 只保留枚举内的字符串，否则回退默认值。 */
export function enumOr(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** 计算 DSH 主目录；与宿主注入的 DSH_HOME 保持一致。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 把 ContentBlock 数组压成纯文本。 */
export function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 截断长文本，并在截断处标注。 */
export function clip(text, limit) {
  if (typeof text !== 'string') return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`
}

/** 记忆文本的归一化形式，用于去重与匹配。 */
export function normalizeText(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 时间戳的 ISO 形字符串。 */
export function isoOf(time) {
  const value = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
  try {
    return new Date(value).toISOString()
  } catch {
    return 'unknown'
  }
}

/** 本地日期，用作分片与 journal 的日期键。 */
export function dateStamp(time) {
  const value = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 判断一个已解析对象是不是记忆条目。 */
export function isEntry(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    KINDS.includes(value.kind)
  )
}

/** 判断一个已解析对象是不是分片索引记录。 */
export function isShard(value) {
  return value !== null && typeof value === 'object' && typeof value.file === 'string'
}

/** 原子写 JSON：先写临时文件再改名，改名失败则退回直接覆盖。 */
export async function writeJsonAtomic(file, value) {
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
export async function readJson(file, fallback) {
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
export function withLock(key, fn) {
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
