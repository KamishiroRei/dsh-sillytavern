/**
 * 遭遇战/先攻引擎。
 *
 * 只做「谁先动、轮到谁、谁倒下了」这些机械活，叙事留给模型。
 * 原则（TrpgRecode GM 标准）：严格按先攻行动，非自己回合不插入动作；
 * 轮到敌人就行动；0 生命按规则进入濒死。
 *
 * 数据形状刻意与前端角色卡面板对齐：每个 combatant 都带 hp/status，
 * 前端可以直接拿 encounter.combatants 画先攻条，不用再查 sheets.json。
 */
import { nowIso, clamp } from '../util.js'
import { rollDice, createRng } from './dice.js'
import { kindIcon, METER_ASSETS } from './icons.js'
import { percentOf } from './sheet.js'

/** 无法行动的单位在推进回合时会被跳过。 */
function incapable(combatant) {
  if (!combatant) return true
  if (combatant.defeated) return true
  if (combatant.hp && typeof combatant.hp.cur === 'number' && combatant.hp.cur <= 0) return true
  if (combatant.incapacitated) return true
  return false
}

/** 阵营：pc/ally 为一队，enemy 为另一队，npc 中立不计入胜负。 */
function sideOf(combatant) {
  if (combatant.kind === 'enemy') return 'enemy'
  if (combatant.kind === 'pc' || combatant.kind === 'ally') return 'party'
  return 'neutral'
}

/**
 * 建一场遭遇战。
 * @param {{
 *   combatants: Array<{ id?: string, name: string, kind?: string, hp?: {cur,max}, ac?: number,
 *     initiative?: number, autoRoll?: boolean, dex?: number, status?: Array<string|Object> }>,
 *   round?: number,
 *   system?: string,
 *   rng?: () => number,
 *   seed?: number,
 * }} input
 *   combatants 里给 initiative 就用手动值；不给且 autoRoll !== false 就自动掷先攻（d20 + dex 修正）
 * @returns {Object} 遭遇战对象，含 combatants（已按先攻排序）与 currentIndex/turn
 * @throws {Error} 没有参战单位或名字重复时抛中文错误
 */
export function createEncounter(input = {}) {
  const list = Array.isArray(input.combatants) ? input.combatants : []
  if (!list.length) throw new Error('遭遇战至少需要一个参战单位')
  const rng = typeof input.rng === 'function'
    ? input.rng
    : input.seed === undefined ? Math.random : createRng(input.seed)

  const seen = new Set()
  const combatants = list.map((raw, index) => {
    const name = String(raw && raw.name ? raw.name : '').trim()
    if (!name) throw new Error('第 ' + (index + 1) + ' 个参战单位缺少名字')
    if (seen.has(name)) throw new Error('参战单位名字重复：' + name)
    seen.add(name)

    const kind = ['pc', 'npc', 'enemy', 'ally'].includes(raw.kind) ? raw.kind : 'npc'
    const hpSource = raw.hp && typeof raw.hp === 'object' ? raw.hp : {}
    const max = Math.max(0, Math.trunc(Number(hpSource.max) || 0))
    const cur = hpSource.cur === undefined ? max : clamp(Math.trunc(Number(hpSource.cur) || 0), 0, Math.max(0, max))

    let initiative = Number(raw.initiative)
    if (!Number.isFinite(initiative)) {
      if (raw.autoRoll === false) initiative = 0
      else {
        const dexMod = Math.trunc(Number(raw.dex) || 0)
        initiative = rollDice('1d20', { rng }).total + dexMod
      }
    }

    const status = []
    for (const entry of Array.isArray(raw.status) ? raw.status : []) {
      const name = typeof entry === 'string' ? entry : entry && entry.name
      if (name) status.push({ name: String(name), duration: entry && Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null })
    }

    return {
      id: raw.id ? String(raw.id) : 'cbt-' + (index + 1) + '-' + Date.now().toString(36),
      name,
      kind,
      hp: { cur, max },
      ac: Number.isFinite(Number(raw.ac)) ? Math.trunc(Number(raw.ac)) : 10,
      initiative: Math.trunc(initiative),
      status,
      acted: false,
      defeated: cur <= 0,
      incapacitated: false,
      note: '',
    }
  })

  // 先攻降序；同值时保持输入顺序（稳定排序在 Node 里天然满足）
  combatants.sort((a, b) => b.initiative - a.initiative)

  return {
    active: true,
    startedAt: nowIso(),
    system: String(input.system || 'dnd5e'),
    round: Math.max(1, Math.trunc(Number(input.round) || 1)),
    currentIndex: 0,
    combatants,
    log: [],
  }
}

