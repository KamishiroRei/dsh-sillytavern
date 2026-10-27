/**
 * SillyTavern 正则脚本（Regex 扩展）引擎。
 *
 * 脚本字段与 ST 的 RegexScriptData 一一对应：
 *   { id, scriptName, findRegex, replaceString, trimStrings, placement, disabled,
 *     markdownOnly, promptOnly, runOnEdit, substituteRegex, minDepth, maxDepth }
 *
 * placement 用 ST 的值：1=显示给用户时（USER_INPUT）、2=发给模型时（AI_OUTPUT）、
 * 5=世界书条目、6=推理内容。插件内部还可以直接传 'display' / 'prompt' 两个别名。
 *
 * findRegex 在真实卡里有两种写法，都要支持：
 *   - 斜杠字面量：/&lt;Status&gt;[\s\S]*?&lt;\/Status&gt;/g
 *   - 裸模式串：  ^[\s\S]*?(...)[\s\S]*$    （FateStayNight 等卡就是这种）
 * 前者走 {@link parseRegexFromString}，后者走 {@link compileRegex} 的宽松规则。
 *
 * replaceString 支持 $1..$9、$<name>、{{match}}，替换后按 trimStrings 过滤。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from '../store.js'

/** ST 的 regex_placement 枚举。 */
export const REGEX_PLACEMENT = Object.freeze({
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
})

/** 别名到数值的映射：插件内部可以直接写 'display' / 'prompt'。 */
const PLACEMENT_ALIAS = Object.freeze({
  display: REGEX_PLACEMENT.USER_INPUT,
  prompt: REGEX_PLACEMENT.AI_OUTPUT,
  input: REGEX_PLACEMENT.USER_INPUT,
  output: REGEX_PLACEMENT.AI_OUTPUT,
  worldinfo: REGEX_PLACEMENT.WORLD_INFO,
  reasoning: REGEX_PLACEMENT.REASONING,
})

/** substituteRegex 的取值：0=原样、1=展开宏、2=展开宏并转义。 */
const SUBSTITUTE = Object.freeze({ NONE: 0, RAW: 1, ESCAPED: 2 })

/** 合法正则标志位：ST 的 regexFromString 允许的集合。 */
const VALID_FLAGS = 'gmixXsuUAJ'

/** 反斜杠字符，用来拼正则时避免二次转义混淆。 */
const BACKSLASH = String.fromCharCode(92)

/** 把 placement 参数（数值 / 别名 / 字符串数字）收敛成数值。 */
function resolvePlacement(placement) {
  if (typeof placement === 'number' && Number.isFinite(placement)) return placement
  const text = String(placement === undefined || placement === null ? '' : placement).trim().toLowerCase()
  if (!text) return REGEX_PLACEMENT.AI_OUTPUT
  if (PLACEMENT_ALIAS[text] !== undefined) return PLACEMENT_ALIAS[text]
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : REGEX_PLACEMENT.AI_OUTPUT
}

/** 把任意值收敛成数字数组（placement 可以是 [1,2] 或 "1,2"）。 */
function toNumbers(value) {
  const list = Array.isArray(value) ? value : String(value === undefined || value === null ? '' : value).split(',')
  const out = []
  for (const item of list) {
    const numeric = Number(item)
    if (Number.isFinite(numeric)) out.push(numeric)
  }
  return out
}

/** 把任意值收敛成字符串数组。 */
function toStrings(value) {
  if (Array.isArray(value)) return value.filter(v => v !== undefined && v !== null).map(v => String(v))
  if (value === undefined || value === null || value === '') return []
  return [String(value)]
}

/** 转义字符串里的正则元字符（substituteRegex=2 时用）。 */
function sanitizeRegexMacro(text) {
  return String(text).replace(/[\n\r\t\v\f\0.^$*+?{}\[\]\\/|()]/g, ch => {
    switch (ch) {
      case '\n': return BACKSLASH + 'n'
      case '\r': return BACKSLASH + 'r'
      case '\t': return BACKSLASH + 't'
      case '\v': return BACKSLASH + 'v'
      case '\f': return BACKSLASH + 'f'
      case '\0': return BACKSLASH + '0'
      default: return BACKSLASH + ch
    }
  })
}

/**
 * 严格解析斜杠字面量 /pattern/flags。
 *
 * 这是 ST 世界书关键词（world-info.js 的 parseRegexFromString）用的规则：
 * 必须首尾是未转义的斜杠，否则不当作正则。
 *
 * @param {string} input 斜杠字面量
 * @returns {RegExp|null} 不是字面量或语法错误时返回 null
 */
