/**
 * SillyTavern 世界书（World Info / Lorebook）的扫描引擎。
 *
 * 行为对齐 ST 1.18 的 public/scripts/world-info.js：
 *  - 常量条目恒激活；
 *  - 关键词条目在「最近 scanDepth 条聊天」+ 可选的角色/场景/作者备注字段里找 key；
 *  - selectiveLogic 0/1/2/3 = AND_ANY / NOT_ALL / NOT_ANY / AND_ALL；
 *  - 递归：激活条目的正文会并入扫描缓冲，再扫下一轮，直到没有新条目或到达层数上限；
 *  - sticky / cooldown / delay 三种定时效果按聊天长度判定；
 *  - 包含组（group）同组只出一个，支持 groupOverride 优先与 groupWeight 加权随机；
 *  - 概率条目按 probability% 掷骰，失败后本场不再重试；
 *  - token 预算按 order 从大到小装填，超出预算丢弃（ignoreBudget 的条目不受限）。
 *
 * 与 ST 的差异只有一处刻意的：ST 的排序依赖全局变量与 UI 设置，这里全部走 options，
 * 不读任何全局状态。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { listJsonFiles, removeFile, safeName, writeJson } from '../store.js'

/** 插入位置枚举，与 ST 的 world_info_position 一致。 */
export const WORLD_INFO_POSITION = Object.freeze({
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
})

/** 次关键词组合逻辑，与 ST 的 world_info_logic 一致。 */
export const WORLD_INFO_LOGIC = Object.freeze({
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
})

/** 默认插入深度与组权重（ST 的 DEFAULT_DEPTH / DEFAULT_WEIGHT）。 */
const DEFAULT_DEPTH = 4
const DEFAULT_WEIGHT = 100

/** 扫描深度硬上限，防止异常配置把聊天全量塞进扫描。 */
const MAX_SCAN_DEPTH = 1000

/** 递归层数硬上限。 */
const MAX_RECURSION = 20

/** 扫描缓冲里用来分隔消息的哨兵字符，防止跨消息误匹配（同 ST）。 */
const MATCHER = '\u0001'

/** 世界书条目默认值：与 ST 的 newWorldInfoEntryDefinition 对齐。 */
const ENTRY_DEFAULTS = Object.freeze({
  uid: 0,
  key: [],
  keysecondary: [],
  comment: '',
  content: '',
  constant: false,
  vectorized: false,
  selective: true,
  selectiveLogic: 0,
  addMemo: false,
  order: 100,
  position: 0,
  disable: false,
  ignoreBudget: false,
  excludeRecursion: false,
  preventRecursion: false,
  matchPersonaDescription: false,
  matchCharacterDescription: false,
  matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false,
  matchScenario: false,
  matchCreatorNotes: false,
  delayUntilRecursion: 0,
  probability: 100,
  useProbability: true,
  depth: DEFAULT_DEPTH,
  outletName: '',
  group: '',
  groupOverride: false,
  groupWeight: DEFAULT_WEIGHT,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  role: 0,
  sticky: null,
  cooldown: null,
  delay: null,
  triggers: [],
})

/** 粗粒度 token 估算；与 lib/util.js 的 estimateTokens 同一口径。 */
function estimateTokens(text) {
  const value = String(text || '')
  if (!value) return 0
  let cjk = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const isCjk = (code >= 0x3040 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xac00 && code <= 0xd7af)
    if (isCjk) cjk++
  }
  return Math.ceil(cjk / 1.5 + (value.length - cjk) / 4)
}

/** 把任意值收敛成字符串数组。 */
function toKeyList(value) {
  if (Array.isArray(value)) return value.filter(v => v !== undefined && v !== null && String(v).trim() !== '').map(v => String(v))
  if (value === undefined || value === null) return []
  const text = String(value).trim()
  if (!text) return []
  // ST 也接受逗号分隔的写法
  return text.split(',').map(item => item.trim()).filter(Boolean)
}

/** 取布尔值并支持 null（表示继承全局设置）。 */
function triBool(value) {
  if (value === undefined || value === null || value === 'null') return null
  return Boolean(value)
}

