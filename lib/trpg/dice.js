/**
 * 骰子表达式解析与投掷。
 *
 * 支持跑团常用写法（大小写、全角符号、空格都做归一化）：
 *   基础       2d6   1d20   d100   纯数字
 *   修饰       2d6+3   2d6-2   2d6+1d4+3
 *   取高/取低   2d20kh1   2d20kl1          —— 优势 / 劣势
 *   丢弃       4d6dl1   4d6dh1            —— 弃最低 / 弃最高
 *   爆炸       1d6!   2d10!>8            —— 掷出上限（或阈值）时续掷并累加
 *   重复       3#1d20                     —— 整条表达式掷三次
 *
 * 全部是纯函数：同一个表达式配同一个 rng 必然得到同一结果，便于测试与回放。
 * 投掷结果里的 detail 直接给人（模型与玩家）读，不是机器格式。
 */

/** 单条表达式里允许的骰子数量上限，防止模型写出 999999d6 把进程拖死。 */
const MAX_DICE_COUNT = 200
/** 骰面数上限。 */
const MAX_DICE_SIDES = 1000
/** 重复掷骰次数上限。 */
const MAX_REPEAT = 100
/** 单颗骰子的爆炸续骰上限，防无限爆炸。 */
const MAX_EXPLOSIONS = 100

/**
 * mulberry32 伪随机数发生器。
 * @param {number} seed 32 位种子
 * @returns {() => number} 返回 [0,1) 的函数
 */
