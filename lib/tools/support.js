/**
 * 工具 / HTTP 路由 / ST 导入器共用的支撑层。
 *
 * 这一层只做四件事：把一次调用解析成稳定的会话 id、把磁盘上的角色卡与世界书读成
 * 规范化对象、给 HTTP 处理函数统一信封与回环守卫、按需加载并行开发的引擎模块。
 * 它不含业务策略——怎么改卡、怎么扫描世界书由各工具自己决定。
 *
 * 约定：所有落盘数据的权威源都是文件；state.data 里只放"索引与偏好"（当前会话、
 * 启用状态、当前预设），不复制整张卡或整本书。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { collection, listJsonFiles, readJson, removeFile, safeName, writeJson } from '../store.js'
import { getBinding, sessionIdOf, setBinding } from '../session.js'
import { nowIso, shortId, toList } from '../util.js'

/**
 * HTTP 路由前缀。routes.js 与角色工具生成的 avatarUrl 共用这一个常量。
 *
 * 不能放在 /api 下面：DSH 的客户端 RPC 桥整个接管了 /api（packages/client/connection
 * 的 API_PATH），未带控制台令牌的请求会在桥那一层被 401 掉，根本到不了插件 handler。
 * dsh-meme 用的也是这种顶层短前缀（/dsh-memes-api）。
 */
export const ROUTE_PREFIX = '/dsh-sillytavern-api'

/** 头像路由前缀（相对 ROUTE_PREFIX 之后的部分由客户端拼接，这里存绝对路径）。 */
export const AVATAR_ROUTE = ROUTE_PREFIX + '/avatars/'

/** 头像扩展名 → Content-Type。ST 卡基本都是 png，其余是用户手工放进去的。 */
const AVATAR_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

// ---------------------------------------------------------------------------
// 引擎模块：tavern-core / trpg-gm 并行开发，按需动态加载
// ---------------------------------------------------------------------------

/** 支撑层依赖的外部模块。键名给调用方用，值是相对本文件的路径。 */
const ENGINE_FILES = {
  character: '../st/character.js',
  worldbook: '../st/worldbook.js',
  macros: '../st/macros.js',
  regex: '../st/regex.js',
  assembly: '../prompt/assembly.js',
  // trpg-gm 把状态装配函数和工具放在同一个文件里，这里按真实路径指过去。
  trpg: './trpg.js',
}

/**
 * 动态加载一个引擎模块。
 *
 * 用动态 import 而不是静态 import：引擎模块由并行开发的队友写，未落地时静态
 * import 会让整个插件加载失败、工具与路由全部消失。动态加载失败只影响用到它的
 * 那一个工具，其它功能照常可用。
 * @param {'character'|'worldbook'|'macros'|'regex'|'assembly'|'trpg'} name 模块键名
 * @returns {Promise<Record<string, any>>} 已加载的 ESM 命名空间
 * @throws {Error} 模块不存在或加载报错时抛出，信息里带相对路径与原始原因
 */
export async function loadEngine(name) {
  const rel = ENGINE_FILES[name]
  if (!rel) throw new Error('未知的引擎模块 "' + name + '"，可用的是 ' + Object.keys(ENGINE_FILES).join(' / '))
  try {
    return await import(rel)
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    throw new Error('依赖模块 ' + rel + ' 不存在或加载失败（由 tavern-core / trpg-gm 提供）：' + reason)
  }
}

/**
 * 取一个模块的命名导出；缺失时报出可读的错误。
 * @param {Record<string, any>} mod 已加载的模块命名空间
 * @param {string} exportName 导出名
 * @param {string} label 给人看的模块名，例如 "lib/st/worldbook.js"
 * @returns {any} 该导出
 * @throws {Error} 导出不存在时抛出
 */
export function needExport(mod, exportName, label) {
  const value = mod ? mod[exportName] : undefined
  if (value === undefined) throw new Error(label + ' 没有导出 "' + exportName + '"，无法继续')
  return value
}

/** 没有会话上下文时使用的默认会话名，与 lib/trpg/persist.js 的 DEFAULT_SESSION_KEY 一致。 */
export const DEFAULT_SESSION_ID = 'default'

/**
 * 解析本次调用所属的会话 id。
 *
 * 优先级：显式参数 → 工具执行上下文里的 agent.id（= DSH SessionId）→ state 里记录的
 * 最近活跃会话 → 默认会话 'default'。
 * 最后那级兜底是刻意的：模型在无会话上下文的地方（单次调用、脚本、自检）也要能用
 * 酒馆工具，此时就是一场"默认对话"，而不是直接报错什么都做不了。
 * @param {Object} state 插件状态
 * @param {Object} [args] 工具参数
 * @param {Object} [exec] ToolRunContext，真实调用由 registry 传入
 * @returns {string} 会话 id（永不为空）
 */
export function resolveSessionId(state, args, exec) {
  const fromArgs = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
  if (fromArgs) return fromArgs
  // Agent.id 就是 SessionId（packages/core/agent/src/types.ts）；sessionIdOf 覆盖
  // agent.session.id 的那种绑定形态，两个都试一遍。
  const agent = exec ? exec.agent : undefined
  if (agent && typeof agent.id === 'string' && agent.id) return agent.id
  const fromExec = sessionIdOf(exec)
  if (fromExec) return fromExec
  const active = state.data && typeof state.data.activeSession === 'string' ? state.data.activeSession : ''
  return active || DEFAULT_SESSION_ID
}