/** 找一个参战单位的下标（按 id 或名字）。 */
function indexOfCombatant(encounter, idOrName) {
  const needle = String(idOrName || '').trim().toLowerCase()
  if (!needle) return -1
  return encounter.combatants.findIndex(
    (entry) => entry.id.toLowerCase() === needle || entry.name.toLowerCase() === needle,
  )
}

/**
 * 推进到下一个可行动的单位。
 * 全员都行动过则进入下一回合：重置 acted、状态持续时间 -1、重复状态记录。
 * @param {Object} encounter 遭遇战（不会被就地修改）
 * @returns {{ encounter: Object, current: Object|null, roundAdvanced: boolean, expired: Array<{name: string, status: string}>, finished: Object|null }}
 *   current 是现在该行动的单位；roundAdvanced 表示这轮换回合了；
 *   expired 是本回合结束到期的状态；finished 非空表示战斗结束（{ type, text }）。
 */
export function nextTurn(encounter) {
  if (!encounter || !encounter.active) throw new Error('这场遭遇战已经结束了，用 trpg_start_encounter 开新的一场')
  const next = JSON.parse(JSON.stringify(encounter))
  const units = next.combatants
  const currentIndex = clamp(Math.trunc(Number(next.currentIndex) || 0), 0, Math.max(0, units.length - 1))
  if (units[currentIndex]) units[currentIndex].acted = true

  let nextIndex = -1
  for (let step = 1; step <= units.length; step += 1) {
    const index = (currentIndex + step) % units.length
    if (!units[index]) continue
    if (units[index].acted || incapable(units[index])) continue
    nextIndex = index
    break
  }

  if (nextIndex >= 0) {
    next.currentIndex = nextIndex
    return { encounter: next, current: { ...units[nextIndex] }, roundAdvanced: false, expired: [], finished: checkFinished(next) }
  }

  // 这一轮走得差不多了，检查战场是否已经分出胜负
  const settled = checkFinished(next)
  if (settled) {
    next.active = false
    next.finishedAt = nowIso()
    next.result = settled
    return { encounter: next, current: null, roundAdvanced: false, expired: [], finished: settled }
  }

  // 进入下一回合：清行动标记、递减状态持续时间
  const expired = []
  for (const unit of units) {
    unit.acted = false
    if (!Array.isArray(unit.status)) continue
    unit.status = unit.status.filter((entry) => {
      if (entry.duration === null || entry.duration === undefined) return true
      const left = entry.duration - 1
      if (left <= 0) {
        expired.push({ name: entry.name, status: unit.name })
        return false
      }
      entry.duration = left
      return true
    })
  }
  next.round = Math.max(1, Math.trunc(Number(next.round) || 1)) + 1
  next.log.push({ round: next.round, text: '第 ' + next.round + ' 回合开始' })

  const first = units.findIndex((unit) => !incapable(unit))
  next.currentIndex = first >= 0 ? first : 0
  return {
    encounter: next,
    current: units[next.currentIndex] ? { ...units[next.currentIndex] } : null,
    roundAdvanced: true,
    expired,
    finished: null,
  }
}

/**
 * 对参战单位施加伤害/治疗，并做死亡判定。
 * @param {Object} encounter 遭遇战（不会被就地修改）
 * @param {string} targetId 目标 id 或名字
 * @param {number} amount 正数=伤害，负数=治疗
 * @returns {{ encounter: Object, target: Object, changes: Array<Object>, notices: string[], downed: boolean, healed: boolean, finished: Object|null }}
 * @throws {Error} 找不到目标或数值非法时抛中文错误
 */