/** 取数字并支持 null（表示继承全局设置）。 */
function triNumber(value) {
  if (value === undefined || value === null || value === 'null' || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * 归一化一条世界书条目：补齐 ST 的全部字段，类型纠偏，null 继承保留。
 *
 * 未知字段原样保留（ST 的扩展会在条目上挂自定义键）。
 *
 * @param {Record<string, any>} input 原始条目
 * @param {number} [uid] 指定 uid；省略时取 input.uid 或 0
 * @returns {Record<string, any>} 规范化条目
 */
export function normalizeWorldbookEntry(input, uid) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const out = { ...ENTRY_DEFAULTS }

  // 先抄未知字段，再用规范字段覆盖，保证扩展数据不丢
  for (const [key, value] of Object.entries(src)) {
    if (!(key in ENTRY_DEFAULTS)) out[key] = value
  }

  out.key = toKeyList(src.key)
  out.keysecondary = toKeyList(src.keysecondary)
  out.comment = src.comment === undefined || src.comment === null ? '' : String(src.comment)
  out.content = src.content === undefined || src.content === null ? '' : String(src.content)
  out.outletName = src.outletName === undefined || src.outletName === null ? '' : String(src.outletName)
  out.group = src.group === undefined || src.group === null ? '' : String(src.group)
  out.automationId = src.automationId === undefined || src.automationId === null ? '' : String(src.automationId)

  const booleans = ['constant', 'vectorized', 'selective', 'addMemo', 'disable', 'ignoreBudget',
    'excludeRecursion', 'preventRecursion', 'matchPersonaDescription', 'matchCharacterDescription',
    'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes',
    'useProbability', 'groupOverride']
  for (const key of booleans) {
    if (src[key] !== undefined && src[key] !== null) out[key] = Boolean(src[key])
  }

  const numbers = ['selectiveLogic', 'order', 'position', 'probability', 'depth', 'groupWeight', 'role']
  for (const key of numbers) {
    const value = Number(src[key])
    if (src[key] !== undefined && src[key] !== null && Number.isFinite(value)) out[key] = value
  }

  // delayUntilRecursion 在 ST 里是 0/false 或正整数层级
  const delay = src.delayUntilRecursion
  if (delay !== undefined && delay !== null) {
    out.delayUntilRecursion = delay === true ? 1 : (delay === false ? 0 : Math.max(0, Number(delay) || 0))
  }

  // 三种定时效果：null 表示未启用
  out.sticky = triNumber(src.sticky)
  out.cooldown = triNumber(src.cooldown)
  out.delay = triNumber(src.delay)

  out.scanDepth = triNumber(src.scanDepth)
  out.caseSensitive = triBool(src.caseSensitive)
  out.matchWholeWords = triBool(src.matchWholeWords)
  out.useGroupScoring = triBool(src.useGroupScoring)

  out.triggers = Array.isArray(src.triggers) ? src.triggers.map(String) : toKeyList(src.triggers)

  out.uid = Number.isFinite(Number(uid)) ? Number(uid)
    : (Number.isFinite(Number(src.uid)) ? Number(src.uid) : 0)

  return out
}

/**
 * 归一化一整本世界书。
 *
 * 接受三种历史形态：ST 原生 { entries: { "0": {...} } }、entries 数组、
 * 以及裸的条目对象。输出永远是 { entries: Record<string, Entry>, name }。
 *
 * @param {Record<string, any>|Array} raw 原始书数据
 * @param {string} [nameHint] 书名兜底
 * @returns {{ entries: Record<string, Record<string, any>>, name: string }} 规范化后的书
 */
export function normalizeWorldbook(raw, nameHint) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const rawEntries = src.entries !== undefined ? src.entries : src
  const entries = {}

  if (Array.isArray(rawEntries)) {
    rawEntries.forEach((entry, index) => {
      const normalized = normalizeWorldbookEntry(entry, index)
      entries[String(normalized.uid)] = normalized
    })
  } else if (rawEntries && typeof rawEntries === 'object') {
    for (const [key, entry] of Object.entries(rawEntries)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const numericKey = Number(key)
      const uid = Number.isFinite(numericKey) ? numericKey : Object.keys(entries).length
      const normalized = normalizeWorldbookEntry(entry, uid)
      entries[String(normalized.uid)] = normalized
    }
  }

  return { name: String(src.name || nameHint || ''), entries }
}

/**
 * 从文件读取一本世界书。
 *
 * @param {string} file JSON 文件绝对路径
 * @returns {{ entries: Record<string, any>, name: string }} 规范化后的书
 * @throws {Error} 文件不存在、不是文件、JSON 损坏时抛出
 */