/**
 * 把会话标记为最近活跃并立即落盘。
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @returns {string} 同一个 sessionId，方便链式使用
 */
export function touchSession(state, sessionId) {
  if (state.data.activeSession !== sessionId) {
    state.data.activeSession = sessionId
    state.save()
  }
  return sessionId
}

// ---------------------------------------------------------------------------
// 角色卡
// ---------------------------------------------------------------------------

/** 角色卡规范化的空壳，保证调用方永远拿到字段齐全的对象。 */
function emptyCardShape() {
  return {
    id: '',
    name: '',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    character_book: null,
    avatar: '',
    createdAt: '',
    updatedAt: '',
  }
}

/**
 * 把磁盘上读到的任意角色卡补成完整字段。
 *
 * 只补形状、不改内容：ST 卡有的字段缺省是空串，有的用 null 表示未设置，
 * 这里统一成空串 / 空数组 / 空对象，让工具与 UI 不必各自防御。
 * @param {Record<string, any>} raw 原始卡对象
 * @param {string} id 文件名派生的稳定 id
 * @returns {Record<string, any>} 补全后的卡
 */
export function normalizeCardShape(raw, id) {
  const out = emptyCardShape()
  const src = raw && typeof raw === 'object' ? raw : {}
  for (const key of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version', 'avatar']) {
    const value = src[key]
    out[key] = value === undefined || value === null ? '' : String(value)
  }
  out.id = String(src.id || id || '')
  out.name = out.name || out.id
  // ST 导出 JSON 卡时用 avatar:"none" 表示没有头像；留成 'none' 会让头像路由找不到文件。
  if (!out.avatar || out.avatar === 'none') out.avatar = ''
  out.alternate_greetings = toList(src.alternate_greetings)
  out.tags = toList(src.tags)
  out.extensions = src.extensions && typeof src.extensions === 'object' && !Array.isArray(src.extensions) ? src.extensions : {}
  out.character_book = src.character_book && typeof src.character_book === 'object' ? src.character_book : null
  out.createdAt = String(src.createdAt || '')
  out.updatedAt = String(src.updatedAt || '')
  // 引擎（lib/st/character.js）认的 V2/V3 标识与原始对象必须原样带回来：
  // serializeCharacter 靠 spec 决定导出 V2 还是 V3，靠 raw 把 ST 不认识的顶层字段并回去。
  out.spec = src.spec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2'
  out.spec_version = String(src.spec_version || (out.spec === 'chara_card_v3' ? '3.0' : '2.0'))
  if (src.raw && typeof src.raw === 'object' && !Array.isArray(src.raw)) out.raw = src.raw
  for (const key of ['nickname', 'group_only_greetings', 'creator_notes_multilingual', 'creation_date', 'modification_date', 'source']) {
    if (src[key] !== undefined) out[key] = src[key]
  }
  return out
}

/**
 * 角色卡仓库。所有读写都走它，避免各处自己拼路径。
 * @param {Object} state 插件状态
 * @returns {Object} 仓库对象
 */
export function characterStore(state) {
  const dir = state.layout.characters
  const box = collection(dir)
  const avatars = state.layout.avatars

  /** 读一张卡；不存在返回 null。 */
  function read(id) {
    const raw = box.read(id)
    return raw ? normalizeCardShape(raw, safeName(id)) : null
  }

  return {
    dir,
    /** 列出全部卡的 id（按文件 mtime 倒序）。 */
    ids() { return box.list().map(item => item.name) },
    read,
    has(id) { return box.has(id) },
    remove(id) { box.remove(id) },
    /**
     * 写一张卡，自动补 id / 时间戳。
     * @param {string} id 稳定 id
     * @param {Record<string, any>} card 卡内容
     * @returns {Record<string, any>} 落盘后的卡
     */
    write(id, card) {
      const prev = box.read(id) || {}
      const merged = normalizeCardShape({ ...prev, ...card }, id)
      merged.id = id
      merged.createdAt = merged.createdAt || nowIso()
      merged.updatedAt = nowIso()
      box.write(id, merged)
      return merged
    },
    /**
     * 由一个名字派生不冲突的 id：先取安全名，重名追加 -2、-3……
     * @param {string} name 角色名
     * @returns {string} 未被占用的 id
     */
    nextId(name) {
      const base = safeName(name, 'character')
      if (!box.has(base)) return base
      for (let n = 2; n < 10000; n++) {
        const candidate = base + '-' + n
        if (!box.has(candidate)) return candidate
      }
      return base + '-' + Date.now().toString(36)
    },
    /**
     * 把引擎给的候选 id 落成一个未被占用的 id。
     * 引擎按「名字 + 关键内容」散列生成 id，两张同名不同内容的卡天然分开；
     * 真的撞上了（例如同一张卡改了个字）就追加序号。
     * @param {string} preferred 引擎建议的 id
     * @param {string} name 角色名，作为兜底
     * @returns {string} 未被占用的 id
     */
    idFor(preferred, name) {
      const base = safeName(String(preferred || '').trim(), '') || safeName(name, 'character')
      if (!box.has(base)) return base
      for (let n = 2; n < 10000; n++) {
        const candidate = base + '-' + n
        if (!box.has(candidate)) return candidate
      }
      return base + '-' + Date.now().toString(36)
    },
    /**
     * 把用户给的名字/id 解析成唯一存在的卡 id。
     * @param {string} query 名字、id 或唯一子串
     * @returns {string|null} 命中时返回 id，无命中返回 null
     * @throws {Error} 命中多张时抛出，信息里列出候选
     */
    resolve(query) {
      const text = String(query || '').trim()
      if (!text) return null
      if (box.has(text)) return text
      const ids = box.list().map(item => item.name)
      const exact = ids.find(id => {
        const card = read(id)
        return card && card.name === text
      })
      if (exact) return exact
      const lower = text.toLowerCase()
      const loose = ids.filter(id => {
        const card = read(id)
        return id.toLowerCase().includes(lower) || (card && card.name.toLowerCase().includes(lower))
      })
      if (loose.length === 1) return loose[0]
      if (loose.length > 1) {
        const names = loose.map(id => {
          const card = read(id)
          return (card ? card.name : id) + '(' + id + ')'
        })
        throw new Error('"' + text + '" 匹配到多张角色卡：' + names.join('、') + '。请用更完整的名字或直接传 id。')
      }
      return null
    },
    /**
     * 头像文件是否真实存在。
     * @param {Record<string, any>} card 角色卡
     * @returns {boolean} 存在且在 avatars 目录里为 true
     */
    hasAvatar(card) {
      if (!card || !card.avatar) return false
      const file = join(avatars, safeName(card.avatar, ''))
      return Boolean(file) && existsSync(file) && statSync(file).isFile()
    },
    /**
     * 写头像字节。
     * @param {string} id 角色 id
     * @param {Buffer} data 图片字节
     * @param {string} [ext] 扩展名（含点），默认 .png
     * @returns {string} 落盘的文件名（写进 card.avatar）
     */
    writeAvatar(id, data, ext = '.png') {
      const name = safeName(id) + (ext.startsWith('.') ? ext : '.' + ext)
      mkdirSync(avatars, { recursive: true })
      writeFileSync(join(avatars, name), data)
      return name
    },
    /**
     * 读头像字节。
     * @param {string} file 文件名
     * @returns {Buffer|null} 不存在时返回 null
     */
    readAvatar(file) {
      const safe = safeName(decodeSegment(file), '')
      if (!safe) return null
      const full = join(avatars, safe)
      if (!full.startsWith(avatars)) return null
      if (!existsSync(full) || !statSync(full).isFile()) return null
      return readFileSync(full)
    },
  }
}

