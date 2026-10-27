/**
 * 插件自检：用假的 ctx 把插件挂起来，检查模块导入、工具契约、真实调用、路由、提示词分节与落盘。
 *
 * 这不是发布产物的一部分，是开发期的快速反馈回路：
 * 起一个 dsh web 要 40 秒，这个只要几秒。
 *
 * 失败项按负责人分组（tavern-core / tavern-tools / trpg-gm / tavern-ui / lead），
 * 方便直接把报错原文转给对应的人。
 *
 * 用法：node scripts/verify.mjs [--keep] [--quiet]
 *   --keep   保留临时数据目录，便于查看真实落盘结果
 *   --quiet  只打印失败项与汇总
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const QUIET = argv.includes('--quiet')
const SEP = String.fromCharCode(92)

/* ────────────────────────── 结果收集 ────────────────────────── */

const failures = []
const passes = []
const skips = []
const notes = []

/** 记录一条检查。owner 表示出问题时该找谁。 */
function check(label, ok, detail, owner) {
  const who = owner || 'lead'
  if (ok) {
    passes.push({ label, who })
    if (!QUIET) console.log('  ✓ ' + label)
  } else {
    const entry = { label, detail: detail === undefined ? '' : String(detail), who }
    failures.push(entry)
    console.log('  ✗ ' + label + (entry.detail ? ' :: ' + entry.detail : ''))
  }
  return Boolean(ok)
}

/** 记录一条跳过（依赖尚未实现）。 */
function skip(label, reason) {
  skips.push({ label, reason: reason || '' })
  if (!QUIET) console.log('  - ' + label + '（跳过' + (reason ? '：' + reason : '') + '）')
}

/** 记录一条不判失败的观察。 */
function note(label) {
  notes.push(label)
  if (!QUIET) console.log('  · ' + label)
}

function section(title) {
  if (!QUIET) console.log('\n— ' + title + ' —')
}

/** 把错误压成一行可读文本，尽量带上本仓库的文件位置。 */
function errorText(error) {
  if (!error) return '未知错误'
  const message = error.message ? String(error.message) : String(error)
  const stack = typeof error.stack === 'string' ? error.stack.split('\n') : []
  const frames = stack
    .map(line => line.trim())
    .filter(line => line.startsWith('at ') && (line.includes('dsh-sillytavern') || line.includes('/lib/') || line.includes(SEP + 'lib' + SEP)))
    .slice(0, 3)
  return frames.length ? message + ' | ' + frames.join(' ← ') : message
}

/* ────────────────────────── 契约常量 ────────────────────────── */

/** 工具名总表（lib/CONTRACTS.md「工具名总表」）→ 负责团队。 */
const EXPECTED_TOOLS = {
  st_list_characters: 'tavern-tools',
  st_get_character: 'tavern-tools',
  st_create_character: 'tavern-tools',
  st_edit_character: 'tavern-tools',
  st_import_character: 'tavern-tools',
  st_export_character: 'tavern-tools',
  st_bind_character: 'tavern-tools',
  st_list_worldbooks: 'tavern-tools',
  st_get_worldbook: 'tavern-tools',
  st_create_worldbook: 'tavern-tools',
  st_import_worldbook: 'tavern-tools',
  st_add_worldbook_entry: 'tavern-tools',
  st_toggle_worldbook: 'tavern-tools',
  st_scan_worldbook: 'tavern-tools',
  st_list_presets: 'tavern-tools',
  st_get_preset: 'tavern-tools',
  st_set_preset: 'tavern-tools',
  st_set_author_note: 'tavern-tools',
  st_apply_regex: 'tavern-tools',
  st_get_chat_state: 'tavern-tools',
  st_swipe: 'tavern-tools',
  st_regenerate: 'tavern-tools',
  st_set_persona: 'tavern-tools',
  st_set_scene: 'tavern-tools',
  st_export_chat: 'tavern-tools',
  st_get_variables: 'tavern-tools',
  st_set_variable: 'tavern-tools',
  st_list_variables: 'tavern-tools',
  st_import_sillytavern: 'tavern-tools',
  st_list_st_sources: 'tavern-tools',
  trpg_roll: 'trpg-gm',
  trpg_check: 'trpg-gm',
  trpg_start_encounter: 'trpg-gm',
  trpg_next_turn: 'trpg-gm',
  trpg_update_sheet: 'trpg-gm',
  trpg_show_map: 'trpg-gm',
  trpg_update_scene: 'trpg-gm',
  trpg_log: 'trpg-gm',
}

/** 需要被 plugin.js 调用的注册函数 → 文件与负责人。 */
const REGISTER_MODULES = [
  { file: 'lib/tools/characters.js', exportName: 'registerCharacterTools', owner: 'tavern-tools' },
  { file: 'lib/tools/worldbooks.js', exportName: 'registerWorldbookTools', owner: 'tavern-tools' },
  { file: 'lib/tools/prompts.js', exportName: 'registerPromptTools', owner: 'tavern-tools' },
  { file: 'lib/tools/chats.js', exportName: 'registerChatTools', owner: 'tavern-tools' },
  { file: 'lib/tools/trpg.js', exportName: 'registerTrpgTools', owner: 'trpg-gm' },
  { file: 'lib/tools/importer.js', exportName: 'registerImportTools', owner: 'tavern-tools' },
  { file: 'lib/prompt/assembly.js', exportName: 'registerAssembly', owner: 'tavern-core' },
  { file: 'lib/routes.js', exportName: 'registerRoutes', owner: 'tavern-tools' },
]

/* ────────────────────────── 假 ctx ────────────────────────── */

/**
 * 最小 Cordis ctx 替身：记录注册物，支持 effect 与 get。
 * 重复注册直接抛错，与真实宿主一致；effect 返回值可被调用以触发卸载钩子。
 */