export function loadWorldbookFromFile(file) {
  const path = String(file || '').trim()
  if (!path) throw new Error('必须给世界书文件路径')
  if (!existsSync(path)) throw new Error('世界书文件不存在：' + path)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error('世界书文件读取失败：' + path + ' :: ' + (error && error.message ? error.message : String(error)))
  }
  let raw
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error('世界书 JSON 解析失败：' + path + ' :: ' + (error && error.message ? error.message : String(error)))
  }
  return normalizeWorldbook(raw, basename(path, extname(path)))
}

/** 转义正则元字符。 */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 解析 ST 的斜杠正则字面量 /pattern/flags。
 * @param {string} input 关键词
 * @returns {RegExp|null} 不是正则或语法错误时返回 null
 */
function parseRegexKey(input) {
  const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(String(input))
  if (!match) return null
  const pattern = match[1]
  const flags = match[2]
  // 未转义的斜杠会让这个正则在其他引擎里失效，ST 也判为无效
  if (/(^|[^\\])\//.test(pattern)) return null
  try {
    return new RegExp(pattern.replace('\\/', '/'), flags)
  } catch {
    return null
  }
}

/**
 * 判断一个关键词是否命中扫描文本。
 *
 * 关键词写成 /pattern/flags 时按正则匹配（并忽略大小写/整词设置，与 ST 一致）；
 * 否则普通子串匹配，可选大小写敏感与整词匹配。
 *
 * @param {string} haystack 被扫描文本
 * @param {string} needle 关键词
 * @param {Record<string, any>} entry 条目（提供 caseSensitive / matchWholeWords）
 * @param {Object} settings 全局设置
 * @param {boolean} settings.caseSensitive 全局大小写敏感
 * @param {boolean} settings.matchWholeWords 全局整词匹配
 * @returns {boolean} 命中为 true
 */
export function matchKey(haystack, needle, entry, settings) {
  const key = String(needle || '')
  if (!key.trim()) return false

  const regex = parseRegexKey(key)
  if (regex) {
    if (regex.global || regex.sticky) regex.lastIndex = 0
    return regex.test(haystack)
  }

  const caseSensitive = entry.caseSensitive === null || entry.caseSensitive === undefined
    ? Boolean(settings.caseSensitive)
    : Boolean(entry.caseSensitive)
  const matchWholeWords = entry.matchWholeWords === null || entry.matchWholeWords === undefined
    ? Boolean(settings.matchWholeWords)
    : Boolean(entry.matchWholeWords)

  const hay = caseSensitive ? haystack : haystack.toLowerCase()
  const needleText = caseSensitive ? key : key.toLowerCase()

  if (!matchWholeWords) return hay.includes(needleText)

  // 整词匹配：包含空白就退化为整串子串匹配，否则用非单词字符作边界
  if (/\s/.test(needleText)) return hay.includes(needleText)
  const boundary = new RegExp('(?:^|\\W)(' + escapeRegex(needleText) + ')(?:$|\\W)')
  return boundary.test(hay)
}

/**
 * 扫描缓冲：把最近若干条消息拼成一段可搜索文本。
 *
 * 与 ST 的 WorldInfoBuffer 同一个思路：消息之间插入哨兵字符，避免跨消息匹配；
 * 递归激活的正文与注入文本追加在末尾。
 */
class ScanBuffer {
  /**
   * @param {string[]} chatLines 聊天文本，索引 0 = 最近一条（与 ST 一致）
   * @param {Object} globalData 角色/场景等聊天外数据
   */
  constructor(chatLines, globalData) {
    this.chatLines = chatLines
    this.globalData = globalData
    this.recurse = []
    this.inject = []
  }

  /** 追加递归激活的正文。 */
  addRecurse(text) {
    if (text) this.recurse.push(String(text))
  }

  /** 追加注入文本（例如深度注释），也参与关键词扫描。 */
  addInject(text) {
    if (text) this.inject.push(String(text))
  }

  /**
   * 取某个条目要扫描的文本。
   * @param {Record<string, any>} entry 条目
   * @param {number} depth 本次生效的扫描深度
   * @param {boolean} [includeRecurse] 是否并入递归缓冲
   * @returns {string} 待扫描文本
   */
  text(entry, depth, includeRecurse = true) {
    const limit = Math.min(Math.max(0, depth), MAX_SCAN_DEPTH, this.chatLines.length)
    let result = MATCHER + this.chatLines.slice(0, limit).join('\n' + MATCHER)
    const joiner = '\n' + MATCHER

    const global = this.globalData
    if (entry.matchPersonaDescription && global.personaDescription) result += joiner + global.personaDescription
    if (entry.matchCharacterDescription && global.characterDescription) result += joiner + global.characterDescription
    if (entry.matchCharacterPersonality && global.characterPersonality) result += joiner + global.characterPersonality
    if (entry.matchCharacterDepthPrompt && global.characterDepthPrompt) result += joiner + global.characterDepthPrompt
    if (entry.matchScenario && global.scenario) result += joiner + global.scenario
    if (entry.matchCreatorNotes && global.creatorNotes) result += joiner + global.creatorNotes

    if (this.inject.length) result += joiner + this.inject.join(joiner)
    if (includeRecurse && this.recurse.length) result += joiner + this.recurse.join(joiner)
    return result
  }
}

/**
 * 计算一个条目在给定缓冲里的命中分（用于包含组的 group scoring）。
 *
 * 规则与 ST 的 WorldInfoBuffer.getScore 一致：
 *  - AND_ANY：主关键词命中数 + 次关键词命中数
 *  - AND_ALL：次关键词全中时才加分，否则只算主关键词
 *  - 其余逻辑：只算主关键词
 *
 * @param {ScanBuffer} buffer 扫描缓冲
 * @param {Record<string, any>} entry 条目
 * @param {number} depth 扫描深度
 * @param {Object} settings 全局设置
 * @returns {number} 命中分
 */
function scoreEntry(buffer, entry, depth, settings) {
  const text = buffer.text(entry, depth)
  let primary = 0
  let secondary = 0
  for (const key of entry.key) if (matchKey(text, key, entry, settings)) primary++
  for (const key of entry.keysecondary) if (matchKey(text, key, entry, settings)) secondary++

  if (!entry.key.length) return 0
  if (!entry.keysecondary.length) return primary

  switch (entry.selectiveLogic) {
    case WORLD_INFO_LOGIC.AND_ANY:
      return primary + secondary
    case WORLD_INFO_LOGIC.AND_ALL:
      return secondary === entry.keysecondary.length ? primary + secondary : primary
    default:
      return primary
  }
}

/**
 * 定时效果判定：sticky / cooldown / delay。
 *
 * 效果存在 chatMetadata.timedWorldInfo[type][key] 里，形如 { hash, start, end, protected }，
 * end 是「聊到第几条结束」。聊天没有前进时（消息数 <= start 且非 protected）效果会被丢弃，
 * 与 ST 的 timedEffects.cleanUp 一致。
 *
 * @param {string[]} chatLines 聊天文本（索引 0 = 最近一条）
 * @param {Record<string, any>} chatMetadata 会话元数据（会被就地修改）
 * @param {boolean} isDryRun 只读试跑：不写元数据
 * @returns {{ isActive: (type: string, entry: Object) => boolean, setTimedEffects: (entries: Object[]) => void }} 定时效果判定器
 */
function createTimedEffects(chatLines, chatMetadata, isDryRun) {
  const chatLength = chatLines.length
  const metadata = chatMetadata && typeof chatMetadata === 'object' ? chatMetadata : {}
  const store = metadata.timedWorldInfo && typeof metadata.timedWorldInfo === 'object'
    ? metadata.timedWorldInfo
    : (metadata.timedWorldInfo = {})
  for (const type of ['sticky', 'cooldown']) {
    if (!store[type] || typeof store[type] !== 'object') store[type] = {}
  }

  /** 由条目内容算稳定 hash，用于在元数据里认回同一个条目。 */
  const hashOf = entry => {
    const text = [entry.uid, entry.content, entry.key.join(','), entry.keysecondary.join(',')].join('\u0000')
    let hash = 0
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i)
      hash |= 0
    }
    return hash >>> 0
  }

  /** 某条目是否有该效果正在生效。 */
  function isEffectActive(type, entry) {
    if (type === 'delay') {
      const span = Number(entry.delay)
      if (!span) return false
      return chatLength < span
    }
    const span = Number(entry[type])
    if (!span) return false
    const table = store[type] || {}
    const hash = hashOf(entry)
    for (const record of Object.values(table)) {
      if (!record || typeof record !== 'object') continue
      if (String(record.hash) !== String(hash)) continue
      return chatLength < Number(record.end)
    }
    return false
  }

  /** 清理过期与失效记录。 */
  function cleanup() {
    if (isDryRun) return
    for (const type of ['sticky', 'cooldown']) {
      const table = store[type] || {}
      for (const [key, record] of Object.entries(table)) {
        if (!record || typeof record !== 'object') { delete table[key]; continue }
        if (chatLength <= Number(record.start) && !record.protected) { delete table[key]; continue }
        if (chatLength >= Number(record.end)) { delete table[key]; continue }
      }
    }
  }

  /** 激活成功后登记效果。 */
  function setTimedEffects(activatedEntries) {
    if (isDryRun) return
    for (const entry of activatedEntries) {
      for (const type of ['sticky', 'cooldown']) {
        const span = Number(entry[type])
        if (!span || span <= 0) continue
        const table = store[type]
        const key = 'wi-' + entry.uid
        if (table[key]) continue
        table[key] = {
          hash: hashOf(entry),
          start: chatLength,
          end: chatLength + span,
          protected: false,
        }
      }
    }
  }

  cleanup()
  return { isActive: isEffectActive, setTimedEffects }
}