export function parseRegexFromString(input) {
  const text = String(input === undefined || input === null ? '' : input)
  const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(text)
  if (!match) return null
  let pattern = match[1]
  const flags = match[2]
  // 未转义的斜杠会让这个字面量在别的引擎里失效，ST 同样判为无效
  if (/(^|[^\\])\//.test(pattern)) return null
  pattern = pattern.replace(BACKSLASH + '/', '/')
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/**
 * 按 ST 的 regexFromString（public/scripts/utils.js）编译正则。
 *
 * 先试严格字面量；失败则按 ST 的宽松规则解析裸模式串。真实卡大量使用裸模式串，
 * 只有严格解析会让这些脚本整条静默失效。
 *
 * @param {string} input 任意正则串
 * @param {string|null} [flagsOverride] 指定标志位（省略时用串里自带的）
 * @returns {RegExp|null} 编译失败返回 null
 */
export function compileRegex(input, flagsOverride) {
  const text = String(input === undefined || input === null ? '' : input)
  if (!text) return null

  const override = flagsOverride === undefined || flagsOverride === null ? null : String(flagsOverride)

  // 1) 严格斜杠字面量
  const strict = parseRegexFromString(text)
  if (strict) {
    try {
      return override ? new RegExp(strict.source, override) : new RegExp(strict.source, strict.flags)
    } catch {
      return null
    }
  }

  // 2) ST 的宽松规则：开头可选 /，贪婪取到最后一个同样的字符，尾部 [a-z]* 当标志位
  let pattern = text
  let flags = ''
  const match = /(\/?)(.+)\1([a-z]*)/i.exec(text)
  if (match) {
    pattern = match[2]
    flags = match[3] || ''
    // 标志位里有重复字符等非法组合时，ST 退回「整串当模式」
    const flagCheck = new RegExp('^(?!.*?(.).*?' + BACKSLASH + '1)[' + VALID_FLAGS + ']+$')
    if (flags && !flagCheck.test(flags)) {
      pattern = text
      flags = ''
    }
  }

  try {
    return new RegExp(pattern, override === null ? flags : override)
  } catch {
    return null
  }
}

/**
 * 归一化一条正则脚本：补默认值、纠类型、把 placement 统一成数字数组。
 *
 * 未知字段原样保留，方便插件自己挂扩展。
 *
 * @param {Record<string, any>} input 原始脚本
 * @param {number} [index] 在数组中的下标，用于补 id
 * @returns {Record<string, any>} 规范化脚本
 */
export function normalizeRegexScript(input, index = 0) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const placement = toNumbers(src.placement)
  const minDepth = src.minDepth === undefined || src.minDepth === null || src.minDepth === '' ? null : Number(src.minDepth)
  const maxDepth = src.maxDepth === undefined || src.maxDepth === null || src.maxDepth === '' ? null : Number(src.maxDepth)
  const out = {
    id: String(src.id || ('regex-' + index)),
    scriptName: String(src.scriptName || src.name || ('正则脚本 ' + (index + 1))),
    findRegex: String(src.findRegex || ''),
    replaceString: src.replaceString === undefined || src.replaceString === null ? '' : String(src.replaceString),
    trimStrings: toStrings(src.trimStrings),
    placement: placement.length ? placement : [REGEX_PLACEMENT.AI_OUTPUT],
    disabled: Boolean(src.disabled),
    markdownOnly: Boolean(src.markdownOnly),
    promptOnly: Boolean(src.promptOnly),
    runOnEdit: Boolean(src.runOnEdit),
    substituteRegex: Number.isFinite(Number(src.substituteRegex)) ? Number(src.substituteRegex) : SUBSTITUTE.NONE,
    minDepth: Number.isFinite(minDepth) ? minDepth : null,
    maxDepth: Number.isFinite(maxDepth) ? maxDepth : null,
  }

  // ST 的历史迁移（public/scripts/extensions/regex/index.js 的 migrateSettings）：
  // placement 里带过时的 MD_DISPLAY(0) 时，把它去掉并改成 markdownOnly + promptOnly
  // （两者同开 = 两种场合都跑）。若 0 是唯一的 placement，则展开成除 0 之外的全部取值，
  // 与 ST 的 Object.values(regex_placement).filter(e => e !== MD_DISPLAY) 完全一致。
  if (out.placement.includes(REGEX_PLACEMENT.MD_DISPLAY)) {
    const rest = out.placement.filter(item => item !== REGEX_PLACEMENT.MD_DISPLAY);
    out.placement = rest.length
      ? rest
      : Object.values(REGEX_PLACEMENT).filter(item => item !== REGEX_PLACEMENT.MD_DISPLAY)
    out.markdownOnly = true
    out.promptOnly = true
  }

  // 保留扩展字段
  for (const [key, value] of Object.entries(src)) {
    if (!(key in out)) out[key] = value
  }
  return out
}

/**
 * 归一化脚本列表，兼容数组与 { scripts: [...] } 两种形态。
 *
 * @param {Array|{scripts: Array}} raw 原始数据
 * @returns {Record<string, any>[]} 规范化后的脚本数组
 * @throws {Error} raw 既不是数组也不是含 scripts 的对象时抛出
 */
export function normalizeRegexScripts(raw) {
  if (raw === undefined || raw === null) return []
  let list
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'object' && Array.isArray(raw.scripts)) list = raw.scripts
  else if (typeof raw === 'object' && Array.isArray(raw.regex)) list = raw.regex
  else throw new Error('正则脚本数据必须是数组或 { scripts: [...] }')
  return list
    .filter(item => item && typeof item === 'object')
    .map((item, index) => normalizeRegexScript(item, index))
}

