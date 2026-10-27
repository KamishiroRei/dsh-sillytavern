/**
 * HTTP API：给客户端插件用的 JSON 接口。
 *
 * 只注册一条 prefix 路由，内部按 pathname + method 自己分发 —— 这样路由表只有一个
 * 注册点，加端点不用碰注册逻辑。所有响应都是 JSON 信封 { ok, data } / { ok, error }，
 * 静态素材（头像、UI 素材）是唯一的二进制出口。
 *
 * 安全：只接受本机回环来源（看 Host 头，不看 Origin），全部响应带 no-store。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { listJsonFiles } from './store.js'
import {
  ROUTE_PREFIX, activeWorldbookNames, bookEnabled, characterStore, createChatStore,
  denyNonLoopback, getTrpgStateSafe, listCharacters, readJsonBody, regenerateLastReply,
  scanWorldbooksForText, sendError, sendImage, sendOk, setBookEnabled, swipeMessage, worldbookStore,
} from './tools/support.js'
import { importFromSillyTavern, probeSillyTavern } from './importer.js'
import { getStage, patchStage, publishStage, clearStage } from './stage.js'

/**
 * 素材分组 → { 相对 assetRoot 的候选目录（按顺序找）, 是否强制带扩展名 }。
 *
 * 写死这张表，绝不拼接任意路径。分组名按 trpg-gm 的图标 key 取单数形式；
 * 除字体外，请求里的 file 一般不带扩展名（如 glyph_strength），这里补 .png。
 *
 * meter 组指向 shared_argent_v1/assets/controls —— 血量条、护盾条、按钮、勾选框、开关、
 * 滑轨这些控件图都在那个目录，前端统一走 meter/<name> 就能取到。
 * panel 组给两个候选目录：frame_panel.png 在 ui/ 根，panel_light / panel_dark 在
 * controls/ 下，两者都是前端要用的面板框，一个 group 覆盖掉比让前端记两个 group 好。
 */
const ASSET_GROUPS = {
  glyph: { dirs: ['ui/icon_library_v1'], needsExt: false },
  painted: { dirs: ['ui/painted_icon_library_v2'], needsExt: false },
  meter: { dirs: ['ui/shared_argent_v1/assets/controls'], needsExt: false },
  panel: { dirs: ['ui', 'ui/shared_argent_v1/assets/controls'], needsExt: false },
  action: { dirs: ['ui/action_icons'], needsExt: false },
  font: { dirs: ['fonts'], needsExt: true },
}

/** 素材扩展名 → Content-Type。 */
const ASSET_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
}

/** 素材文件名白名单：只允许字母数字下划线点横线，天然排除路径分隔符与 ".."。 */
const ASSET_FILE_RE = /^[A-Za-z0-9_.-]+$/

/**
 * 带 HTTP 状态码的业务错误：调用方输入不合法用 4xx，服务端意外用 5xx。
 * dispatch 的外层捕获按 status 决定状态码，避免"参数写错"也被报成 500。
 * @param {number} status HTTP 状态码
 * @param {string} message 中文错误信息
 * @returns {Error} 带 status 字段的错误
 */
function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * 解析一个素材请求到绝对路径。
 * @param {string} assetRoot 素材根目录
 * @param {string} group 分组名（必须在 ASSET_GROUPS 里）
 * @param {string} file 文件名（必须过白名单）
 * @returns {string|null} 可读文件的绝对路径；不合法或不存在返回 null
 */
function resolveAsset(assetRoot, group, file) {
  const spec = ASSET_GROUPS[group]
  if (!spec || !assetRoot) return null
  let name = String(file || '')
  if (!ASSET_FILE_RE.test(name) || name.startsWith('.') || name.includes('..')) return null
  // 图标 key 不带扩展名，按约定补 .png；字体必须显式带扩展名。
  if (!extname(name) && !spec.needsExt) name += '.png'
  const ext = extname(name).toLowerCase()
  if (!ASSET_MIME[ext]) return null
  if (spec.needsExt && !ext) return null
  const root = resolve(assetRoot)
  for (const dir of spec.dirs) {
    const full = resolve(join(root, dir, name))
    // 双重保险：解析后的路径必须仍在素材根目录里。
    const rel = relative(root, full)
    if (rel.startsWith('..') || rel.includes(':')) continue
    if (existsSync(full) && statSync(full).isFile()) return full
  }
  return null
}