export function applyDamage(encounter, targetId, amount) {
  if (!encounter || !encounter.active) throw new Error('这场遭遇战已经结束了')
  const value = Math.trunc(Number(amount))
  if (!Number.isFinite(value)) throw new Error('伤害数值必须是数字，收到 ' + amount)
  const next = JSON.parse(JSON.stringify(encounter))
  const index = indexOfCombatant(next, targetId)
  if (index < 0) {
    throw new Error('参战单位里没有「' + targetId + '」。当前场上：' + next.combatants.map((unit) => unit.name).join('、'))
  }
  const unit = next.combatants[index]
  const before = unit.hp.cur
  const heal = value < 0
  const after = heal
    ? clamp(before + Math.abs(value), 0, unit.hp.max)
    : clamp(before - value, 0, unit.hp.max)

  const changes = [{ field: 'hp.cur', before, after }]
  const notices = []
  unit.hp.cur = after
  if (!heal && after <= 0 && before > 0) {
    unit.defeated = true
    unit.incapacitated = true
    notices.push(unit.name + ' 生命归零，倒下')
  }
  if (heal && before <= 0 && after > 0) {
    unit.defeated = false
    unit.incapacitated = false
    notices.push(unit.name + ' 被救回来了')
  }
  const finished = checkFinished(next)
  if (finished) {
    next.active = false
    next.finishedAt = nowIso()
    next.result = finished
  }
  return {
    encounter: next,
    target: { ...unit },
    changes,
    notices,
    downed: after <= 0 && before > 0,
    healed: heal,
    finished,
  }
}

/**
 * 追加一个状态到某个参战单位（带持续时间）。
 * @param {Object} encounter 遭遇战（不会被就地修改）
 * @param {string} targetId 目标 id 或名字
 * @param {string} statusName 状态名
 * @param {number|null} [duration] 持续回合数；null 表示直到被移除
 * @returns {{ encounter: Object, target: Object }}
 * @throws {Error} 找不到目标时抛中文错误
 */
export function addCombatStatus(encounter, targetId, statusName, duration = null) {
  const next = JSON.parse(JSON.stringify(encounter))
  const index = indexOfCombatant(next, targetId)
  if (index < 0) throw new Error('参战单位里没有「' + targetId + '」')
  const unit = next.combatants[index]
  const name = String(statusName || '').trim()
  if (!name) throw new Error('状态名不能为空')
  const left = duration === null || duration === undefined ? null : Math.max(1, Math.trunc(Number(duration) || 1))
  const existing = unit.status.find((entry) => entry.name === name)
  if (existing) existing.duration = left
  else unit.status.push({ name, duration: left })
  return { encounter: next, target: { ...unit } }
}

/**
 * 战场胜负判定。
 * 敌方全灭 → 胜利；我方全灭 → 失败；除此之外 null。
 * 中立 NPC 不参与胜负（中立全灭不判负）。
 * @param {Object} encounter 遭遇战
 * @returns {{ type: 'victory'|'defeat'|'draw', text: string }|null} 未分胜负返回 null
 */
export function checkFinished(encounter) {
  if (!encounter || !Array.isArray(encounter.combatants) || !encounter.combatants.length) return null
  const enemies = encounter.combatants.filter((unit) => sideOf(unit) === 'enemy')
  const party = encounter.combatants.filter((unit) => sideOf(unit) === 'party')
  const enemyDown = enemies.length > 0 && enemies.every(incapable)
  const partyDown = party.length > 0 && party.every(incapable)
  if (enemyDown && partyDown) return { type: 'draw', text: '双方都失去了战斗能力，战斗结束' }
  if (enemyDown) return { type: 'victory', text: '敌人全部倒下，战斗胜利' }
  if (partyDown) return { type: 'defeat', text: '队伍全员失去战斗能力，战斗失败' }
  return null
}

/**
 * 结束这场遭遇战（手动收尾）。
 * @param {Object} encounter 遭遇战（不会被就地修改）
 * @param {string} [reason] 结束原因，写进结果里
 * @returns {Object} 已结束的遭遇战
 * @throws {Error} 传入的不是遭遇战时抛中文错误
 */