/**
 * 一条脚本在给定场景下是否应当生效。
 *
 * 判定顺序与 ST 的 getRegexedString 一致：先看 markdownOnly / promptOnly 的互斥，
 * 再看 runOnEdit，最后看 minDepth / maxDepth。
 *
 * @param {Record<string, any>} script 脚本
 * @param {number} placement 本次作用的 placement 数值
 * @param {Object} [options]
 * @param {boolean} [options.markdown] 输入是不是 Markdown 展示文本
 * @param {boolean} [options.prompt]   输入是不是发给模型的提示词
 * @param {boolean} [options.edit]     是不是编辑消息
 * @param {number} [options.depth]     消息深度（用于 minDepth / maxDepth）
 * @returns {boolean} 应当生效为 true
 */
export function regexScriptApplies(script, placement, options = {}) {
  if (!script || script.disabled) return false
  if (!script.findRegex) return false
  if (!Array.isArray(script.placement) || !script.placement.includes(placement)) return false

  const isMarkdown = options.markdown === true
  const isPrompt = options.prompt === true

  // 与 ST 相同：两个 only 都开或都不开时，只对「既不是 Markdown 也不是 prompt」的普通文本生效
  const appliesByKind =
    (script.markdownOnly && isMarkdown) ||
    (script.promptOnly && isPrompt) ||
    (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt)
  if (!appliesByKind) return false

  if (options.edit === true && !script.runOnEdit) return false

  const depth = options.depth
  if (Number.isFinite(depth)) {
    if (Number.isFinite(script.minDepth) && script.minDepth >= -1 && depth < script.minDepth) return false
    if (Number.isFinite(script.maxDepth) && script.maxDepth >= 0 && depth > script.maxDepth) return false
  }

  return true
}

/**
 * 过滤替换内容里要剔除的字符串（ST 的 trimStrings）。
 *
 * @param {string} text 待过滤文本
 * @param {string[]} trimStrings 要剔除的字符串
 * @param {((value: string) => string)|null} [expand] 宏展开函数
 * @returns {string} 过滤后的文本
 */
function filterTrimStrings(text, trimStrings, expand) {
  let result = String(text)
  for (const trim of trimStrings || []) {
    const resolved = expand ? String(expand(trim)) : String(trim)
    if (!resolved) continue
    result = result.split(resolved).join('')
  }
  return result
}

/**
 * 对一段文本执行一条脚本。
 *
 * @param {Record<string, any>} script 已规范化的脚本
 * @param {string} text 待处理文本
 * @param {Object} [options]
 * @param {(value: string) => string} [options.expand] 宏展开函数，用于 substituteRegex 与替换串里的宏
 * @returns {string} 处理后的文本；正则无效或脚本禁用时原样返回
 */
