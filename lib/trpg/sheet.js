/**
 * 角色卡数值管理：HP / 资源 / 状态 / 物品。
 *
 * 设计原则（来自 TrpgRecode 的 GM 协议）：数值由工具精确更新，不靠模型记忆。
 * 所以这里每一个写操作都返回「改了哪个字段、旧值→新值」，让模型能核对，
 * 也让日志能记清。
 *
 * 存盘位置：<dataRoot>/trpg/<会话>/sheets.json，内容是 { sheets: Sheet[] }。
 * 角色卡与 ST 角色卡（characters/）是两套东西：ST 角色卡是人格设定，
 * 跑团角色卡是数值面板，一个角色可以同时有两者，用 stCharacterId 关联。
 */
import { readDoc, writeDoc, makeId } from './persist.js'
import { nowIso, clamp } from '../util.js'
import { attributeIcon, attributeName, statusIcon, itemIcon, kindIcon, METER_ASSETS } from './icons.js'
import { ATTRIBUTE_NAMES } from './icons.js'

/** 六维键的规范顺序，用于展示与缺省补全。 */
export const ATTRIBUTE_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha']

/**
 * 六维键的中文名。
 * 单一事实来源在 icons.js 的 ATTRIBUTE_NAMES，这里只做再导出，避免两份表漂移。
 */
export const ATTRIBUTE_LABELS = ATTRIBUTE_NAMES

/** 状态可以设置在哪个槽位：影响判定时的提示，不做强制。 */
export const STATUS_NAME_ALIASES = {
  poison: '中毒',
  poisoned: '中毒',
  stun: '眩晕',
  stunned: '眩晕',
  bleed: '流血',
  bleeding: '流血',
  prone: '倒地',
  sleep: '睡眠',
  asleep: '睡眠',
  fear: '恐惧',
  feared: '恐惧',
  charm: '魅惑',
  charmed: '魅惑',
  invisible: '隐形',
  blinded: '目盲',
  deafened: '耳聋',
  paralyzed: '麻痹',
  restrained: '束缚',
  exhaustion: '力竭',
}

/**
 * 把状态名归一成中文（已是中文就原样返回）。
 * @param {string} name 状态名
 * @returns {string} 中文状态名
 */
export function normalizeStatusName(name) {
  const text = String(name || '').trim()
  if (!text) return ''
  const alias = STATUS_NAME_ALIASES[text.toLowerCase()]
  return alias || text
}

/** 数字归一化：非法值返回兜底并夹在范围内。 */
function intInRange(value, fallback, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return clamp(Math.trunc(n), lo, hi)
}

/** 把任意输入整理成 { cur, max } 资源对。 */
function resourcePair(input, fallbackMax) {
  const source = input && typeof input === 'object' ? input : {}
  const max = Math.max(0, intInRange(source.max, fallbackMax, 0, 1000000))
  const cur = clamp(intInRange(source.cur !== undefined ? source.cur : source.current, max, 0, 1000000), 0, Math.max(0, max))
  return { cur, max }
}

/**
 * 把 { name, duration } 或纯字符串整理成结构化状态条目。
 * @param {string|Object} input 状态输入
 * @returns {{ name: string, duration: number|null, desc: string }|null} 归一化状态；空值返回 null
 */
export function normalizeStatus(input) {
  if (input === null || input === undefined) return null
  if (typeof input === 'string') {
    const name = normalizeStatusName(input)
    return name ? { name, duration: null, desc: '' } : null
  }
  if (typeof input !== 'object') return null
  const name = normalizeStatusName(input.name || input.label || input.status || '')
  if (!name) return null
  const rawDuration = input.duration
  const duration = rawDuration === undefined || rawDuration === null || rawDuration === '' ? null : intInRange(rawDuration, null, 0, 100000)
  return { name, duration, desc: String(input.desc || input.description || '').trim() }
}

/**
 * 规范化一件物品。
 * @param {string|Object} input 物品输入（'火把' 或 { name, qty, desc }）
 * @returns {{ name: string, qty: number, desc: string }|null} 归一化物品；无名字返回 null
 */
