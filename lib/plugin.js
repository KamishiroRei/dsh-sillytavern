/**
 * 插件主体：配置校验、状态装配、各子系统接线。
 * lib/index.js 只是 bundle 入口，真正的 apply 在这里。
 *
 * 本文件对其他 DSH 包零依赖：插件装在 profile 树之外，裸包名只有 profile
 * 内的插件能解析。配置校验因此自带一个最小 Standard Schema 实现。
 */
import { join } from 'node:path'
import { dshHome, ensureLayout } from './paths.js'
import { registerCharacterTools } from './tools/characters.js'
import { registerWorldbookTools } from './tools/worldbooks.js'
import { registerPromptTools } from './tools/prompts.js'
import { registerChatTools } from './tools/chats.js'
import { registerTrpgTools } from './tools/trpg.js'
import { registerImportTools } from './tools/importer.js'
import { registerAssembly } from './prompt/assembly.js'
import { registerPromptBridge } from './prompt/bridge.js'
import { registerRoutes } from './routes.js'
import { registerStageTools } from './tools/stage.js'
import { registerChatManageTools } from './tools/chatmanage.js'
import { registerTavernModeTools } from './tools/tavernmode.js'
import { autoImportOnStartup } from './bootstrap.js'
import { readJson, writeJson } from './store.js'

export const name = 'dsh-sillytavern'
/**
 * 顶层只声明 tools：这是插件在任何 profile（含 headless）下都必须有的能力。
 *
 * webServer 与 systemPrompt 是 Web profile 才有的服务，不能写进顶层 inject ——
 * 写了会让插件在 headless 下永远 PENDING、工具一个都挂不上。
 * 它们走 ctx.inject()：Cordis 在服务真正 ACTIVE 后回调，而不是在 apply 的同步执行里
 * 直接读（那时 webServer 还没 ACTIVE，ctx.get 返回 undefined，路由会静默不注册）。
 */
export const inject = ['tools']

/** 默认值表：既是 Schema 的默认，也是文档的唯一事实来源。 */
const DEFAULTS = {
  dataRoot: '',
  sillyTavernRoot: '',
  autoBind: true,
  maxWorldInfoDepth: 4,
  worldInfoBudget: 2048,
  authorNoteDepth: 4,
  trpgLayout: true,
  trpgCenterPanel: 'map',
  injectSystemPrompt: true,
  promptSectionOrder: 6500,
  maxHistoryMessages: 60,
  defaultDiceSystem: 'dnd5e',
  assetRoot: 'D:\\Game\\tianjie-fall\\assets',
}

const CENTER_PANELS = ['map', 'scene', 'sheet', 'log']
const DICE_SYSTEMS = ['dnd5e', 'coc7e', 'generic']