export function createRng(seed) {
  let a = (Number(seed) >>> 0) || 1
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 掷一颗骰子。
 * @param {number} sides 骰面数，必须为正整数
 * @param {() => number} [rng] 随机源，缺省 Math.random
 * @returns {number} 1..sides 的整数
 * @throws {Error} 骰面数非法时抛出中文错误
 */
export function rollDie(sides, rng) {
  const n = Math.trunc(Number(sides))
  if (!Number.isFinite(n) || n < 1) throw new Error('骰面数必须是正整数，收到 ' + sides)
  const source = typeof rng === 'function' ? rng : Math.random
  return 1 + Math.floor(source() * n)
}

/** 把全角/大小写/空格统一掉，方便后续扫描。 */
function normalizeExpression(input) {
  if (input === undefined || input === null) throw new Error('骰子表达式不能为空')
  const compact = String(input).normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  if (!compact) throw new Error('骰子表达式不能为空')
  return compact
}

/**
 * 解析一条骰子表达式。
 * @param {string} input 例如 '2d6+3'、'4d6dl1'、'3#1d20'
 * @returns {{ repeat: number, terms: Array<Object>, source: string }}
 *   repeat 为重复次数（默认 1）；terms 每项形如
 *   { kind: 'dice', count, sides, keep, drop, explode, explodeOn, sign }
 *   或 { kind: 'number', value, sign }
 * @throws {Error} 表达式非法时抛出中文错误（模型可见，说明哪一段错了）
 */
export function parseDiceExpression(input) {
  const s = normalizeExpression(input)

  let repeat = 1
  let cursor = 0
  const hash = s.indexOf('#')
  if (hash >= 0) {
    const head = s.slice(0, hash)
    if (!/^\d+$/.test(head)) throw new Error('重复掷骰写法应是 "3#1d20" 这种「次数#表达式」，收到 "' + s + '"')
    repeat = Number.parseInt(head, 10)
    if (repeat < 1) throw new Error('重复掷骰次数必须 ≥ 1，收到 ' + repeat)
    if (repeat > MAX_REPEAT) throw new Error('重复掷骰次数不能超过 ' + MAX_REPEAT + '，收到 ' + repeat)
    cursor = hash + 1
    if (cursor >= s.length) throw new Error('"#" 后面缺少骰子表达式')
  }

  const terms = []
  let sign = 1
  while (cursor < s.length) {
    const ch = s[cursor]
    if (ch === '+') { sign = 1; cursor += 1; continue }
    if (ch === '-') { sign = -1; cursor += 1; continue }
    const parsed = parseTerm(s, cursor)
    terms.push({ ...parsed.term, sign })
    sign = 1
    cursor = parsed.next
  }
  if (!terms.length) throw new Error('骰子表达式里没有任何骰子或数字：' + s)
  return { repeat, terms, source: s }
}

/**
 * 从 cursor 起解析一个项：骰子或纯数字。
 * @returns {{ term: Object, next: number }} next 是该项结束后的下标
 */
function parseTerm(s, cursor) {
  let i = cursor
  while (i < s.length && s[i] >= '0' && s[i] <= '9') i += 1
  const headDigits = s.slice(cursor, i)

  if (s[i] === 'd') {
    const count = headDigits ? Number.parseInt(headDigits, 10) : 1
    if (count < 1) throw new Error('骰子数量必须 ≥ 1，收到 ' + count)
    if (count > MAX_DICE_COUNT) throw new Error('单次投掷的骰子数量不能超过 ' + MAX_DICE_COUNT + '，收到 ' + count)
    let j = i + 1
    const sidesStart = j
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j += 1
    const sidesText = s.slice(sidesStart, j)
    if (!sidesText) throw new Error('"' + s.slice(cursor) + '" 里缺少骰面数（例如 2d6 的 6）')
    const sides = Number.parseInt(sidesText, 10)
    if (sides < 1) throw new Error('骰面数必须 ≥ 1，收到 ' + sides)
    if (sides > MAX_DICE_SIDES) throw new Error('骰面数不能超过 ' + MAX_DICE_SIDES + '，收到 ' + sides)

    let keep = null
    let drop = null
    let explode = false
    let explodeOn = null
    let k = j
    for (;;) {
      const rest = s.slice(k)
      let m = /^kh(\d+)/.exec(rest)
      if (m) { keep = { mode: 'high', n: Number.parseInt(m[1], 10) }; k += m[0].length; continue }
      m = /^kl(\d+)/.exec(rest)
      if (m) { keep = { mode: 'low', n: Number.parseInt(m[1], 10) }; k += m[0].length; continue }
      m = /^dh(\d+)/.exec(rest)
      if (m) { drop = { mode: 'high', n: Number.parseInt(m[1], 10) }; k += m[0].length; continue }
      m = /^dl(\d+)/.exec(rest)
      if (m) { drop = { mode: 'low', n: Number.parseInt(m[1], 10) }; k += m[0].length; continue }
      if (rest[0] === '!') {
        explode = true
        k += 1
        if (s[k] === '>') {
          k += 1
          let e = k
          while (e < s.length && s[e] >= '0' && s[e] <= '9') e += 1
          if (e === k) throw new Error('爆炸阈值写法是 "1d6!>5"，缺少阈值数字')
          explodeOn = Number.parseInt(s.slice(k, e), 10)
          if (explodeOn < 1 || explodeOn > sides) throw new Error('爆炸阈值必须在 1..' + sides + ' 之间，收到 ' + explodeOn)
          k = e
        }
        continue
      }
      break
    }
    return {
      term: { kind: 'dice', count, sides, keep, drop, explode, explodeOn },
      next: k,
    }
  }

  if (!headDigits) {
    throw new Error('无法解析 "' + s.slice(cursor) + '"：这里应该是骰子（如 2d6）或数字')
  }
  return { term: { kind: 'number', value: Number.parseInt(headDigits, 10) }, next: i }
}

/**
 * 掷一个骰子项，产出骰池。
 * 被丢弃的原始骰与其爆炸续骰整组一起标记（按 parent 归组）。
 * @returns {{ pool: Array<Object>, originals: number[] }} originals 是每个原始骰在 pool 中的下标
 */
function rollDicePool(term, rng) {
  const pool = []
  const originals = []
  for (let i = 0; i < term.count; i += 1) {
    const idx = pool.length
    originals.push(idx)
    const first = rollDie(term.sides, rng)
    pool.push({ sides: term.sides, value: first, dropped: false, exploded: false, parent: idx })
    if (!term.explode) continue
    const threshold = term.explodeOn === null ? term.sides : term.explodeOn
    let current = first
    let guard = 0
    while (current >= threshold && guard < MAX_EXPLOSIONS) {
      guard += 1
      current = rollDie(term.sides, rng)
      pool.push({ sides: term.sides, value: current, dropped: false, exploded: true, parent: idx })
    }
  }
  return { pool, originals }
}

/**
 * 按取高/取低与丢弃规则标记 dropped。
 * 至少保留一颗原始骰（drop 与 keep 都不会把整池丢空）。
 */
function applyKeepDrop(pool, originals, keep, drop) {
  let kept = originals.slice()

  if (keep && keep.n > 0) {
    const sorted = kept
      .slice()
      .sort((a, b) => (keep.mode === 'high' ? pool[b].value - pool[a].value : pool[a].value - pool[b].value))
    const keptSet = new Set(sorted.slice(0, Math.min(keep.n, sorted.length)))
    kept = kept.filter((idx) => keptSet.has(idx))
  }
  if (drop && drop.n > 0 && kept.length > 1) {
    const sorted = kept
      .slice()
      .sort((a, b) => (drop.mode === 'high' ? pool[b].value - pool[a].value : pool[a].value - pool[b].value))
    const dropSet = new Set(sorted.slice(0, Math.min(drop.n, kept.length - 1)))
    kept = kept.filter((idx) => !dropSet.has(idx))
  }

  const keptSet = new Set(kept)
  for (const idx of originals) {
    if (keptSet.has(idx)) continue
    pool[idx].dropped = true
    for (const die of pool) {
      if (die.parent === idx) die.dropped = true
    }
  }
}

/** 把骰池渲染成可读片段：'[14,7] 取[14]'。 */
function displayPool(pool, keep, drop, explode) {
  const values = pool.map((die) => String(die.value))
  for (const die of pool) {
    if (!die.exploded) continue
    const parentDie = pool[die.parent]
    if (parentDie) values[die.parent] = parentDie.value + '!'
  }
  const annotations = []
  const droppedValues = pool.filter((die) => die.dropped).map((die) => die.value)
  if (droppedValues.length) annotations.push('弃[' + droppedValues.join(',') + ']')
  if (keep) {
    const keptValues = []
    for (const die of pool) if (!die.dropped && !die.exploded) keptValues.push(die.value)
    if (keptValues.length) annotations.push('取[' + keptValues.join(',') + ']')
  }
  if (explode) annotations.push('爆')
  const head = '[' + values.join(',') + ']'
  return annotations.length ? head + ' ' + annotations.join(' ') : head
}

/** 对已解析的表达式执行一次投掷（不处理 repeat）。 */
function rollTerms(terms, rng) {
  const allRolls = []
  const parts = []
  const faces = []
  let total = 0

  terms.forEach((term, index) => {
    const signChar = term.sign < 0 ? '-' : index === 0 ? '' : '+'
    if (term.kind === 'number') {
      parts.push(signChar + String(term.value))
      total += term.sign * term.value
      return
    }
    const { pool, originals } = rollDicePool(term, rng)
    applyKeepDrop(pool, originals, term.keep, term.drop)
    const groupValues = []
    const groupKept = []
    for (const die of pool) {
      allRolls.push({ sides: die.sides, value: die.value, dropped: die.dropped, exploded: die.exploded })
      groupValues.push(die.value)
      if (!die.dropped) {
        total += term.sign * die.value
        groupKept.push(die.value)
      }
    }
    // faces 是给前端画骰面/做动画的结构化数据：type 是骰型，values 是全部骰面，kept 是真正计入总和的
    faces.push({ type: 'd' + term.sides, values: groupValues, kept: groupKept, sign: term.sign })
    parts.push(signChar + displayPool(pool, term.keep, term.drop, term.explode))
  })

  return { total, rolls: allRolls, parts, faces }
}

/** 执行一次完整投掷并拼出 detail。 */
function rollOnce(parsed, rng) {
  const { total, rolls, parts, faces } = rollTerms(parsed.terms, rng)
  return { total, rolls, faces, detail: parsed.source + ' = ' + parts.join('') + ' = ' + total }
}

/** 按需创建随机源：优先 rng 函数，其次 seed，最后 Math.random。 */
function resolveRng(options) {
  if (typeof options.rng === 'function') return options.rng
  if (options.seed !== undefined && options.seed !== null) return createRng(options.seed)
  return Math.random
}

/**
 * 掷骰子。
 * @param {string} expr 骰子表达式
 * @param {{ rng?: () => number, seed?: number }} [options] 随机源；给 seed 时结果可复现
 * @returns {{
 *   expr: string,
 *   total: number,
 *   rolls: Array<{ sides: number, value: number, dropped: boolean, exploded: boolean }>,
 *   faces: Array<{ type: string, values: number[], kept: number[], sign: number }>,
 *   detail: string,
 *   repeat: number,
 *   repeats: Array<{ total: number, rolls: Array<Object>, faces: Array<Object>, detail: string }> | null
 * }}
 *   重复掷骰（3#1d20）时 rolls 为空数组，逐次结果在 repeats 里，total 是各次之和。
 * @throws {Error} 表达式非法时抛出中文错误
 */
export function rollDice(expr, options = {}) {
  const parsed = parseDiceExpression(expr)
  const rng = resolveRng(options)
  const label = String(expr).trim()

  if (parsed.repeat > 1) {
    const repeats = []
    let total = 0
    // 单次明细用去掉 "3#" 前缀的表达式文本，避免每一行都重复次数
    const single = { ...parsed, source: String(expr).trim().replace(/^\s*\d+\s*#\s*/, '') }
    for (let i = 0; i < parsed.repeat; i += 1) {
      const once = rollOnce(single, rng)
      repeats.push({ total: once.total, rolls: once.rolls, faces: once.faces, detail: once.detail })
      total += once.total
    }
    const lines = repeats.map((r, i) => '  ' + (i + 1) + '. ' + r.detail)
    return {
      expr: label,
      total,
      rolls: [],
      faces: [],
      detail: label + '（掷 ' + parsed.repeat + ' 次）：\n' + lines.join('\n') + '\n  合计 = ' + total,
      repeat: parsed.repeat,
      repeats,
    }
  }

  const once = rollOnce(parsed, rng)
  return { expr: label, total: once.total, rolls: once.rolls, faces: once.faces, detail: once.detail, repeat: 1, repeats: null }
}

/**
 * 把（可能被改写过的）项列表还原成表达式文本，用于展示暴击后的骰子。
 * @param {Array<Object>} terms parseDiceExpression 产出的项列表
 * @returns {string} 表达式文本
 */
export function formatDiceExpression(terms) {
  return terms
    .map((term, index) => {
      const signChar = term.sign < 0 ? '-' : index === 0 ? '' : '+'
      if (term.kind === 'number') return signChar + term.value
      let body = term.count + 'd' + term.sides
      if (term.keep) body += (term.keep.mode === 'high' ? 'kh' : 'kl') + term.keep.n
      if (term.drop) body += (term.drop.mode === 'high' ? 'dh' : 'dl') + term.drop.n
      if (term.explode) body += '!' + (term.explodeOn === null ? '' : '>' + term.explodeOn)
      return signChar + body
    })
    .join('')
}

/**
 * 掷伤害骰，支持暴击。
 * 暴击（crit）按 5e 规则把骰子数量翻倍（2d6+3 → 4d6+3），固定加值不翻倍。
 * @param {string} expr 伤害表达式
 * @param {{ crit?: boolean, critMultiplier?: number, rng?: () => number, seed?: number }} [options]
 * @returns {{ expr: string, rollExpr: string, total: number, rolls: Array<Object>, detail: string, crit: boolean }}
 * @throws {Error} 表达式非法时抛出中文错误
 */
export function rollDamage(expr, options = {}) {
  const parsed = parseDiceExpression(expr)
  const multiplier = options.crit ? Math.max(2, Math.trunc(Number(options.critMultiplier) || 2)) : 1
  const rng = resolveRng(options)
  const label = String(expr).trim()

  if (multiplier === 1) {
    const once = rollOnce(parsed, rng)
    return { expr: label, rollExpr: parsed.source, total: once.total, rolls: once.rolls, faces: once.faces, detail: once.detail, crit: false }
  }

  const critTerms = parsed.terms.map((term) =>
    term.kind === 'dice' ? { ...term, count: term.count * multiplier } : { ...term },
  )
  const { total, rolls, parts, faces } = rollTerms(critTerms, rng)
  const rollExpr = formatDiceExpression(critTerms)
  return {
    expr: label,
    rollExpr,
    total,
    rolls,
    faces,
    detail: rollExpr + '（暴击 ×' + multiplier + ' 骰）= ' + parts.join('') + ' = ' + total,
    crit: true,
  }
}

/**
 * 一次投掷多组骰子并汇总，用于「先攻」「群体伤害」这类批量场景。
 * @param {string[]} exprs 表达式数组
 * @param {{ rng?: () => number, seed?: number }} [options]
 * @returns {{ results: Array<Object>, total: number }}
 * @throws {Error} 任一表达式非法时抛出中文错误
 */
export function rollMany(exprs, options = {}) {
  const list = Array.isArray(exprs) ? exprs : [exprs]
  const rng = resolveRng(options)
  const results = list.map((expr) => rollDice(expr, { rng }))
  return { results, total: results.reduce((sum, item) => sum + item.total, 0) }
}
