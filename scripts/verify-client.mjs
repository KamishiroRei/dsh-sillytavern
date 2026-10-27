/**
 * 客户端 bundle 自检：用最小 DOM stub 把 lib/client.js 真的加载一遍。
 *
 * 为什么要有这个：客户端 bundle 没有构建步骤，语法错、注册错、组件在渲染时
 * 抛错，都要等 dsh web 起来 40 秒后才在浏览器控制台里看到。这里 1 秒内做完：
 *   1. __ModuleLoader__.load 被调用、id 正确
 *   2. factory 返回 { apply, inject }
 *   3. apply 用假 ctx 跑通，记录注册了哪些 slot
 *   4. 每个注册的组件用真实 props 渲染一次，不抛错
 *   5. 纯函数（markdown / 选项 / 地图归一 / 节点识别）行为正确
 *
 * 用法：node scripts/verify-client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundlePath = join(root, 'lib', 'client.js')

let failures = 0
let checks = 0
function check(label, ok, detail) {
  checks += 1
  if (ok) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail ? ' :: ' + detail : ''))
  }
}

/** 极简 DOM：只实现本 bundle 会碰到的 API。 */
function createDom() {
  const created = []
  const head = {
    appendChild(node) { created.push(node); node.parent = head; return node },
    removeChild(node) { const i = created.indexOf(node); if (i >= 0) created.splice(i, 1); return node },
  }
  const element = (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    textContent: '',
    dataset: {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] },
    appendChild(child) { this.children.push(child); return child },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child },
    remove() { if (this.parent && this.parent.removeChild) this.parent.removeChild(this) },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return [] },
    querySelector() { return null },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 600 } },
  })
  const documentStub = {
    head,
    body: head,
    documentElement: head,
    createElement: element,
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return [] },
    querySelector() { return null },
    baseURI: 'http://localhost/',
  }
  return { document: documentStub, created }
}

/**
 * 迷你 React：createElement + 能跑函数组件与 hooks 的渲染器。
 * 目的不是还原 React 语义，而是「让组件真的执行一遍」，把渲染期异常暴露出来。
 */
function createReact() {
  const hookState = []
  let cursor = 0
  let effects = []
  let depth = 0

  function createElement(type, props, ...children) {
    const flat = []
    const pushChild = (child) => {
      if (child === null || child === undefined || child === false || child === true) return
      if (Array.isArray(child)) { child.forEach(pushChild); return }
      flat.push(child)
    }
    children.forEach(pushChild)
    return { $$element: true, type, props: props || {}, children: flat }
  }

  const React = {
    createElement,
    Fragment: 'Fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        hookState[index] = typeof next === 'function' ? next(hookState[index]) : next
      }
      return [hookState[index], set]
    },
    useMemo(fn) { cursor += 1; return fn() },
    useCallback(fn) { cursor += 1; return fn },
    useRef(initial) {
      const index = cursor++
      if (!(index in hookState)) hookState[index] = { current: initial }
      return hookState[index]
    },
    useEffect(fn) { cursor += 1; effects.push(fn); return undefined },
    useSyncExternalStore(subscribe, getSnapshot) { cursor += 1; return getSnapshot() },
  }

  /**
   * 渲染一次元素树并返回收集到的纯文本。
   * @param {any} element - createElement 产物、数组或纯文本。
   * @param {number} budget - 节点上限，防死循环。
   * @returns {string} 拼起来的文本内容。
   */
  function render(element, budget = 6000) {
    if (budget <= 0) throw new Error('渲染节点超预算（疑似无限展开）')
    if (element === null || element === undefined || element === false) return ''
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    if (Array.isArray(element)) return element.map(child => render(child, budget - 1)).join('')
    if (!element.$$element) return ''
    const { type, props, children } = element
    if (typeof type === 'function') {
      if (depth > 60) throw new Error('组件递归过深')
      const savedCursor = cursor
      const savedEffects = effects
      cursor = 0
      effects = []
      depth += 1
      let output
      try {
        output = type({ ...props, children })
      } finally {
        depth -= 1
        cursor = savedCursor
        effects = savedEffects
      }
      return render(output, budget - 1)
    }
    return children.map(child => render(child, budget - 1)).join('')
  }

  return { React, render }
}