/**
 * 一次 URI 分段的解码；非法转义时返回原样文本。
 * @param {string} value 原始分段
 * @returns {string} 解码后的文本
 */
function decodeSegment(value) {
  const text = String(value === undefined || value === null ? '' : value)
  try { return decodeURIComponent(text) } catch { return text }
}

/**
 * 头像 URL（相对站点根）。没有头像返回空串。
 * @param {Record<string, any>} card 角色卡
 * @returns {string} 形如 /dsh-sillytavern-api/avatars/xxx.png
 */
export function avatarUrlOf(card) {
  if (!card || !card.avatar) return ''
  return AVATAR_ROUTE + encodeURIComponent(card.avatar)
}

/**
 * 记录一次角色使用，供列表按"最后使用"排序。
 * @param {Object} state 插件状态
 * @param {string} id 角色 id
 * @returns {void}
 */
export function touchCharacterUsage(state, id) {
  if (!id) return
  state.data.characterUsage = state.data.characterUsage || {}
  state.data.characterUsage[id] = Date.now()
  state.data.lastCharacter = id
}

/**
 * 角色列表摘要：名字、标签、头像、最后使用时间。工具与路由共用。
 * @param {Object} state 插件状态
 * @param {{ query?: string, limit?: number }} [options] 过滤与上限
 * @returns {Array<Record<string, any>>} 摘要数组（按最后使用时间倒序）
 */
export function listCharacters(state, options = {}) {
  const store = characterStore(state)
  const query = String(options.query || '').trim().toLowerCase()
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(options.limit)) : 200
  const usage = state.data.characterUsage || {}
  const rows = []
  for (const id of store.ids()) {
    const card = store.read(id)
    if (!card) continue
    if (query) {
      const haystack = [card.name, card.id, card.creator, ...(card.tags || [])].join(' ').toLowerCase()
      if (!haystack.includes(query)) continue
    }
    rows.push({
      id: card.id,
      name: card.name,
      avatar: card.avatar,
      hasAvatar: store.hasAvatar(card),
      avatarUrl: store.hasAvatar(card) ? avatarUrlOf(card) : '',
      tags: card.tags,
      creator: card.creator,
      characterVersion: card.character_version,
      hasCharacterBook: Boolean(card.character_book),
      alternateGreetings: card.alternate_greetings.length,
      lastUsedAt: usage[card.id] ? new Date(usage[card.id]).toISOString() : '',
      updatedAt: card.updatedAt,
    })
  }
  rows.sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)) || a.name.localeCompare(b.name))
  return rows.slice(0, limit)
}

/**
 * 把角色卡绑定到会话：写 state.data.sessions 与 lastCharacter，并按需落盘。
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @param {string} characterId 角色 id
 * @returns {{ sessionId: string, characterId: string }} 绑定结果
 */
export function bindCharacterToSession(state, sessionId, characterId) {
  state.data.sessions = state.data.sessions || {}
  setBinding(state, sessionId, { characterId })
  state.data.activeSession = sessionId
  touchCharacterUsage(state, characterId)
  state.save()
  return { sessionId, characterId }
}

// ---------------------------------------------------------------------------
// 聊天记录
// ---------------------------------------------------------------------------

/**
 * 把磁盘上的聊天对象补成完整形状。
 * @param {Record<string, any>} raw 原始对象
 * @param {string} sessionId 会话 id
 * @returns {Record<string, any>} ChatSession
 */