function fakeCtx() {
  const tools = new Map()
  const routes = new Map()
  const sections = new Map()
  const effects = []
  const getRequests = []
  /** ctx.inject 回调里抛出的错误（真实宿主里会让 fiber FAILED，这里收集起来报）。 */
  const injectErrors = []
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const ctx = {
    tools: {
      register(tool) {
        if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error('工具注册缺少 name')
        if (tools.has(tool.name)) throw new Error('工具重名: ' + tool.name)
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      list() { return [...tools.keys()] },
    },
    webServer: {
      register(route) {
        const key = String(route && route.kind) + ':' + String(route && route.path)
        if (routes.has(key)) throw new Error('路由重名: ' + key)
        routes.set(key, route)
        return () => routes.delete(key)
      },
    },
    systemPrompt: {
      section(entry) {
        if (!entry || typeof entry.name !== 'string') throw new Error('提示词分节缺少 name')
        if (sections.has(entry.name)) throw new Error('提示词分节重名: ' + entry.name)
        sections.set(entry.name, entry)
        return () => sections.delete(entry.name)
      },
      variable() { return () => {} },
      context() { return () => {} },
      getSectionOrder() { return 6500 },
    },
    layout: { selectPanel() { return () => {} }, registerPanel() { return () => {} } },
    slots: { inject() { return () => {} }, register() { return () => {} } },
    logger,
    get(name) {
      getRequests.push(String(name))
      if (name === 'logger') return logger
      if (name === 'systemPrompt') return ctx.systemPrompt
      if (name === 'webServer') return ctx.webServer
      return undefined
    },
/**
     * Cordis 的 ctx.inject(deps, callback)：服务就绪后用作用域 ctx 调回调。
     * 假 ctx 里所有服务都当作已就绪，直接同步调用；回调返回 dispose 时接住。
     */
    inject(deps, callback) {
      const scoped = Object.create(ctx)
      // 作用域 ctx 只多一层"这些服务一定可用"的语义，接口与 ctx 相同。
      const created = Object.assign(scoped, { _scope: true })
      let disposer
      try {
        disposer = typeof callback === 'function' ? callback(created) : undefined
      } catch (error) {
        injectErrors.push({ deps, error })
        throw error
      }
      if (typeof disposer === 'function') effects.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    on() { return () => {} },
    // 模拟 Cordis 的 ctx.inject(services, callback)：服务就绪后回调。
    // 假 ctx 里所有服务都是"已就绪"，所以同步执行回调。
    inject(_services, callback) {
      const result = callback(ctx)
      if (result && typeof result.then === 'function') return result
      return result
    },
    emit() {},
    _introspect: { tools, routes, sections, effects, getRequests, injectErrors },
  }
  return ctx
}

/** 建一个与 lib/paths.js ensureLayout 同形的目录表（并真的创建目录）。 */
function ensureLayoutSync(rootDir) {
  const layout = {
    root: rootDir,
    characters: join(rootDir, 'characters'),
    avatars: join(rootDir, 'avatars'),
    worlds: join(rootDir, 'worlds'),
    chats: join(rootDir, 'chats'),
    groups: join(rootDir, 'groups'),
    presets: join(rootDir, 'presets'),
    regex: join(rootDir, 'regex'),
    quickReplies: join(rootDir, 'quick-replies'),
    personas: join(rootDir, 'personas'),
    trpg: join(rootDir, 'trpg'),
    settings: join(rootDir, 'settings.json'),
    bindings: join(rootDir, 'bindings.json'),
    state: join(rootDir, 'state.json'),
  }
  for (const key of ['root', 'characters', 'avatars', 'worlds', 'chats', 'groups', 'presets', 'regex', 'quickReplies', 'personas', 'trpg']) {
    mkdirSync(layout[key], { recursive: true })
  }
  return layout
}

/** 造一个与 lib/plugin.js createState 同形的状态对象。 */
function makeState(ctx, config, rootDir) {
  return {
    ctx,
    config,
    layout: ensureLayoutSync(rootDir),
    cache: new Map(),
    data: { version: 1, sessions: {}, lastCharacter: null, personas: {}, ui: {}, trpg: {} },
    save() {},
    invalidate() {},
  }
}

/* ────────────────────────── JSON Schema 校验 ────────────────────────── */

const SCHEMA_CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const SCHEMA_ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * 按 DSH 支持的子集校验一个 JSON Schema（对齐 packages/core/tools/src/json-schema.ts）。
 * @param {any} node 待校验的 schema 节点
 * @param {string} path 当前路径，用于报错定位
 * @param {string[]} violations 违规收集器
 * @returns {void} 违规追加进 violations
 */
function checkJsonSchema(node, path, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(path + ' 不是 schema 对象')
    return
  }
  for (const key of Object.keys(node)) {
    if (SCHEMA_CONSTRAINT_KEYWORDS.has(key) || SCHEMA_ANNOTATION_KEYWORDS.has(key)) continue
    violations.push(path + '.' + key + ' 不是受支持的关键字')
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) { violations.push(path + ' 不能同时有 type 和 oneOf'); return }
  if (hasOneOf) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) violations.push(path + '.' + key + ' 不能与 oneOf 并列')
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(path + '.oneOf 至少要有两个分支')
    else node.oneOf.forEach((branch, i) => checkJsonSchema(branch, path + '.oneOf[' + i + ']', violations))
    return
  }
  if (!hasType) { violations.push(path + ' 缺少 type 或 oneOf'); return }
  if (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type)) {
    violations.push(path + '.type 非法: ' + JSON.stringify(node.type))
    return
  }
  const onlyFor = { properties: 'object', required: 'object', additionalProperties: 'object', items: 'array' }
  for (const [key, allowed] of Object.entries(onlyFor)) {
    if (Object.hasOwn(node, key) && node.type !== allowed) violations.push(path + '.' + key + ' 只能用于 ' + allowed)
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(path + '.additionalProperties 必须是布尔值')
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some(v => typeof v !== 'string')) {
      violations.push(path + '.required 必须是字符串数组')
    } else if (node.properties && typeof node.properties === 'object') {
      for (const key of node.required) {
        if (!Object.hasOwn(node.properties, key)) violations.push(path + '.required 里的 "' + key + '" 不在 properties 中')
      }
    }
  }
  if (Object.hasOwn(node, 'properties')) {
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      violations.push(path + '.properties 必须是对象')
    } else {
      for (const [key, child] of Object.entries(node.properties)) checkJsonSchema(child, path + '.properties.' + key, violations)
    }
  }
  if (Object.hasOwn(node, 'items')) checkJsonSchema(node.items, path + '.items', violations)
  if (Object.hasOwn(node, 'enum') && !Array.isArray(node.enum)) violations.push(path + '.enum 必须是数组')
  if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') violations.push(path + '.description 必须是字符串')
  if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') violations.push(path + '.title 必须是字符串')
}