/**
 * 读聊天记录并整理成路由返回的形态。
 * @param {Record<string, any>} chat ChatSession
 * @returns {Record<string, any>} 精简后的会话
 */
function presentChat(chat) {
  return {
    sessionId: chat.id,
    title: chat.title,
    characterId: chat.characterId,
    persona: chat.persona,
    messages: chat.messages,
    variables: chat.variables,
    metadata: chat.metadata,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  }
}

/**
 * 布局状态：把 state.data.ui / trpg 里客户端关心的键摊平。
 * @param {Object} state 插件状态
 * @returns {Record<string, any>} 布局状态
 */
function layoutState(state) {
  const ui = state.data.ui || {}
  return {
    trpgLayout: ui.trpgLayout !== undefined ? Boolean(ui.trpgLayout) : Boolean(state.config.trpgLayout),
    centerPanel: ui.centerPanel || state.config.trpgCenterPanel || 'map',
    leftCollapsed: Boolean(ui.leftCollapsed),
    splitRatio: typeof ui.splitRatio === 'number' ? ui.splitRatio : 0.24,
    activeCharacterId: state.data.lastCharacter || '',
    ui,
    trpg: state.data.trpg || {},
    lastCharacter: state.data.lastCharacter || '',
    sessions: Object.keys(state.data.sessions || {}),
    activeSession: state.data.activeSession || '',
  }
}

// --------------------------------------------------------------------------
// 端点实现：每个返回 { status?, data } 或抛错（由外层转成 500）
// --------------------------------------------------------------------------

/**
 * 启动配置的只读回显。
 *
 * 这些值来自 cordis.patch.yml / 插件 Config，客户端改不了也不该改 —— 设置页只做只读展示，
 * 并提示"改 cordis.patch.yml 后重启生效"。这里刻意只列对外有意义的字段，
 * 不把 dataRoot 这类路径混进来（它们在 ping 顶层已经有了）。
 * @param {Object} config 已校验的插件配置
 * @returns {Record<string, any>} 配置快照
 */
function configSnapshot(config) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    worldInfoBudget: source.worldInfoBudget,
    maxWorldInfoDepth: source.maxWorldInfoDepth,
    maxHistoryMessages: source.maxHistoryMessages,
    authorNoteDepth: source.authorNoteDepth,
    trpgLayout: source.trpgLayout,
    trpgCenterPanel: source.trpgCenterPanel,
    defaultDiceSystem: source.defaultDiceSystem,
    injectSystemPrompt: source.injectSystemPrompt,
    autoBind: source.autoBind,
  }
}

/** GET /ping */
function handlePing(state) {
  const cards = characterStore(state)
  return {
    version: '0.1.0',
    plugin: 'dsh-sillytavern',
    dataRoot: state.layout.root,
    stRoot: String(state.config.sillyTavernRoot || ''),
    assetRoot: String(state.config.assetRoot || ''),
    characterCount: cards.ids().length,
    worldbookCount: worldbookStore(state).names().length,
    sessions: Object.keys(state.data.sessions || {}).length,
    /** 只读启动配置；改动只能改 cordis.patch.yml 后重启。 */
    config: configSnapshot(state.config),
  }
}

/** GET /state */
function handleGetState(state) {
  return layoutState(state)
}

/** POST /state 接受并落进 state.data.ui 的键。白名单之外的键会被丢弃并在 dropped 里回报。 */
const LAYOUT_UI_KEYS = ['trpgLayout', 'centerPanel', 'leftCollapsed', 'splitRatio', 'theme', 'panelWidth', 'rightWidth']