function normalizeChatShape(raw, sessionId) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const messages = Array.isArray(src.messages) ? src.messages : []
  return {
    id: String(src.id || sessionId),
    characterId: String(src.characterId || ''),
    title: String(src.title || ''),
    persona: String(src.persona || ''),
    messages: messages.map(message => ({
      id: String(message && message.id ? message.id : shortId('msg')),
      role: message && (message.role === 'user' || message.role === 'system') ? message.role : 'assistant',
      name: String((message && message.name) || ''),
      content: String((message && message.content) || ''),
      time: Number(message && message.time) || 0,
      hidden: Boolean(message && message.hidden),
      swipes: toList(message && message.swipes),
      swipeIndex: Number(message && message.swipeIndex) || 0,
      extra: message && typeof message.extra === 'object' && message.extra ? message.extra : {},
    })),
    variables: src.variables && typeof src.variables === 'object' && !Array.isArray(src.variables) ? src.variables : {},
    metadata: src.metadata && typeof src.metadata === 'object' && !Array.isArray(src.metadata) ? src.metadata : {},
    createdAt: Number(src.createdAt) || Date.now(),
    updatedAt: Number(src.updatedAt) || Date.now(),
  }
}

/**
 * 聊天记录仓库。
 *
 * 文件布局：<layout.chats>/<safeName(sessionId)>.json。prompt/assembly.js 也用它读
 * 聊天，两边必须共用同一个实现，否则写入不同步。
 * @param {Object} state 插件状态
 * @returns {Object} 仓库对象
 */