/** 判断一个值是否是无损 JSON（可被 JSON.stringify 无损往返）。 */
function isLosslessJson(value, seen) {
  const visited = seen || new Set()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object') return false
  if (visited.has(value)) return false
  visited.add(value)
  try {
    if (Array.isArray(value)) return value.every(item => isLosslessJson(item, visited))
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(value).every(item => isLosslessJson(item, visited))
  } finally {
    visited.delete(value)
  }
}

/* ────────────────────────── 参数合成 ────────────────────────── */

/** 从 schema 节点合成一个类型正确的样值。 */
function sampleValue(node) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0]
  if (Object.hasOwn(node, 'default')) return node.default
  if (Array.isArray(node.oneOf) && node.oneOf.length) return sampleValue(node.oneOf[0])
  switch (node.type) {
    case 'string': return 'qa-sample'
    case 'number':
    case 'integer': return typeof node.minimum === 'number' ? node.minimum : 1
    case 'boolean': return false
    case 'array': return []
    case 'object': return {}
    case 'null': return null
    default: return null
  }
}

/** 由参数 schema 合成一份「必填字段齐全」的最小合法参数。 */
function minimalArgs(schema) {
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const required = new Set(Array.isArray(schema && schema.required) ? schema.required : [])
  const args = {}
  for (const [name, node] of Object.entries(props)) {
    if (required.has(name) || Object.hasOwn(node, 'default')) args[name] = sampleValue(node)
  }
  return args
}

/** 深遍历任意 JSON 值里的对象。 */
function collectObjects(value, out, depth) {
  const acc = out || []
  const level = depth || 0
  if (level > 12 || value === null || typeof value !== 'object') return acc
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, acc, level + 1)
    return acc
  }
  acc.push(value)
  for (const item of Object.values(value)) collectObjects(item, acc, level + 1)
  return acc
}

/* ────────────────────────── 假 req / res ────────────────────────── */

/** 构造一个回环 GET 请求对象。 */
function fakeRequest(pathname) {
  return {
    method: 'GET',
    url: pathname,
    headers: { host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 5555, localAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
    on() {},
    once() {},
    off() {},
    resume() {},
    pause() {},
    setEncoding() {},
    read() { return null },
    destroy() {},
    pipe() { return this },
  }
}

/** 构造一个收集响应的 res 对象。 */
function fakeResponse() {
  const chunks = []
  const res = {
    statusCode: 200,
    headers: {},
    finished: false,
    writableEnded: false,
    setHeader(name, value) { res.headers[String(name).toLowerCase()] = value },
    getHeader(name) { return res.headers[String(name).toLowerCase()] },
    removeHeader(name) { delete res.headers[String(name).toLowerCase()] },
    writeHead(code, headers) {
      res.statusCode = code
      if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
      }
      return res
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) res.write(chunk)
      res.finished = true
      res.writableEnded = true
      return res
    },
    get body() { return Buffer.concat(chunks).toString('utf8') },
    get json() { try { return JSON.parse(res.body) } catch { return undefined } },
  }
  return res
}

/* ────────────────────────── 运行环境 ────────────────────────── */

/** 假 ctx 里给工具用的会话 id：模拟"模型在某个 DSH 会话里调用工具"。 */
const SESSION_ID = 'qa-session'

/** 真实 SillyTavern 安装目录候选（存在即用来跑只读导入探测）。 */
const ST_ROOT_CANDIDATES = [
  process.env.SILLYTAVERN_ROOT || '',
  'D:' + SEP + 'Silly' + SEP + 'SillyTavern-1.16.0',
]
const ST_ROOT = ST_ROOT_CANDIDATES.find(dir => dir && existsSync(dir)) || ''

/** 造临时测试文件用的小工具。 */
function fixturePath(name) {
  return join(dataRoot, 'fixtures', name)
}

/* ────────────────────────── 主流程 ────────────────────────── */

console.log('[dsh-sillytavern] 自检开始')

const dataRoot = join(process.env.TEMP || '/tmp', 'dsh-sillytavern-verify-' + process.pid)
try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* 上次残留清不掉也不影响本次 */ }

let mod
try {
  mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
} catch (error) {
  console.error('导入 lib/index.js 失败:', errorText(error))
  process.exit(1)
}

