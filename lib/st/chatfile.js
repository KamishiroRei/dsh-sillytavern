/**
 * ST 原生聊天文件格式（.jsonl）读写。
 *
 * ST 的 chat 是一个 JSONL 文件：
 *   第 1 行 = { chat_metadata: {...}, user_name, character_name }
 *   之后每行 = 一条消息 { name, is_user, is_system, send_date, mes, extra, swipe_id, swipes }
 *
 * 我原来的实现用的是自创的单个 .json，跟 ST 对不上——用户已有的聊天记录进不来，
 * 我们的聊天 ST 也读不了。这个模块把两边统一到 ST 的原生格式。
 *
 * 保真点：
 *  - chat_metadata 原样保留（integrity / chat_id_hash / note_* / timedWorldInfo / variables）
 *  - 消息的 swipe_id / swipes 是双游标结构，swipe 切换只改 swipe_id，不动 swipes
 *  - extra 原样保留（ST 的 reasoning、gen_id、token_count、worldInfo 等都塞这里）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nowIso } from '../util.js'

/** 新聊天的默认 metadata，字段名与 ST 一致。 */
export function defaultChatMetadata() {
  return {
    integrity: '',
    chat_id_hash: 0,
    note_prompt: '',
    note_interval: 1,
    note_position: 1,
    note_depth: 4,
    note_role: 0,
    timedWorldInfo: { sticky: {}, cooldown: {} },
    variables: {},
  }
}

/**
 * 解析 JSONL 文本 → { metadata, messages, lineCount }。
 * 空行与损坏行跳过并计数，不整份失败。
 * @param {string} text
 * @returns {{ metadata: Object, messages: Array<Object>, skipped: number }}
 */
export function parseChatJsonl(text) {
  const lines = String(text || '').split(/\r?\n/)
  let metadata = null
  const messages = []
  let skipped = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { skipped += 1; continue }

    // 第一行带 chat_metadata 的是头
    if (i === 0 && row && typeof row === 'object' && row.chat_metadata) {
      metadata = row
      continue
    }
    if (!row || typeof row !== 'object') { skipped += 1; continue }

    // 兼容两种写法：ST 的 { mes } 与少数扩展的 { content }
    const text2 = row.mes !== undefined ? row.mes : (row.content !== undefined ? row.content : '')
    const message = {
      name: String(row.name || ''),
      is_user: Boolean(row.is_user),
      is_system: Boolean(row.is_system),
      send_date: String(row.send_date || nowIso()),
      mes: String(text2 || ''),
      extra: row.extra && typeof row.extra === 'object' ? row.extra : {},
    }
    if (row.swipes !== undefined) {
      message.swipes = Array.isArray(row.swipes) ? row.swipes.slice() : []
      message.swipe_id = Number.isFinite(Number(row.swipe_id)) ? Number(row.swipe_id) : 0
    }
    if (row.force_avatar !== undefined) message.force_avatar = String(row.force_avatar)
    if (row.original_avatar !== undefined) message.original_avatar = String(row.original_avatar)
    // 其余未知字段原样带上，避免扩展数据丢失
    for (const [key, value] of Object.entries(row)) {
      if (!(key in message)) message[key] = value
    }
    messages.push(message)
  }

  if (!metadata) metadata = { chat_metadata: defaultChatMetadata(), user_name: 'unused', character_name: 'unused' }
  if (!metadata.chat_metadata) metadata.chat_metadata = defaultChatMetadata()
  return { metadata, messages, skipped }
}

/**
 * 序列化成 JSONL 文本。首行 metadata，其余每行一条消息。
 * @param {Object} metadata
 * @param {Array<Object>} messages
 * @returns {string}
 */
export function stringifyChatJsonl(metadata, messages) {
  const rows = [JSON.stringify(metadata && metadata.chat_metadata ? metadata : { chat_metadata: defaultChatMetadata(), user_name: 'unused', character_name: 'unused' })]
  for (const message of messages || []) rows.push(JSON.stringify(message))
  return rows.join('\n') + '\n'
}

/** 读一个 .jsonl 聊天文件。 */
export function readChatFile(file) {
  if (!existsSync(file) || !file.endsWith('.jsonl')) return null
  return parseChatJsonl(readFileSync(file, 'utf8'))
}

/** 原子写 .jsonl 聊天文件。 */
export function writeChatFile(file, metadata, messages) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, stringifyChatJsonl(metadata, messages), 'utf8')
  renameSync(tmp, file)
}

/**
 * 构造一条 ST 格式的消息。
 * @param {{ name: string, isUser?: boolean, isSystem?: boolean, mes: string, extra?: Object, swipes?: string[], swipeId?: number }} input
 * @returns {Object}
 */
export function makeMessage(input) {
  const mes = String(input.mes || '')
  const message = {
    name: String(input.name || ''),
    is_user: Boolean(input.isUser),
    is_system: Boolean(input.isSystem),
    send_date: input.sendDate || nowIso(),
    mes,
    extra: input.extra && typeof input.extra === 'object' ? input.extra : {},
  }
  if (Array.isArray(input.swipes) && input.swipes.length) {
    message.swipes = input.swipes.slice()
    message.swipe_id = Number.isFinite(Number(input.swipeId)) ? Number(input.swipeId) : 0
  }
  return message
}

/**
 * 当前生效的回复文本（swipe 结构下取 swipe_id 指向的那条）。
 * @param {Object} message
 * @returns {string}
 */
export function activeText(message) {
  if (!message || typeof message !== 'object') return ''
  if (Array.isArray(message.swipes) && message.swipes.length) {
    const at = Number.isFinite(Number(message.swipe_id)) ? Number(message.swipe_id) : 0
    const text = message.swipes[at]
    return text === undefined ? String(message.mes || '') : String(text)
  }
  return String(message.mes || '')
}

/**
 * 切到下一个/上一个 swipe。ST 的语义：只在 swipe_id 上移动，不删不改 swipes。
 * @param {Object} message
 * @param {number} direction +1 / -1
 * @returns {{ changed: boolean, text: string, index: number, total: number }}
 */
export function moveSwipe(message, direction = 1) {
  const swipes = Array.isArray(message && message.swipes) ? message.swipes : []
  if (swipes.length < 2) {
    return { changed: false, text: activeText(message), index: 0, total: swipes.length }
  }
  const current = Number.isFinite(Number(message.swipe_id)) ? Number(message.swipe_id) : 0
  const next = ((current + (direction >= 0 ? 1 : -1)) % swipes.length + swipes.length) % swipes.length
  message.swipe_id = next
  message.send_date = nowIso()
  return { changed: next !== current, text: String(swipes[next] || ''), index: next, total: swipes.length }
}

/**
 * 给一条消息追加一个新的 swipe 并切过去（重生成用）。
 * @param {Object} message
 * @param {string} text
 * @returns {{ index: number, total: number }}
 */
export function appendSwipe(message, text) {
  if (!Array.isArray(message.swipes) || !message.swipes.length) {
    message.swipes = [String(message.mes || '')]
    message.swipe_id = 0
  }
  message.swipes.push(String(text || ''))
  message.swipe_id = message.swipes.length - 1
  message.mes = String(text || '')
  message.send_date = nowIso()
  return { index: message.swipe_id, total: message.swipes.length }
}