/**
 * 跑团日志：判定记录、剧情摘要、系统事件。
 *
 * 日志是给玩家看的「本场都发生过什么」，也是给模型看的「刚才发生了什么」。
 * 所以每条都尽量带结构化的 total/success，前端才能上色，模型才能引用。
 *
 * 存盘：<dataRoot>/trpg/<会话>/log.json = { entries: LogEntry[] }，从旧到新追加，超出上限截头。
 */
import { nowIso } from '../util.js'
import { readDoc, writeDoc, makeId } from './persist.js'

/** 合法的日志类型。 */
export const LOG_KINDS = ['roll', 'check', 'damage', 'scene', 'system']

/** 每种类型的中文名。 */
export const LOG_KIND_LABELS = {
  roll: '掷骰',
  check: '判定',
  damage: '伤害',
  scene: '场景',
  system: '系统',
}

/** 单局最多保留多少条日志，超出截掉最旧的。 */
const MAX_LOG_ENTRIES = 500

/** 读日志文档。 */
function readLogDoc(state, sessionId) {
  const doc = readDoc(state, sessionId, 'log', null)
  if (!doc || !Array.isArray(doc.entries)) return { entries: [] }
  return doc
}

/**
 * 追加一条日志。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @param {{
 *   kind: string, title?: string, detail?: string, total?: number,
 *   success?: boolean, actor?: string, text?: string,
 * }} entry 日志条目
 * @returns {Object} 写入后的日志条目（含 id/time）
 * @throws {Error} kind 非法时抛中文错误
 */
export function appendLog(state, sessionId, entry = {}) {
  const kind = LOG_KINDS.includes(entry.kind) ? entry.kind : 'system'
  const item = {
    id: String(entry.id || makeId('log')),
    time: nowIso(),
    kind,
    title: String(entry.title || ''),
    detail: String(entry.detail || ''),
    actor: entry.actor ? String(entry.actor) : '',
    text: entry.text ? String(entry.text) : '',
  }
  if (Number.isFinite(Number(entry.total))) item.total = Math.trunc(Number(entry.total))
  if (entry.success !== undefined && entry.success !== null) item.success = Boolean(entry.success)

  const doc = readLogDoc(state, sessionId)
  doc.entries.push(item)
  if (doc.entries.length > MAX_LOG_ENTRIES) {
    doc.entries = doc.entries.slice(doc.entries.length - MAX_LOG_ENTRIES)
  }
  writeDoc(state, sessionId, 'log', doc)
  return item
}

/**
 * 读日志。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @param {{ limit?: number, kind?: string }} [options] limit 取最近 N 条；kind 只看某类
 * @returns {Array<Object>} 从旧到新的日志条目
 */
export function readLog(state, sessionId, options = {}) {
  let entries = readLogDoc(state, sessionId).entries.slice()
  if (options.kind && LOG_KINDS.includes(options.kind)) {
    entries = entries.filter((entry) => entry.kind === options.kind)
  }
  const limit = Math.trunc(Number(options.limit))
  if (Number.isFinite(limit) && limit > 0 && entries.length > limit) {
    entries = entries.slice(entries.length - limit)
  }
  return entries
}

/**
 * 清空日志。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @returns {number} 清掉的条数
 */
export function clearLog(state, sessionId) {
  const doc = readLogDoc(state, sessionId)
  const count = doc.entries.length
  writeDoc(state, sessionId, 'log', { entries: [] })
  return count
}

/**
 * 把日志渲染成给模型看的一段紧凑文本（只带最近几条，省 token）。
 * @param {Array<Object>} entries 日志条目
 * @param {{ limit?: number }} [options]
 * @returns {string} 多行文本；没有日志返回空字符串
 */
export function renderLogForPrompt(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) return ''
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 8))
  const recent = list.slice(-limit)
  const lines = recent.map((entry) => {
    const head = '· [' + (LOG_KIND_LABELS[entry.kind] || entry.kind) + ']'
    const title = entry.title ? ' ' + entry.title : ''
    const detail = entry.detail ? ' —— ' + entry.detail : ''
    const actor = entry.actor ? '（' + entry.actor + '）' : ''
    return head + actor + title + detail
  })
  return lines.join('\n')
}