/** 三栏中间面板的合法取值，与 plugin.js 的 CENTER_PANELS 保持一致。 */
const CENTER_PANELS = ['map', 'scene', 'sheet', 'log']

/**
 * POST /state：浅合并布局状态。
 *
 * 接受 trpgLayout / centerPanel / leftCollapsed / splitRatio / activeCharacterId（以及
 * theme / panelWidth / rightWidth），全部落进 state.data.ui 并立即回显。
 * activeCharacterId 还会写进 state.data.lastCharacter 与当前活跃会话的绑定 ——
 * 客户端点右栏切换角色时，下一次装配提示词就该用新卡。
 * 白名单之外的键不会被静默丢弃：返回值里的 dropped 会逐个列出，方便前端自检。
 * @param {Object} state 插件状态
 * @param {Record<string, any>} body 请求体
 * @returns {Record<string, any>} 合并后的状态（额外带 accepted / dropped 两个自检字段）
 */
function handleSetState(state, body) {
  const patch = body && typeof body === 'object' ? body : {}
  const ui = { ...(state.data.ui || {}) }
  const accepted = []

  // 客户端可能把整包 ui 直接塞回来（data 字段里的 ui），也接受，并按同样白名单过滤。
  const incoming = { ...patch }
  if (patch.ui && typeof patch.ui === 'object' && !Array.isArray(patch.ui)) Object.assign(incoming, patch.ui)

  for (const key of LAYOUT_UI_KEYS) {
    if (incoming[key] === undefined) continue
    if (key === 'centerPanel') {
      if (!CENTER_PANELS.includes(incoming[key])) continue
      ui.centerPanel = incoming[key]
      accepted.push(key)
      continue
    }
    if (key === 'splitRatio') {
      const ratio = Number(incoming[key])
      if (!Number.isFinite(ratio)) continue
      // 分割条夹在 10%~60%：超出范围的值不落盘，免得下次启动布局错乱。
      ui.splitRatio = Math.min(0.6, Math.max(0.1, ratio))
      accepted.push(key)
      continue
    }
    if (key === 'trpgLayout' || key === 'leftCollapsed') {
      ui[key] = Boolean(incoming[key])
      accepted.push(key)
      continue
    }
    ui[key] = incoming[key]
    accepted.push(key)
  }

  if (patch.trpg && typeof patch.trpg === 'object' && !Array.isArray(patch.trpg)) {
    state.data.trpg = { ...(state.data.trpg || {}), ...patch.trpg }
    accepted.push('trpg')
  }

  if (incoming.activeCharacterId !== undefined) {
    const store = characterStore(state)
    const resolved = incoming.activeCharacterId ? store.resolve(String(incoming.activeCharacterId)) : null
    if (resolved) {
      state.data.lastCharacter = resolved
      const sessionId = String(state.data.activeSession || '')
      if (sessionId) {
        state.data.sessions = state.data.sessions || {}
        state.data.sessions[sessionId] = { ...(state.data.sessions[sessionId] || {}), characterId: resolved }
        const chats = createChatStore(state)
        const chat = chats.read(sessionId)
        if (chat) {
          chat.characterId = resolved
          chats.write(sessionId, chat)
        }
      }
      accepted.push('activeCharacterId')
    }
  }

  if (!('trpgLayout' in ui) && state.config.trpgLayout !== undefined) ui.trpgLayout = state.config.trpgLayout
  if (!('centerPanel' in ui) && state.config.trpgCenterPanel) ui.centerPanel = state.config.trpgCenterPanel
  state.data.ui = ui
  state.save()

  const known = new Set([...LAYOUT_UI_KEYS, 'activeCharacterId', 'trpg', 'ui'])
  const dropped = Object.keys(patch).filter(key => !known.has(key))
  return { ...layoutState(state), accepted, dropped }
}

/** GET /characters */
function handleListCharacters(state) {
  return listCharacters(state, { limit: 500 })
}

