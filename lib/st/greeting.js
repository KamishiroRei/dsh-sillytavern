/**
 * 开场消息（ST 的 first_message / alternate_greetings）。
 *
 * 这一步是「装完就能玩」的关键：绑定角色后要自动把角色的第一句话放进会话，
 * 而不是等用户先开口。ST 的完整语义（public/script.js 的 getFirstMessage）：
 *
 *  1. first_mes 是主开场；alternate_greetings 是备选
 *  2. 两者合并成 swipes 数组：[first_mes, ...alternates]
 *  3. first_mes 为空时，把第一个备选提到 mes，并从 swipes 里移掉
 *  4. 每条都过一遍 AI_OUTPUT 位置的正则
 *  5. 同时写入 swipe_info（每条的时间戳与额外信息），这是 ST 的扩展字段
 *
 * 群聊的 group_only_greetings 单独处理：只在群聊里作为备选出现。
 */
import { nowIso } from '../util.js'

/**
 * 把正则应用到开场文本。没有正则引擎时原样返回。
 * @param {string} text
 * @param {(text: string, placement: string) => string} [applyRegex]
 * @returns {string}
 */
function regexed(text, applyRegex) {
  const value = String(text || '')
  if (!value || typeof applyRegex !== 'function') return value
  try {
    return String(applyRegex(value, 'ai_output'))
  } catch {
    return value
  }
}

/**
 * 构造开场消息，返回 ST 形状的 message 对象。
 *
 * @param {Object} card 规范化角色卡
 * @param {{
 *   isGroup?: boolean,
 *   applyRegex?: (text: string, placement: string) => string,
 *   name?: string,
 *   sendDate?: string,
 * }} [options]
 * @returns {Object|null} ST 格式消息；没有任何开场时返回 null
 */
export function buildGreetingMessage(card, options = {}) {
  if (!card) return null
  const name = String(options.name || card.name || '角色')
  const sendDate = options.sendDate || nowIso()

  let first = regexed(card.first_mes, options.applyRegex)
  const alternates = (Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [])
    .map(item => regexed(item, options.applyRegex))
  const groupOnly = (Array.isArray(card.group_only_greetings) ? card.group_only_greetings : [])
    .map(item => regexed(item, options.applyRegex))

  // 群聊里额外带上 group_only_greetings 作为备选
  const pool = alternates.concat(options.isGroup ? groupOnly : [])

  if (!first && pool.length === 0) return null

  const message = {
    name,
    is_user: false,
    is_system: false,
    send_date: sendDate,
    mes: first,
    extra: {},
  }

  const swipes = pool.length > 0 ? [first, ...pool] : []
  if (swipes.length > 0) {
    // first_mes 为空时，第一个备选顶上成为主开场（ST 的做法）
    if (!message.mes) {
      swipes.shift()
      message.mes = swipes[0] || ''
    }
    message.swipe_id = 0
    message.swipes = swipes
    // ST 的 swipe_info：每条 swipe 各自的时间戳与额外信息
    message.swipe_info = swipes.map(() => ({
      send_date: sendDate,
      gen_started: undefined,
      gen_finished: undefined,
      extra: {},
    }))
  }

  if (!message.mes && !(message.swipes && message.swipes.length)) return null
  return message
}

/**
 * 角色有没有任何开场内容（决定要不要自动开场）。
 * @param {Object} card
 * @returns {boolean}
 */
export function hasGreeting(card) {
  if (!card) return false
  const first = String(card.first_mes || '').trim()
  if (first) return true
  const alternates = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : []
  return alternates.some(item => String(item || '').trim())
}

/**
 * 列出全部可用开场（给"换一个开场白"用）。
 * @param {Object} card
 * @param {{ isGroup?: boolean }} [options]
 * @returns {string[]}
 */
export function listGreetings(card, options = {}) {
  if (!card) return []
  const out = []
  const first = String(card.first_mes || '').trim()
  if (first) out.push(first)
  for (const item of Array.isArray(card.alternate_greetings) ? card.alternate_greetings : []) {
    if (String(item || '').trim()) out.push(String(item))
  }
  if (options.isGroup) {
    for (const item of Array.isArray(card.group_only_greetings) ? card.group_only_greetings : []) {
      if (String(item || '').trim()) out.push(String(item))
    }
  }
  return out
}