/** 收集元素树里出现的所有 type（用来断言渲染产物包含预期标签）。 */
function collectTypes(nodes) {
  const types = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node.$$element) return
    types.push(typeof node.type === 'string' ? node.type : 'fn')
    if (node.children) node.children.forEach(walk)
    if (node.props && node.props.children) walk(node.props.children)
  }
  walk(nodes)
  return types
}

/** 假 cordis ctx：记录 slot 注册，提供 slots/effect/sessions。 */
function createCtx() {
  const registrations = []
  const sent = []
  const ctx = {
    slots: {
      inject(name, factory) {
        const disposer = factory()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    sessions: {
      scope() {
        return {
          get(name) {
            if (name !== 'conversation') return undefined
            return { send: async (text) => { sent.push(text) } }
          },
        }
      },
    },
    _sent: sent,
    _registrations: registrations,
  }
  return ctx
}

console.log('[dsh-sillytavern] 客户端自检开始')

const source = readFileSync(bundlePath, 'utf8')

// --- 0. 前后端契约对齐 ---
// 最贵的一类 bug 是「前端调的路由后端没注册」：浏览器里表现为 404/401，
// 控制台一行看不出来。这里直接把后端的路由前缀常量读出来比对。
const supportPath = join(root, 'lib', 'tools', 'support.js')
try {
  const support = readFileSync(supportPath, 'utf8')
  const declare = /ROUTE_PREFIX\s*=\s*'([^']+)'/.exec(support)
  const used = /const API_BASE = '([^']+)'/.exec(source)
  check('能读到后端 ROUTE_PREFIX', Boolean(declare), supportPath)
  check('能读到前端 API_BASE', Boolean(used))
  if (declare && used) {
    check('前后端路由前缀一致', declare[1] === used[1], declare[1] + ' vs ' + used[1])
    check('前缀不带 /api（会被 RPC 桥 401）', !used[1].startsWith('/api'), used[1])
  }
} catch {
  check('后端 support.js 可读（跳过前缀比对）', false, supportPath)
}

check('bundle 里没有 import/export 语句', !/^\s*(import|export)\s/m.test(source))
check('bundle 末尾恰好一个换行', source.endsWith('\n') && !source.endsWith('\n\n') && !source.endsWith('\r\n'))
check('使用 window.__ModuleLoader__.load', source.includes('window.__ModuleLoader__.load'))