/* ── 1. 入口导出 ── */
section('入口导出')
check('导出 apply', typeof mod.apply === 'function')
check('导出 name', mod.name === 'dsh-sillytavern', String(mod.name))
check('导出 inject 数组', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
check('不使用 default export（Loader 会因此丢弃命名导出）', mod.default === undefined)
check('Config 是 Standard Schema v1', Boolean(mod.Config && mod.Config['~standard'] && mod.Config['~standard'].version === 1))

/* ── 2. Config ── */
section('Config')
/** 默认值表：字段名 → 期望类型（plugin.js 的 DEFAULTS 是唯一事实来源）。 */
const DEFAULT_TYPES = {
  dataRoot: 'string',
  sillyTavernRoot: 'string',
  autoBind: 'boolean',
  maxWorldInfoDepth: 'number',
  worldInfoBudget: 'number',
  authorNoteDepth: 'number',
  trpgLayout: 'boolean',
  trpgCenterPanel: 'string',
  injectSystemPrompt: 'boolean',
  promptSectionOrder: 'number',
  maxHistoryMessages: 'number',
  defaultDiceSystem: 'string',
}
let resolvedConfig = { dataRoot }
try {
  const result = mod.Config['~standard'].validate({ dataRoot })
  check('Config 校验通过（空配置）', !result.issues, JSON.stringify(result.issues || []))
  resolvedConfig = result.value
  const missing = Object.keys(DEFAULT_TYPES).filter(key => !Object.hasOwn(resolvedConfig, key))
  check('默认值表每个字段都有值', missing.length === 0, '缺少: ' + missing.join(', '))
  const wrong = Object.entries(DEFAULT_TYPES).filter(([key, type]) => resolvedConfig[key] !== undefined && typeof resolvedConfig[key] !== type)
  check('默认值类型正确', wrong.length === 0, wrong.map(([k, t]) => k + ' 应为 ' + t + ' 实际 ' + typeof resolvedConfig[k]).join('; '))
  check('dataRoot 原样保留传入值', resolvedConfig.dataRoot === dataRoot, String(resolvedConfig.dataRoot))
  check('dataRoot 为空时回退到 DSH home', (() => {
    const fallback = mod.Config['~standard'].validate({ dataRoot: '' }).value.dataRoot
    return typeof fallback === 'string' && fallback !== '' && fallback !== dataRoot
  })())

  const coarse = mod.Config['~standard'].validate({
    maxWorldInfoDepth: 999,
    maxHistoryMessages: -5,
    trpgCenterPanel: '不存在的面板',
    defaultDiceSystem: 'nope',
    worldInfoBudget: 'abc',
  }).value
  check('越界整数被夹取', coarse.maxWorldInfoDepth === 20 && coarse.maxHistoryMessages === 2,
    JSON.stringify({ maxWorldInfoDepth: coarse.maxWorldInfoDepth, maxHistoryMessages: coarse.maxHistoryMessages }))
  check('非法枚举回退默认值', coarse.trpgCenterPanel === 'map' && coarse.defaultDiceSystem === 'dnd5e',
    JSON.stringify({ trpgCenterPanel: coarse.trpgCenterPanel, defaultDiceSystem: coarse.defaultDiceSystem }))
  check('非法数字回退默认值', coarse.worldInfoBudget === 2048, String(coarse.worldInfoBudget))
  check('null 配置也能给出完整默认值', Boolean(mod.Config['~standard'].validate(null).value.dataRoot))
} catch (error) {
  check('Config 校验不抛异常', false, errorText(error))
}

/* ── 3. 逐模块注册（归属定位） ── */
section('逐模块注册')
/** 模块 → 它注册的工具 / 路由 / 分节，用于把失败归到具体人。 */
const moduleFacts = {}
for (const spec of REGISTER_MODULES) {
  const file = join(root, spec.file)
  if (!existsSync(file)) {
    check(spec.file + ' 存在', false, '文件不存在', spec.owner)
    continue
  }
  let imported
  try {
    imported = await import(pathToFileURL(file).href)
  } catch (error) {
    check(spec.file + ' 可被 ESM 加载', false, errorText(error), spec.owner)
    continue
  }
  if (typeof imported[spec.exportName] !== 'function') {
    check(spec.file + ' 导出 ' + spec.exportName, false, '实际导出: ' + (Object.keys(imported).join(', ') || '（无）'), spec.owner)
    continue
  }
  const localCtx = fakeCtx()
  try {
    imported[spec.exportName](localCtx, makeState(localCtx, resolvedConfig, join(dataRoot, 'probe-' + spec.exportName)))
    const names = [...localCtx._introspect.tools.keys()]
    const routes = [...localCtx._introspect.routes.keys()]
    const sectionNames = [...localCtx._introspect.sections.keys()]
    moduleFacts[spec.file] = { tools: names, routes, sections: sectionNames }
    check(spec.file + ' 注册成功', names.length + routes.length + sectionNames.length > 0,
      '注册了 0 个工具/路由/分节（空实现）', spec.owner)
    if (names.length) note(spec.file + ' → ' + names.length + ' 个工具: ' + names.join(', '))
    if (routes.length) note(spec.file + ' → ' + routes.length + ' 条路由: ' + routes.join(', '))
    if (sectionNames.length) note(spec.file + ' → ' + sectionNames.length + ' 个分节: ' + sectionNames.join(', '))
  } catch (error) {
    check(spec.file + ' 注册不抛异常', false, errorText(error), spec.owner)
  }
}

/* ── 4. 集成 apply ── */
section('集成 apply')
const ctx = fakeCtx()
let applyOk = false
try {
  await mod.apply(ctx, resolvedConfig)
  applyOk = true
  check('apply 执行成功', true)
} catch (error) {
  check('apply 执行成功', false, errorText(error))
}

const tools = [...ctx._introspect.tools.keys()].sort()
const routeEntries = [...ctx._introspect.routes.entries()]
const sectionEntries = [...ctx._introspect.sections.entries()]

if (!QUIET) {
  console.log('\n工具 (' + tools.length + '):')
  for (const name of tools) console.log('  - ' + name + '  [' + (EXPECTED_TOOLS[name] || '契约外') + ']')
  console.log('\n路由 (' + routeEntries.length + '):')
  for (const [key] of routeEntries) console.log('  - ' + key)
  console.log('\n提示词分节 (' + sectionEntries.length + '):')
  for (const [key] of sectionEntries) console.log('  - ' + key)
}

/* ── 5. 工具名总表齐全性 ── */
section('工具名总表')
const ownerOfTool = new Map()
for (const [file, facts] of Object.entries(moduleFacts)) {
  const owner = (REGISTER_MODULES.find(s => s.file === file) || {}).owner || 'lead'
  for (const name of facts.tools) ownerOfTool.set(name, owner)
}
if (applyOk) {
  const registered = new Set(tools)
  const missing = Object.keys(EXPECTED_TOOLS).filter(name => !registered.has(name))
  const missingByOwner = new Map()
  for (const name of missing) {
    const owner = EXPECTED_TOOLS[name] || 'tavern-tools'
    missingByOwner.set(owner, (missingByOwner.get(owner) || 0) + 1)
  }
  check('契约工具全部注册', missing.length === 0,
    missing.length ? '缺少 ' + missing.length + ' 个: ' + missing.join(', ') + '（' + [...missingByOwner].map(([o, n]) => o + ' ' + n + ' 个').join('，') + '）' : undefined,
    missing.length ? EXPECTED_TOOLS[missing[0]] : undefined)
  const extra = tools.filter(name => !Object.hasOwn(EXPECTED_TOOLS, name))
  if (extra.length) note('契约外的额外工具: ' + extra.join(', '))
  check('工具名带 st_ / trpg_ / stage_ / tavern_ 前缀', tools.every(t => t.startsWith('st_') || t.startsWith('trpg_') || t.startsWith('stage_') || t.startsWith('tavern_')),
    tools.filter(t => !t.startsWith('st_') && !t.startsWith('trpg_')).join(', '))
  check('工具名唯一', new Set(tools).size === tools.length)
  const unowned = tools.filter(name => !ownerOfTool.has(name))
  if (unowned.length) note('无法归属到具体模块的工具: ' + unowned.join(', '))
} else {
  skip('工具名总表检查', 'apply 未成功')
}

/* ── 6. 工具契约 ── */
section('工具契约')
if (applyOk) {
  let broken = 0
  for (const name of tools) {
    const tool = ctx._introspect.tools.get(name)
    const owner = ownerOfTool.get(name) || EXPECTED_TOOLS[name] || 'tavern-tools'
    const problems = []
    if (typeof tool.description !== 'string' || tool.description.trim() === '') problems.push('description 为空')
    else if (/TODO|待补|占位|简化版/.test(tool.description)) problems.push('description 含占位/TODO 字样')
    else if (tool.description.trim().length < 10) problems.push('description 太短（' + tool.description.trim().length + ' 字符）')
    const schemaViolations = []
    checkJsonSchema(tool.parameters, 'parameters', schemaViolations)
    if (schemaViolations.length) problems.push('parameters 非法: ' + schemaViolations.slice(0, 3).join('; '))
    else if (tool.parameters.type !== 'object') problems.push('parameters 根不是 object')
    if (!tool.output || typeof tool.output !== 'object') problems.push('缺少 output')
    else {
      if (!tool.output.schema) problems.push('缺少 output.schema')
      else {
        const outViolations = []
        checkJsonSchema(tool.output.schema, 'output.schema', outViolations)
        if (outViolations.length) problems.push('output.schema 非法: ' + outViolations.slice(0, 3).join('; '))
      }
      if (typeof tool.output.render !== 'function') problems.push('缺少 output.render')
    }
    if (typeof tool.execute !== 'function') problems.push('缺少 execute')
    if (problems.length) {
      broken++
      check(name + ' 契约完整', false, problems.join('; '), owner)
    }
  }
  if (broken === 0) check('全部 ' + tools.length + ' 个工具的 description/parameters/output 合法', true)
} else {
  skip('工具契约检查', 'apply 未成功')
}

/* ────────────────────────── 真实调用 ────────────────────────── */

/** 调一个工具一次，记录结果。 */
async function invoke(name, extra) {
  const tool = ctx._introspect.tools.get(name)
  if (!tool) return { name, ok: false, error: '工具未注册', unregistered: true }
  const args = { ...minimalArgs(tool.parameters), ...(extra || {}) }
  const started = Date.now()
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), 20000)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  try {
    const value = await Promise.race([
      tool.execute(args, { signal: undefined, arguments: args, name, agent: { id: SESSION_ID } }),
      timeout,
    ])
    const ms = Date.now() - started
    if (value && value.timedOut === true) return { name, ok: false, error: '执行超过 20 秒未返回', ms, args }
    if (!isLosslessJson(value)) return { name, ok: false, error: '返回值不是无损 JSON（含 undefined/函数/循环引用）', ms, args }
    if (value && typeof value === 'object' && value.ok === false) {
      return { name, ok: false, error: '工具返回 ok:false :: ' + String(value.error || '（没有 error 字段）'), ms, args, business: true }
    }
    let roundTrip
    try {
      roundTrip = JSON.parse(JSON.stringify(value === undefined ? null : value))
    } catch (error) {
      return { name, ok: false, error: 'JSON.stringify 失败: ' + errorText(error), ms, args }
    }
    let rendered
    try {
      rendered = tool.output.render(args, roundTrip)
    } catch (error) {
      return { name, ok: false, error: 'output.render 抛错: ' + errorText(error), ms, args, value: roundTrip }
    }
    if (!Array.isArray(rendered)) return { name, ok: false, error: 'output.render 未返回数组', ms, args, value: roundTrip }
    const badBlock = rendered.find(block => !block || typeof block !== 'object' || typeof block.type !== 'string')
    if (badBlock) return { name, ok: false, error: 'output.render 返回非法内容块: ' + JSON.stringify(badBlock).slice(0, 120), ms, args, value: roundTrip }
    const badText = rendered.find(block => block.type === 'text' && typeof block.text !== 'string')
    if (badText) return { name, ok: false, error: 'text 块缺少字符串 text', ms, args, value: roundTrip }
    return { name, ok: true, value: roundTrip, ms, args }
  } catch (error) {
    const ms = Date.now() - started
    const errName = error && error.name ? error.name : 'Error'
    const errMsg = error && error.message ? String(error.message) : String(error)
    return { name, ok: false, error: errName + ': ' + errMsg, stack: errorText(error), ms, args, threw: true }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 判断一个抛错是不是「业务性拒绝」（找不到实体、前置条件未满足）。
 * 这类错误说明工具正常工作、只是没有数据，不算契约破坏。
 */
function isBusinessRejection(result) {
  if (result.business) return true
  if (!result.threw) return false
  const message = String(result.error || '')
  if (/^(TypeError|ReferenceError|SyntaxError|RangeError|URIError|ToolArgumentError)/.test(message)) return false
  if (/依赖模块\s+\S+\s+(当前不可用|不存在或加载失败)/.test(message)) return false
  return /不存在|未找到|找不到|没有|未指定|需要先|请先|必须先|未绑定|为空|无效|not found|NotFound|Unknown|unknown/i.test(message)
}

/** 写两个真实格式的 fixture 文件，给 st_import_character / st_import_worldbook 真有东西可读。 */
const FIXTURES = (() => {
  const dir = join(dataRoot, 'fixtures')
  mkdirSync(dir, { recursive: true })
  const cardPath = join(dir, 'qa-card.json')
  const bookPath = join(dir, 'qa-book.json')
  writeFileSync(cardPath, JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'QA导入角色',
      description: '这是一张用于自检导入链路的角色卡。',
      personality: '谨慎',
      scenario: '自检场景',
      first_mes: '我是被导入的角色。',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['qa'],
      creator: 'QA',
      character_version: '1.0',
    },
  }, null, 2), 'utf8')
  writeFileSync(bookPath, JSON.stringify({
    name: 'QA导入世界书',
    entries: {
      0: {
        uid: 0, key: ['自检', 'qa'], keysecondary: [], comment: 'QA 条目', content: '这是 QA 导入的条目正文。',
        constant: false, selective: true, selectiveLogic: 0, disable: false, order: 100, position: 0,
        depth: 4, role: 0, probability: 100, useProbability: true, group: '', groupWeight: 100,
        caseSensitive: false, matchWholeWords: false,
      },
    },
  }, null, 2), 'utf8')
  return { cardPath, bookPath, dir }
})()