/**
 * 包含组过滤：同一个 group 里最终只保留一个条目。
 *
 * 顺序与 ST 一致：
 *  1. 组里有 sticky 条目 -> 只留 sticky；
 *  2. 开了 group scoring -> 只留命中分最高的；
 *  3. 组已经在本轮之前激活过 -> 本轮该组的全部出局；
 *  4. groupOverride 的条目按 order 优先；
 *  5. 否则按 groupWeight 加权随机。
 *
 * @param {Record<string, any>[]} candidates 本轮候选（会被就地裁剪）
 * @param {Map<string, Record<string, any>>} activated 已激活条目
 * @param {ScanBuffer} buffer 扫描缓冲
 * @param {number} depth 扫描深度
 * @param {Object} settings 全局设置
 * @param {{ isActive: Function }} timed 定时效果判定器
 * @returns {void} 就地修改 candidates
 */
function filterByInclusionGroups(candidates, activated, buffer, depth, settings, timed) {
  const grouped = new Map()
  for (const entry of candidates) {
    if (!entry.group) continue
    const names = String(entry.group).split(/,\s*/).map(name => name.trim()).filter(Boolean)
    for (const groupName of names) {
      if (!grouped.has(groupName)) grouped.set(groupName, [])
      grouped.get(groupName).push(entry)
    }
  }
  if (grouped.size === 0) return

  const removed = new Set()

  for (const [groupName, group] of grouped) {
    const live = group.filter(entry => !removed.has(entry))

    // 1) sticky 优先
    const sticky = live.filter(entry => timed.isActive('sticky', entry))
    if (sticky.length) {
      for (const entry of live) if (!sticky.includes(entry)) removed.add(entry)
      continue
    }

    // 3) 组上一轮已激活过：本轮该组全出局
    const alreadyActivated = Array.from(activated.values()).some(entry =>
      String(entry.group || '').split(/,\s*/).map(name => name.trim()).includes(groupName))
    if (alreadyActivated) {
      for (const entry of live) removed.add(entry)
      continue
    }

    if (live.length <= 1) continue

    // 2) 组内评分：只保留最高分
    const useScoring = Boolean(settings.useGroupScoring) || live.some(entry => entry.useGroupScoring === true)
    if (useScoring) {
      const scored = []
      const unscored = []
      for (const entry of live) {
        const applies = entry.useGroupScoring === null || entry.useGroupScoring === undefined
          ? Boolean(settings.useGroupScoring)
          : Boolean(entry.useGroupScoring)
        if (applies) scored.push({ entry, score: scoreEntry(buffer, entry, depth, settings) })
        else unscored.push(entry)
      }
      if (scored.length) {
        const maxScore = Math.max.apply(null, scored.map(item => item.score))
        for (const item of scored) if (item.score < maxScore) removed.add(item.entry)
      }
    }

    const remaining = live.filter(entry => !removed.has(entry))
    if (remaining.length <= 1) continue

    // 4) groupOverride 优先
    const overrides = remaining.filter(entry => entry.groupOverride).sort((a, b) => b.order - a.order || a.uid - b.uid)
    if (overrides.length) {
      for (const entry of remaining) if (entry !== overrides[0]) removed.add(entry)
      continue
    }

    // 5) 加权随机
    const totalWeight = remaining.reduce((sum, entry) => sum + (Number(entry.groupWeight) || DEFAULT_WEIGHT), 0)
    if (totalWeight <= 0) {
      for (const entry of remaining.slice(1)) removed.add(entry)
      continue
    }
    let roll = Math.random() * totalWeight
    let winner = remaining[remaining.length - 1]
    for (const entry of remaining) {
      roll -= Number(entry.groupWeight) || DEFAULT_WEIGHT
      if (roll <= 0) { winner = entry; break }
    }
    for (const entry of remaining) if (entry !== winner) removed.add(entry)
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    if (removed.has(candidates[i])) candidates.splice(i, 1)
  }
}