const dom = createDom()
const { React, render } = createReact()
const sandbox = {
  console,
  document: dom.document,
  fetch: async () => { throw new Error('自检环境不联网') },
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: () => 0,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.__ModuleLoader__ = { load(entry) { sandbox.__entry = entry } }

const requireMap = {
  react: React,
  'react-dom': { createRoot: () => ({ render() {} }) },
  'react-dom/client': { createRoot: () => ({ render() {} }) },
  'react/jsx-runtime': { jsx: React.createElement, jsxs: React.createElement, Fragment: 'Fragment' },
}

const context = vm.createContext(sandbox)
try {
  vm.runInContext(source, context, { filename: 'lib/client.js' })
  check('bundle 执行成功', true)
} catch (error) {
  check('bundle 执行成功', false, error && error.message)
  process.exit(1)
}

const entry = sandbox.__entry
check('调用了 __ModuleLoader__.load', Boolean(entry))
check('id 是 dsh-sillytavern', Boolean(entry) && entry.id === 'dsh-sillytavern', entry && String(entry.id))
check('factory 是函数', Boolean(entry) && typeof entry.factory === 'function')

let mod
try {
  mod = entry.factory((name) => {
    if (requireMap[name]) return requireMap[name]
    throw new Error('未知平台模块: ' + name)
  })
  check('factory 返回模块对象', Boolean(mod))
} catch (error) {
  check('factory 返回模块对象', false, error && error.message)
  process.exit(1)
}

check('导出 apply', typeof mod.apply === 'function')
check('导出 inject 数组', Array.isArray(mod.inject))
check('inject 含 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject))
check('导出 __test', Boolean(mod.__test) && typeof mod.__test.renderMarkdown === 'function')

const ctx = createCtx()
try {
  mod.apply(ctx)
  check('apply 执行成功', true)
} catch (error) {
  check('apply 执行成功', false, error && error.stack ? error.stack.split('\n')[0] : String(error))
  process.exit(1)
}

const styleEl = dom.created[0]
check('注入了归属本插件的 <style>', Boolean(styleEl) && styleEl.attributes['data-plugin'] === 'dsh-sillytavern')
check('样式内容非空', Boolean(styleEl) && String(styleEl.textContent).length > 2000, styleEl && String(styleEl.textContent).length)
check('样式不写死颜色（只用 --dsw- 令牌）', styleEl
  ? !/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/.test(String(styleEl.textContent).replace(/\/\*[\s\S]*?\*\//g, ''))
  : false)

const regs = ctx._registrations
const slotNames = regs.map(r => r.options.name)
for (const name of ['conversation.input.overlay', 'conversation.input.left', 'settings.section', 'plugins.bundle.config']) {
  check('注册了 slot ' + name, slotNames.includes(name), JSON.stringify(slotNames))
}
check('没有注册到 root（会顶掉整个外壳）', !slotNames.includes('root'))
// 回归守卫：接管 chat.node 会让每轮第一次回复重复渲染（用户报过）。
check('不接管 conversation.chat.node（否则回复会重复）', !slotNames.includes('conversation.chat.node'), JSON.stringify(slotNames))
check('会话作用域的注册都带 inject', regs
  .filter(r => r.options.inject !== undefined)
  .every(r => typeof r.options.inject === 'function'))

const sessionProps = {
  sessionId: 'verify-session',
  sendPrompt: () => {},
  node: null,
  turn: 1,
  seq: 1,
  openFile: () => {},
}
for (const reg of regs) {
  const label = reg.options.name + (reg.options.key || reg.options.id ? ' [' + (reg.options.key || reg.options.id) + ']' : '')
  try {
    const injected = typeof reg.options.inject === 'function' ? (reg.options.inject('verify-session') || {}) : {}
    const output = render(reg.component({ ...sessionProps, ...injected }))
    check('渲染 ' + label + ' 不抛错', true, output.length === 0 ? '（本次无内容，属正常空态）' : '')
  } catch (error) {
    check('渲染 ' + label + ' 不抛错', false, error && error.message ? error.message : String(error))
  }
}

const t = mod.__test
const BT = String.fromCharCode(96)

const md = t.renderMarkdown('**粗体** 和 *斜体* 与 ' + BT + 'code' + BT + '\n\n- 甲\n- 乙', { keyPrefix: 'x' })
check('markdown 渲染出节点', Array.isArray(md) && md.length > 0)
check('markdown 识别粗体', collectTypes(md).includes('strong'))
check('markdown 识别斜体', collectTypes(md).includes('em'))
check('markdown 识别行内代码', collectTypes(md).includes('code'))
check('markdown 识别列表', collectTypes(md).includes('ul'))

const md2 = t.renderMarkdown('## 小标题\n\n> 引用\n\n---\n\n' + BT + BT + BT + 'js\nconst a = 1\n' + BT + BT + BT, { keyPrefix: 'y' })
const types2 = collectTypes(md2)
check('markdown 识别标题', types2.includes('div'), JSON.stringify(types2.slice(0, 8)))
check('markdown 识别引用', types2.includes('blockquote'))
check('markdown 识别分割线', types2.includes('hr'))
check('markdown 识别代码块', types2.includes('pre'))

const side = t.renderMarkdown('（她转过身）你好', { keyPrefix: 's' })
check('侧边动作被识别', collectTypes(side).includes('span'))

const choices = t.extractChoices('你想怎么做？\n<options>上前|后退|等待</options>', null)
check('解析 <options> 标签', choices.choices.length === 3, JSON.stringify(choices.choices))
check('选项标签从正文剔除', !choices.text.includes('<options>'), JSON.stringify(choices.text))
const choices2 = t.extractChoices('正文', { choices: ['甲', '乙'] })
check('优先用 extra.choices', JSON.stringify(choices2.choices) === '["甲","乙"]', JSON.stringify(choices2.choices))

const wi = t.readActivatedWorldInfo({ activatedWorldInfo: [{ uid: 1, comment: '火龙' }, '酒馆'] })
check('解析世界书激活记录', wi.length === 2 && wi[0].title === '火龙' && wi[1].title === '酒馆', JSON.stringify(wi))
check('无记录时返回空数组', t.readActivatedWorldInfo(null).length === 0)

const emptyMap = t.normalizeMap(null)
check('空地图给出兜底棋盘', emptyMap.synthetic === true && emptyMap.map.width > 0)
const realMap = t.normalizeMap({
  width: 3,
  height: 2,
  tileSize: 40,
  cells: [{ x: 0, y: 0, type: 'water' }, { x: 9, y: 9, type: 'wall' }],
  tokens: [{ x: 1, y: 1, name: '艾拉', color: '#f00' }],
  fog: { enabled: true, revealed: [] },
})
check('越界格子被丢弃', realMap.map.cells.length === 1, String(realMap.map.cells.length))
check('token 保留', realMap.map.tokens.length === 1 && realMap.map.tokens[0].name === '艾拉')
check('地形类名正确', t.terrainClass('water') === 'st-tile st-tile-water')

const iconMap = t.normalizeMap({
  width: 3, height: 3, tileSize: 40,
  cells: [{ x: 1, y: 1, type: 'stone', icon: 'glyph_absolute' }],
  tokens: [{ x: 0, y: 0, name: '艾拉', icon: 'glyph_strength' }],
  features: [{ x: 2, y: 1, type: 'chest', icon: 'glyph_coins' }],
})
check('保留 cell.icon（地形图标）', iconMap.map.cells[0].icon === 'glyph_absolute', JSON.stringify(iconMap.map.cells[0]))
check('保留 token.icon（棋子图标）', iconMap.map.tokens[0].icon === 'glyph_strength')
check('保留 feature.icon（物件图标）', iconMap.map.features[0].icon === 'glyph_coins')
check('图标 URL 自动补 .png', t.assetUrl('glyph', 'glyph_fire') === '/dsh-sillytavern-api/assets/glyph/glyph_fire.png', t.assetUrl('glyph', 'glyph_fire'))
check('字体 URL 保留扩展名', t.assetUrl('font', 'KnightTitleSerif-CN.otf').endsWith('.otf'))

// 与 /state 契约对齐：centerPanel 只在这四个里，splitRatio 只在后端夹的区间里
check('中间面板只有四个合法值',
  JSON.stringify(t.CENTER_PANELS.map(p => p.id)) === '["map","scene","sheet","log"]',
  JSON.stringify(t.CENTER_PANELS.map(p => p.id)))
check('默认面板合法', t.CENTER_PANELS.some(p => p.id === t.DEFAULT_LAYOUT.centerPanel))
check('splitRatio 落在后端夹持区间 [0.1, 0.6]',
  t.DEFAULT_LAYOUT.splitRatio >= 0.1 && t.DEFAULT_LAYOUT.splitRatio <= 0.6,
  String(t.DEFAULT_LAYOUT.splitRatio))

// 头像/素材/接口地址都必须带前缀 /dsh-sillytavern-api（写错就是 404）
const apiPrefix = /const API_BASE = '([^']+)'/.exec(source)[1]
check('头像地址带正确前缀', t.avatarUrlOf({ avatar: 'x.png' }).startsWith(apiPrefix))
check('素材地址带正确前缀', t.assetUrl('glyph', 'a').startsWith(apiPrefix))
check('API_BASE 无尾部斜杠', !apiPrefix.endsWith('/'), apiPrefix)

check('头像地址走后端路由', t.avatarUrlOf({ avatar: 'a b.png' }).includes('/avatars/'))
check('素材地址按组拼', t.assetUrl('glyph', 'glyph_fire.png').includes('/assets/glyph/glyph_fire.png'))

check('非酒馆节点返回 null（不吞普通对话）', t.readTavernNode({ data: { blocks: [{ kind: 'text', text: 'hi' }] } }) === null)
const tavernNode = t.readTavernNode({
  data: { blocks: [{ kind: 'text', text: '你说' }], extra: { name: '艾拉', avatarUrl: '/a.png' } },
})
check('酒馆节点被识别', Boolean(tavernNode) && tavernNode.name === '艾拉' && tavernNode.text === '你说')

// 三栏浮层在关闭状态下不应渲染任何东西（不会挡住主界面）
const overlayReg = regs.find(r => r.options.name === 'conversation.input.overlay' && String(r.options.id || '').includes('stage'))
if (overlayReg) {
  const html = render(overlayReg.component({ ...sessionProps, sendPrompt: () => {} }))
  check('跑团浮层默认关闭（不遮挡主界面）', html === '', JSON.stringify(html.slice(0, 80)))
}

console.log('')
console.log('检查 ' + checks + ' 项')
if (failures) {
  console.log('失败 ' + failures + ' 项')
  process.exit(1)
} else {
  console.log('全部通过')
}