/** 阶段一：造数据用的语义参数（字段名以实际 schema 为准，多余的会被丢弃）。 */
const SEMANTIC_CREATE = {
  st_create_character: {
    name: 'QA测试角色',
    description: 'QA 自检生成的角色卡描述，用于验证解析与存储链路。',
    personality: '冷静、精确、只说事实。',
    scenario: '一个只存在于自检里的测试场景。',
    first_mes: '你好，我是 QA 测试角色。',
    mes_example: '<START>\n{{user}}: 测试\n{{char}}: 收到。',
    tags: ['qa', '测试'],
    creator: 'QA',
  },
  st_create_worldbook: { name: 'QA测试世界书', description: 'QA 自检用世界书' },
  st_import_character: { path: FIXTURES.cardPath },
  st_import_worldbook: { path: FIXTURES.bookPath },
  st_import_sillytavern: { stRoot: ST_ROOT, dryRun: true },
  st_list_st_sources: { stRoot: ST_ROOT },
  st_set_author_note: { text: '这是 QA 自检写入的作者注释。' },
  st_add_worldbook_entry: { content: 'QA 自检写入的世界书条目正文。', key: ['qa', '自检'], comment: 'QA 条目' },
  trpg_roll: { expr: '2d6+3', expression: '2d6+3' },
  trpg_update_sheet: { action: 'create', name: 'QA角色', kind: 'pc', hp: 20, maxHp: 20 },
  trpg_show_map: { action: 'create', width: 12, height: 8, theme: 'dungeon' },
  trpg_log: { action: 'append', text: 'QA 日志条目', kind: 'system' },
  trpg_parse_markers: { text: '普通文本 {{roll 1d20}} 结束' },
}

