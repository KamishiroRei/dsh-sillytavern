/**
 * 判定引擎：把「掷骰 + 规则」变成一个有等级、有叙述提示的结果。
 *
 * 三套体系，都是真实规则，不是占位：
 *   dnd5e    d20 + 加值 vs DC；裸骰 20 大成功、裸骰 1 大失败；优势/劣势取高/取低
 *   coc7e    d100 vs 技能值；大成功/极难成功/困难成功/普通成功/失败/大失败，含规则可选的 96+ 大失败
 *   generic  百分比：d100 ≤ 目标值即成功，按差值分等级
 *
 * 结果里的 narration 是**给模型的语气参考**，不是让模型照抄的正文：它告诉模型
 * 「这一掷该有多轻松/多勉强」，模型自己写描述。
 */
import { rollDice, createRng } from './dice.js'

/** DC/难度文字表的公共部分，dnd5e 与 generic 共用。 */
const DIFFICULTY_LABELS = [
  { at: 5, label: '极简单' },
  { at: 10, label: '简单' },
  { at: 15, label: '中等' },
  { at: 20, label: '困难' },
  { at: 25, label: '极难' },
  { at: 30, label: '几乎不可能' },
]

/**
 * 把 DC 数字翻译成难度词。
 * @param {number} dc 难度值
 * @returns {string} 中文难度描述
 */
export function difficultyLabel(dc) {
  const value = Number(dc)
  if (!Number.isFinite(value)) return '中等'
  let label = '极简单'
  for (const item of DIFFICULTY_LABELS) {
    if (value >= item.at) label = item.label
  }
  return label
}

/** 解析随机源：优先 rng，其次 seed，最后 Math.random。 */
function resolveRng(options) {
  const source = options || {}
  if (typeof source.rng === 'function') return source.rng
  if (source.seed !== undefined && source.seed !== null) return createRng(source.seed)
  return Math.random
}

/** 数字归一化：不是有限数就返回兜底值。 */
function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 把 undefined/null/空串的叙事字段清掉，拼成一句中文提示。 */
function joinNarration(parts) {
  return parts.filter((p) => p && String(p).trim()).join('')
}

/**
 * d20 + 加值 vs DC 的判定，含优势/劣势与大成功大失败。
 * @param {{ bonus?: number, dc?: number, advantage?: boolean, disadvantage?: boolean, rng?: () => number, seed?: number }} input
 * @returns {{ total: number, natural: number, dc: number, success: boolean, degree: string, breakdown: string, narration: string, rolls: Array<Object>, kind: string }}
 */
function rollD20Check(input) {
  const rng = resolveRng(input)
  const bonus = num(input.bonus, 0)
  const dc = num(input.dc, 15)
  const advantage = Boolean(input.advantage)
  const disadvantage = Boolean(input.disadvantage) && !advantage

  let roll
  if (advantage) roll = rollDice('2d20kh1', { rng })
  else if (disadvantage) roll = rollDice('2d20kl1', { rng })
  else roll = rollDice('1d20', { rng })

  const rawValues = roll.rolls.filter((die) => !die.dropped)
  const natural = rawValues.length ? rawValues[0].value : roll.total
  const total = natural + bonus

  let success = total >= dc
  /** @type {'大成功'|'成功'|'失败'|'大失败'} */
  let degree
  if (natural === 20) { degree = '大成功'; success = true }
  else if (natural === 1) { degree = '大失败'; success = false }
  else degree = success ? '成功' : '失败'

  const modeLabel = advantage ? ' 优势' : disadvantage ? ' 劣势' : ''
  const bonusLabel = bonus === 0 ? '' : bonus > 0 ? '+' + bonus : String(bonus)
  const allFaces = roll.rolls.map((die) => (die.dropped ? '[' + die.value + ']' : String(die.value))).join(',')
  const breakdown = 'd20' + modeLabel + ' [' + allFaces + '] 裸骰 ' + natural + bonusLabel + ' = ' + total + ' vs DC ' + dc
  const gap = total - dc

  let narration
  if (degree === '大成功') narration = '裸骰 20，大成功：这一下漂亮得不讲道理，该给足描写。'
  else if (degree === '大失败') narration = '裸骰 1，大失败：加值再高也救不回来，该有代价，不要心软。'
  else if (success) narration = gap === 0 ? '压线成功——刚好够着，别写得轻松。' : gap <= 2 ? '险胜，只差一点就翻车。' : gap <= 5 ? '稳健成功。' : '大幅成功，有余裕，可以写得利落。'
  else narration = gap >= -2 ? '差一点点失败，是那种「手已经摸到却滑掉」的失败。' : gap >= -5 ? '明确失败，不要给奇迹。' : '输得很彻底，代价应当明显。'

  return {
    kind: 'd20',
    total,
    natural,
    dc,
    success,
    degree,
    breakdown,
    narration,
    rolls: roll.rolls,
    detail: roll.detail,
    advantage,
    disadvantage,
    bonus,
  }
}