/** 角色枚举转名字：0=system 1=user 2=assistant（ST 的 extension_prompt_roles）。 */
function roleName(role) {
  const value = Number(role)
  if (value === 1) return 'user'
  if (value === 2) return 'assistant'
  return 'system'
}

/**
 * 扫描世界书，算出这一轮该插入哪些条目、插到哪里。
 *
 * @param {Record<string, Record<string, any>>|Array} entries 条目表（uid → 条目）或条目数组
 * @param {Object} [options] 扫描选项
 * @param {string[]} [options.chatLines]  聊天文本，**从旧到新**（内部会反转为由近及远）
 * @param {number} [options.scanDepth=4]  扫描最近多少条消息
 * @param {number} [options.budget=0]     token 预算；<=0 表示不限制
 * @param {boolean} [options.caseSensitive=false] 全局大小写敏感
 * @param {boolean} [options.matchWholeWords=false] 全局整词匹配
 * @param {number} [options.maxRecursionDepth=3]  递归层数上限
 * @param {boolean} [options.recursive=true]      是否启用递归
 * @param {boolean} [options.useGroupScoring=false] 是否启用包含组评分
 * @param {string} [options.trigger='normal']     触发类型，用于条目 triggers 过滤
 * @param {string} [options.charName='']          角色名（供宏与 names 使用）
 * @param {string} [options.userName='']          用户名
 * @param {string} [options.personaDescription='']
 * @param {string} [options.characterDescription='']
 * @param {string} [options.characterPersonality='']
 * @param {string} [options.characterDepthPrompt='']
 * @param {string} [options.scenario='']
 * @param {string} [options.creatorNotes='']
 * @param {Record<string, any>} [options.chatMetadata] 会话元数据（定时效果写这里）
 * @param {boolean} [options.dryRun=true] 干跑：不写定时效果、不落任何状态
 * @param {boolean} [options.fresh=false] 丢弃会话里残留的定时效果，重新开始
 * @param {() => number} [options.random] 随机数源，测试可注入
 * @returns {{ before: string[], after: string[], atDepth: {text: string, depth: number, role: string}[], anTop: string[], anBottom: string[], activated: number[], tokens: number }} 扫描结果
 * @throws {Error} entries 既不是对象也不是数组时抛出
 */