/**
 * GET /characters/<id>
 * @param {Object} state 插件状态
 * @param {string} id 角色 id 或名字
 * @returns {Record<string, any>} 完整卡
 */
function handleGetCharacter(state, id) {
  const store = characterStore(state)
  const resolved = store.resolve(id)
  if (!resolved) return null
  const card = store.read(resolved)
  if (!card) return null
  return {
    ...card,
    avatarUrl: store.hasAvatar(card) ? ROUTE_PREFIX + '/avatars/' + encodeURIComponent(card.avatar) : '',
  }
}

/** GET /worldbooks */
function handleListWorldbooks(state) {
  const books = worldbookStore(state)
  return books.names().map(name => ({
    name,
    entries: books.count(name),
    enabled: bookEnabled(state, name),
  }))
}

/**
 * POST /worldbooks/login（停用/启用）
 * @param {Object} state 插件状态
 * @param {Record<string, any>} body 请求体
 * @returns {Record<string, any>} 结果
 */
function handleToggleWorldbook(state, body) {
  const books = worldbookStore(state)
  const name = books.resolve(body.name)
  if (!name) throw httpError(404, '找不到世界书 "' + String(body.name || '') + '"')
  if (body.entryUid !== undefined && body.entryUid !== null) {
    const book = books.read(name)
    if (!book) throw new Error('世界书文件损坏：' + name)
    const entry = book.entries[String(body.entryUid)]
    if (!entry) throw new Error('世界书 "' + name + '" 里没有 uid=' + body.entryUid + ' 的条目')
    entry.disable = !body.enabled
    books.write(name, { entries: book.entries })
    return { name, entryUid: Number(body.entryUid), enabled: Boolean(body.enabled) }
  }
  return setBookEnabled(state, name, Boolean(body.enabled))
}

/**
 * POST /worldbooks/scan：用给定文本或当前会话试跑扫描。
 * @param {Object} state 插件状态
 * @param {Record<string, any>} body 请求体
 * @returns {Promise<Record<string, any>>} 扫描结果
 */
async function handleScanWorldbook(state, body) {
  const books = worldbookStore(state)
  const sessionId = String(body.sessionId || state.data.activeSession || '')
  const names = Array.isArray(body.books) && body.books.length
    ? body.books.map(value => {
      const resolved = books.resolve(value)
      if (!resolved) throw httpError(404, '找不到世界书 "' + value + '"')
      return resolved
    })
    : activeWorldbookNames(state, sessionId)
  if (names.length === 0) {
    return { activated: [], tokens: 0, before: [], after: [], atDepth: [], anTop: [], anBottom: [], scannedBooks: [] }
  }
  return scanWorldbooksForText(state, { names, text: body.text, lines: body.lines, sessionId })
}

/** GET /presets */
function handleListPresets(state) {
  const dir = state.layout.presets
  return listJsonFiles(dir).map(item => {
    let prompts = 0
    try {
      const raw = JSON.parse(readFileSync(item.file, 'utf8'))
      prompts = Array.isArray(raw.prompts) ? raw.prompts.length : 0
    } catch { prompts = 0 }
    return { name: item.name, prompts }
  })
}

/**
 * GET /presets/<name>
 * @param {Object} state 插件状态
 * @param {string} name 预设名
 * @returns {Record<string, any>|null} 预设内容
 */
function handleGetPreset(state, name) {
  const file = listJsonFiles(state.layout.presets).find(item => item.name === name)
  if (!file) return null
  return JSON.parse(readFileSync(file.file, 'utf8'))
}

/** GET /chats */
function handleListChats(state) {
  return createChatStore(state).list().map(chat => ({
    sessionId: chat.id,
    title: chat.title,
    characterId: chat.characterId,
    messages: chat.messages.length,
    updatedAt: chat.updatedAt,
  }))
}

/**
 * GET /chat/<sessionId>
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @returns {Record<string, any>|null} 会话；不存在返回 null
 */
