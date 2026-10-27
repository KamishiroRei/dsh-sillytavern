/**
 * SillyTavern 宏引擎（{{...}} 语法）的移植。
 *
 * 设计要点：
 *  - 纯函数为主：展开结果只取决于传入的 env。唯一的例外是变量类宏
 *    （setvar / addvar / incvar 等），它们按 ST 的语义直接改写 env.variables，
 *    这个副作用是宏本身的功能，不是隐藏状态。
 *  - 最内层优先：{{random::{{char}},x}} 先展开内层再解析外层，最多 100 轮防死循环。
 *  - 未知宏原样保留，不会被吞掉，也不会造成死循环。
 *
 * 宏清单见 {@link listMacros}。
 */

/** 单次展开最多迭代轮数。正常文本一轮宏一个来回，这里是防死循环的硬天花板。 */
const MAX_PASSES = 20000

/** 循环检测保留的历史状态条数：完整文本重演即说明进入了死循环。 */
const MAX_HISTORY = 32

/** 占位符分隔符：用于把「不认识、要原样保留」的宏暂存起来，避免反复命中。 */
const HOLD_OPEN = '\u0000\u0001'
const HOLD_CLOSE = '\u0001\u0000'

/** 占位符分隔符：用于 {{! }} 字面量块，展开结束后还原。 */
const LITERAL_OPEN = '\u0000\u0002'
const LITERAL_CLOSE = '\u0002\u0000'

/** 占位符分隔符：用于 {{if}} 选中的分支，展开结束后还原。 */
const BRANCH_OPEN = '\u0000\u0003'
const BRANCH_CLOSE = '\u0003\u0000'

/** 空值统一转字符串：null/undefined → ''，其余走 String()。 */
function str(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

/** ST 的布尔判定：空串、false、off、0 视为假。 */
function isFalseBoolean(value) {
  const s = str(value).trim()
  return s === '' || s === 'false' || s === 'off' || s === '0'
}

/** 32 位字符串散列（和 ST 的 getStringHash 同类用途，不要求逐位一致）。 */
function hashString(text) {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i)
    hash |= 0
  }
  return hash >>> 0
}

/** 可复现的伪随机数发生器：同一种子必得同一序列，用于 {{pick}}。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 真正的熵随机：用于 {{random}} 与概率判定。 */
function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive)
}

/**
 * 归一化运行环境。
 *
 * 调用方只需要提供自己有的字段，其余补默认值；返回的是**新对象**，
 * 但 variables.local / variables.global 与传入对象共享引用（宏有副作用）。
 *
 * @param {Object} [env] 原始环境
 * @param {string} [env.user]      用户（persona）名
 * @param {string} [env.char]      角色名
 * @param {string} [env.group]     群聊成员名列表（单人聊天时留空）
 * @param {string} [env.groupNotMuted] 群聊成员名列表（排除静音）
 * @param {string} [env.notChar]   除当前发言者外的参与者
 * @param {string} [env.persona]   persona 描述
 * @param {string} [env.description]       角色描述
 * @param {string} [env.personality]       角色性格
 * @param {string} [env.scenario]          场景
 * @param {string} [env.charPrompt]        角色卡 Main Prompt 覆盖
 * @param {string} [env.charInstruction]   角色卡 Post-History 覆盖
 * @param {string} [env.mesExamples]       对话示例（已格式化）
 * @param {string} [env.mesExamplesRaw]    对话示例（原始）
 * @param {string} [env.charDepthPrompt]   角色卡 @depth 注释
 * @param {string} [env.creatorNotes]      作者备注
 * @param {string} [env.firstMessage]      开场白
 * @param {string[]} [env.alternateGreetings] 备选开场白
 * @param {string} [env.version]           角色版本
 * @param {Array<{role:string,content:string,name?:string,time?:number}>} [env.messages] 聊天记录（旧→新）
 * @param {string} [env.chatId]            会话 id，用于 {{pick}} 的稳定种子
 * @param {{local:Object, global:Object}} [env.variables] 变量表
 * @param {Date} [env.now]                 当前时间（测试可注入）
 * @param {Object} [env.system]            运行环境信息
 * @param {string} [env.system.model]       模型名
 * @param {number} [env.system.maxPrompt]   上下文预算
 * @param {number} [env.system.maxContext]  最大上下文
 * @param {number} [env.system.maxResponse] 最大回复
 * @param {string} [env.system.input]       输入框里的草稿
 * @param {string} [env.system.original]    原始消息内容
 * @param {string} [env.system.lastGenerationType] 上次生成类型
 * @param {number} [env.system.idleDurationMs] 距上条用户消息的毫秒数
 * @returns {Object} 归一化后的环境
 */