export function scanWorldInfo(entries, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const source = entries && typeof entries === 'object' ? entries : null
  if (!source) throw new Error('scanWorldInfo 需要条目表（uid → 条目）')

  const rawList = Array.isArray(source) ? source : Object.values(source)
  const all = rawList
    .filter(entry => entry && typeof entry === 'object')
    .map((entry, index) => normalizeWorldbookEntry(entry, Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : index))
    .filter(entry => !entry.disable)

  const empty = { before: [], after: [], atDepth: [], anTop: [], anBottom: [], activated: [], tokens: 0 }
  if (all.length === 0) return empty

  const random = typeof opts.random === 'function' ? opts.random : Math.random
  const settings = {
    caseSensitive: Boolean(opts.caseSensitive),
    matchWholeWords: Boolean(opts.matchWholeWords),
    useGroupScoring: Boolean(opts.useGroupScoring),
  }
  const scanDepth = Number.isFinite(Number(opts.scanDepth)) ? Math.max(0, Math.min(Number(opts.scanDepth), MAX_SCAN_DEPTH)) : 4
  const budget = Number.isFinite(Number(opts.budget)) ? Math.max(0, Number(opts.budget)) : 0
  const maxRecursion = Number.isFinite(Number(opts.maxRecursionDepth))
    ? Math.max(0, Math.min(Number(opts.maxRecursionDepth), MAX_RECURSION))
    : 3
  const recursive = opts.recursive !== false
  const trigger = String(opts.trigger || 'normal')

  // ST 的缓冲索引 0 = 最近一条；调用方给的是旧→新，这里反转
  const chatInput = Array.isArray(opts.chatLines) ? opts.chatLines.map(line => String(line)) : []
  const chatLines = chatInput.slice().reverse()

  const globalData = {
    personaDescription: String(opts.personaDescription || ''),
    characterDescription: String(opts.characterDescription || ''),
    characterPersonality: String(opts.characterPersonality || ''),
    characterDepthPrompt: String(opts.characterDepthPrompt || ''),
    scenario: String(opts.scenario || ''),
    creatorNotes: String(opts.creatorNotes || ''),
  }

  const buffer = new ScanBuffer(chatLines, globalData)
  if (opts.injectText) buffer.addInject(String(opts.injectText))

  const chatMetadata = opts.chatMetadata && typeof opts.chatMetadata === 'object' ? opts.chatMetadata : {}
  if (opts.fresh && chatMetadata.timedWorldInfo) delete chatMetadata.timedWorldInfo
  const timed = createTimedEffects(chatLines, chatMetadata, opts.dryRun !== false)

  // 按 order 从大到小排序：装填与展示都以这个顺序为准
  const sorted = all.slice().sort((a, b) => b.order - a.order || a.uid - b.uid)

  const activated = new Map()
  const failedProbability = new Set()
  let usedTokens = 0
  let overflowed = false

  for (let layer = 0; layer <= maxRecursion; layer++) {
    const candidates = []
    const depth = scanDepth

    for (const entry of sorted) {
      if (activated.has(entry.uid) || failedProbability.has(entry)) continue

      // 生成类型过滤（continue / regenerate 等）
      if (Array.isArray(entry.triggers) && entry.triggers.length > 0 && !entry.triggers.includes(trigger)) continue

      // 递归层专用标记
      if (layer > 0) {
        if (entry.excludeRecursion) continue
        if (Number(entry.delayUntilRecursion) > layer) continue
      } else if (Number(entry.delayUntilRecursion) > 0) {
        continue
      }

      const isSticky = timed.isActive('sticky', entry)
      if (timed.isActive('delay', entry)) continue
      if (timed.isActive('cooldown', entry) && !isSticky) continue

      if (entry.constant || isSticky) {
        candidates.push(entry)
        continue
      }

      if (entry.key.length === 0) continue

      const text = buffer.text(entry, depth)
      const primaryHit = entry.key.some(key => matchKey(text, key, entry, settings))
      if (!primaryHit) continue

      if (entry.keysecondary.length === 0) {
        candidates.push(entry)
        continue
      }

      // 次关键词组合逻辑
      let anyMatch = false
      let allMatch = true
      let matched = false
      for (const key of entry.keysecondary) {
        const hit = matchKey(text, key, entry, settings)
        if (hit) anyMatch = true
        if (!hit) allMatch = false
        if (entry.selectiveLogic === WORLD_INFO_LOGIC.AND_ANY && hit) { matched = true; break }
        if (entry.selectiveLogic === WORLD_INFO_LOGIC.NOT_ALL && !hit) { matched = true; break }
      }
      if (!matched) {
        if (entry.selectiveLogic === WORLD_INFO_LOGIC.NOT_ANY && !anyMatch) matched = true
        if (entry.selectiveLogic === WORLD_INFO_LOGIC.AND_ALL && allMatch) matched = true
      }
      if (matched) candidates.push(entry)
    }

    if (candidates.length === 0) break

    // 包含组过滤只在本轮候选之间进行
    filterByInclusionGroups(candidates, activated, buffer, depth, settings, timed)

    // 概率与预算：按 order 从大到小依次装填
    const layerActivated = []
    for (const entry of candidates) {
      const skipProbability = !entry.useProbability || entry.probability >= 100 || timed.isActive('sticky', entry)
      if (!skipProbability && random() * 100 > entry.probability) {
        failedProbability.add(entry)
        continue
      }

      const cost = estimateTokens(entry.content)
      if (!entry.ignoreBudget && budget > 0 && usedTokens + cost >= budget) {
        overflowed = true
        continue
      }

      activated.set(entry.uid, entry)
      usedTokens += cost
      layerActivated.push(entry)
    }

    if (overflowed) break

    // 递归：激活条目的正文并入扫描缓冲；preventRecursion 的不参与
    const forRecursion = layerActivated.filter(entry => !entry.preventRecursion)
    if (!recursive || forRecursion.length === 0) break
    buffer.addRecurse(forRecursion.map(entry => entry.content).join('\n'))
  }

  timed.setTimedEffects(Array.from(activated.values()))

  // —— 分槽 ——
  const before = []
  const after = []
  const anTop = []
  const anBottom = []
  const depthBuckets = new Map()
  let tokens = 0

  const ordered = Array.from(activated.values()).sort((a, b) => b.order - a.order || a.uid - b.uid)
  for (const entry of ordered) {
    if (!entry.content) continue
    tokens += estimateTokens(entry.content)
    switch (entry.position) {
      case WORLD_INFO_POSITION.before:
        // 从 999 往 1 追加：unshift 保证 order 大的在前
        before.unshift(entry.content)
        break
      case WORLD_INFO_POSITION.after:
        after.unshift(entry.content)
        break
      case WORLD_INFO_POSITION.ANTop:
        anTop.unshift(entry.content)
        break
      case WORLD_INFO_POSITION.ANBottom:
        anBottom.unshift(entry.content)
        break
      case WORLD_INFO_POSITION.atDepth: {
        const depthValue = Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : DEFAULT_DEPTH
        const role = roleName(entry.role)
        const bucketKey = depthValue + '|' + role
        if (!depthBuckets.has(bucketKey)) depthBuckets.set(bucketKey, { depth: depthValue, role, texts: [] })
        depthBuckets.get(bucketKey).texts.unshift(entry.content)
        break
      }
      default:
        // EMTop / EMBottom / outlet 不进这四个槽，跳过
        break
    }
  }

  const atDepth = Array.from(depthBuckets.values())
    .map(bucket => ({ text: bucket.texts.join('\n'), depth: bucket.depth, role: bucket.role }))
    .sort((a, b) => b.depth - a.depth)

  return {
    before,
    after,
    atDepth,
    anTop,
    anBottom,
    activated: Array.from(activated.keys()),
    tokens,
  }
}