export function createChatStore(state) {
  const dir = state.layout.chats

  /** 会话 id → 文件路径。 */
  function fileOf(sessionId) {
    return join(dir, safeName(sessionId, 'session') + '.json')
  }

  return {
    dir,
    fileOf,
    /** 列出全部聊天（按 mtime 倒序）。 */
    list() {
      return listJsonFiles(dir).map(item => {
        const raw = readJson(item.file)
        return normalizeChatShape(raw, item.name)
      })
    },
    /**
     * 读一个会话；文件不存在返回 null。
     * @param {string} sessionId 会话 id
     * @returns {Record<string, any>|null} ChatSession
     */
    read(sessionId) {
      const raw = readJson(fileOf(sessionId))
      return raw ? normalizeChatShape(raw, sessionId) : null
    },
    /**
     * 写一个会话并刷新 updatedAt。
     * @param {string} sessionId 会话 id
     * @param {Record<string, any>} chat 聊天对象
     * @returns {Record<string, any>} 落盘后的对象
     */
    write(sessionId, chat) {
      const normalized = normalizeChatShape(chat, sessionId)
      normalized.id = String(sessionId)
      normalized.updatedAt = Date.now()
      writeJson(fileOf(sessionId), normalized)
      return normalized
    },
    /**
     * 读会话，不存在就按当前绑定关系新建。
     * @param {string} sessionId 会话 id
     * @returns {Record<string, any>} 一定存在的 ChatSession
     */
    ensure(sessionId) {
      const existing = this.read(sessionId)
      if (existing) return existing
      const binding = getBinding(state, sessionId)
      const persona = state.data.currentPersona || ''
      return this.write(sessionId, {
        id: sessionId,
        characterId: binding.characterId || '',
        title: '',
        persona: binding.persona || persona || '',
        messages: [],
        variables: {},
        metadata: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    },
    /**
     * 追加一条消息。
     * @param {string} sessionId 会话 id
     * @param {Record<string, any>} message ChatMessage
     * @returns {Record<string, any>} 落盘后的会话
     */
    append(sessionId, message) {
      const chat = this.ensure(sessionId)
      chat.messages.push(message)
      return this.write(sessionId, chat)
    },
    /** 删除一个会话文件。 */
    remove(sessionId) { removeFile(fileOf(sessionId)) },
  }
}

// ---------------------------------------------------------------------------
// 世界书
// ---------------------------------------------------------------------------

/**
 * ST 世界书条目的完整默认值表。
 *
 * 字段与 ST 1.12+/1.18 的 world info 条目一一对应；scanDepth / caseSensitive /
 * matchWholeWords / useGroupScoring 的 null 表示"继承全局设置"，与 ST 一致。
 * @returns {Record<string, any>} 一份全新的默认条目
 */
function stEntryDefaults() {
  return {
    uid: 0,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
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
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    triggers: [],
    displayIndex: 0,
  }
}

const ENTRY_BOOL_KEYS = ['constant', 'vectorized', 'selective', 'addMemo', 'disable', 'ignoreBudget',
  'excludeRecursion', 'preventRecursion', 'matchPersonaDescription', 'matchCharacterDescription',
  'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes',
  'delayUntilRecursion', 'useProbability', 'groupOverride']
const ENTRY_NUM_KEYS = ['uid', 'selectiveLogic', 'order', 'position', 'probability', 'depth',
  'groupWeight', 'role', 'sticky', 'cooldown', 'delay', 'displayIndex']
const ENTRY_STR_KEYS = ['comment', 'content', 'outletName', 'group', 'automationId']
const ENTRY_ARR_KEYS = ['key', 'keysecondary', 'triggers']
const ENTRY_INHERIT_KEYS = ['scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring']

/**
 * 归一化一条世界书条目：缺字段补默认、类型纠偏、null 继承保留。
 * @param {Record<string, any>} input 用户或文件给的条目
 * @param {number} [uid] 指定的 uid（新增条目时由调用方分配）
 * @returns {Record<string, any>} 规范化条目
 */
export function normalizeWorldbookEntry(input, uid) {
  const src = input && typeof input === 'object' ? input : {}
  const out = stEntryDefaults()
  for (const key of ENTRY_BOOL_KEYS) {
    if (src[key] !== undefined && src[key] !== null) out[key] = Boolean(src[key])
  }
  for (const key of ENTRY_NUM_KEYS) {
    const value = Number(src[key])
    if (src[key] !== undefined && src[key] !== null && Number.isFinite(value)) out[key] = value
  }
  for (const key of ENTRY_STR_KEYS) {
    if (src[key] !== undefined && src[key] !== null) out[key] = String(src[key])
  }
  for (const key of ENTRY_ARR_KEYS) {
    if (src[key] !== undefined) out[key] = toList(src[key])
  }
  for (const key of ENTRY_INHERIT_KEYS) {
    const value = src[key]
    if (value === undefined) continue
    if (value === null || value === 'null' || value === '') { out[key] = null; continue }
    if (key === 'scanDepth') {
      const n = Number(value)
      out[key] = Number.isFinite(n) ? n : null
    } else {
      out[key] = Boolean(value)
    }
  }
  if (Number.isFinite(uid)) out.uid = uid
  else out.uid = Number.isFinite(Number(src.uid)) ? Number(src.uid) : 0
  if (!out.displayIndex) out.displayIndex = out.uid
  return out
}

/**
 * 世界书仓库。
 *
 * 文件是 ST 原生格式 { entries: { "0": {...} } }，可以直接反向导出给 ST。
 * 书级启用状态**不进文件**，存在 state.data.worldInfo.books 里，
 * 这样原样导出时不会带上插件私有字段。
 * @param {Object} state 插件状态
 * @returns {Object} 仓库对象
 */
export function worldbookStore(state) {
  const dir = state.layout.worlds

  /** 归一化整本书，兼容 entries 数组、裸对象两种历史写法。 */
  function normalizeBook(raw, name) {
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
        if (!entry || typeof entry !== 'object') continue
        const uid = Number.isFinite(Number(key)) ? Number(key) : Object.keys(entries).length
        entries[String(uid)] = normalizeWorldbookEntry(entry, uid)
      }
    }
    return { name: String(src.name || name || ''), entries }
  }

  return {
    dir,
    /** 全部书名（按 mtime 倒序）。 */
    names() { return listJsonFiles(dir).map(item => item.name) },
    /**
     * 读一本书。
     * @param {string} name 书名
     * @returns {{ name: string, entries: Record<string, any> }|null} 不存在返回 null
     */
    read(name) {
      const file = join(dir, safeName(name, '') + '.json')
      const raw = readJson(file)
      return raw ? normalizeBook(raw, name) : null
    },
    /**
     * 写一本书（只写 ST 原生 entries，不夹带插件私有字段）。
     * @param {string} name 书名
     * @param {{ entries: Record<string, any> }} book 书内容
     * @returns {{ name: string, entries: Record<string, any> }} 落盘后的书
     */
    write(name, book) {
      const normalized = normalizeBook({ entries: (book && book.entries) || {} }, name)
      writeJson(join(dir, safeName(name, 'worldbook') + '.json'), { entries: normalized.entries })
      return normalized
    },
    /** 删除一本书。 */
    remove(name) { removeFile(join(dir, safeName(name, '') + '.json')) },
    /** 书是否存在。 */
    has(name) { return existsSync(join(dir, safeName(name, '') + '.json')) },
    /**
     * 解析书名为真实存在的书名（支持唯一子串）。
     * @param {string} query 书名或子串
     * @returns {string|null} 命中返回书名，无命中返回 null
     * @throws {Error} 多义时抛错并列出候选
     */
    resolve(query) {
      const text = String(query || '').trim()
      if (!text) return null
      const names = this.names()
      if (names.includes(text)) return text
      const lower = text.toLowerCase()
      const loose = names.filter(name => name.toLowerCase().includes(lower))
      if (loose.length === 1) return loose[0]
      if (loose.length > 1) {
        throw new Error('"' + text + '" 匹配到多本世界书：' + loose.join('、') + '。请传完整书名。')
      }
      return null
    },
    /** 某本书的条目数。 */
    count(name) {
      const book = this.read(name)
      return book ? Object.keys(book.entries).length : 0
    },
  }
}

/**
 * 一本书是否启用。未登记过的书默认**不启用**，与 ST 需要手动挂载世界书一致。
 * @param {Object} state 插件状态
 * @param {string} name 书名
 * @returns {boolean} 启用为 true
 */
export function bookEnabled(state, name) {
  const books = (state.data.worldInfo && state.data.worldInfo.books) || {}
  const record = books[name]
  return Boolean(record && record.enabled)
}

/**
 * 设置一本书的启用状态并落盘。
 * @param {Object} state 插件状态
 * @param {string} name 书名
 * @param {boolean} enabled 是否启用
 * @returns {{ name: string, enabled: boolean }} 结果
 */
export function setBookEnabled(state, name, enabled) {
  state.data.worldInfo = state.data.worldInfo || {}
  state.data.worldInfo.books = state.data.worldInfo.books || {}
  const prev = state.data.worldInfo.books[name] || {}
  state.data.worldInfo.books[name] = { ...prev, enabled: Boolean(enabled) }
  state.save()
  return { name, enabled: Boolean(enabled) }
}