export function normalizeItem(input) {
  if (input === null || input === undefined) return null
  if (typeof input === 'string') {
    const name = input.trim()
    return name ? { name, qty: 1, desc: '' } : null
  }
  if (typeof input !== 'object') return null
  const name = String(input.name || input.label || '').trim()
  if (!name) return null
  return {
    name,
    qty: Math.max(0, intInRange(input.qty !== undefined ? input.qty : input.count, 1, 0, 1000000)),
    desc: String(input.desc || input.description || '').trim(),
  }
}

/** 属性表归一化：只保留数字值，缺省六维补 10。 */
function normalizeAttributes(input, system) {
  const source = input && typeof input === 'object' ? input : {}
  const out = {}
  const keys = system === 'coc7e'
    ? ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu']
    : ATTRIBUTE_KEYS
  for (const key of keys) {
    const raw = source[key]
    const n = Number(raw)
    out[key] = Number.isFinite(n) ? Math.trunc(n) : (system === 'coc7e' ? 50 : 10)
  }
  // 保留调用方额外塞进来的键（自定义体系）
  for (const [key, value] of Object.entries(source)) {
    if (Object.prototype.hasOwnProperty.call(out, key)) continue
    const n = Number(value)
    if (Number.isFinite(n)) out[key] = Math.trunc(n)
  }
  return out
}

/** 技能表归一化：名称→数值。 */
function normalizeSkills(input) {
  const source = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    const name = String(key).trim()
    if (!name) continue
    const n = Number(value)
    if (Number.isFinite(n)) out[name] = Math.trunc(n)
  }
  return out
}

/**
 * 建一张跑团角色卡。
 * @param {{
 *   name: string,
 *   system?: string,
 *   attributes?: Object,
 *   skills?: Object,
 *   hp?: { cur?: number, max?: number } | number,
 *   maxHp?: number,
 *   mp?: { cur?: number, max?: number },
 *   ac?: number,
 *   items?: Array<string|Object>,
 *   status?: Array<string|Object>,
 *   notes?: string,
 *   kind?: 'pc'|'npc'|'enemy'|'ally',
 *   stCharacterId?: string,
 *   id?: string,
 * }} input
 * @returns {Object} 规范化后的角色卡（未落盘）
 * @throws {Error} 缺少名字时抛中文错误
 */