/** 阶段二：依赖阶段一产出的实体。 */
function semanticArgs(name, stage) {
  const character = stage.character || 'QA测试角色'
  const book = stage.worldbook || 'QA测试世界书'
  switch (name) {
    case 'st_get_character':
    case 'st_edit_character':
    case 'st_export_character':
    case 'st_bind_character':
      return { id: character, name: character, character, characterId: character, identifier: character }
    case 'st_get_worldbook':
    case 'st_add_worldbook_entry':
    case 'st_toggle_worldbook':
    case 'st_scan_worldbook':
      return { name: book, worldbook: book, id: book, book }
    case 'st_get_preset':
    case 'st_set_preset':
    case 'st_apply_regex':
      return { name: 'QA 自检预设', preset: 'QA 自检预设' }
    case 'trpg_check':
      return { skill: '力量', ability: '力量', target: 12, dc: 12 }
    case 'trpg_next_turn':
      return { encounterId: stage.encounter, id: stage.encounter }
    case 'trpg_show_map':
      return { sceneId: stage.scene, id: stage.scene }
    case 'st_set_variable':
      return { key: 'qa_var', value: 'qa_value' }
    default:
      return {}
  }
}

const stage = {}
const calls = new Map()

// 阶段一必须覆盖所有"能独立造数据"的工具：名字里没有 create/import 的
// 语义型工具（掷骰、解析标记）参数不能靠 minimalArgs 合成。
const CREATE_PATTERN = /_create_|_import_|^trpg_roll$|^trpg_parse_markers$/



if (applyOk && tools.length > 0) {
  section('真实调用（阶段一：造数据）')
  const createTargets = tools.filter(name => CREATE_PATTERN.test(name))
  for (const name of createTargets) {
    const result = await invoke(name, SEMANTIC_CREATE[name] || {})
    calls.set(name, result)
    if (result.ok) note(name + ' 成功（' + result.ms + 'ms）')
    else note(name + ' 失败: ' + result.error)
  }

  // 造完立刻列出，拿到真实实体标识
  for (const listName of ['st_list_characters', 'st_list_worldbooks']) {
    if (!calls.has(listName)) {
      const result = await invoke(listName, {})
      calls.set(listName, result)
      if (result.ok) {
        const raw = result.value
        const first = collectObjects(raw).find(obj => obj && (typeof obj.id === 'string' || typeof obj.name === 'string'))
        if (first) {
          if (listName === 'st_list_characters') stage.character = first.id || first.name
          if (listName === 'st_list_worldbooks') stage.worldbook = first.name || first.id
        }
      }
    }
  }
  if (stage.character) note('角色实体标识: ' + stage.character)
  if (stage.worldbook) note('世界书实体标识: ' + stage.worldbook)

  section('真实调用（阶段二：全量）')
  for (const name of tools) {
    if (calls.has(name)) continue
    const result = await invoke(name, { ...(SEMANTIC_CREATE[name] || {}), ...semanticArgs(name, stage) })
    calls.set(name, result)
  }

  /* 汇总 */
  section('调用结果')
  const hard = []
  const soft = []
  for (const [name, result] of calls) {
    if (result.ok) continue
    if (isBusinessRejection(result)) { soft.push({ name, result }); continue }
    hard.push({ name, result })
  }
  for (const { name, result } of hard) {
    const missing = /依赖模块\s+(\S+?)\s+当前不可用/.exec(String(result.error || ''))
    // 「依赖模块 ../st/xxx.js 不可用」是提供方没写，不怪调用方工具。
    const owner = missing ? 'tavern-core（缺 ' + missing[1] + '）' : (ownerOfTool.get(name) || EXPECTED_TOOLS[name] || 'tavern-tools')
    check(name + ' 可调用', false, result.error + (result.stack && result.stack !== result.error ? ' ← ' + result.stack : ''), owner)
  }
  const total = calls.size
  if (hard.length === 0) check('全部 ' + total + ' 个工具调用未抛未预期异常', true)
  for (const { name, result } of soft) note(name + ' 返回业务性拒绝（非契约破坏）: ' + result.error)
  const okCount = [...calls.values()].filter(r => r.ok).length
  note('调用成功 ' + okCount + ' / ' + total + '（业务性拒绝 ' + soft.length + '，异常 ' + hard.length + '）')
  const slowest = [...calls.values()].filter(r => r.ok).sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, 3)
  if (slowest.length) note('最慢: ' + slowest.map(r => r.name + ' ' + r.ms + 'ms').join(', '))
}