/**
 * 当前会话实际生效的世界书名。
 *
 * 会话上写了 worldbooks 数组就以它为准（st_bind 时可自选），否则用全局启用的书。
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @returns {string[]} 书名数组
 */
export function activeWorldbookNames(state, sessionId) {
  const binding = getBinding(state, sessionId)
  const store = worldbookStore(state)
  if (Array.isArray(binding.worldbooks) && binding.worldbooks.length > 0) {
    return binding.worldbooks.filter(name => store.has(name))
  }
  const books = (state.data.worldInfo && state.data.worldInfo.books) || {}
  return Object.keys(books).filter(name => books[name] && books[name].enabled)
}


// ---------------------------------------------------------------------------
// 世界书扫描（工具与 HTTP 路由共用同一份实现）
// ---------------------------------------------------------------------------

/**
 * 从会话里取扫描用的上下文：最近消息文本、角色信息、persona 描述。
 * @param {Object} state 插件状态
 * @param {string} [sessionId] 会话 id，可为空
 * @returns {Record<string, any>} 传给 scanWorldInfo 的上下文字段
 */
function scanContextOf(state, sessionId) {
  const context = {
    chatLines: [],
    charName: '',
    userName: '',
    personaDescription: '',
    characterDescription: '',
    characterPersonality: '',
    characterDepthPrompt: '',
    scenario: '',
    creatorNotes: '',
  }
  if (!sessionId) return context
  const chat = createChatStore(state).read(sessionId)
  if (!chat) return context
  context.chatLines = chat.messages
    .filter(message => !message.hidden)
    .map(message => String(message.content || ''))
    .filter(Boolean)
  context.userName = chat.persona || ''
  const binding = getBinding(state, sessionId)
  const boundId = chat.characterId || binding.characterId || ''
  const card = boundId ? characterStore(state).read(boundId) : null
  if (card) {
    context.charName = card.name
    context.characterDescription = card.description
    context.characterPersonality = card.personality
    context.characterDepthPrompt = String((card.extensions && card.extensions.depth_prompt && card.extensions.depth_prompt.prompt) || '')
    context.scenario = card.scenario
    context.creatorNotes = card.creator_notes
  }
  return context
}

/**
 * 把多本书的条目合并成一份 uid 全局唯一的表单，并记录 uid → { book, uid } 的反查表。
 *
 * 各本书的 uid 会重复，合并前必须重新编号，否则激活结果分不清来自哪本书。
 * @param {Array<{ name: string, entries: Record<string, any> }>} books 书数组
 * @returns {{ entries: Record<string, any>, index: Map<number, { book: string, uid: number }> }} 合并结果
 */
function mergeWorldbooks(books) {
  const entries = {}
  const index = new Map()
  let next = 0
  for (const book of books) {
    for (const [key, entry] of Object.entries(book.entries || {})) {
      const uid = next++
      entries[String(uid)] = { ...entry, uid }
      index.set(uid, { book: book.name, uid: Number(key) })
    }
  }
  return { entries, index }
}

/**
 * 试跑一次世界书扫描。工具与 HTTP 路由共用这一个实现。
 * @param {Object} state 插件状态
 * @param {Object} options 扫描选项
 * @param {string[]} options.names 要扫的书名（必须已存在）
 * @param {string} [options.text] 聊天文本（多行一组），给了就覆盖会话内容
 * @param {string[]} [options.lines] 已经是数组形态的聊天行
 * @param {string} [options.sessionId] 会话 id，用于取角色与 persona 上下文
 * @param {number} [options.scanDepth] 扫描深度，缺省用配置
 * @param {number} [options.budget] token 预算，缺省用配置
 * @param {number} [options.maxRecursionDepth] 递归层数，缺省 3
 * @returns {Promise<Record<string, any>>} 扫描结果（含 activated / tokens / 各插入槽）
 */
export async function scanWorldbooksForText(state, options = {}) {
  const names = Array.isArray(options.names) ? options.names : []
  if (names.length === 0) {
    return {
      scannedBooks: [], scannedMessages: 0, activated: [], activatedEntries: [],
      tokens: 0, before: [], after: [], atDepth: [], anTop: [], anBottom: [],
    }
  }
  const engine = await loadEngine('worldbook')
  const scan = needExport(engine, 'scanWorldInfo', 'lib/st/worldbook.js')
  const books = worldbookStore(state)
  const loaded = names.map(name => books.read(name)).filter(Boolean)
  const merged = mergeWorldbooks(loaded)

  const context = scanContextOf(state, options.sessionId)
  let chatLines = context.chatLines
  if (Array.isArray(options.lines) && options.lines.length > 0) {
    chatLines = options.lines.map(line => String(line))
  } else if (typeof options.text === 'string' && options.text.trim()) {
    chatLines = options.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  }

  const result = await scan(merged.entries, {
    chatLines,
    scanDepth: options.scanDepth !== undefined ? options.scanDepth : state.config.maxWorldInfoDepth,
    budget: options.budget !== undefined ? options.budget : state.config.worldInfoBudget,
    caseSensitive: false,
    matchWholeWords: false,
    maxRecursionDepth: options.maxRecursionDepth !== undefined ? options.maxRecursionDepth : 3,
    charName: context.charName,
    userName: context.userName,
    personaDescription: context.personaDescription,
    characterDescription: context.characterDescription,
    characterPersonality: context.characterPersonality,
    characterDepthPrompt: context.characterDepthPrompt,
    scenario: context.scenario,
    creatorNotes: context.creatorNotes,
    dryRun: true,
  }) || {}

  const activatedUids = Array.isArray(result.activated) ? result.activated : []
  const activatedEntries = activatedUids.map(uid => {
    const source = merged.index.get(uid)
    const entry = merged.entries[String(uid)] || {}
    return {
      uid: source ? source.uid : uid,
      book: source ? source.book : '',
      comment: entry.comment || '',
      position: entry.position === undefined ? null : entry.position,
      depth: entry.depth === undefined ? null : entry.depth,
      chars: String(entry.content || '').length,
    }
  })
  return {
    scannedBooks: names,
    scannedMessages: chatLines.length,
    activated: activatedUids,
    activatedEntries,
    tokens: Number(result.tokens) || 0,
    before: result.before || [],
    after: result.after || [],
    atDepth: result.atDepth || [],
    anTop: result.anTop || [],
    anBottom: result.anBottom || [],
  }
}