export function createSheet(input = {}) {
  const name = String(input.name || '').trim()
  if (!name) throw new Error('角色卡必须有名字（name）')
  const system = String(input.system || 'dnd5e').trim() || 'dnd5e'

  const hpInput = input.hp !== undefined && input.hp !== null && typeof input.hp === 'object'
    ? input.hp
    : { cur: input.hp, max: input.maxHp }
  const fallbackMax = Number.isFinite(Number(input.maxHp)) ? Number(input.maxHp) : 10
  const hp = resourcePair(hpInput, fallbackMax)

  const items = []
  for (const raw of Array.isArray(input.items) ? input.items : []) {
    const item = normalizeItem(raw)
    if (item) items.push(item)
  }
  const status = []
  for (const raw of Array.isArray(input.status) ? input.status : []) {
    const entry = normalizeStatus(raw)
    if (entry) status.push(entry)
  }

  const sheet = {
    id: String(input.id || makeId('sheet')),
    name,
    system,
    kind: ['pc', 'npc', 'enemy', 'ally'].includes(input.kind) ? input.kind : 'pc',
    hp,
    ac: Number.isFinite(Number(input.ac)) ? Math.trunc(Number(input.ac)) : 10,
    attributes: normalizeAttributes(input.attributes, system),
    skills: normalizeSkills(input.skills),
    status,
    items,
    notes: String(input.notes || ''),
    stCharacterId: input.stCharacterId ? String(input.stCharacterId) : null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  if (input.mp !== undefined) sheet.mp = resourcePair(input.mp, 0)
  return sheet
}

/** 读会话全部角色卡。 */
function readSheetsDoc(state, sessionId) {
  const doc = readDoc(state, sessionId, 'sheets', null)
  if (!doc || !Array.isArray(doc.sheets)) return { sheets: [] }
  return doc
}

/**
 * 列出会话里的全部角色卡。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @returns {Array<Object>} 角色卡数组（浅拷贝）
 */
export function listSheets(state, sessionId) {
  return readSheetsDoc(state, sessionId).sheets.map((sheet) => ({ ...sheet }))
}

/**
 * 按 id 或名字查一张角色卡。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @param {string} idOrName 角色 id 或名字（大小写不敏感，允许唯一前缀匹配）
 * @returns {Object|null} 找到返回副本，否则 null
 */
export function findSheet(state, sessionId, idOrName) {
  const needle = String(idOrName || '').trim().toLowerCase()
  if (!needle) return null
  const sheets = readSheetsDoc(state, sessionId).sheets
  const exact = sheets.find((sheet) => sheet.id.toLowerCase() === needle || sheet.name.toLowerCase() === needle)
  if (exact) return { ...exact }
  const partial = sheets.filter((sheet) => sheet.name.toLowerCase().includes(needle) || sheet.id.toLowerCase().includes(needle))
  return partial.length === 1 ? { ...partial[0] } : null
}

/**
 * 保存一张角色卡（按 id 覆盖，不存在则追加）。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @param {Object} sheet 角色卡
 * @returns {Object} 写入后的角色卡
 */
export function saveSheet(state, sessionId, sheet) {
  const doc = readSheetsDoc(state, sessionId)
  const next = { ...sheet, updatedAt: nowIso() }
  const index = doc.sheets.findIndex((item) => item.id === next.id)
  if (index >= 0) doc.sheets[index] = next
  else doc.sheets.push(next)
  writeDoc(state, sessionId, 'sheets', doc)
  return next
}

/**
 * 新建并落盘一张角色卡。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @param {Object} input createSheet 的参数
 * @returns {Object} 写入后的角色卡
 * @throws {Error} 缺少名字或同名角色已存在时抛中文错误
 */
export function addSheet(state, sessionId, input) {
  const sheet = createSheet(input)
  const doc = readSheetsDoc(state, sessionId)
  if (doc.sheets.some((item) => item.name === sheet.name)) {
    throw new Error('已经有叫「' + sheet.name + '」的角色卡了，换一个名字，或用 trpg_update_sheet 改已有的那张')
  }
  doc.sheets.push(sheet)
  writeDoc(state, sessionId, 'sheets', doc)
  return sheet
}

/**
 * 删除一张角色卡。
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] 会话 id
 * @param {string} idOrName 角色 id 或名字
 * @returns {boolean} 是否删掉了
 */
export function removeSheet(state, sessionId, idOrName) {
  const sheet = findSheet(state, sessionId, idOrName)
  if (!sheet) return false
  const doc = readSheetsDoc(state, sessionId)
  doc.sheets = doc.sheets.filter((item) => item.id !== sheet.id)
  writeDoc(state, sessionId, 'sheets', doc)
  return true
}

/** 记录一条变更，供返回给模型核对。 */
function change(changes, field, before, after) {
  changes.push({ field, before, after })
}

/**
 * 更新角色卡。只处理显式给出的字段，其余原样保留。
 * HP 变化夹在 [0, maxHp]；状态按名字合并（同名刷新持续时间）。
 * @param {Object} sheet 现有角色卡（不会被就地修改）
 * @param {{
 *   name?: string, hp?: number|{cur?:number,max?:number}, maxHp?: number,
 *   hpDelta?: number, ac?: number, mp?: number|{cur?:number,max?:number},
 *   mpDelta?: number, attributes?: Object, skills?: Object, notes?: string,
 *   status?: Array<string|Object>, removeStatus?: string[],
 *   items?: Array<string|Object>, removeItem?: string[], kind?: string,
 *   stCharacterId?: string,
 * }} patch 变更
 * @returns {{ sheet: Object, changes: Array<{field: string, before: any, after: any}>, notices: string[] }}
 *   返回新角色卡、逐项变更清单、需要提醒模型的注意事项
 */
export function updateSheet(sheet, patch = {}) {
  if (!sheet || typeof sheet !== 'object') throw new Error('updateSheet 需要一个角色卡对象')
  const next = JSON.parse(JSON.stringify(sheet))
  const changes = []
  const notices = []

  if (patch.name !== undefined && String(patch.name).trim() && String(patch.name).trim() !== next.name) {
    change(changes, 'name', next.name, String(patch.name).trim())
    next.name = String(patch.name).trim()
  }
  if (patch.kind !== undefined && ['pc', 'npc', 'enemy', 'ally'].includes(patch.kind)) {
    change(changes, 'kind', next.kind, patch.kind)
    next.kind = patch.kind
  }
  if (patch.stCharacterId !== undefined) {
    const value = patch.stCharacterId ? String(patch.stCharacterId) : null
    change(changes, 'stCharacterId', next.stCharacterId, value)
    next.stCharacterId = value
  }

  // HP：支持直接设值、给 {cur,max}、或给增量
  if (patch.maxHp !== undefined && Number.isFinite(Number(patch.maxHp))) {
    const max = Math.max(0, Math.trunc(Number(patch.maxHp)))
    change(changes, 'hp.max', next.hp.max, max)
    next.hp.max = max
    if (next.hp.cur > max) {
      change(changes, 'hp.cur', next.hp.cur, max)
      next.hp.cur = max
      notices.push('最大值下调，当前生命被夹到新上限')
    }
  }
  if (patch.hp !== undefined && patch.hp !== null) {
    if (typeof patch.hp === 'object') {
      if (patch.hp.max !== undefined && Number.isFinite(Number(patch.hp.max))) {
        const max = Math.max(0, Math.trunc(Number(patch.hp.max)))
        change(changes, 'hp.max', next.hp.max, max)
        next.hp.max = max
      }
      if (patch.hp.cur !== undefined && patch.hp.cur !== null) {
        const cur = clamp(Math.trunc(Number(patch.hp.cur) || 0), 0, Math.max(0, next.hp.max))
        change(changes, 'hp.cur', next.hp.cur, cur)
        next.hp.cur = cur
      }
    } else if (Number.isFinite(Number(patch.hp))) {
      const cur = clamp(Math.trunc(Number(patch.hp)), 0, Math.max(0, next.hp.max))
      change(changes, 'hp.cur', next.hp.cur, cur)
      next.hp.cur = cur
    }
  }
  if (patch.hpDelta !== undefined && Number.isFinite(Number(patch.hpDelta)) && Number(patch.hpDelta) !== 0) {
    const before = next.hp.cur
    const after = clamp(before + Math.trunc(Number(patch.hpDelta)), 0, Math.max(0, next.hp.max))
    if (after !== before) {
      change(changes, 'hp.cur', before, after)
      next.hp.cur = after
      if (after === 0 && before > 0) notices.push('生命归零，按规则进入濒死/死亡流程')
      if (after === next.hp.max && before < next.hp.max) notices.push('生命已满')
    }
  }

  // 资源池（mp / 自定义）：结构同 hp
  if (patch.mp !== undefined && patch.mp !== null) {
    const existing = next.mp || { cur: 0, max: 0 }
    const merged = { ...existing }
    if (typeof patch.mp === 'object') {
      if (patch.mp.max !== undefined) merged.max = Math.max(0, Math.trunc(Number(patch.mp.max) || 0))
      if (patch.mp.cur !== undefined) merged.cur = Math.trunc(Number(patch.mp.cur) || 0)
    } else {
      merged.cur = Math.trunc(Number(patch.mp) || 0)
    }
    merged.cur = clamp(merged.cur, 0, Math.max(0, merged.max))
    change(changes, 'mp', existing, merged)
    next.mp = merged
  }
  if (patch.mpDelta !== undefined && Number.isFinite(Number(patch.mpDelta)) && Number(patch.mpDelta) !== 0) {
    const existing = next.mp || { cur: 0, max: 0 }
    const before = existing.cur
    const after = clamp(before + Math.trunc(Number(patch.mpDelta)), 0, Math.max(0, existing.max))
    if (after !== before) {
      change(changes, 'mp.cur', before, after)
      next.mp = { ...existing, cur: after }
      if (after === 0 && before > 0) notices.push('资源耗尽')
    }
  }

  if (patch.ac !== undefined && Number.isFinite(Number(patch.ac))) {
    const ac = Math.trunc(Number(patch.ac))
    if (ac !== next.ac) {
      change(changes, 'ac', next.ac, ac)
      next.ac = ac
    }
  }
  if (patch.attributes && typeof patch.attributes === 'object') {
    for (const [key, value] of Object.entries(patch.attributes)) {
      const n = Number(value)
      if (!Number.isFinite(n)) continue
      const before = next.attributes[key]
      if (before !== Math.trunc(n)) {
        change(changes, 'attributes.' + key, before, Math.trunc(n))
        next.attributes[key] = Math.trunc(n)
      }
    }
  }
  if (patch.skills && typeof patch.skills === 'object') {
    for (const [key, value] of Object.entries(patch.skills)) {
      const n = Number(value)
      if (!Number.isFinite(n)) continue
      const before = next.skills[key]
      if (before !== Math.trunc(n)) {
        change(changes, 'skills.' + key, before, Math.trunc(n))
        next.skills[key] = Math.trunc(n)
      }
    }
  }
  if (patch.notes !== undefined) {
    const notes = String(patch.notes)
    if (notes !== next.notes) {
      change(changes, 'notes', next.notes, notes)
      next.notes = notes
    }
  }

  // 状态：按名字合并，同名刷新持续时间；也支持移除
  if (Array.isArray(patch.status) && patch.status.length) {
    for (const raw of patch.status) {
      const entry = normalizeStatus(raw)
      if (!entry) continue
      const index = next.status.findIndex((item) => item.name === entry.name)
      if (index >= 0) {
        const before = next.status[index]
        const merged = { ...before, duration: entry.duration !== null ? entry.duration : before.duration, desc: entry.desc || before.desc }
        change(changes, 'status.' + entry.name, before, merged)
        next.status[index] = merged
      } else {
        change(changes, 'status.' + entry.name, null, entry)
        next.status.push(entry)
      }
    }
  }
  if (Array.isArray(patch.removeStatus) && patch.removeStatus.length) {
    for (const raw of patch.removeStatus) {
      const name = normalizeStatusName(raw)
      const index = next.status.findIndex((item) => item.name === name)
      if (index >= 0) {
        change(changes, 'status.' + name, next.status[index], null)
        next.status.splice(index, 1)
      }
    }
  }
  if ((Array.isArray(patch.status) && patch.status.length) || (Array.isArray(patch.removeStatus) && patch.removeStatus.length)) {
    notices.push(next.status.length ? '角色现在带有状态：' + next.status.map((item) => item.name).join('、') : '角色目前没有负面状态')
  }

  // 物品：同名合并数量
  if (Array.isArray(patch.items) && patch.items.length) {
    for (const raw of patch.items) {
      const item = normalizeItem(raw)
      if (!item) continue
      const index = next.items.findIndex((entry) => entry.name === item.name)
      if (index >= 0) {
        const before = next.items[index]
        const merged = { ...before, qty: before.qty + item.qty, desc: item.desc || before.desc }
        change(changes, 'items.' + item.name, before, merged)
        next.items[index] = merged
      } else {
        change(changes, 'items.' + item.name, null, item)
        next.items.push(item)
      }
    }
  }
  if (Array.isArray(patch.removeItem) && patch.removeItem.length) {
    for (const raw of patch.removeItem) {
      const name = String(raw).trim()
      const index = next.items.findIndex((entry) => entry.name === name)
      if (index < 0) continue
      const before = next.items[index]
      const nextQty = before.qty - 1
      if (nextQty <= 0) {
        change(changes, 'items.' + name, before, null)
        next.items.splice(index, 1)
      } else {
        const merged = { ...before, qty: nextQty }
        change(changes, 'items.' + name, before, merged)
        next.items[index] = merged
      }
    }
  }

  if (changes.length) next.updatedAt = nowIso()
  return { sheet: next, changes, notices }
}

/** 伤害类型对应的提醒文案。 */
const DAMAGE_TYPE_HINTS = {
  火: '火焰伤害，注意可燃物与装备',
  冰: '寒冷伤害',
  雷: '雷电伤害',
  酸: '强酸伤害，可能腐蚀装备',
  毒: '毒素伤害，可能附带中毒状态',
  精神: '精神伤害，不伤肉体只伤神志',
  真实: '真实伤害，无视抗性',
  穿刺: '穿刺伤害',
  挥砍: '挥砍伤害',
  钝击: '钝击伤害',
}

/**
 * 施加伤害。
 * @param {Object} sheet 角色卡
 * @param {number} amount 伤害数值（正数表示扣血；负数会被当成治疗拒绝）
 * @param {string} [type] 伤害类型（火/冰/毒/穿刺……），仅用于文案与提示
 * @returns {{ sheet: Object, changes: Array<Object>, notices: string[], damaged: number, downed: boolean }}
 * @throws {Error} 伤害数值非法时抛中文错误
 */
export function applyDamage(sheet, amount, type) {
  const value = Math.trunc(Number(amount))
  if (!Number.isFinite(value)) throw new Error('伤害数值必须是数字，收到 ' + amount)
  if (value < 0) throw new Error('伤害不能是负数，治疗请用 healSheet')
  const result = updateSheet(sheet, { hpDelta: -value })
  const typeLabel = type ? String(type).trim() : ''
  const notices = result.notices.slice()
  if (typeLabel && DAMAGE_TYPE_HINTS[typeLabel]) notices.push(DAMAGE_TYPE_HINTS[typeLabel])
  const before = sheet.hp.cur
  const after = result.sheet.hp.cur
  const damaged = before - after
  if (damaged < value) notices.push('实际只扣了 ' + damaged + ' 点（剩余生命不足 ' + value + '），溢出伤害不额外记录')
  const downed = after <= 0
  return { sheet: result.sheet, changes: result.changes, notices, damaged, downed }
}

/**
 * 治疗。
 * @param {Object} sheet 角色卡
 * @param {number} amount 治疗量
 * @returns {{ sheet: Object, changes: Array<Object>, notices: string[], healed: number }}
 * @throws {Error} 治疗量非法时抛中文错误
 */
export function healSheet(sheet, amount) {
  const value = Math.trunc(Number(amount))
  if (!Number.isFinite(value)) throw new Error('治疗量必须是数字，收到 ' + amount)
  if (value < 0) throw new Error('治疗量不能是负数，扣血请用 applyDamage')
  const before = sheet.hp.cur
  const result = updateSheet(sheet, { hpDelta: value })
  const after = result.sheet.hp.cur
  const healed = after - before
  const notices = result.notices.slice()
  if (healed < value) notices.push('实际只回了 ' + healed + ' 点（已接近生命上限）')
  return { sheet: result.sheet, changes: result.changes, notices, healed }
}

/**
 * 获得物品（同名叠加数量）。
 * @param {Object} sheet 角色卡
 * @param {string|Object|Array<string|Object>} item 物品或物品数组
 * @returns {{ sheet: Object, changes: Array<Object>, notices: string[] }}
 * @throws {Error} 物品格式非法时抛中文错误
 */
export function addItem(sheet, item) {
  const list = Array.isArray(item) ? item : [item]
  const normalized = []
  for (const raw of list) {
    const entry = normalizeItem(raw)
    if (entry) normalized.push(entry)
  }
  if (!normalized.length) throw new Error('没有可添加的物品：每件物品至少要有名字')
  const result = updateSheet(sheet, { items: normalized })
  return { sheet: result.sheet, changes: result.changes, notices: result.notices }
}

/**
 * 移除物品（数量减 1；减到 0 删除条目）。一次可以传多个名字。
 * @param {Object} sheet 角色卡
 * @param {string|Array<string>} names 物品名
 * @returns {{ sheet: Object, changes: Array<Object>, notices: string[], missing: string[] }}
 * @throws {Error} 未给物品名时抛中文错误
 */
export function removeItem(sheet, names) {
  const list = (Array.isArray(names) ? names : [names]).map((name) => String(name || '').trim()).filter(Boolean)
  if (!list.length) throw new Error('removeItem 需要物品名字')
  const existing = new Set((sheet.items || []).map((entry) => entry.name))
  const missing = list.filter((name) => !existing.has(name))
  const result = updateSheet(sheet, { removeItem: list.filter((name) => existing.has(name)) })
  const notices = result.notices.slice()
  if (missing.length) notices.push('角色身上没有：' + missing.join('、'))
  return { sheet: result.sheet, changes: result.changes, notices, missing }
}

/**
 * 推进一轮状态持续时间（战斗每回合末调用）。
 * 有 duration 的状态减 1，减到 0 就移除；duration 为 null 表示永久，不递减。
 * @param {Object} sheet 角色卡
 * @returns {{ sheet: Object, expired: string[] }}
 */
export function tickStatuses(sheet) {
  const next = JSON.parse(JSON.stringify(sheet))
  const expired = []
  next.status = (next.status || []).filter((entry) => {
    if (entry.duration === null || entry.duration === undefined) return true
    const left = entry.duration - 1
    if (left <= 0) {
      expired.push(entry.name)
      return false
    }
    entry.duration = left
    return true
  })
  if (expired.length) next.updatedAt = nowIso()
  return { sheet: next, expired }
}

/**
 * 角色卡的展示摘要（给模型看的一行字）。
 * @param {Object} sheet 角色卡
 * @returns {string} 例如 '阿拉贡（pc）：HP 24/32 AC 16 状态 流血(2)'
 */
export function describeSheet(sheet) {
  if (!sheet) return '（无角色卡）'
  const status = (sheet.status || []).map((entry) => entry.name + (entry.duration !== null && entry.duration !== undefined ? '(' + entry.duration + ')' : '')).join(' ')
  const parts = [sheet.name + '（' + (sheet.kind || 'pc') + '）', 'HP ' + sheet.hp.cur + '/' + sheet.hp.max]
  if (sheet.mp) parts.push('MP ' + sheet.mp.cur + '/' + sheet.mp.max)
  parts.push('AC ' + sheet.ac)
  if (status) parts.push('状态 ' + status)
  return parts.join(' ')
}

/** 百分比：前端画血条用，已经算好并夹在 0..100。 */
export function percentOf(cur, max) {
  const c = Number(cur)
  const m = Number(max)
  if (!Number.isFinite(c) || !Number.isFinite(m) || m <= 0) return 0
  return clamp(Math.round((c / m) * 100), 0, 100)
}

/**
 * 把角色卡压成前端面板直接能画的形状。
 *
 * 所有派生值都算好：百分比、图标 key、中文属性名。前端不再做任何计算。
 * attributes 保留成对象（老调用方按 key 取值不会坏），同时额外给 attributeList
 * 数组（带 icon/中文名/顺序），前端直接 map 就能画图标行。
 *
 * @param {Object} sheet 角色卡
 * @returns {Object} 面板视图
 */
export function sheetPanelView(sheet) {
  const kind = sheet.kind || 'pc'
  const attributes = { ...sheet.attributes }
  const attributeList = Object.entries(attributes).map(([key, value]) => ({
    key,
    name: attributeName(key),
    value,
    icon: attributeIcon(key),
  }))
  const hpPercent = percentOf(sheet.hp.cur, sheet.hp.max)
  return {
    id: sheet.id,
    name: sheet.name,
    system: sheet.system,
    kind,
    kindIcon: kindIcon(kind),
    hp: { cur: sheet.hp.cur, max: sheet.hp.max, percent: hpPercent, bar: METER_ASSETS.health },
    mp: sheet.mp
      ? { cur: sheet.mp.cur, max: sheet.mp.max, percent: percentOf(sheet.mp.cur, sheet.mp.max), bar: METER_ASSETS.track }
      : null,
    /** 护盾/临时生命，没有就是 0；前端配合 meter_shield 画。 */
    shield: {
      cur: Number.isFinite(Number(sheet.shield && sheet.shield.cur)) ? Math.trunc(Number(sheet.shield.cur)) : 0,
      max: Number.isFinite(Number(sheet.shield && sheet.shield.max)) ? Math.trunc(Number(sheet.shield.max)) : 0,
      bar: METER_ASSETS.shield,
    },
    ac: sheet.ac,
    attributes,
    attributeList,
    skills: { ...sheet.skills },
    status: (sheet.status || []).map((entry) => entry.name),
    conditions: (sheet.status || []).map((entry) => ({
      name: entry.name,
      duration: entry.duration,
      desc: entry.desc,
      icon: statusIcon(entry.name),
    })),
    items: (sheet.items || []).map((entry) => ({
      name: entry.name,
      qty: entry.qty,
      desc: entry.desc,
      icon: itemIcon(entry.name),
    })),
    notes: sheet.notes || '',
    updatedAt: sheet.updatedAt,
  }
}