export function endEncounter(encounter, reason) {
  if (!encounter || typeof encounter !== 'object') throw new Error('endEncounter 需要一个遭遇战对象')
  const next = JSON.parse(JSON.stringify(encounter))
  next.active = false
  next.finishedAt = nowIso()
  const settled = next.result || checkFinished(next)
  next.result = settled || { type: 'manual', text: String(reason || '战斗结束') }
  if (reason && next.result.type === 'manual') next.result.text = String(reason)
  return next
}

/**
 * 往遭遇战里临时加入一个单位（增援）。
 * @param {Object} encounter 遭遇战（不会被就地修改）
 * @param {{ name: string, kind?: string, hp?: {cur,max}, ac?: number, initiative?: number, dex?: number }} raw 新单位
 * @returns {{ encounter: Object, added: Object }}
 * @throws {Error} 重名或遭遇战已结束时抛中文错误
 */
export function addCombatant(encounter, raw) {
  if (!encounter || !encounter.active) throw new Error('这场遭遇战已经结束了')
  const next = JSON.parse(JSON.stringify(encounter))
  const name = String(raw && raw.name ? raw.name : '').trim()
  if (!name) throw new Error('新参战单位需要名字')
  if (indexOfCombatant(next, name) >= 0) throw new Error('场上已经有「' + name + '」了')
  const temporary = createEncounter({
    combatants: [{ ...raw, name, autoRoll: raw.initiative === undefined }],
    system: next.system,
  })
  const unit = temporary.combatants[0]
  next.combatants.push(unit)
  next.combatants.sort((a, b) => b.initiative - a.initiative)
  // 排序后重新定位当前行动者，避免索引错位
  next.currentIndex = Math.max(0, next.combatants.findIndex((entry) => entry.acted === false))
  return { encounter: next, added: unit }
}

/**
 * 把遭遇战压成前端先攻条的数据。
 * HP 百分比、图标 key 都算好，前端直接画。
 * @param {Object} encounter 遭遇战
 * @returns {{ round: number, active: boolean, current: string|null, order: Array<Object>, result: Object|null }}
 */
export function encounterView(encounter) {
  if (!encounter) return { round: 0, active: false, current: null, order: [], result: null }
  const current = encounter.combatants[encounter.currentIndex]
  return {
    round: encounter.round,
    active: Boolean(encounter.active),
    current: encounter.active && current ? current.name : null,
    order: encounter.combatants.map((unit, index) => ({
      index,
      id: unit.id,
      name: unit.name,
      kind: unit.kind,
      kindIcon: kindIcon(unit.kind),
      side: sideOf(unit),
      initiative: unit.initiative,
      hp: { cur: unit.hp.cur, max: unit.hp.max, percent: percentOf(unit.hp.cur, unit.hp.max), bar: METER_ASSETS.health },
      ac: unit.ac,
      status: (unit.status || []).map((entry) => entry.name),
      acted: Boolean(unit.acted),
      down: incapable(unit),
      current: index === encounter.currentIndex && encounter.active,
    })),
    result: encounter.result || null,
  }
}

/**
 * 从角色卡列表建遭遇战，省掉手工拼参战单位。
 * @param {Array<Object>} sheets 角色卡数组（sheet.js 的形状）
 * @param {{ rng?: () => number, seed?: number, system?: string }} [options]
 * @returns {Object} 遭遇战对象
 */
export function encounterFromSheets(sheets, options = {}) {
  const list = Array.isArray(sheets) ? sheets : []
  return createEncounter({
    combatants: list.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
      kind: sheet.kind,
      hp: { cur: sheet.hp.cur, max: sheet.hp.max },
      ac: sheet.ac,
      dex: sheet.attributes && Number.isFinite(Number(sheet.attributes.dex))
        ? Math.floor((Number(sheet.attributes.dex) - 10) / 2)
        : 0,
      status: (sheet.status || []).map((entry) => entry.name),
    })),
    system: options.system,
    rng: options.rng,
    seed: options.seed,
  })
}