function handleGetChat(state, sessionId) {
  const chat = createChatStore(state).read(sessionId)
  return chat ? presentChat(chat) : null
}

/**
 * GET /trpg 与 /trpg/<sessionId>
 * @param {Object} state 插件状态
 * @param {string} [sessionId] 会话 id
 * @returns {Promise<Record<string, any>>} 跑团状态
 */
async function handleTrpgState(state, sessionId) {
  const id = String(sessionId || state.data.activeSession || 'default')
  const content = await getTrpgStateSafe(state, id)
  return { sessionId: id, ...content }
}

/**
 * POST /trpg/log：增量拉日志。
 * @param {Object} state 插件状态
 * @param {Record<string, any>} body 请求体
 * @returns {Promise<Record<string, any>>} 日志与游标
 */
async function handleTrpgLog(state, body) {
  const id = String(body.sessionId || state.data.activeSession || 'default')
  const content = await getTrpgStateSafe(state, id)
  const log = Array.isArray(content.log) ? content.log : []
  const since = Number(body.since)
  const from = Number.isFinite(since) && since >= 0 && since <= log.length ? since : 0
  return { sessionId: id, log: log.slice(from), next: log.length }
}

/**
 * POST /characters/bind：把角色卡绑定到会话。
 * @param {Object} state 插件状态
 * @param {Record<string, any>} body 请求体
 * @returns {Record<string, any>} 绑定结果
 */
function handleBindCharacter(state, body) {
  const store = characterStore(state)
  const id = store.resolve(body.characterId || body.character)
  if (!id) throw httpError(404, '找不到角色卡 "' + String(body.characterId || body.character || '') + '"')
  const sessionId = String(body.sessionId || state.data.activeSession || '')
  if (!sessionId) throw httpError(400, '缺少 sessionId，且当前没有活跃会话')
  state.data.sessions = state.data.sessions || {}
  state.data.sessions[sessionId] = { ...(state.data.sessions[sessionId] || {}), characterId: id, updatedAt: new Date().toISOString() }
  state.data.activeSession = sessionId
  state.data.lastCharacter = id
  const chat = createChatStore(state).ensure(sessionId)
  chat.characterId = id
  createChatStore(state).write(sessionId, chat)
  state.save()
  return { sessionId, characterId: id }
}

/**
 * POST /chat/<sessionId>/swipe
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @param {Record<string, any>} body 请求体
 * @returns {Record<string, any>} 切换结果
 */
function handleSwipe(state, sessionId, body) {
  return swipeMessage(state, sessionId, body)
}

/**
 * POST /import：从 ST 目录导入。
 * @param {Object} state 插件状态
 * @param {Record<string, any>} body 请求体
 * @returns {Promise<Record<string, any>>} 导入报告
 */
async function handleImport(state, body) {
  const stRoot = String(body.stRoot || state.config.sillyTavernRoot || '').trim()
  if (!stRoot) throw httpError(400, '没有配置 SillyTavern 安装目录')
  if (body.dryRun) {
    const probe = probeSillyTavern(stRoot)
    if (!probe.ok) throw httpError(404, '探测失败：' + probe.reason)
    return { dryRun: true, probe }
  }
  const report = await importFromSillyTavern(state, stRoot, { overwrite: Boolean(body.overwrite) })
  if (state.invalidate) state.invalidate()
  return { dryRun: false, report }
}

/** GET /assets：素材分组自检。 */
function handleAssetGroups(state) {
  const root = String(state.config.assetRoot || '')
  const detail = {}
  for (const [group, spec] of Object.entries(ASSET_GROUPS)) {
    const dirs = spec.dirs.map(dir => {
      const full = root ? join(resolve(root), dir) : ''
      return { dir: full, exists: Boolean(full) && existsSync(full) }
    })
    detail[group] = { dirs, needsExt: spec.needsExt }
  }
  return { groups: Object.keys(ASSET_GROUPS), prefix: ROUTE_PREFIX, root, detail }
}