/**
 * 把多本书的条目合并成一张 uid 全局唯一的表。
 *
 * 各本书的 uid 会重复，合并时必须重新编号，否则激活结果分不清来自哪本书。
 * 返回 index 用于把扫描结果的 uid 映射回「哪本书的第几条」。
 *
 * @param {Array<{ name: string, entries: Record<string, any> }>} books 书目数组
 * @returns {{ entries: Record<string, any>, index: Map<number, { book: string, uid: number }>, names: string[] }}
 *          合并后的条目表、反查表与书名列表
 */
export function mergeWorldbookEntries(books) {
  const entries = {}
  const index = new Map()
  const names = []
  let next = 0
  for (const book of Array.isArray(books) ? books : []) {
    if (!book || !book.entries) continue
    names.push(String(book.name || ''))
    for (const [key, entry] of Object.entries(book.entries)) {
      if (!entry || typeof entry !== 'object') continue
      const uid = next++
      entries[String(uid)] = { ...entry, uid }
      index.set(uid, { book: String(book.name || ''), uid: Number.isFinite(Number(key)) ? Number(key) : uid })
    }
  }
  return { entries, index, names }
}

/**
 * 世界书仓库：一个目录一本书，文件名即书名。
 *
 * 文件内容是 ST 原生 { entries: { "0": {...} } }，书级启用状态不进文件。
 *
 * @param {Object} state 插件状态（需要 state.layout.worlds）
 * @returns {{ dir: string, names: Function, read: Function, write: Function, remove: Function, has: Function, list: Function }} 仓库对象
 * @throws {Error} state 缺少 layout.worlds 时抛出
 */