/**
 * COC 7 版 d100 判定。
 * 技能值默认 50；成功等级按技能值的 1/2（困难）、1/5（极难）划分。
 * 大成功：01；大失败：100，或（规则可选）96..100 且技能值 < 50。
 * @param {{ targetValue?: number, bonus?: number, dc?: number, cocFumble?: number, rng?: () => number, seed?: number }} input
 * @returns {Object} 判定结果
 */
function rollCocCheck(input) {
  const rng = resolveRng(input)
  const target = num(input.targetValue, num(input.dc, 50))
  const skill = Math.max(1, Math.min(999, Math.round(target + num(input.bonus, 0))))
  const roll = rollDice('1d100', { rng })
  const value = roll.total
  const extreme = Math.floor(skill / 5)
  const hard = Math.floor(skill / 2)
  const fumbleFloor = num(input.cocFumble, skill < 50 ? 96 : 100)

  /** @type {'大成功'|'极难成功'|'困难成功'|'普通成功'|'失败'|'大失败'} */
  let degree
  if (value === 1) degree = '大成功'
  else if (value >= fumbleFloor) degree = '大失败'
  else if (value <= extreme) degree = '极难成功'
  else if (value <= hard) degree = '困难成功'
  else if (value <= skill) degree = '普通成功'
  else degree = '失败'
  const success = degree === '大成功' || degree === '极难成功' || degree === '困难成功' || degree === '普通成功'

  const breakdown = 'd100 = ' + value + ' vs 技能 ' + skill + '（极难 ≤' + extreme + ' / 困难 ≤' + hard + '）'

  let narration
  switch (degree) {
    case '大成功': narration = '掷出 01，大成功：超常发挥，给出额外的、具体的好处。'; break
    case '大失败': narration = '大失败：不是「没成功」，而是搞砸了，写明代价。'; break
    case '极难成功': narration = '极难成功：干净漂亮，几乎没有破绽。'; break
    case '困难成功': narration = '困难成功：做到了，而且做得体面。'; break
    case '普通成功': narration = '普通成功：勉强够用，别写得太潇洒。'; break
    default: narration = value > skill + 30 ? '输得很彻底。' : '失败，但离成功不远，可以留一点余味。'
  }

  return {
    kind: 'd100',
    total: value,
    natural: value,
    dc: skill,
    targetValue: skill,
    success,
    degree,
    breakdown,
    narration,
    rolls: roll.rolls,
    detail: roll.detail,
    extreme,
    hard,
  }
}

/**
 * 通用百分比判定：掷 1d100，≤ 目标值即成功。
 * @param {{ targetValue?: number, dc?: number, bonus?: number, rng?: () => number, seed?: number }} input
 * @returns {Object} 判定结果
 */
function rollPercentCheck(input) {
  const rng = resolveRng(input)
  const target = Math.max(1, Math.min(100, Math.round(num(input.targetValue, num(input.dc, 50)) + num(input.bonus, 0))))
  const roll = rollDice('1d100', { rng })
  const value = roll.total
  const success = value <= target
  const margin = target - value

  /** @type {string} */
  let degree
  if (success) degree = margin >= 40 ? '大成功' : margin >= 20 ? '明显成功' : '成功'
  else degree = margin <= -40 ? '大失败' : '失败'

  const breakdown = 'd100 = ' + value + ' vs 目标 ' + target
  const narration = success
    ? margin >= 40 ? '远远达到目标，效果可以超出预期。' : margin >= 20 ? '顺利达成。' : '刚好够，别写得轻松。'
    : margin <= -40 ? '彻底失败。' : '失败，差 ' + Math.abs(margin) + ' 点。'

  return {
    kind: 'percent',
    total: value,
    natural: value,
    dc: target,
    targetValue: target,
    success,
    degree,
    breakdown,
    narration,
    rolls: roll.rolls,
    detail: roll.detail,
  }
}