// ---------------------------------------------------------------------------
// 正则脚本
// ---------------------------------------------------------------------------

/**
 * 正则脚本仓库（一份全局脚本表，文件 <layout.regex>/scripts.json）。
 * @param {Object} state 插件状态
 * @returns {Object} 仓库对象
 */
export function regexStore(state) {
  const file = join(state.layout.regex, 'scripts.json')
  return {
    file,
    /**
     * 读脚本表。
     * @returns {Array<Record<string, any>>} 脚本数组
     */
    read() {
      const raw = readJson(file)
      const list = raw && Array.isArray(raw.scripts) ? raw.scripts : Array.isArray(raw) ? raw : []
      return list.filter(item => item && typeof item === 'object')
    },
    /**
     * 写脚本表（整表覆盖）。
     * @param {Array<Record<string, any>>} scripts 脚本数组
     * @returns {Array<Record<string, any>>} 落盘后的数组
     */
    write(scripts) {
      const list = Array.isArray(scripts) ? scripts : []
      writeJson(file, { scripts: list })
      if (state.cache && typeof state.cache.delete === 'function') state.cache.delete('regex')
      return list
    },
  }
}

// ---------------------------------------------------------------------------
// 跑团状态桥
// ---------------------------------------------------------------------------

/** trpg-gm 尚未提供状态时的空骨架，保证路由不会 500。 */
function emptyTrpgState() {
  return { map: null, scene: null, sheets: [], log: [], encounter: null, party: [] }
}

/**
 * 生成 ST 聊天记录里一条消息的 extra 字段。
 *
 * ST 的 extra 里带 swipe_id / swipes / swipe_info（每条 swipe 的生成时间），
 * 导出 JSONL 时必须补齐，否则 ST 导入后看不到可切换的 swipe。
 * @param {Record<string, any>} message ChatMessage
 * @returns {Record<string, any>} 可直接写进 ST JSONL 的 extra
 */
export function stExtraOf(message) {
  const extra = message.extra && typeof message.extra === 'object' ? { ...message.extra } : {}
  const swipes = Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [message.content]
  extra.swipe_id = message.swipeIndex || 0
  extra.swipes = swipes
  if (!Array.isArray(extra.swipe_info) || extra.swipe_info.length !== swipes.length) {
    const base = Number(message.time) || Date.now()
    extra.swipe_info = swipes.map((_text, index) => ({
      send_date: new Date(base + index).toISOString(),
      gen_started: null,
      gen_finished: null,
      extra: {},
    }))
  }
  return extra
}

/**
 * 切换一条回复的 swipe：追加新分支、跳到指定分支，或前后翻一个。
 *
 * 不传 messageId 时操作最后一条 AI 回复。swipes 数组里不含当前生效内容时先补进去，
 * 保证切换过程不会丢文本。
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @param {{ direction?: number, content?: string, messageId?: string, index?: number }} options 切换参数
 * @returns {Record<string, any>} 切换结果
 * @throws {Error} 会话里没有任何可操作的 AI 回复时抛出
 */
export function swipeMessage(state, sessionId, options = {}) {
  const chats = createChatStore(state)
  const chat = chats.ensure(sessionId)
  const target = options.messageId
    ? chat.messages.find(message => message.id === options.messageId)
    : [...chat.messages].reverse().find(message => message.role === 'assistant')
  if (!target) throw new Error('这个会话里还没有任何 AI 回复，无法 swipe。')

  if (target.swipes.length === 0) target.swipes = [target.content]
  if (target.swipeIndex >= target.swipes.length) target.swipeIndex = target.swipes.length - 1

  if (typeof options.content === 'string') {
    target.swipes.push(options.content)
    target.swipeIndex = target.swipes.length - 1
    target.content = options.content
  } else if (options.index !== undefined && options.index !== null && Number.isFinite(Number(options.index))) {
    const index = Math.max(0, Math.min(Math.trunc(Number(options.index)), target.swipes.length - 1))
    target.swipeIndex = index
    target.content = target.swipes[index]
  } else {
    const step = Number(options.direction) === -1 ? -1 : 1
    const count = target.swipes.length
    target.swipeIndex = ((target.swipeIndex + step) % count + count) % count
    target.content = target.swipes[target.swipeIndex]
  }
  target.time = Date.now()
  chats.write(sessionId, chat)
  return {
    sessionId,
    messageId: target.id,
    index: target.swipeIndex,
    total: target.swipes.length,
    content: target.content,
    swipes: target.swipes,
  }
}