/* ── 语义回读 ── */
section('语义回读')
if (applyOk) {
  const listChars = calls.get('st_list_characters')
  if (!listChars) check('角色列表回读', false, 'st_list_characters 未注册', 'tavern-tools')
  else if (listChars.ok) {
    const hasChar = collectObjects(listChars.value).some(obj => obj && (obj.name === 'QA测试角色' || obj.id === 'QA测试角色'))
    check('新建的角色能被列出', hasChar, '结果里找不到 QA测试角色', 'tavern-tools')
  } else {
    check('角色列表回读', false, listChars.error, 'tavern-tools')
  }
  const listBooks = calls.get('st_list_worldbooks')
  if (!listBooks) check('世界书列表回读', false, 'st_list_worldbooks 未注册', 'tavern-tools')
  else if (listBooks.ok) {
    const hasBook = collectObjects(listBooks.value).some(obj => obj && (obj.name === 'QA测试世界书' || obj.title === 'QA测试世界书'))
    check('新建的世界书能被列出', hasBook, '结果里找不到 QA测试世界书', 'tavern-tools')
  } else {
    check('世界书列表回读', false, listBooks.error, 'tavern-tools')
  }

  const roll = calls.get('trpg_roll')
  if (roll && roll.ok) {
    const totals = collectObjects(roll.value).filter(obj => typeof obj.total === 'number').map(obj => obj.total)
    const inRange = totals.filter(n => n >= 5 && n <= 15)
    check('trpg_roll 2d6+3 结果落在 5..15', inRange.length > 0 && totals.length > 0,
      'value=' + JSON.stringify(roll.value).slice(0, 300), 'trpg-gm')
    // 顺带确认骰子是真的随机：同一表达式连掷 30 次不能全一样。
    if (inRange.length > 0) {
      const samples = new Set()
      for (let i = 0; i < 30; i++) {
        const again = await invoke('trpg_roll', { expr: '1d100' })
        if (again.ok) {
          const value = collectObjects(again.value).find(obj => typeof obj.total === 'number')
          if (value) samples.add(value.total)
        }
      }
      check('trpg_roll 连掷 30 次结果不恒定（真随机）', samples.size > 1, '30 次只出现 ' + samples.size + ' 种结果', 'trpg-gm')
    }
  } else if (roll) {
    check('trpg_roll 可调用', false, roll.error, 'trpg-gm')
  }
} else {
  skip('语义回读', 'apply 未成功')
}

/* ── 路由 ── */
section('路由')
if (applyOk) {
  check('注册了 HTTP 路由', routeEntries.length >= 1, '实际 ' + routeEntries.length, 'tavern-tools')
  const badRoutes = []
  for (const [key, route] of routeEntries) {
    if (route.kind !== 'exact' && route.kind !== 'prefix') badRoutes.push(key + ' kind 非法: ' + route.kind)
    else if (typeof route.path !== 'string' || !route.path.startsWith('/')) badRoutes.push(key + ' path 必须以 / 开头')
    else if (typeof route.handler !== 'function') badRoutes.push(key + ' 缺少 handler')
  }
  check('路由条目形状合法', badRoutes.length === 0, badRoutes.join('; '), 'tavern-tools')

  /** 拿一条路由的假响应。 */
  async function probeRoute(pathname) {
    const match = routeEntries.find(([, route]) => pathname === route.path || pathname.startsWith(route.path + '/'))
    if (!match) return undefined
    const res = fakeResponse()
    await match[1].handler(fakeRequest(pathname), res)
    return res
  }

  // 从注册表里取实际前缀，不写死：前缀改了测试不用改。
  const routeBase = routeEntries.length ? routeEntries[0][1].path : ''
  const pingRes = routeBase
    ? await probeRoute(routeBase + '/ping').catch(error => ({ thrown: errorText(error) }))
    : undefined
  if (!pingRes) {
    skip('GET /ping 实调', '未注册 ping 路由')
  } else if (pingRes.thrown) {
    check('GET /ping 不抛异常', false, pingRes.thrown, 'tavern-tools')
  } else {
    check('GET /ping 返回 200', pingRes.statusCode === 200, '实际 ' + pingRes.statusCode + ' body=' + pingRes.body.slice(0, 200), 'tavern-tools')
    check('GET /ping 返回 { ok: true }', Boolean(pingRes.json && pingRes.json.ok === true), 'body=' + pingRes.body.slice(0, 200), 'tavern-tools')
  }

  const charsRes = routeBase
    ? await probeRoute(routeBase + '/characters').catch(error => ({ thrown: errorText(error) }))
    : undefined
  if (!charsRes) {
    skip('GET /characters 实调', '未注册 characters 路由')
  } else if (charsRes.thrown) {
    check('GET /characters 不抛异常', false, charsRes.thrown, 'tavern-tools')
  } else {
    check('GET /characters 返回 200', charsRes.statusCode === 200, '实际 ' + charsRes.statusCode + ' body=' + charsRes.body.slice(0, 200), 'tavern-tools')
    const body = charsRes.json
    const isArray = Array.isArray(body) || (body && Array.isArray(body.characters)) || (body && Array.isArray(body.data)) || (body && Array.isArray(body.items))
    check('GET /characters 返回角色数组', Boolean(isArray), 'body=' + charsRes.body.slice(0, 300), 'tavern-tools')
  }
} else {
  skip('路由检查', 'apply 未成功')
}

/* ── 提示词分节 ── */
section('提示词分节')
if (applyOk) {
  check('注册了提示词分节', sectionEntries.length >= 1, '实际 ' + sectionEntries.length, 'tavern-core')
  for (const [key, entry] of sectionEntries) {
    const problems = []
    if (typeof entry.order !== 'number' || !Number.isFinite(entry.order)) problems.push('order 非有限数字')
    // 真实宿主允许 text 是字符串或 (AssembleContext) => string 的求值函数。
    let resolved
    if (typeof entry.text === 'string') resolved = entry.text
    else if (typeof entry.text === 'function') {
      try {
        resolved = await entry.text({ promptVariables: {}, variables: {} })
      } catch (error) {
        problems.push('text() 抛错: ' + errorText(error))
      }
    } else problems.push('text 既不是字符串也不是函数，实际 ' + typeof entry.text)
    if (typeof resolved === 'string') {
      if (resolved.trim() === '') problems.push('求值后的 text 为空')
      else if (/TODO|待补|占位|简化版/.test(resolved)) problems.push('text 含占位字样')
      if (typeof entry.text === 'function') note('分节 ' + key + ' 动态求值得到 ' + resolved.length + ' 字符')
    } else if (problems.length === 0) problems.push('求值后的 text 不是字符串')
    check('分节 ' + key + ' 合法', problems.length === 0, problems.join('; '), 'tavern-core')
  }
} else {
  skip('提示词分节检查', 'apply 未成功')
}