/** 各体系的规范名，兼容常见别名。 */
const SYSTEM_ALIASES = {
  dnd: 'dnd5e',
  dnd5: 'dnd5e',
  d20: 'dnd5e',
  '5e': 'dnd5e',
  coc: 'coc7e',
  coc7: 'coc7e',
  'coc7th': 'coc7e',
  'call-of-cthulhu': 'coc7e',
  generic: 'generic',
  percent: 'generic',
  'd100': 'generic',
}

/**
 * 归一化规则体系名。
 * @param {string} [system] 体系名或别名
 * @returns {'dnd5e'|'coc7e'|'generic'} 规范名；未知时退化为 generic
 */
export function normalizeSystem(system) {
  if (!system) return 'generic'
  const key = String(system).trim().toLowerCase()
  if (key === 'dnd5e' || key === 'coc7e' || key === 'generic') return key
  return SYSTEM_ALIASES[key] || 'generic'
}

/**
 * 一次完整判定：选体系、掷骰、算等级、给叙述提示。
 * @param {{
 *   system?: string,
 *   attribute?: string,
 *   skill?: string,
 *   bonus?: number,
 *   dc?: number,
 *   advantage?: boolean,
 *   disadvantage?: boolean,
 *   targetValue?: number,
 *   modifier?: number,
 *   cocFumble?: number,
 *   rng?: () => number,
 *   seed?: number,
 * }} input
 *   - system：dnd5e / coc7e / generic，未知值退化为 generic
 *   - attribute / skill：只用于展示标签，加值请通过 bonus 传（角色卡里的数值由调用方取）
 *   - dc：dnd5e 的难度，coc7e/generic 的目标值（给 targetValue 时优先 targetValue）
 * @returns {{
 *   system: string, attribute: string|null, skill: string|null,
 *   success: boolean, degree: string, total: number, natural: number, dc: number,
 *   breakdown: string, narration: string, rolls: Array<Object>, detail: string, kind: string,
 * }}
 * @throws {Error} 参数明显非法时抛中文错误
 */
export function abilityCheck(input = {}) {
  const system = normalizeSystem(input.system)
  const attribute = input.attribute ? String(input.attribute).trim() : null
  const skill = input.skill ? String(input.skill).trim() : null
  const bonus = num(input.bonus, num(input.modifier, 0))

  let result
  if (system === 'dnd5e') {
    result = rollD20Check({
      bonus,
      dc: num(input.dc, 15),
      advantage: input.advantage === true,
      disadvantage: input.disadvantage === true,
      rng: input.rng,
      seed: input.seed,
    })
  } else if (system === 'coc7e') {
    result = rollCocCheck({
      targetValue: input.targetValue,
      bonus,
      dc: input.dc,
      cocFumble: input.cocFumble,
      rng: input.rng,
      seed: input.seed,
    })
  } else {
    result = rollPercentCheck({
      targetValue: input.targetValue,
      bonus,
      dc: input.dc,
      rng: input.rng,
      seed: input.seed,
    })
  }

  const label = [attribute, skill].filter(Boolean).join(' / ')
  return { system, attribute, skill, label: label || null, ...result }
}

/**
 * 对抗判定：双方各掷一次，比较成败与差值。
 * 平局时按规则处理：dnd5e 视为维持原状（防守方不落败），coc7e/generic 比成功等级。
 * @param {Object} a 甲方的 abilityCheck 参数
 * @param {Object} b 乙方的 abilityCheck 参数
 * @returns {{
 *   a: Object, b: Object, winner: 'a'|'b'|'tie', margin: number, success: boolean,
 *   degree: string, breakdown: string, narration: string,
 * }}
 *   success 表示甲方是否获胜；winner='tie' 时 success 为 false（对抗未分胜负，由 GM 定夺）。
 * @throws {Error} 参数明显非法时抛中文错误
 */