export function createMacroEnv(env = {}) {
  const source = env && typeof env === 'object' ? env : {}
  const messages = Array.isArray(source.messages) ? source.messages : []
  const variables = source.variables && typeof source.variables === 'object' ? source.variables : {}
  const system = source.system && typeof source.system === 'object' ? source.system : {}
  const user = str(source.user) || 'User'
  const char = str(source.char) || 'Character'

  return {
    user,
    char,
    group: str(source.group),
    groupNotMuted: str(source.groupNotMuted),
    notChar: str(source.notChar),
    persona: str(source.persona),
    description: str(source.description),
    personality: str(source.personality),
    scenario: str(source.scenario),
    charPrompt: str(source.charPrompt),
    charInstruction: str(source.charInstruction),
    mesExamples: str(source.mesExamples),
    mesExamplesRaw: str(source.mesExamplesRaw || source.mesExamples),
    charDepthPrompt: str(source.charDepthPrompt),
    creatorNotes: str(source.creatorNotes),
    firstMessage: str(source.firstMessage),
    alternateGreetings: Array.isArray(source.alternateGreetings) ? source.alternateGreetings.map(str) : [],
    version: str(source.version),
    messages,
    chatId: str(source.chatId),
    variables: {
      local: variables.local && typeof variables.local === 'object' ? variables.local : {},
      global: variables.global && typeof variables.global === 'object' ? variables.global : {},
    },
    now: source.now instanceof Date ? source.now : new Date(),
    system: {
      model: str(system.model),
      maxPrompt: system.maxPrompt === undefined ? 4096 : Number(system.maxPrompt),
      maxContext: system.maxContext === undefined ? 8192 : Number(system.maxContext),
      maxResponse: system.maxResponse === undefined ? 1024 : Number(system.maxResponse),
      input: str(system.input),
      original: str(system.original),
      lastGenerationType: str(system.lastGenerationType),
      idleDurationMs: Number.isFinite(Number(system.idleDurationMs)) ? Number(system.idleDurationMs) : 0,
    },
  }
}

/** 从消息数组里按条件找最后一条，返回其内容（找不到给空串）。 */
function lastMessageMatching(messages, predicate) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (predicate(message)) return str(message.content)
  }
  return ''
}

/** 人类可读时长，供 {{idle_duration}} 用。 */
function humanizeDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes <= 1 ? 'a minute ago' : minutes + ' minutes ago'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours <= 1 ? 'an hour ago' : hours + ' hours ago'
  const days = Math.floor(hours / 24)
  return days <= 1 ? 'a day ago' : days + ' days ago'
}

/** 解析骰子表达式：支持 3d6、3d6+2、2d20kh1、4d6kl3、d20。 */
function rollFormula(formula) {
  const text = str(formula).trim().replace(/^\+/, '')
  const match = /^(\d*)d(\d+)(?:(kh|kl)(\d+))?(?:([+-])(\d+))?$/i.exec(text)
  if (!match) {
    // 纯数字视为 1dN 的简写
    if (/^\d+$/.test(text)) return rollFormula('1d' + text)
    return null
  }
  const count = match[1] ? Number(match[1]) : 1
  const sides = Number(match[2])
  if (!Number.isFinite(count) || count < 1 || count > 1000) return null
  if (!Number.isFinite(sides) || sides < 1 || sides > 100000) return null

  let rolls = []
  for (let i = 0; i < count; i++) rolls.push(1 + randomInt(sides))

  let kept = rolls.slice()
  if (match[3]) {
    const keepCount = Math.max(1, Number(match[4]))
    const sorted = rolls.slice().sort((a, b) => (match[3].toLowerCase() === 'kh' ? b - a : a - b))
    kept = sorted.slice(0, keepCount)
  }
  const modifier = match[5] ? (match[5] === '-' ? -1 : 1) * Number(match[6]) : 0
  const total = kept.reduce((sum, value) => sum + value, 0) + modifier
  return { total, rolls, kept, modifier, formula: text }
}