/* ── 落盘 ── */
section('落盘')
/** 安全读目录里的文件名。 */
function listDir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}
try {
  // 触发卸载钩子，让 state.save() 真正写一次 state.json
  for (const disposer of ctx._introspect.effects) {
    if (typeof disposer === 'function') {
      try { disposer() } catch { /* 单个卸载钩子失败不影响结论 */ }
    }
  }
  const stateFile = join(dataRoot, 'state.json')
  check('state.json 已写入 dataRoot', existsSync(stateFile), stateFile)
  if (existsSync(stateFile)) {
    let parsed
    let parseError
    try { parsed = JSON.parse(readFileSync(stateFile, 'utf8')) } catch (error) { parseError = errorText(error) }
    check('state.json 是合法 JSON', Boolean(parsed) && !parseError, parseError)
  }
  const layoutDirs = ['characters', 'avatars', 'worlds', 'chats', 'groups', 'presets', 'regex', 'quick-replies', 'personas', 'trpg']
  const missingDirs = layoutDirs.filter(dir => !existsSync(join(dataRoot, dir)))
  check('数据目录全部创建', missingDirs.length === 0, '缺少: ' + missingDirs.join(', '))

  const charFiles = listDir(join(dataRoot, 'characters')).filter(n => n.endsWith('.json'))
  const worldFiles = listDir(join(dataRoot, 'worlds')).filter(n => n.endsWith('.json'))
  const createdChar = calls.get('st_create_character')
  if (createdChar && createdChar.ok) check('角色真的落成文件', charFiles.length > 0, 'characters/ 下没有 .json', 'tavern-tools')
  else skip('角色落盘', 'st_create_character 未跑通')
  const createdBook = calls.get('st_create_worldbook')
  if (createdBook && createdBook.ok) check('世界书真的落成文件', worldFiles.length > 0, 'worlds/ 下没有 .json', 'tavern-tools')
  else skip('世界书落盘', 'st_create_worldbook 未跑通')
  if (charFiles.length || worldFiles.length) note('characters/ ' + charFiles.length + ' 个文件，worlds/ ' + worldFiles.length + ' 个文件')
} catch (error) {
  check('落盘检查不抛异常', false, errorText(error))
}

/* ── 客户端 bundle ── */
section('客户端 bundle')
try {
  const clientFile = join(root, 'lib', 'client.js')
  if (!existsSync(clientFile)) {
    check('lib/client.js 存在', false, '文件不存在', 'tavern-ui')
  } else {
    const source = readFileSync(clientFile, 'utf8')
    let syntaxOk = true
    try {
      new vm.Script(source, { filename: clientFile })
    } catch (error) {
      syntaxOk = false
      check('lib/client.js 语法合法', false, errorText(error), 'tavern-ui')
    }
    if (syntaxOk) check('lib/client.js 语法合法', true)

    const placeholder = /占位实现|暂未实现|TODO:\s*实现|简化版/g.test(source)
    check('lib/client.js 无占位实现', !placeholder, '仍含未完成标记', 'tavern-ui')
    check('lib/client.js 有真实 UI 代码（不只是空壳）', source.length > 4000, '只有 ' + source.length + ' 字节，疑似空壳', 'tavern-ui')

    let captured
    const sandbox = {
      window: { __ModuleLoader__: { load(options) { captured = options } } },
      console,
      setTimeout,
      clearTimeout,
      URL,
    }
    try {
      vm.createContext(sandbox)
      vm.runInContext(source, sandbox, { filename: clientFile })
      check('lib/client.js 走 ModuleLoader 注册', Boolean(captured), '没有调用 window.__ModuleLoader__.load', 'tavern-ui')
      if (captured) {
        check('客户端 bundle id 为 dsh-sillytavern', captured.id === 'dsh-sillytavern', '实际 ' + String(captured.id), 'tavern-ui')
        check('客户端 bundle 导出 factory', typeof captured.factory === 'function', '实际 ' + typeof captured.factory, 'tavern-ui')
        if (typeof captured.factory === 'function') {
          let factoryResult
          let factoryError
          const fakeRequire = () => ({
            createElement() { return {} },
            Fragment: {},
            useState: () => [undefined, () => {}],
            useEffect: () => {},
            useMemo: () => undefined,
            useCallback: (fn) => fn,
            useRef: () => ({ current: undefined }),
          })
          try { factoryResult = captured.factory(fakeRequire) } catch (error) { factoryError = errorText(error) }
          if (factoryError) check('factory 可被调用', false, factoryError, 'tavern-ui')
          else check('factory 可被调用', true)

          const surface = factoryResult && typeof factoryResult === 'object' ? factoryResult : {}
          const keys = Object.keys(surface)
          check('客户端 bundle 导出 apply', typeof surface.apply === 'function',
            keys.length
              ? 'factory 返回的对象没有 apply；实际键: [' + keys.join(', ') + ']'
              : 'factory 返回空对象 —— bundle 末尾没有给 module.exports 赋 apply/inject（检查 lib/client.js 是否在 // __PART_B__ 处被截断）'
            , 'tavern-ui')
          check('客户端 bundle 导出 inject 数组', Array.isArray(surface.inject),
            '实际 ' + typeof surface.inject, 'tavern-ui')
        }
      }
    } catch (error) {
      check('lib/client.js 可在假 window 下加载', false, errorText(error), 'tavern-ui')
    }
  }
} catch (error) {
  check('客户端 bundle 检查不抛异常', false, errorText(error), 'tavern-ui')
}

/* ── 收尾 ── */
if (!KEEP) {
  try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}

console.log('')
console.log('通过 ' + passes.length + ' 项，失败 ' + failures.length + ' 项，跳过 ' + skips.length + ' 项')
if (notes.length) {
  console.log('\n观察 (' + notes.length + '):')
  for (const item of notes) console.log('  · ' + item)
}
if (skips.length) {
  console.log('\n跳过 (' + skips.length + '):')
  for (const item of skips) console.log('  - ' + item.label + (item.reason ? '（' + item.reason + '）' : ''))
}
if (failures.length) {
  console.log('\n失败明细（按负责人）:')
  const byOwner = new Map()
  for (const item of failures) byOwner.set(item.who, [...(byOwner.get(item.who) || []), item])
  for (const [owner, items] of byOwner) {
    console.log('  【' + owner + '】' + items.length + ' 项')
    for (const item of items) console.log('    - ' + item.label + (item.detail ? ' :: ' + item.detail : ''))
  }
  process.exitCode = 1
} else {
  console.log('\n全部通过')
  process.exitCode = 0
}
if (KEEP) console.log('\n临时数据目录已保留: ' + dataRoot)