export function runRegexScript(script, text, options = {}) {
  const input = String(text === undefined || text === null ? '' : text)
  if (!script || script.disabled || !script.findRegex || !input) return input

  const expand = typeof options.expand === 'function' ? options.expand : null

  let pattern = script.findRegex
  if (script.substituteRegex === SUBSTITUTE.RAW && expand) pattern = expand(pattern)
  else if (script.substituteRegex === SUBSTITUTE.ESCAPED && expand) pattern = sanitizeRegexMacro(expand(pattern))

  const regex = compileRegex(pattern)
  if (!regex) return input

  // 先处理 {{match}}，再处理 $n / $<name>
  const template = String(script.replaceString || '')
  const withMatch = template.replace(/\{\{match\}\}/gi, '$0')

  const replaced = input.replace(regex, (...args) => {
    // args: [match, p1..pn, offset, string, groups?]
    const tail = args.length ? args[args.length - 1] : null
    const groups = tail && typeof tail === 'object' ? tail : null
    return withMatch.replace(/\$(\d+)|\$<([^>]+)>/g, (whole, number, groupName) => {
      let captured = ''
      if (number !== undefined) {
        const index = Number(number)
        captured = args[index] === undefined || args[index] === null ? '' : String(args[index])
      } else if (groupName && groups && groups[groupName] !== undefined) {
        captured = String(groups[groupName])
      }
      if (!captured) return ''
      return filterTrimStrings(captured, script.trimStrings, expand)
    })
  })

  // 与 ST 一致：替换串里剩下的宏也要展开
  return expand ? expand(replaced) : replaced
}

/**
 * 按顺序把一批正则脚本作用到文本上。
 *
 * @param {string} text 原始文本
 * @param {Record<string, any>[]|{scripts: Array}} scripts 脚本数组（会自动规范化）
 * @param {'prompt'|'display'|number|string} placement 作用场景：'display'=显示、'prompt'=发给模型，也可以给 ST 的数值
 * @param {Object} [options]
 * @param {boolean} [options.markdown] 输入是 Markdown 展示文本
 * @param {boolean} [options.edit]     输入来自编辑消息
 * @param {number} [options.depth]     消息深度
 * @param {(value: string) => string} [options.expand] 宏展开函数
 * @returns {string} 处理后的文本
 */
export function applyRegex(text, scripts, placement, options = {}) {
  const input = String(text === undefined || text === null ? '' : text)
  if (!input) return input
  const list = normalizeRegexScripts(scripts)
  if (list.length === 0) return input

  const target = resolvePlacement(placement)
  const isPrompt = target === REGEX_PLACEMENT.AI_OUTPUT || target === REGEX_PLACEMENT.WORLD_INFO
  const isMarkdown = target === REGEX_PLACEMENT.MD_DISPLAY
  const context = {
    markdown: options.markdown === undefined ? isMarkdown : Boolean(options.markdown),
    prompt: options.prompt === undefined ? isPrompt : Boolean(options.prompt),
    edit: Boolean(options.edit),
    depth: options.depth,
  }

  let result = input
  for (const script of list) {
    if (!regexScriptApplies(script, target, context)) continue
    try {
      result = runRegexScript(script, result, options)
    } catch {
      // 单条脚本炸了不能毁掉整段提示词：跳过它，保持前面脚本的结果
    }
  }
  return result
}

/**
 * 正则脚本仓库：全部脚本存一份 <layout.regex>/scripts.json。
 *
 * 文件形态 { scripts: [...] }，与 lib/tools/prompts.js 的 st_apply_regex 工具共用同一个文件。
 *
 * @param {Object} state 插件状态（需要 state.layout.regex）
 * @returns {{ file: string, read: Function, list: Function, write: Function }} 仓库对象
 * @throws {Error} state 缺少 layout.regex 时抛出
 */
export function createRegexStore(state) {
  if (!state || !state.layout || !state.layout.regex) throw new Error('createRegexStore 需要 state.layout.regex')
  const file = join(state.layout.regex, 'scripts.json')

  return {
    file,
    /**
     * 读全部脚本（已规范化）。
     * @returns {Record<string, any>[]} 脚本数组
     */
    read() {
      const raw = existsSync(file) ? readJson(file, { scripts: [] }) : { scripts: [] }
      return normalizeRegexScripts(raw)
    },
    /**
     * 列出全部脚本（read 的别名，供 CONTRACTS 里的 list() 使用）。
     * @returns {Record<string, any>[]} 脚本数组
     */
    list() {
      return this.read()
    },
    /**
     * 整表覆盖写入。
     * @param {Array|{scripts: Array}} scripts 脚本数组
     * @returns {Record<string, any>[]} 落盘后的脚本数组
     */
    write(scripts) {
      const list = normalizeRegexScripts(scripts)
      writeJson(file, { scripts: list })
      if (state.cache && typeof state.cache.delete === 'function') state.cache.delete('regex')
      return list
    },
  }
}