function clampInt(value, fallback, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

function coerce(config) {
  const input = config && typeof config === 'object' ? config : {}
  const out = {}
  out.dataRoot = typeof input.dataRoot === 'string' && input.dataRoot.trim()
    ? input.dataRoot.trim()
    : join(dshHome(), 'dsh-sillytavern')
  out.sillyTavernRoot = typeof input.sillyTavernRoot === 'string' ? input.sillyTavernRoot.trim() : ''
  out.autoBind = input.autoBind === undefined ? DEFAULTS.autoBind : Boolean(input.autoBind)
  out.maxWorldInfoDepth = clampInt(input.maxWorldInfoDepth, DEFAULTS.maxWorldInfoDepth, 1, 20)
  out.worldInfoBudget = clampInt(input.worldInfoBudget, DEFAULTS.worldInfoBudget, 0, 100000)
  out.authorNoteDepth = clampInt(input.authorNoteDepth, DEFAULTS.authorNoteDepth, 0, 100)
  out.trpgLayout = input.trpgLayout === undefined ? DEFAULTS.trpgLayout : Boolean(input.trpgLayout)
  out.trpgCenterPanel = CENTER_PANELS.includes(input.trpgCenterPanel) ? input.trpgCenterPanel : DEFAULTS.trpgCenterPanel
  out.injectSystemPrompt = input.injectSystemPrompt === undefined ? DEFAULTS.injectSystemPrompt : Boolean(input.injectSystemPrompt)
  out.promptSectionOrder = Number.isFinite(Number(input.promptSectionOrder)) ? Number(input.promptSectionOrder) : DEFAULTS.promptSectionOrder
  out.maxHistoryMessages = clampInt(input.maxHistoryMessages, DEFAULTS.maxHistoryMessages, 2, 1000)
  out.defaultDiceSystem = DICE_SYSTEMS.includes(input.defaultDiceSystem) ? input.defaultDiceSystem : DEFAULTS.defaultDiceSystem
  out.assetRoot = typeof input.assetRoot === 'string' && input.assetRoot.trim()
    ? input.assetRoot.trim()
    : DEFAULTS.assetRoot
  return out
}

/** Standard Schema v1 实现：Cordis 用它校验并补默认值。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-sillytavern',
    validate(value) {
      try {
        return { value: coerce(value) }
      } catch (error) {
        return { issues: [{ message: error && error.message ? error.message : String(error) }] }
      }
    },
  },
}

/** 装配共享状态：所有子系统拿到同一个对象。 */
function createState(ctx, config) {
  const layout = ensureLayout(config.dataRoot)
  const initial = { version: 1, sessions: {}, lastCharacter: null, personas: {}, ui: {}, trpg: {} }
  const loaded = readJson(layout.state, initial) || initial
  const state = {
    ctx,
    config,
    layout,
    /** 运行期缓存：解析后的角色卡/世界书，避免每次都读盘。 */
    cache: new Map(),
    /** 落盘的进程内状态。 */
    data: { ...initial, ...loaded },
    /** 立即落盘。 */
    save() {
      writeJson(this.layout.state, this.data)
    },
    /** 丢弃缓存中的某个前缀。 */
    invalidate(prefix) {
      for (const key of [...this.cache.keys()]) {
        if (!prefix || key.startsWith(prefix)) this.cache.delete(key)
      }
    },
  }
  state.data.sessions ||= {}
  state.data.personas ||= {}
  state.data.ui ||= {}
  state.data.trpg ||= {}
  return state
}

export function apply(ctx, config) {
  const resolved = coerce(config)
  const state = createState(ctx, resolved)

  registerCharacterTools(ctx, state)
  registerWorldbookTools(ctx, state)
  registerPromptTools(ctx, state)
  registerChatTools(ctx, state)
  registerTrpgTools(ctx, state)
  registerImportTools(ctx, state)
  // 提示词装配不依赖任何服务：assemblePrompt / scanWorldInfo / 宏展开都是纯函数。
  // 必须放在 inject 外面，否则 headless profile（无 systemPrompt 服务）下
  // state.promptRuntime 挂不上，会话只能拿到"只有角色描述"的兜底提示词。
  registerAssembly(ctx, state)

  // 只有"把分节挂进 DSH 系统提示词"这一步需要 systemPrompt 服务，
  // 它按 profile 而定，所以走 ctx.inject 延迟到服务 ACTIVE。
  ctx.inject(['systemPrompt'], scoped => {
    registerPromptBridge(scoped, state)
  })

  // HTTP 路由：webServer 就绪后再注册，否则 ctx.get 拿到 undefined 会静默跳过。
  // headless profile 没有 webServer，这个回调不会触发，工具照常可用。
  ctx.inject(['webServer'], scoped => {
    registerStageTools(ctx, state)
    registerChatManageTools(ctx, state)
    registerTavernModeTools(ctx, state)
    registerRoutes(scoped, state)
  })

  ctx.effect(() => () => {
    try { state.save() } catch { /* 卸载时落盘失败不阻塞卸载 */ }
  })

  const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
  if (logger && typeof logger.info === 'function') {
    logger.info('[dsh-sillytavern] 已加载；数据目录 ' + state.layout.root)
  }

  // 首次启动自动导入 ST 数据；异步执行，失败只记日志，不阻塞加载。
  autoImportOnStartup(state).then(result => {
    if (!logger) return
    if (result.imported) {
      const r = result.report || {}
      logger.info('[dsh-sillytavern] 已从 SillyTavern 导入：角色 ' + (r.characters || 0)
        + '，世界书 ' + (r.worlds || 0) + '，预设 ' + (r.presets || 0))
    } else if (result.reason && typeof logger.info === 'function') {
      logger.info('[dsh-sillytavern] 未自动导入：' + result.reason)
    }
  }).catch(() => { /* 自动导入失败不阻塞插件 */ })
}