export function opposedCheck(a = {}, b = {}) {
  // 双方用同一体系：以甲方为准，乙方未指定时继承
  const system = normalizeSystem(a.system || b.system)
  const resultA = abilityCheck({ ...a, system })
  const resultB = abilityCheck({ ...b, system })

  const RANK = {
    dnd5e: { 大成功: 3, 成功: 2, 失败: 1, 大失败: 0 },
    coc7e: { 大成功: 5, 极难成功: 4, 困难成功: 3, 普通成功: 2, 失败: 1, 大失败: 0 },
    generic: { 大成功: 4, 明显成功: 3, 成功: 2, 失败: 1, 大失败: 0 },
  }
  const table = RANK[system] || RANK.generic
  const rankA = table[resultA.degree] !== undefined ? table[resultA.degree] : (resultA.success ? 2 : 1)
  const rankB = table[resultB.degree] !== undefined ? table[resultB.degree] : (resultB.success ? 2 : 1)

  let winner
  let margin = 0
  if (rankA > rankB) {
    winner = 'a'
    margin = rankA - rankB
  } else if (rankB > rankA) {
    winner = 'b'
    margin = rankB - rankA
  } else {
    // 同等级时比数值余量（d20 比高出 DC 的差值，d100 比低于技能值的余量）
    const gapA = resultA.kind === 'd20' ? resultA.total - resultA.dc : resultA.dc - resultA.total
    const gapB = resultB.kind === 'd20' ? resultB.total - resultB.dc : resultB.dc - resultB.total
    if (gapA > gapB) { winner = 'a'; margin = gapA - gapB }
    else if (gapB > gapA) { winner = 'b'; margin = gapB - gapA }
    else { winner = 'tie'; margin = 0 }
  }

  const success = winner === 'a'
  const breakdown = '甲方 ' + resultA.degree + '（' + resultA.breakdown + '） vs 乙方 ' + resultB.degree + '（' + resultB.breakdown + '）'

  let narration
  if (winner === 'tie') narration = '双方咬得很死，这一轮没分出高下——别硬判，可以让局势僵住或再加条件。'
  else if (winner === 'a') narration = margin >= 2 ? '甲方赢得干脆，别给对方翻盘的余地。' : '甲方险胜，分寸要拿捏在「刚好压住」。'
  else narration = margin >= 2 ? '乙方压制得很彻底，甲方不该有余力。' : '乙方险胜，甲方只差一口气。'

  return { a: resultA, b: resultB, winner, margin, success, degree: winner === 'a' ? resultA.degree : winner === 'b' ? resultB.degree : '平手', breakdown, narration, system }
}

/**
 * 骰池判定（世界线 / 暗影狂奔风格，也用于 dnd5e 的部分系统）：
 * 掷 count 颗 dSides，达到 target 的算成功，统计成功数。
 * @param {{ count?: number, sides?: number, target?: number, explode?: boolean, rng?: () => number, seed?: number }} input
 * @returns {{ success: boolean, hits: number, total: number, degree: string, breakdown: string, narration: string, rolls: Array<Object>, detail: string, kind: string, dc: number, natural: number }}
 */
export function poolCheck(input = {}) {
  const rng = resolveRng(input)
  const count = Math.max(1, Math.min(200, Math.round(num(input.count, 5))))
  const sides = Math.max(2, Math.min(1000, Math.round(num(input.sides, 6))))
  const target = Math.max(2, Math.min(sides + 1, Math.round(num(input.target, Math.ceil(sides / 2)))))
  const expr = count + 'd' + sides + (input.explode ? '!' : '')
  const roll = rollDice(expr, { rng })
  const values = roll.rolls.map((die) => die.value)
  const hits = values.filter((value) => value >= target).length
  const success = hits > 0
  const degree = hits === 0 ? '失败' : hits >= 4 ? '大成功' : hits >= 2 ? '成功' : '勉强成功'
  const breakdown = expr + ' = [' + values.join(',') + ']，≥' + target + ' 命中 ' + hits + ' 次'
  const narration = hits === 0
    ? '一个成功都没有，彻底失败。'
    : hits >= 4 ? '成功数爆表，效果可以给足。' : hits >= 2 ? '成功数正常，按一次成功结算。' : '只有一个成功，勉强。'
  return {
    kind: 'pool',
    success,
    hits,
    total: hits,
    natural: hits,
    dc: 1,
    degree,
    breakdown,
    narration,
    rolls: roll.rolls,
    detail: roll.detail,
    threshold: target,
  }
}

/**
 * 取判定结果的「一句话摘要」，给日志与工具返回复用。
 * @param {Object} result abilityCheck / opposedCheck / poolCheck 的结果
 * @returns {string} 例如 '成功（18 vs DC 15）'
 */
export function summarizeCheck(result) {
  if (!result || typeof result !== 'object') return '无判定结果'
  if (result.winner !== undefined) {
    const who = result.winner === 'a' ? '甲方胜' : result.winner === 'b' ? '乙方胜' : '平手'
    return who + '：' + result.breakdown
  }
  const verdict = result.degree ? result.degree : result.success ? '成功' : '失败'
  return verdict + '（' + result.breakdown + '）'
}