export function createWorldbookStore(state) {
  if (!state || !state.layout || !state.layout.worlds) throw new Error('createWorldbookStore 需要 state.layout.worlds')
  const dir = state.layout.worlds
  const fileOf = name => join(dir, safeName(name, 'worldbook') + '.json')

  return {
    dir,
    /** 全部书名（按 mtime 倒序）。 */
    names() {
      return listJsonFiles(dir).map(item => item.name)
    },
    /**
     * 读一本书。
     * @param {string} name 书名
     * @returns {{ name: string, entries: Record<string, any> }|null} 不存在返回 null
     */
    read(name) {
      const file = fileOf(name)
      if (!existsSync(file)) return null
      const { entries } = loadWorldbookFromFile(file)
      return { name, entries }
    },
    /**
     * 写一本书（只写 ST 原生 entries，不夹带插件私有字段）。
     * @param {string} name 书名
     * @param {{ entries: Record<string, any> }} book 书内容
     * @returns {{ name: string, entries: Record<string, any> }} 落盘后的书
     */
    write(name, book) {
      const normalized = normalizeWorldbook(book || {}, name)
      writeJson(fileOf(name), { entries: normalized.entries })
      return { name, entries: normalized.entries }
    },
    /** 删除一本书。 */
    remove(name) {
      removeFile(fileOf(name))
    },
    /** 书是否存在。 */
    has(name) {
      return existsSync(fileOf(name))
    },
    /** 列出全部书（含条目数）。 */
    list() {
      return this.names().map(name => {
        const book = this.read(name)
        return { name, entries: book ? Object.keys(book.entries).length : 0 }
      })
    },
  }
}
