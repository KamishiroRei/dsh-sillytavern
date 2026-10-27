/**
 * 通用工具：令牌估算、深度比较、清洗、时间戳。
 * 全部纯函数，无副作用，方便在组装提示时反复调用。
 */

/** 粗略令牌估算：中英混排按 2.2 字符/token 取整；够用且稳定，不做分词器依赖。 */
export function estimateTokens(text) {
  if (!text) return 0
  const s = String(text)
  let cjk = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0x3040 && code <= 0x9fff) cjk++
    else if (code >= 0xf900 && code <= 0xfaff) cjk++
    else if (code >= 0xac00 && code <= 0xd7af) cjk++
  }
  const rest = s.length - cjk
  return Math.ceil(cjk / 1.5 + rest / 4)
}

/** 按令牌预算从尾部截断消息数组；保底永远保留最后一条。 */
export function trimByBudget(messages, budget, getText) {
  const out = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = getText(messages[i])
    const cost = estimateTokens(text)
    if (out.length > 0 && used + cost > budget) break
    out.unshift(messages[i])
    used += cost
  }
  return out
}

/** 去重的稳定合并：后者覆盖前者的同名键。 */
export function assign(target, ...sources) {
  Object.assign(target, ...sources.filter(Boolean))
  return target
}

/** 把任意值拍平成可写进提示词的展示文本。 */
export function displayText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join(', ')
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** 生成稳定短 id。 */
export function shortId(prefix = 'id') {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/** 数字夹取。 */
export function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

/** 深拷贝 JSON 安全子集。 */
export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 大小写不敏感包含。 */
export function contains(haystack, needle) {
  if (haystack === undefined || haystack === null) return false
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase())
}

/** 把 ST 的列表型字段（数组或逗号分隔字符串）统一成数组。 */
export function toList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(v => v !== undefined && v !== null && String(v).trim() !== '')
  return String(value).split(',').map(s => s.trim()).filter(Boolean)
}

/** 安全正则编译；失败返回 null 并记录原因。 */
export function tryRegExp(pattern, flags = '') {
  try { return new RegExp(pattern, flags) } catch { return null }
}

/** 当前时间的秒级 ISO，用于记录。 */
export function nowIso() {
  return new Date().toISOString()
}