/**
 * 重生成最后一条 AI 回复：旧内容存进 swipe 历史，正文清空并标记待生成。
 *
 * 工具与 HTTP 路由共用这一份实现，避免两边行为跑偏。真正的"生成"由模型完成：
 * 这里只负责把该腾的位置腾出来，并把装配好的上下文交回去。
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @param {{ keepOldSwipe?: boolean }} [options] keepOldSwipe=false 时丢弃旧内容
 * @returns {Promise<Record<string, any>>} 重生成上下文
 * @throws {Error} 会话里没有任何 AI 回复时抛出
 */
export async function regenerateLastReply(state, sessionId, options = {}) {
  const chats = createChatStore(state)
  const chat = chats.ensure(sessionId)
  const target = [...chat.messages].reverse().find(message => message.role === 'assistant' && !message.hidden)
  if (!target) throw new Error('这个会话里还没有任何 AI 回复，无法重生成。')

  if (target.swipes.length === 0) target.swipes = [target.content]
  if (options.keepOldSwipe !== false && target.content && !target.swipes.includes(target.content)) {
    target.swipes.push(target.content)
  }
  target.content = ''
  target.time = Date.now()
  target.extra = { ...target.extra, regenerate: true }
  chat.metadata.pendingRegeneration = { messageId: target.id, at: nowIso() }

  let assembled = null
  let assemblyError = ''
  try {
    const assembly = await loadEngine('assembly')
    if (typeof assembly.assemblePrompt === 'function') {
      const card = chat.characterId ? characterStore(state).read(chat.characterId) : null
      assembled = await assembly.assemblePrompt(state, chat, card, {})
    }
  } catch (error) {
    assemblyError = error && error.message ? error.message : String(error)
  }
  chats.write(sessionId, chat)
  return {
    sessionId,
    messageId: target.id,
    cleared: true,
    previousSwipeCount: target.swipes.length,
    systemPrompt: assembled ? assembled.systemPrompt : '',
    history: assembled ? assembled.history : [],
    diagnostics: assembled ? assembled.diagnostics : {},
    assemblyError,
    nextStep: '现在直接写出新的回复正文，然后调用 st_swipe 并传 content=<新回复> 把它写回这条消息的 swipe 末尾。',
  }
}

/**
 * 取会话的跑团状态；trpg-gm 的模块未就绪时返回空骨架。
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @returns {Promise<Record<string, any>>} 跑团状态
 */
export async function getTrpgStateSafe(state, sessionId) {
  try {
    const mod = await loadEngine('trpg')
    if (typeof mod.getTrpgState === 'function') {
      const value = await mod.getTrpgState(state, sessionId)
      if (value && typeof value === 'object') return { ...emptyTrpgState(), ...value }
    }
  } catch (error) {
    // 跑团模块未就绪或存档损坏都不该让 HTTP 整体 500：返回空骨架并在字段里说明原因。
    return { ...emptyTrpgState(), unavailable: error && error.message ? error.message : String(error) }
  }
  return emptyTrpgState()
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 请求是否来自本机回环地址。
 *
 * 只看 Host：浏览器按实际连接目标填写，DNS rebinding 时它就是攻击者的域名，直接落选。
 * 没有 Host 头时返回 true（HTTP/1.0 与本机 socket 直连都不带这个头，浏览器一定会带）。
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {boolean} 回环来源为 true
 */
function hostIsLoopback(req) {
  const raw = String((req && req.headers && req.headers.host) || '')
  if (!raw) return true
  const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
  return LOOPBACK_HOSTS.has(name.toLowerCase())
}

/**
 * 非回环来源直接回 403。
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @returns {boolean} 已拒绝并结束响应时为 true，调用方应立即 return
 */
export function denyNonLoopback(req, res) {
  if (hostIsLoopback(req)) return false
  sendJson(res, 403, { ok: false, error: '拒绝：只接受本机（回环地址）请求' })
  return true
}

/**
 * 发一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} status HTTP 状态码
 * @param {any} value 响应体（JSON 可序列化）
 * @param {Record<string, string>} [headers] 额外响应头
 * @returns {void}
 */
function sendJson(res, status, value, headers = {}) {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

/**
 * 发一个错误信封 { ok: false, error }。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} status HTTP 状态码
 * @param {string} message 中文错误信息
 * @returns {void}
 */
export function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: String(message || '未知错误') })
}

/**
 * 发一个成功信封 { ok: true, data }。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {any} data 数据
 * @param {number} [status] 状态码，默认 200
 * @returns {void}
 */
export function sendOk(res, data, status = 200) {
  sendJson(res, status, { ok: true, data })
}

/**
 * 发一个图片文件。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {Buffer} data 图片字节
 * @param {string} file 文件名（用于推断 Content-Type）
 * @returns {void}
 */
export function sendImage(res, data, file) {
  const mime = AVATAR_MIME[extname(String(file || '')).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': data.length,
    'Cache-Control': 'public, max-age=300',
  })
  res.end(data)
}

/**
 * 读请求体并解析 JSON。
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {number} [limitBytes] 体积上限，默认 2 MiB
 * @returns {Promise<Record<string, any>>} 解析后的对象；空体返回 {}
 * @throws {Error} 超限或不是合法 JSON 时抛出中文错误
 */
export function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > limitBytes) {
        fail(new Error('请求体超过 ' + limitBytes + ' 字节上限'))
        try { req.destroy() } catch { /* 已断开，无需再处理 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('error', error => fail(error instanceof Error ? error : new Error(String(error))))
    req.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) { resolve({}); return }
      try {
        const value = JSON.parse(text)
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : { value })
      } catch (error) {
        reject(new Error('请求体不是合法 JSON：' + (error && error.message ? error.message : String(error))))
      }
    })
  })
}