/** 把时间格式化成 ST 的「本地短格式」LT（时:分）。 */
function formatLocalTime(date) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
  } catch {
    return date.toTimeString().slice(0, 5)
  }
}

/** 把日期格式化成 ST 的「本地长格式」LL（年月日）。 */
function formatLocalDate(date) {
  try {
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/** 用 moment 风格格式串格式化时间（支持常用的 YYYY/MM/DD/HH/mm/ss/MMMM/MMM/dddd/ddd/A）。 */
function formatWithPattern(date, pattern) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  const weekdayLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const weekdayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const monthLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hours12 = date.getHours() % 12 === 0 ? 12 : date.getHours() % 12

  const table = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MMMM: monthLong[date.getMonth()],
    MMM: monthShort[date.getMonth()],
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad(date.getDate()),
    D: String(date.getDate()),
    dddd: weekdayLong[date.getDay()],
    ddd: weekdayShort[date.getDay()],
    HH: pad(date.getHours()),
    H: String(date.getHours()),
    hh: pad(hours12),
    h: String(hours12),
    mm: pad(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad(date.getSeconds()),
    s: String(date.getSeconds()),
    SSS: pad(date.getMilliseconds(), 3),
    A: date.getHours() < 12 ? 'AM' : 'PM',
    a: date.getHours() < 12 ? 'am' : 'pm',
  }

  return str(pattern).replace(/\[([^\]]+)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|SSS|A|a/g, (token, literal) => {
    if (literal) return literal
    return table[token] !== undefined ? table[token] : token
  })
}

/**
 * 拆分 list 型宏的参数：{{random::a::b}} 与 {{random a,b}} 都支持。
 * 两者混用时（{{random:a::b::c}}）优先按 :: 切。
 *
 * @param {string} raw 参数原文
 * @returns {string[]} 候选项
 */
function splitListArg(raw) {
  const text = str(raw)
  if (!text) return []
  if (text.includes('::')) return text.split('::').map(item => item.trim())
  return text
    .replace(/\\,/g, '\u0000COMMA\u0000')
    .split(',')
    .map(item => item.trim().replace(/\u0000COMMA\u0000/g, ','))
}

/** 解析宏头：名字 + 参数原文。名字允许 [a-zA-Z][\w-]* 与 // 注释形式。 */
function parseMacro(inner) {
  const text = str(inner)
  const trimmed = text.trim()

  // 注释宏 {{// 任意内容}} 与 scoped 形式 {{//}}...{{///}}
  if (trimmed.startsWith('//')) return { name: '//', args: { positional: [], raw: trimmed.slice(2) } }

  // 执行标志：/ # ! ? ~ > 可以出现在名字前
  let body = trimmed
  let closing = false
  let preserveWhitespace = false
  let literal = false
  while (body.length > 0) {
    const head = body[0]
    if (head === '/') { closing = true; body = body.slice(1); continue }
    if (head === '#') { preserveWhitespace = true; body = body.slice(1); continue }
    if (head === '!') { literal = true; body = body.slice(1); continue }
    if (head === '?' || head === '~' || head === '>') { body = body.slice(1); continue }
    break
  }

  const nameMatch = /^([a-zA-Z][\w-]*)/.exec(body)
  if (!nameMatch) {
    return { name: '', args: { positional: [], raw: body }, closing, preserveWhitespace, literal, unparsable: true }
  }
  const name = nameMatch[1]
  const rest = body.slice(name.length)

  return { name, args: parseArgs(rest), closing, preserveWhitespace, literal }
}

/** 解析参数：优先 :: 分隔，其次单冒号，最后按空白（支持引号）。 */
function parseArgs(rest) {
  let text = str(rest)
  if (text.startsWith('::')) {
    text = text.slice(2)
    return { positional: text.split('::').map(item => item.trim()), raw: text }
  }
  if (text.startsWith(':')) {
    return { positional: [text.slice(1).trim()], raw: text.slice(1) }
  }
  text = text.trim()
  if (!text) return { positional: [], raw: '' }
  // 空白分隔，支持 "带 空格" 的引号参数
  const positional = []
  let current = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') { quoted = !quoted; continue }
    if (!quoted && /\s/.test(ch)) {
      if (current) { positional.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current) positional.push(current)
  return { positional, raw: text }
}

/** 变量操作的统一实现（数字则加减，否则字符串拼接，与 ST 一致）。 */
function addVar(table, name, value) {
  const current = table[name]
  if (current === undefined || current === null) {
    table[name] = value
    return
  }
  const currentNumber = Number(current)
  const nextNumber = Number(value)
  if (Number.isFinite(currentNumber) && Number.isFinite(nextNumber)) {
    table[name] = currentNumber + nextNumber
    return
  }
  table[name] = str(current) + str(value)
}

/** 变量自增/自减，返回新值。 */
function stepVar(table, name, delta) {
  const current = Number(table[name])
  const next = (Number.isFinite(current) ? current : 0) + delta
  table[name] = next
  return String(next)
}

/**
 * 展开单个宏。
 *
 * @param {string} inner      {{ 与 }} 之间的原文
 * @param {Object} env       归一化环境（见 createMacroEnv）
 * @param {number} offset     该宏在原文中的起始位置，供 {{pick}} 稳定取模
 * @returns {string|null}    展开结果；返回 null 表示不认识，调用方应原样保留
 */
function expandOne(inner, env, offset) {
  const parsed = parseMacro(inner)
  if (parsed.unparsable) return null
  if (parsed.closing) return null

  const name = parsed.name
  const positional = parsed.args.positional
  const first = positional.length ? str(positional[0]) : ''
  const messages = env.messages
  const local = env.variables.local
  const global = env.variables.global

  switch (name) {
    // —— 名字 ——
    case 'user': return env.user
    case 'char': return env.char
    case 'group': return env.group || env.char
    case 'charIfNotGroup': return env.group || env.char
    case 'groupNotMuted': return env.groupNotMuted || env.group || env.char
    case 'notChar': return env.notChar

    // —— 角色卡字段 ——
    case 'description':
    case 'charDescription': return env.description
    case 'personality':
    case 'charPersonality': return env.personality
    case 'scenario':
    case 'charScenario': return env.scenario
    case 'persona': return env.persona
    case 'charPrompt': return env.charPrompt
    case 'charInstruction': return env.charInstruction
    case 'mesExamples': return env.mesExamples
    case 'mesExamplesRaw': return env.mesExamplesRaw
    case 'charDepthPrompt': return env.charDepthPrompt
    case 'charCreatorNotes':
    case 'creatorNotes': return env.creatorNotes
    case 'charVersion':
    case 'version':
    case 'char_version': return env.version
    case 'charFirstMessage':
    case 'greeting': {
      const index = Number(first)
      if (!Number.isFinite(index) || index <= 0) return env.firstMessage
      return env.alternateGreetings[index - 1] !== undefined ? env.alternateGreetings[index - 1] : ''
    }

    // —— 空白与工具 ——
    case 'space': {
      const count = Number(first)
      return ' '.repeat(Number.isFinite(count) && count > 0 ? Math.min(count, 1000) : 1)
    }
    case 'newline': {
      const count = Number(first)
      return '\n'.repeat(Number.isFinite(count) && count > 0 ? Math.min(count, 1000) : 1)
    }
    case 'noop': return ''
    case '//': return ''
    case 'trim': return '{{trim}}'
    case 'reverse': return Array.from(str(positional[0])).reverse().join('')
    case 'input': return env.system.input
    case 'original': return env.system.original

    // —— 时间 ——
    case 'time': {
      const offsetSpec = first
      if (!offsetSpec) return formatLocalTime(env.now)
      const match = /^UTC([+-]\d+)$/i.exec(offsetSpec)
      if (!match) return formatLocalTime(env.now)
      const hoursOffset = Number.parseInt(match[1], 10)
      if (!Number.isFinite(hoursOffset)) return formatLocalTime(env.now)
      const shifted = new Date(env.now.getTime() + hoursOffset * 3600 * 1000)
      return formatLocalTime(new Date(shifted.getTime() + shifted.getTimezoneOffset() * 60 * 1000))
    }
    case 'date': return formatLocalDate(env.now)
    case 'weekday': return formatWithPattern(env.now, 'dddd')
    case 'isotime': return formatWithPattern(env.now, 'HH:mm')
    case 'isodate': return formatWithPattern(env.now, 'YYYY-MM-DD')
    case 'datetimeformat': return formatWithPattern(env.now, positional.join('::'))
    case 'idle_duration':
    case 'idleDuration': return humanizeDuration(env.system.idleDurationMs)
    case 'timeDiff': {
      const left = Date.parse(positional[0])
      const right = Date.parse(positional[1])
      if (!Number.isFinite(left) || !Number.isFinite(right)) return ''
      const diffMs = Math.abs(left - right)
      return humanizeDuration(diffMs).replace(' ago', '')
    }

    // —— 聊天 ——
    case 'lastMessage': return lastMessageMatching(messages, () => true)
    case 'lastUserMessage': return lastMessageMatching(messages, m => m.role === 'user')
    case 'lastCharMessage': return lastMessageMatching(messages, m => m.role === 'assistant')
    case 'lastMessageId': return String(messages.length - 1)
    case 'allChatRange': return messages.length === 0 ? '' : '0-' + (messages.length - 1)
    case 'lastSwipeId': {
      const message = messages[messages.length - 1]
      return message && Array.isArray(message.swipes) ? String(message.swipes.length) : ''
    }
    case 'currentSwipeId': {
      const message = messages[messages.length - 1]
      return message && Number.isFinite(Number(message.swipeIndex)) ? String(Number(message.swipeIndex) + 1) : ''
    }

    // —— 随机 ——
    case 'random': {
      const list = positional.length === 1 ? splitListArg(positional[0]) : positional.filter(item => str(item).trim() !== '')
      if (!list.length) return ''
      return list[randomInt(list.length)]
    }
    case 'pick': {
      const list = positional.length === 1 ? splitListArg(positional[0]) : positional.filter(item => str(item).trim() !== '')
      if (!list.length) return ''
      const seed = hashString([env.chatId, parsed.args.raw, offset].join('-'))
      const rng = mulberry32(seed)
      return list[Math.floor(rng() * list.length)]
    }
    case 'roll': {
      const formula = positional.length ? positional.join(' ') : ''
      const result = rollFormula(formula)
      return result ? String(result.total) : ''
    }

    // —— 变量：本地 ——
    case 'getvar': {
      const key = str(positional[0])
      return local[key] === undefined ? '' : str(local[key])
    }
    case 'setvar': {
      local[str(positional[0])] = positional.length > 1 ? positional[1] : ''
      return ''
    }
    case 'addvar': {
      addVar(local, str(positional[0]), positional.length > 1 ? positional[1] : '')
      return ''
    }
    case 'incvar': return stepVar(local, str(positional[0]), 1)
    case 'decvar': return stepVar(local, str(positional[0]), -1)
    case 'hasvar':
    case 'varexists': return Object.prototype.hasOwnProperty.call(local, str(positional[0])) ? 'true' : 'false'
    case 'deletevar':
    case 'flushvar': { delete local[str(positional[0])]; return '' }

    // —— 变量：全局 ——
    case 'getglobalvar': {
      const key = str(positional[0])
      return global[key] === undefined ? '' : str(global[key])
    }
    case 'setglobalvar': {
      global[str(positional[0])] = positional.length > 1 ? positional[1] : ''
      return ''
    }
    case 'addglobalvar': {
      addVar(global, str(positional[0]), positional.length > 1 ? positional[1] : '')
      return ''
    }
    case 'incglobalvar': return stepVar(global, str(positional[0]), 1)
    case 'decglobalvar': return stepVar(global, str(positional[0]), -1)
    case 'hasglobalvar':
    case 'globalvarexists': return Object.prototype.hasOwnProperty.call(global, str(positional[0])) ? 'true' : 'false'
    case 'deleteglobalvar':
    case 'flushglobalvar': { delete global[str(positional[0])]; return '' }

    // —— 运行环境 ——
    case 'model': return env.system.model
    case 'maxPrompt':
    case 'maxPromptTokens': return String(env.system.maxPrompt)
    case 'maxContext':
    case 'maxContextTokens': return String(env.system.maxContext)
    case 'maxResponse':
    case 'maxResponseTokens': return String(env.system.maxResponse)
    case 'lastGenerationType': return env.system.lastGenerationType
    case 'isMobile': return 'false'
    case 'systemPrompt': return env.charPrompt
    case 'banned': return ''
    case 'outlet': return ''

    default:
      return null
  }
}

/**
 * 找出最内层的一个宏（第一个 }} 之前最近的 {{）。
 *
 * @param {string} text 待扫描文本
 * @returns {{ start: number, end: number, inner: string }|null}
 */
function findInnermostMacro(text) {
  let close = text.indexOf('}}')
  while (close >= 0) {
    // 占位符内部的 \u0001 不会包含 {{ }}，所以不必特殊处理
    const open = text.lastIndexOf('{{', close)
    if (open >= 0 && open < close) {
      return { start: open, end: close + 2, inner: text.slice(open + 2, close) }
    }
    close = text.indexOf('}}', close + 2)
  }
  return null
}

/**
 * 处理 {{if 条件}}…{{else}}…{{/if}} 块（支持嵌套）。
 *
 * 条件支持 ! 取反、变量简写（.local / $global）、注册宏名（自动求值），
 * 假值判定与 ST 一致：空串、false、off、0。
 *
 * 被选中分支的内容先换成占位符占住位置，外层宏展开结束后再统一还原并继续
 * 展开，这样分支里的 {{roll}} 之类不会因为反复展开而重掷。
 *
 * @param {string} text 原文
 * @param {Object} env  归一化环境
 * @param {string[]} held 占位符内容收集器
 * @returns {string} 处理完 if 块的文本
 */
function expandIfBlocks(text, env, held) {
  const OPEN = '{{if '
  const OPEN_COLON = '{{if::'
  let result = ''
  let index = 0

  while (index < text.length) {
    let openStart = text.indexOf(OPEN, index)
    const colonStart = text.indexOf(OPEN_COLON, index)
    if (openStart < 0 || (colonStart >= 0 && colonStart < openStart)) openStart = colonStart
    if (openStart < 0) {
      result += text.slice(index)
      break
    }

    result += text.slice(index, openStart)

    // 条件结束于与之配对的 }}：条件里可能嵌着 {{getvar::x}} 这类宏
    let condEnd = -1
    {
      let scan = openStart + 2
      let level = 0
      while (scan < text.length) {
        if (text.startsWith('{{', scan)) { level++; scan += 2; continue }
        if (text.startsWith('}}', scan)) {
          if (level === 0) { condEnd = scan; break }
          level--
          scan += 2
          continue
        }
        scan++
      }
    }
    if (condEnd < 0) {
      result += text.slice(openStart)
      break
    }
    const conditionRaw = text.slice(openStart + 2, condEnd).replace(/^if\s*:::?/, '').trim()

    // 找配对的 {{/if}}，按嵌套计数
    let cursor = condEnd + 2
    let level = 1
    let elseAt = -1
    let closeAt = -1
    while (cursor < text.length) {
      const nextOpen = text.indexOf('{{if ', cursor)
      const nextOpenColon = text.indexOf('{{if::', cursor)
      const nextElse = text.indexOf('{{else}}', cursor)
      const nextClose = text.indexOf('{{/if}}', cursor)
      const candidates = [nextOpen, nextOpenColon, nextElse, nextClose].filter(pos => pos >= 0)
      if (!candidates.length) break
      const nearest = Math.min.apply(null, candidates)
      if (nearest === nextOpen || nearest === nextOpenColon) { level++; cursor = nearest + 5; continue }
      if (nearest === nextElse) {
        if (level === 1 && elseAt < 0) elseAt = nearest
        cursor = nearest + 8
        continue
      }
      level--
      if (level === 0) { closeAt = nearest; break }
      cursor = nearest + 7
    }

    if (closeAt < 0) {
      // 没有闭合：原样保留，避免吞内容
      result += text.slice(openStart, condEnd + 2)
      index = condEnd + 2
      continue
    }

    const thenEnd = elseAt >= 0 ? elseAt : closeAt
    const thenBranch = text.slice(condEnd + 2, thenEnd)
    const elseBranch = elseAt >= 0 ? text.slice(elseAt + 8, closeAt) : ''

    let condition = conditionRaw
    let inverted = false
    if (/^!/.test(condition)) {
      inverted = true
      condition = condition.replace(/^!\s*/, '')
    }

    // 变量简写：.local / $global
    const shorthand = /^([.$])([a-zA-Z][\w-]*)$/.exec(condition)
    if (shorthand) {
      const table = shorthand[1] === '.' ? env.variables.local : env.variables.global
      condition = table[shorthand[2]] === undefined ? '' : str(table[shorthand[2]])
    } else if (/^[a-zA-Z][\w-]*$/.test(condition)) {
      // 已注册的零参宏名：自动求值；不认识就当普通字面量
      const resolved = expandOne(condition, env, 0)
      if (resolved !== null) condition = resolved
    } else {
      condition = expandMacros(condition, env)
    }

    let falsy = condition.trim() === '' || isFalseBoolean(condition)
    if (inverted) falsy = !falsy
    const chosen = falsy ? elseBranch : thenBranch
    result += BRANCH_OPEN + held.length + BRANCH_CLOSE
    held.push(chosen)
    index = closeAt + 7
  }

  return result
}

/**
 * 展开 {{! ... }} 字面量块：内部原文原样保留，不再当宏展开。
 *
 * 用花括号配对找闭合，所以 {{!{{char}}}} 也能正确保留成 {{char}}。
 * 保留下来的内容会先换成占位符，等整轮展开结束后再还原，否则后面
 * 的迭代又会被当成宏吃掉。
 *
 * @param {string} text  原文
 * @param {string[]} held 占位符内容收集器（调用方在最后还原）
 * @returns {string} 用占位符替换过字面量块的文本
 */
function holdLiteralBlocks(text, held) {
  let result = ''
  let index = 0
  while (index < text.length) {
    const start = text.indexOf('{{!', index)
    if (start < 0) {
      result += text.slice(index)
      break
    }
    // '{{!' 本身可能是 '{{//' 之类的前缀误判，这里要求 {{! 后面不是 /
    result += text.slice(index, start)
    let cursor = start + 3
    let level = 1
    let end = -1
    while (cursor < text.length) {
      if (text.startsWith('{{', cursor)) { level++; cursor += 2; continue }
      if (text.startsWith('}}', cursor)) {
        level--
        if (level === 0) { end = cursor; break }
        cursor += 2
        continue
      }
      cursor++
    }
    if (end < 0) {
      result += text.slice(start)
      break
    }
    const literal = text.slice(start + 3, end)
    result += LITERAL_OPEN + held.length + LITERAL_CLOSE
    held.push(literal)
    index = end + 2
  }
  return result
}

/**
 * 展开文本里的全部宏。
 *
 * 处理顺序：
 *  1. {{! ... }} 字面量块（原样输出内部文本）
 *  2. {{if}}…{{else}}…{{/if}} 条件块
 *  3. 其余宏按「最内层优先」迭代展开，最多 100 轮
 *  4. {{trim}} 连同其前后换行一起删除（与 ST 的后处理一致）
 *
 * 未识别的宏原样保留。变量类宏会改写 env.variables（这是它们的功能）。
 *
 * @param {string} text 原始文本；非字符串会被转成字符串，空值返回 ''
 * @param {Object} env  createMacroEnv 的结果
 * @returns {string} 展开后的文本
 */
export function expandMacros(text, env) {
  if (text === undefined || text === null) return ''
  let result = String(text)
  if (!result.includes('{{')) return result

  const sandbox = env && typeof env === 'object' ? env : createMacroEnv()
  const normalized = sandbox.variables ? sandbox : createMacroEnv(sandbox)

  // 字面量块与 if 分支先换成占位符占位，避免被后续迭代重复展开
  const literalHold = []
  result = holdLiteralBlocks(result, literalHold)

  const branchHold = []
  if (result.includes('{{if ') || result.includes('{{if::')) {
    result = expandIfBlocks(result, normalized, branchHold)
    // 选中的分支各展开一次，结果留在占位符里，最后统一还原
    for (let i = 0; i < branchHold.length; i++) {
      branchHold[i] = expandMacros(branchHold[i], normalized)
    }
  }

  const held = []
  /** 最近若干轮的整体文本：完整重演即表明进入了死循环。 */
  const history = []
  let passes = 0
  while (passes++ < MAX_PASSES) {
    const found = findInnermostMacro(result)
    if (!found) break

    const raw = result.slice(found.start, found.end)
    let replacement
    // 先判断「这份文本之前出现过没有」，再把当前状态记进历史，
    // 顺序反了会把每一次正常展开都误判成死循环。
    const cycled = history.indexOf(result) >= 0
    if (!cycled) {
      history.push(result)
      if (history.length > MAX_HISTORY) history.shift()
    }
    if (cycled) {
      // 同一份文本又回来了：这个宏自己指向自己（例如 A 变量里存着 {{getvar::A}}）
      replacement = null
    } else if (found.inner.startsWith('//')) {
      replacement = ''
    } else {
      const expanded = expandOne(found.inner, normalized, found.start)
      replacement = expanded === null || expanded === found.inner || expanded === raw ? null : expanded
    }

    if (replacement === null) {
      // 不认识或会自指的宏：换成占位符，等整轮结束后原样还原
      replacement = HOLD_OPEN + held.length + HOLD_CLOSE
      held.push(raw)
    }

    result = result.slice(0, found.start) + replacement + result.slice(found.end)
  }

  // 还原暂存的未知宏
  for (let i = 0; i < held.length; i++) {
    result = result.split(HOLD_OPEN + i + HOLD_CLOSE).join(held[i])
  }

  // 还原 if 分支占位符（分支内容已各自展开过）
  for (let i = 0; i < branchHold.length; i++) {
    result = result.split(BRANCH_OPEN + i + BRANCH_CLOSE).join(branchHold[i])
  }

  // 还原 {{! }} 字面量块：里面的内容永远是原文，不再展开
  for (let i = 0; i < literalHold.length; i++) {
    result = result.split(LITERAL_OPEN + i + LITERAL_CLOSE).join(literalHold[i])
  }

  // {{trim}} 连前后换行一起吃掉
  result = result.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '')

  return result
}

/**
 * 已支持的宏名清单（主名，别名不重复列出）。
 *
 * 供文档与自检使用；返回顺序稳定，便于快照比对。
 *
 * @returns {string[]} 宏名数组
 */
export function listMacros() {
  return [
    'char', 'user', 'group', 'charIfNotGroup', 'groupNotMuted', 'notChar', 'persona',
    'description', 'charDescription', 'personality', 'charPersonality',
    'scenario', 'charScenario', 'charPrompt', 'charInstruction',
    'mesExamples', 'mesExamplesRaw', 'charDepthPrompt', 'creatorNotes',
    'charFirstMessage', 'greeting', 'charVersion', 'version',
    'space', 'newline', 'noop', 'trim', 'reverse', 'input', 'original', '//', '!',
    'time', 'date', 'weekday', 'isotime', 'isodate', 'datetimeformat', 'idle_duration', 'timeDiff',
    'lastMessage', 'lastUserMessage', 'lastCharMessage', 'lastMessageId',
    'allChatRange', 'lastSwipeId', 'currentSwipeId',
    'random', 'pick', 'roll', 'if', 'else',
    'getvar', 'setvar', 'addvar', 'incvar', 'decvar', 'hasvar', 'deletevar',
    'getglobalvar', 'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar',
    'hasglobalvar', 'deleteglobalvar',
    'model', 'maxPrompt', 'maxContext', 'maxResponse', 'lastGenerationType',
    'isMobile', 'systemPrompt',
  ]
}
