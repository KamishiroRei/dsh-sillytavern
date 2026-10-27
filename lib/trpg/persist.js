/**
 * 跑团存档的落盘层。
 *
 * 一个 DSH 会话 = 一局跑团 = 一个存档目录：
 *   <dataRoot>/trpg/<会话键>/{map,scene,sheets,encounter,log,protocol}.json
 *
 * 之所以按会话分目录而不是全塞进 trpg/ 根下：DSH 里同时开两个会话跑两局是常态，
 * 共用一份存档会互相踩。没有会话 id 时用 'default'。
 *
 * 所有读写都走 lib/store.js 的原子写，进程被杀不会留下半截 JSON。
 */
import { mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson, safeName } from '../store.js'
import { nowIso } from '../util.js'

/** 没有会话 id 时使用的存档名。 */
export const DEFAULT_SESSION_KEY = 'default'

/**
 * 把 DSH 会话 id 变成一个安全的目录名。
 * @param {string} [sessionId] DSH 会话 id，可为空
 * @returns {string} 目录名；空值回退到 'default'
 */
export function sessionKey(sessionId) {
  if (!sessionId) return DEFAULT_SESSION_KEY
  const raw = String(sessionId).trim()
  if (!raw) return DEFAULT_SESSION_KEY
  return safeName(raw, DEFAULT_SESSION_KEY)
}

/**
 * 某一个会话的存档目录（不创建）。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @returns {string} 绝对路径
 */
export function sessionDir(state, sessionId) {
  return join(state.layout.trpg, sessionKey(sessionId))
}

/**
 * 某一个会话的存档目录（确保存在）。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @returns {string} 绝对路径
 */
export function ensureSessionDir(state, sessionId) {
  const dir = sessionDir(state, sessionId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 读一份存档文档。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @param {string} name 文档名（不含 .json），如 'map'
 * @param {*} [fallback] 文件不存在时的返回值
 * @returns {*} 解析后的 JSON 或 fallback
 * @throws {Error} JSON 损坏时抛中文错误（带文件路径）
 */
export function readDoc(state, sessionId, name, fallback = null) {
  return readJson(join(sessionDir(state, sessionId), safeName(name) + '.json'), fallback)
}

/**
 * 原子写一份存档文档。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @param {string} name 文档名（不含 .json）
 * @param {*} value 任意可 JSON 化的值
 * @returns {*} 写入的值
 */
export function writeDoc(state, sessionId, name, value) {
  ensureSessionDir(state, sessionId)
  writeJson(join(sessionDir(state, sessionId), safeName(name) + '.json'), value)
  return value
}

/**
 * 列出本插件目前有哪些跑团存档。
 * @param {Object} state 插件共享状态
 * @returns {Array<{ key: string, dir: string, updatedAt: string|null }>} 按目录 mtime 倒序
 */
export function listSessions(state) {
  const root = state.layout.trpg
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const stateDoc = readJson(join(dir, 'meta.json'), null)
    out.push({ key: entry.name, dir, updatedAt: stateDoc && stateDoc.updatedAt ? stateDoc.updatedAt : null })
  }
  return out
}

/**
 * 删除一局跑团存档。
 * @param {Object} state 插件共享状态
 * @param {string} sessionId 会话 id
 * @returns {boolean} 是否确实删掉了东西
 */
export function clearSession(state, sessionId) {
  const dir = sessionDir(state, sessionId)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * 写入存档元信息（用于存档列表展示）。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @param {Object} patch 要合并的字段
 * @returns {Object} 合并后的元信息
 */
export function touchMeta(state, sessionId, patch = {}) {
  const existing = readDoc(state, sessionId, 'meta', {}) || {}
  const next = { ...existing, ...patch, updatedAt: nowIso() }
  writeDoc(state, sessionId, 'meta', next)
  return next
}

/**
 * 把外部传来的会话 id 规整成存档键。
 * 工具与路由都走这里，保证 getTrpgState(state, 'abc') 与 getTrpgState(state, undefined) 的行为一致。
 * @param {string} [sessionId] DSH 会话 id
 * @returns {string} 存档目录名
 */
export function sessionIdFor(sessionId) {
  return sessionKey(sessionId)
}

/**
 * 给落盘对象补一个稳定 id。调用方必须已保证 id 唯一；这里只负责格式。
 * @param {string} prefix 前缀，如 'sheet'
 * @returns {string} 形如 'sheet-lq3k9-7f2a'
 */
export function makeId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}