/**
 * GET /assets/<group>/<file>：读素材文件。
 * @param {Object} state 插件状态
 * @param {string} group 分组
 * @param {string} file 文件名
 * @returns {string|null} 文件绝对路径
 */
function handleAssetFile(state, group, file) {
  return resolveAsset(String(state.config.assetRoot || ''), group, file)
}

// --------------------------------------------------------------------------
// 分发
// --------------------------------------------------------------------------

/**
 * 把一次请求分发到具体处理函数。
 * @param {Object} state 插件状态
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @returns {Promise<void>}
 */
async function dispatch(state, req, res) {
  if (denyNonLoopback(req, res)) return

  const url = new URL(req.url || '/', 'http://x')
  const pathname = url.pathname
  const method = String(req.method || 'GET').toUpperCase()
  const rest = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')
  const parts = rest ? rest.split('/').map(part => {
    try { return decodeURIComponent(part) } catch { return part }
  }) : []
  const isGet = method === 'GET'
  const isPost = method === 'POST'

  // 二进制出口先走，避免被 JSON 信封包住。
  if (isGet && parts[0] === 'avatars') {
    const file = parts.slice(1).join('/')
    const data = file ? characterStore(state).readAvatar(file) : null
    if (!data) { sendError(res, 404, '头像不存在：' + file); return }
    sendImage(res, data, file)
    return
  }
  if (isGet && parts[0] === 'assets' && parts.length === 3) {
    const full = handleAssetFile(state, parts[1], parts[2])
    if (!full) { sendError(res, 404, '素材不存在或不允许访问'); return }
    const data = readFileSync(full)
    res.writeHead(200, {
      'Content-Type': ASSET_MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(data)
    return
  }

  let body = {}
  if (isPost) {
    try { body = await readJsonBody(req) } catch (error) {
      sendError(res, 400, error && error.message ? error.message : String(error))
      return
    }
  }

  const route = parts[0] || ''

  if (route === '' && isGet) { sendOk(res, { ok: true, name: 'dsh-sillytavern', prefix: ROUTE_PREFIX }); return }
  if (route === 'ping' && isGet) { sendOk(res, handlePing(state)); return }

  if (route === 'state') {
    if (isGet) { sendOk(res, handleGetState(state)); return }
    if (isPost) { sendOk(res, handleSetState(state, body)); return }
    sendError(res, 405, '只支持 GET / POST'); return
  }

  if (route === 'characters') {
    if (parts.length === 1 && isGet) { sendOk(res, handleListCharacters(state)); return }
    if (parts.length === 2 && isPost && parts[1] === 'bind') { sendOk(res, handleBindCharacter(state, body)); return }
    if (parts.length === 2 && isGet) {
      const card = handleGetCharacter(state, parts[1])
      if (!card) { sendError(res, 404, '角色卡不存在：' + parts[1]); return }
      sendOk(res, card)
      return
    }
    sendError(res, 404, '未知的角色端点'); return
  }

  if (route === 'worldbooks') {
    if (parts.length === 1 && isGet) { sendOk(res, handleListWorldbooks(state)); return }
    if (parts.length === 2 && isPost && parts[1] === 'toggle') { sendOk(res, handleToggleWorldbook(state, body)); return }
    if (parts.length === 2 && isPost && parts[1] === 'scan') { sendOk(res, await handleScanWorldbook(state, body)); return }
    sendError(res, 404, '未知的世界书端点'); return
  }

  if (route === 'presets') {
    if (parts.length === 1 && isGet) { sendOk(res, handleListPresets(state)); return }
    if (parts.length === 2 && isGet) {
      const preset = handleGetPreset(state, parts[1])
      if (!preset) { sendError(res, 404, '预设不存在：' + parts[1]); return }
      sendOk(res, preset)
      return
    }
    sendError(res, 404, '未知的预设端点'); return
  }

  if (route === 'chats' && parts.length === 1 && isGet) { sendOk(res, handleListChats(state)); return }

  if (route === 'chat' && parts.length >= 2) {
    const sessionId = parts[1]
    if (parts.length === 2 && isGet) {
      const chat = handleGetChat(state, sessionId)
      if (!chat) { sendError(res, 404, '会话没有聊天记录：' + sessionId); return }
      sendOk(res, chat)
      return
    }
    if (parts.length === 3 && isPost && parts[2] === 'swipe') { sendOk(res, handleSwipe(state, sessionId, body)); return }
    if (parts.length === 3 && isPost && parts[2] === 'regenerate') {
      sendOk(res, await regenerateLastReply(state, sessionId, { keepOldSwipe: body.keepOldSwipe !== false }))
      return
    }
    sendError(res, 404, '未知的会话端点'); return
  }

  if (route === 'stage') {
    // 舞台：AI 决定内容与形状，客户端只负责渲染。
    // GET  /stage/<sessionId>        读当前面板
    // POST /stage/<sessionId>        { panels?, panel?, mode? } 发布（merge/replace）
    // POST /stage/<sessionId>/patch  { operations:[…] } 增量修改
    // POST /stage/<sessionId>/clear  清空
    const sid = parts[1] || 'default'
    if (parts.length === 2 && isGet) { sendOk(res, getStage(state, sid)); return }
    if (parts.length === 3 && isPost && parts[2] === 'patch') {
      sendOk(res, patchStage(state, sid, body && body.operations ? body.operations : [])); return
    }
    if (parts.length === 3 && isPost && parts[2] === 'clear') { sendOk(res, clearStage(state, sid)); return }
    if (parts.length === 2 && isPost) {
      sendOk(res, publishStage(state, sid, { panels: body && body.panels, panel: body && body.panel, mode: body && body.mode })); return
    }
    sendError(res, 404, '未知的舞台端点'); return
  }

  if (route === 'trpg') {
    if (parts.length === 1 && isGet) { sendOk(res, await handleTrpgState(state)); return }
    if (parts.length === 2 && isGet) { sendOk(res, await handleTrpgState(state, parts[1])); return }
    if (parts.length === 2 && isPost && parts[1] === 'log') { sendOk(res, await handleTrpgLog(state, body)); return }
    sendError(res, 404, '未知的跑团端点'); return
  }

  if (route === 'import' && isPost) { sendOk(res, await handleImport(state, body)); return }

  if (route === 'assets' && isGet && parts.length === 1) { sendOk(res, handleAssetGroups(state)); return }

  sendError(res, 404, '未知端点：' + (method + ' ' + pathname))
}

/**
 * 注册插件 HTTP 路由。
 *
 * webServer 是可选服务：拿不到就静默跳过（插件在无 web 的宿主里仍然可用），
 * 拿到注册失败也只记日志，不让插件加载失败。
 * @param {Object} ctx Cordis 上下文
 * @param {Object} state 插件共享状态
 * @returns {void}
 */
export function registerRoutes(ctx, state) {
  // 调用方保证本函数只在 webServer 就绪后执行（plugin.js 用 ctx.inject 包着）。
  // 因此这里拿不到服务就是真的错了，直接抛出来，而不是静默跳过 ——
  // 静默失败曾让路由一条都没注册而所有人都以为插件正常。
  const server = ctx.webServer
  if (!server || typeof server.register !== 'function') {
    throw new Error('dsh-sillytavern: webServer 服务不可用，无法注册 HTTP 路由（ROUTE_PREFIX=' + ROUTE_PREFIX + '）')
  }

  const handler = async (req, res) => {
    try {
      await dispatch(state, req, res)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      // httpError 自带状态码（4xx）；其它异常一律 500，但都回同一个 JSON 信封。
      const status = error && Number.isInteger(error.status) ? error.status : 500
      try { sendError(res, status, message) } catch { /* 响应已关闭，无法再写 */ }
    }
  }

  const disposer = server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  if (typeof ctx.effect === 'function') ctx.effect(() => disposer)
}
