/**
 * 提示词装配：把角色卡、世界书、宏、正则、作者注释按 ST PromptManager 的顺序
 * 拼成一次请求该看到的系统提示词与聊天历史。
 *
 * ST 的默认顺序（docs/ARCHITECTURE.md 已核实）：
 *   main -> worldInfoBefore -> personaDescription -> charDescription -> charPersonality
 *        -> scenario -> enhanceDefinitions(默认关) -> nsfw -> worldInfoAfter
 *        -> dialogueExamples -> chatHistory -> jailbreak
 *
 * 与 DSH 的分工：本模块只产出「文本」，不注册工具、不写文件。
 * lib/prompt/render.js 通过 state.promptRuntime.assemble() 调它，把结果注进系统提示词；
 * 工具（st_regenerate 等）通过 assemblePrompt() 拿 history 与 diagnostics。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, safeName } from '../store.js'
import { estimateTokens } from '../util.js'
import { createChatStore, characterStore, regexStore, worldbookStore } from '../tools/support.js'
import { getBinding, personaOf } from '../session.js'
import { currentSessionId } from './inject.js'
import { createMacroEnv, expandMacros } from '../st/macros.js'
import { applyRegex, REGEX_PLACEMENT } from '../st/regex.js'
import { mergeWorldbookEntries, scanWorldInfo } from '../st/worldbook.js'

/** ST 提示词块的默认顺序（PromptManager 的 promptManagerDefaultPromptOrder）。 */
const DEFAULT_PROMPT_ORDER = [
  { identifier: 'main', enabled: true },
  { identifier: 'worldInfoBefore', enabled: true },
  { identifier: 'personaDescription', enabled: true },
  { identifier: 'charDescription', enabled: true },
  { identifier: 'charPersonality', enabled: true },
  { identifier: 'scenario', enabled: true },
  { identifier: 'enhanceDefinitions', enabled: false },
  { identifier: 'nsfw', enabled: true },
  { identifier: 'worldInfoAfter', enabled: true },
  { identifier: 'dialogueExamples', enabled: true },
  { identifier: 'chatHistory', enabled: true },
  { identifier: 'jailbreak', enabled: true },
]

/** 每个块的中文标签，供 UI 与 listPromptBlocks 使用。 */
const PROMPT_LABELS = Object.freeze({
  main: '主提示词',
  worldInfoBefore: '世界书（角色定义前）',
  personaDescription: '用户设定',
  charDescription: '角色描述',
  charPersonality: '角色性格',
  scenario: '场景',
  enhanceDefinitions: '定义增强（默认关闭）',
  nsfw: '辅助提示词',
  worldInfoAfter: '世界书（角色定义后）',
  dialogueExamples: '对话示例',
  chatHistory: '聊天记录',
  jailbreak: '后置指令',
})

/** ST 默认主提示词（与 PromptManager 的 chatCompletionDefaultPrompts 一致）。 */
const DEFAULT_MAIN_PROMPT = "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}."

/** ST 默认的 enhanceDefinitions 内容。 */
const DEFAULT_ENHANCE = "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute."

/** 没有绑定角色时的兜底 persona 名。 */
const DEFAULT_PERSONA_NAME = 'User'

/** 取字符串，null/undefined → ''。 */
function str(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

/** 有内容才算一块；只用空白字符组成的块也算空。 */
function isMeaningful(text) {
  return str(text).trim() !== ''
}

/** 用空行拼接多个块，跳过空块。 */
function joinBlocks(parts) {
  return parts.filter(isMeaningful).map(part => str(part).trim()).join('\n\n')
}

/**
 * 读一份预设文件（ST 的 OpenAI Settings JSON）。
 *
 * @param {Object} state 插件状态
 * @param {string} name 预设名
 * @returns {Record<string, any>|null} 预设内容，不存在返回 null
 */
function readPreset(state, name) {
  if (!name) return null
  const file = join(state.layout.presets, safeName(name, 'preset') + '.json')
  if (!existsSync(file)) return null
  try {
    return readJson(file, null)
  } catch {
    return null
  }
}

/**
 * 从预设里解析出这一轮生效的块顺序与块内容覆盖。
 *
 * ST 把顺序存在预设的 prompt_order 数组里（按 character_id 分组），
 * 内容覆盖存在 prompts 数组里。没有预设时退回默认顺序。
 *
 * @param {Object} state 插件状态
 * @param {string} characterId 角色 id（用于匹配 prompt_order 分组）
 * @returns {{ order: {identifier: string, enabled: boolean}[], overrides: Record<string, string>, presetName: string }}
 *          解析结果
 */
function resolvePresetOrder(state, characterId) {
  const presetName = state.data && state.data.presets ? str(state.data.presets.active) : ''
  const preset = readPreset(state, presetName)
  if (!preset) return { order: DEFAULT_PROMPT_ORDER.slice(), overrides: {}, presetName: '' }

  const overrides = {}
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : []
  for (const prompt of prompts) {
    if (!prompt || typeof prompt !== 'object') continue
    const identifier = str(prompt.identifier)
    if (!identifier) continue
    if (prompt.content !== undefined && prompt.content !== null) overrides[identifier] = String(prompt.content)
  }

  const groups = Array.isArray(preset.prompt_order) ? preset.prompt_order : []
  const forCharacter = groups.find(group => group && String(group.character_id) === String(characterId))
  const forDummy = groups.find(group => group && (String(group.character_id) === '100000' || String(group.character_id) === '100001'))
  const chosen = forCharacter || forDummy || groups[0]
  const list = chosen && Array.isArray(chosen.order) ? chosen.order : null
  if (!list || list.length === 0) return { order: DEFAULT_PROMPT_ORDER.slice(), overrides, presetName }

  const order = list
    .filter(item => item && typeof item === 'object' && str(item.identifier))
    .map(item => ({ identifier: str(item.identifier), enabled: item.enabled !== false }))
  if (order.length === 0) return { order: DEFAULT_PROMPT_ORDER.slice(), overrides, presetName }

  // 预设里可能漏掉某些块，补在末尾，避免整块消失
  const seen = new Set(order.map(item => item.identifier))
  for (const item of DEFAULT_PROMPT_ORDER) {
    if (!seen.has(item.identifier) && item.identifier !== 'chatHistory') order.push({ identifier: item.identifier, enabled: false })
  }
  if (!seen.has('chatHistory')) order.push({ identifier: 'chatHistory', enabled: true })

  return { order, overrides, presetName }
}

/**
 * 取当前会话该用的世界书条目。
 *
 * 多本书的 uid 会重复，这里合并时重新编号，并记录 uid → 源书的反查表，
 * 这样扫描结果还能映射回「哪本书的第几条」。
 *
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @param {string[]} [explicitNames] 显式指定书名（会话绑定里的 worldbooks）
 * @returns {{ entries: Record<string, any>, index: Map<number, {book: string, uid: number}>, names: string[] }}
 *          合并后的条目表
 */
function collectWorldEntries(state, sessionId, explicitNames) {
  const store = worldbookStore(state)
  let names = Array.isArray(explicitNames) && explicitNames.length ? explicitNames : []
  if (names.length === 0) {
    const books = (state.data && state.data.worldInfo && state.data.worldInfo.books) || {}
    names = Object.keys(books).filter(name => books[name] && books[name].enabled)
  }
  const loaded = []
  for (const name of names) {
    const book = store.read(name)
    if (book) loaded.push({ name, entries: book.entries })
  }
  return mergeWorldbookEntries(loaded)
}

/**
 * 把聊天消息转成 ST 风格的扫描文本行。
 *
 * ST 用 `${name}: ${mes}`（world_info_include_names 默认开），并只取真正进入上下文的消息。
 *
 * @param {Record<string, any>[]} messages 聊天消息（旧→新）
 * @param {string} charName 角色名
 * @param {string} userName 用户名
 * @returns {string[]} 扫描文本行（旧→新）
 */
function buildScanLines(messages, charName, userName) {
  const lines = []
  for (const message of messages) {
    if (!message || message.hidden) continue
    const content = str(message.content).trim()
    if (!content) continue
    const name = str(message.name) || (message.role === 'user' ? userName : charName)
    lines.push(name ? name + ': ' + content : content)
  }
  return lines
}

/**
 * 按 ST 的规则给一条世界书正文做正则清洗。
 *
 * @param {string} content 条目正文
 * @param {Record<string, any>[]} scripts 正则脚本
 * @param {number|null} depth 条目深度（@depth 条目才给）
 * @param {(value: string) => string} expand 宏展开函数
 * @returns {string} 清洗后的正文
 */
function cleanWorldContent(content, scripts, depth, expand) {
  if (!scripts.length) return content
  return applyRegex(content, scripts, REGEX_PLACEMENT.WORLD_INFO, {
    prompt: true,
    markdown: false,
    depth: depth === null ? undefined : depth,
    expand,
  })
}

/**
 * 取用户 persona 的名字与描述。
 *
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @param {Record<string, any>|null} chat 聊天对象（可能有自己的 persona）
 * @returns {{ name: string, description: string }} persona
 */
function resolvePersona(state, sessionId, chat) {
  const fromChat = chat && chat.persona ? str(chat.persona) : ''
  let name = fromChat
  if (!name) {
    try {
      name = personaOf(state, sessionId, DEFAULT_PERSONA_NAME)
    } catch {
      // lib/session.js 在 state.data 不完整时会抛：装配不能因此整轮失败
      name = DEFAULT_PERSONA_NAME
    }
  }
  const personas = (state.data && state.data.personas) || {}
  const record = personas[name]
  return {
    name,
    description: record && record.description ? str(record.description) : '',
  }
}

/**
 * 取角色卡。优先用调用方给的，其次用聊天/绑定里的 characterId 读盘。
 *
 * @param {Object} state 插件状态
 * @param {Record<string, any>|null} chat 聊天对象
 * @param {Record<string, any>|null} character 调用方传入的卡
 * @param {Object} binding 会话绑定
 * @returns {Record<string, any>|null} 角色卡
 */
function resolveCharacter(state, chat, character, binding) {
  if (character && typeof character === 'object') return character
  const id = (chat && chat.characterId) || (binding && binding.characterId) || ''
  if (!id) return null
  try {
    return characterStore(state).read(id)
  } catch {
    return null
  }
}

/**
 * 从角色卡里取 @depth 注释（ST 的 depth_prompt 扩展字段）。
 *
 * @param {Record<string, any>|null} card 角色卡
 * @returns {{ prompt: string, depth: number, role: string }|null} 注释，没有则 null
 */
function resolveDepthPrompt(card) {
  const extension = card && card.extensions && card.extensions.depth_prompt
  if (!extension || typeof extension !== 'object') return null
  const prompt = str(extension.prompt).trim()
  if (!prompt) return null
  const depth = Number(extension.depth)
  return {
    prompt,
    depth: Number.isFinite(depth) ? depth : 4,
    role: str(extension.role) || 'system',
  }
}

/**
 * 取作者注释。会话级覆盖优先于全局默认。
 *
 * @param {Object} state 插件状态
 * @param {Record<string, any>|null} chat 聊天对象
 * @returns {{ text: string, depth: number, role: string }} 作者注释
 */
function resolveAuthorNote(state, chat) {
  const sessionNote = chat && chat.metadata && chat.metadata.authorNote ? chat.metadata.authorNote : null
  const globalNote = (state.data && state.data.authorNote) || null
  const source = sessionNote || globalNote || {}
  const depth = Number(source.depth)
  return {
    text: str(source.text).trim(),
    depth: Number.isFinite(depth) ? depth : (Number(state.config && state.config.authorNoteDepth) || 4),
    role: str(source.role) || 'system',
  }
}

/**
 * 归一化聊天历史消息，供装配与返回。
 *
 * @param {Record<string, any>[]} messages 聊天消息
 * @param {Object} options 装配选项
 * @returns {Record<string, any>[]} 归一化后的消息（旧→新）
 */
function normalizeHistory(messages, options) {
  const out = []
  for (const message of messages) {
    if (!message || message.hidden) continue
    if (options.skipEmpty !== false && !isMeaningful(message.content)) continue
    out.push({
      role: message.role === 'user' ? 'user' : (message.role === 'system' ? 'system' : 'assistant'),
      content: str(message.content),
      name: str(message.name),
      id: message.id === undefined ? undefined : message.id,
    })
  }
  return out
}

/**
 * 把内容按深度插进历史。
 *
 * 深度语义与 ST 一致：depth=0 表示紧接在最后一条之后（也就是历史末尾），
 * depth=n 表示倒数第 n 条之后。同深度同角色合并成一条。
 *
 * @param {Record<string, any>[]} history 历史消息（旧→新）
 * @param {{ text: string, depth: number, role: string }[]} injections 待插入条目
 * @returns {Record<string, any>[]} 插入后的历史（不修改入参）
 */
function injectAtDepth(history, injections) {
  if (!injections.length) return history
  const result = history.slice()
  // 深度从大到小插入，避免前面的插入影响后面的下标
  const sorted = injections.slice().sort((a, b) => b.depth - a.depth)
  for (const item of sorted) {
    if (!isMeaningful(item.text)) continue
    const depth = Math.max(0, Math.min(Number(item.depth) || 0, result.length))
    const index = Math.max(0, result.length - depth)
    result.splice(index, 0, {
      role: item.role === 'user' ? 'user' : (item.role === 'assistant' ? 'assistant' : 'system'),
      content: item.text,
      name: '',
      injected: true,
      depth,
    })
  }
  return result
}

/**
 * 装配一次完整提示词。
 *
 * 流程：读角色/会话 → 世界书扫描（含递归、概率、分组、预算）→ 宏展开 → 正则清洗
 * → 按 PromptManager 顺序拼块 → @depth 与作者注释插进历史 → 预算裁剪。
 *
 * @param {Object} state 插件状态
 * @param {Record<string, any>|null} chat 聊天对象（ChatSession）
 * @param {Record<string, any>|null} character 角色卡；省略时按会话绑定读盘
 * @param {Object} [options] 装配选项
 * @param {string} [options.sessionId]           会话 id，省略时取 chat.id / 活跃会话
 * @param {string} [options.persona]             persona 名字覆盖
 * @param {string} [options.personaDescription]  persona 描述覆盖
 * @param {string[]} [options.worldbooks]        显式指定世界书（省略用会话绑定/全局启用）
 * @param {number} [options.scanDepth=4]         世界书扫描深度
 * @param {number} [options.budget]              世界书 token 预算（省略用 config.worldInfoBudget）
 * @param {number} [options.maxRecursionDepth=3] 世界书递归层数
 * @param {number} [options.maxHistoryMessages]  历史条数上限（省略用 config.maxHistoryMessages）
 * @param {number} [options.historyBudget]       历史 token 预算（0 表示不限）
 * @param {string} [options.trigger='normal']    生成类型（normal / continue / regenerate）
 * @param {boolean} [options.includeHistory=true] 是否返回 history
 * @param {Date} [options.now]                   当前时间（测试注入）
 * @param {boolean} [options.dryRun=true]        是否干跑。true 时世界书的 sticky / cooldown / delay
 *        一律不写 chat.metadata，也不落盘；false 时按 ST 规则记录并按需写回会话文件。
 *        真实生成路径必须传 false，试跑与查询保持默认。
 * @returns {{ systemPrompt: string, history: Record<string, any>[], diagnostics: Record<string, any> }}
 *          装配结果
 * @throws {Error} state 缺少必要目录时抛出
 */
export function assemblePrompt(state, chat, character, options = {}) {
  if (!state || !state.layout) throw new Error('assemblePrompt 需要插件状态')
  const opts = options && typeof options === 'object' ? options : {}
  const sessionId = str(opts.sessionId) || (chat && chat.id) || (state.data && state.data.activeSession) || 'default'
  // 绑定读不到（state.data 结构不完整）时退回空绑定，装配不能因此整轮失败
  let binding = {}
  try {
    binding = getBinding(state, sessionId) || {}
  } catch {
    binding = {}
  }
  const card = resolveCharacter(state, chat, character, binding)
  const resolvedPersona = resolvePersona(state, sessionId, chat)
  const persona = {
    name: str(opts.persona) || resolvedPersona.name,
    description: str(opts.personaDescription) || resolvedPersona.description,
  }
  const charName = card ? str(card.name) : ''

  // —— 1. 正则脚本（全局表） ——
  let scripts = []
  try {
    scripts = regexStore(state).read()
  } catch {
    scripts = []
  }

  // —— 2. 宏环境 ——
  const historySource = chat && Array.isArray(chat.messages) ? chat.messages : []
  const macroEnv = createMacroEnv({
    user: persona.name,
    char: charName,
    persona: persona.description,
    description: card ? str(card.description) : '',
    personality: card ? str(card.personality) : '',
    scenario: card ? str(card.scenario) : '',
    charPrompt: card ? str(card.system_prompt) : '',
    charInstruction: card ? str(card.post_history_instructions) : '',
    mesExamples: card ? str(card.mes_example) : '',
    mesExamplesRaw: card ? str(card.mes_example) : '',
    charDepthPrompt: card ? str(resolveDepthPrompt(card) && resolveDepthPrompt(card).prompt) : '',
    creatorNotes: card ? str(card.creator_notes) : '',
    firstMessage: card ? str(card.first_mes) : '',
    alternateGreetings: card && Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [],
    version: card ? str(card.character_version) : '',
    messages: historySource.map(message => ({ role: message.role, content: message.content, name: message.name })),
    chatId: sessionId,
    variables: {
      local: (chat && chat.variables) || {},
      global: (state.data && state.data.worldVariables) || {},
    },
    now: opts.now,
    system: {
      model: '',
      maxPrompt: Number(state.config && state.config.worldInfoBudget) || 2048,
      maxContext: 8192,
      maxResponse: 1024,
      input: '',
      original: '',
      lastGenerationType: str(opts.trigger) || 'normal',
    },
  })
  const expand = value => expandMacros(str(value), macroEnv)

  // —— 3. 世界书扫描 ——
  const world = collectWorldEntries(state, sessionId, opts.worldbooks !== undefined ? opts.worldbooks : binding.worldbooks)
  const scanLines = buildScanLines(historySource, charName, persona.name)
  const authorNote = resolveAuthorNote(state, chat)
  const depthNote = resolveDepthPrompt(card)

  let scan = { before: [], after: [], atDepth: [], anTop: [], anBottom: [], activated: [], tokens: 0 }
  const dryRun = opts.dryRun !== false
  if (Object.keys(world.entries).length > 0) {
    // 定时效果（sticky / cooldown / delay）写在 chat.metadata.timedWorldInfo 上。
    // scanWorldInfo 是就地改写对象，所以这里先留一份快照：非 dryRun 且真有变化时
    // 才落盘，避免每一轮 step 都写一次聊天文件。
    const metadataBefore = dryRun || !chat || !chat.metadata ? null : JSON.stringify(chat.metadata.timedWorldInfo || null)
    try {
      scan = scanWorldInfo(world.entries, {
        chatLines: scanLines,
        scanDepth: Number.isFinite(Number(opts.scanDepth)) ? Number(opts.scanDepth) : (Number(state.config && state.config.maxWorldInfoDepth) || 4),
        budget: Number.isFinite(Number(opts.budget)) ? Number(opts.budget) : (Number(state.config && state.config.worldInfoBudget) || 0),
        maxRecursionDepth: Number.isFinite(Number(opts.maxRecursionDepth)) ? Number(opts.maxRecursionDepth) : 3,
        caseSensitive: false,
        matchWholeWords: false,
        trigger: str(opts.trigger) || 'normal',
        charName,
        userName: persona.name,
        personaDescription: persona.description,
        characterDescription: card ? str(card.description) : '',
        characterPersonality: card ? str(card.personality) : '',
        characterDepthPrompt: depthNote ? depthNote.prompt : '',
        scenario: card ? str(card.scenario) : '',
        creatorNotes: card ? str(card.creator_notes) : '',
        chatMetadata: chat && chat.metadata ? chat.metadata : {},
        dryRun,
      })
    } catch (error) {
      scan = { before: [], after: [], atDepth: [], anTop: [], anBottom: [], activated: [], tokens: 0 }
      opts.scanError = error && error.message ? error.message : String(error)
    }

    // 非 dryRun：定时效果有变化就写回聊天文件，否则 sticky/cooldown 下一轮就丢了
    if (metadataBefore !== null && chat && chat.id) {
      const metadataAfter = JSON.stringify((chat.metadata && chat.metadata.timedWorldInfo) || null)
      if (metadataAfter !== metadataBefore) {
        try {
          createChatStore(state).write(String(chat.id), chat)
        } catch (error) {
          // 写盘失败不能打断这一轮提示词装配，只是定时效果不生效
          opts.timedEffectsError = error && error.message ? error.message : String(error)
        }
      }
    }
  }

  // 世界书正文：先宏展开，再正则清洗
  const cleanWorld = (text, depth) => cleanWorldContent(expand(text), scripts, depth === undefined ? null : depth, expand)
  const worldBefore = scan.before.map(item => cleanWorld(item)).filter(isMeaningful).join('\n')
  const worldAfter = scan.after.map(item => cleanWorld(item)).filter(isMeaningful).join('\n')
  const anTop = scan.anTop.map(item => cleanWorld(item)).filter(isMeaningful).join('\n')
  const anBottom = scan.anBottom.map(item => cleanWorld(item)).filter(isMeaningful).join('\n')
  const worldAtDepth = scan.atDepth
    .map(item => ({ text: cleanWorld(item.text, item.depth), depth: item.depth, role: item.role }))
    .filter(item => isMeaningful(item.text))

  // —— 4. 按 PromptManager 顺序拼块 ——
  const preset = resolvePresetOrder(state, card ? str(card.id) : '')
  const override = identifier => (preset.overrides[identifier] !== undefined ? preset.overrides[identifier] : null)

  const selfName = charName || 'Character'
  const blockContent = {
    main: override('main') !== null ? override('main') : DEFAULT_MAIN_PROMPT,
    worldInfoBefore: worldBefore,
    personaDescription: persona.description,
    charDescription: card ? str(card.description) : '',
    charPersonality: card ? str(card.personality) : '',
    scenario: card ? str(card.scenario) : '',
    enhanceDefinitions: override('enhanceDefinitions') !== null ? override('enhanceDefinitions') : DEFAULT_ENHANCE,
    nsfw: override('nsfw') !== null ? override('nsfw') : '',
    worldInfoAfter: worldAfter,
    dialogueExamples: card ? str(card.mes_example) : '',
    chatHistory: '',
    jailbreak: override('jailbreak') !== null ? override('jailbreak') : (card ? str(card.post_history_instructions) : ''),
  }

  // 没有角色卡时不该硬塞 ST 的默认主提示词
  if (!card) blockContent.main = override('main') !== null ? override('main') : ''

  const sections = []
  const blockTokens = {}
  const enabledBlocks = []
  for (const item of preset.order) {
    const identifier = item.identifier
    if (!item.enabled) continue
    if (identifier === 'chatHistory') continue
    if (!(identifier in blockContent)) continue
    const text = expand(blockContent[identifier])
    // 正则只作用在聊天与世界书上；角色字段保持 ST 原样，不跑正则（与 ST 一致）
    if (!isMeaningful(text)) continue
    blockTokens[identifier] = estimateTokens(text)
    enabledBlocks.push(identifier)
    sections.push({ identifier, text: text.trim() })
  }

  // 作者注释：ANTop / ANBottom 包在原文两侧，与 ST 的 shouldWIAddPrompt 行为一致
  const noteParts = [anTop, authorNote.text, anBottom].filter(isMeaningful)
  const noteText = noteParts.join('\n')
  if (isMeaningful(noteText)) {
    blockTokens.authorNote = estimateTokens(noteText)
    enabledBlocks.push('authorNote')
  }

  // —— 5. 历史 ——
  const maxHistory = Number.isFinite(Number(opts.maxHistoryMessages))
    ? Math.max(0, Number(opts.maxHistoryMessages))
    : (Number(state.config && state.config.maxHistoryMessages) || 60)
  let history = normalizeHistory(historySource, opts)
  if (maxHistory > 0 && history.length > maxHistory) history = history.slice(history.length - maxHistory)

  // 历史消息也走一次正则（发给模型的版本）。depth 与 ST 同口径：最后一条为 0，往上递增。
  const historyLength = history.length
  history = history.map((message, index) => ({
    ...message,
    content: applyRegex(message.content, scripts,
      message.role === 'user' ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
      { prompt: true, markdown: false, depth: historyLength - index - 1, expand }),
  }))

  // 历史 token 预算
  const historyBudget = Number.isFinite(Number(opts.historyBudget)) ? Math.max(0, Number(opts.historyBudget)) : 0
  if (historyBudget > 0) {
    const kept = []
    let used = 0
    for (let i = history.length - 1; i >= 0; i--) {
      const cost = estimateTokens(history[i].content)
      if (kept.length > 0 && used + cost > historyBudget) break
      kept.unshift(history[i])
      used += cost
    }
    history = kept
  }

  // @depth：世界书深度条目、角色卡深度注释、作者注释
  const injections = worldAtDepth.slice()
  if (depthNote) injections.push({ text: expand(depthNote.prompt), depth: depthNote.depth, role: depthNote.role })
  if (isMeaningful(noteText)) injections.push({ text: expand(noteText), depth: authorNote.depth, role: authorNote.role })
  const historyWithDepth = injectAtDepth(history, injections)

  // —— 6. 系统提示词 ——
  // 分两段返回：
  //   bodyPrompt  = 按 PromptManager 顺序排好的正文块
  //   depthPrompt = 作者注释、角色卡 @depth 注释、@depth 世界书条目
  // DSH 的对话历史由宿主管理，插件没法在任意深度插话，所以 @depth 内容单独成段，
  // 由 registerAssembly 注册的分节排到系统提示词末尾（也就是最贴近对话的位置）。
  const bodyPrompt = joinBlocks(sections.map(section => section.text))
  const depthPrompt = joinDepthSection(worldAtDepth, depthNote, noteText, expand)
  const systemPrompt = joinBlocks([bodyPrompt, depthPrompt])

  const diagnostics = {
    sessionId,
    characterId: card ? str(card.id) : '',
    characterName: charName,
    persona: persona.name,
    preset: preset.presetName,
    blocks: enabledBlocks,
    blockTokens,
    systemTokens: estimateTokens(systemPrompt),
    historyCount: historyWithDepth.length,
    historyTokens: historyWithDepth.reduce((sum, message) => sum + estimateTokens(message.content), 0),
    worldbooks: world.names,
    worldActivated: scan.activated.length,
    worldTokens: scan.tokens,
    worldDetail: scan.activated.map(uid => {
      const source = world.index.get(uid)
      const entry = world.entries[String(uid)] || {}
      return {
        uid: source ? source.uid : uid,
        book: source ? source.book : '',
        comment: str(entry.comment),
        position: entry.position,
        depth: entry.depth,
      }
    }),
    regexScripts: scripts.length,
    injected: injections.length,
    ...(opts.scanError ? { scanError: opts.scanError } : {}),
  }

  return {
    systemPrompt,
    bodyPrompt,
    depthPrompt,
    history: opts.includeHistory === false ? [] : historyWithDepth,
    diagnostics,
  }
}

/**
 * 把 @depth 内容拼成系统提示词末尾的一段。
 *
 * DSH 的对话历史由宿主管理，插件无法在任意深度插话，所以这里把深度条目
 * 集中排在末尾，并标出原始深度，让模型知道它们的相对位置。
 *
 * @param {{text: string, depth: number, role: string}[]} worldAtDepth 世界书深度条目
 * @param {{prompt: string, depth: number, role: string}|null} depthNote 角色卡深度注释
 * @param {string} noteText 作者注释（含前后世界书）
 * @param {(value: string) => string} expand 宏展开函数
 * @returns {string} 拼接结果；没有任何内容时返回空串
 */
function joinDepthSection(worldAtDepth, depthNote, noteText, expand) {
  const parts = []
  if (isMeaningful(noteText)) parts.push(expand(noteText))
  if (depthNote) parts.push(expand(depthNote.prompt))
  for (const item of worldAtDepth) parts.push(item.text)
  return parts.filter(isMeaningful).join('\n\n')
}

/**
 * 列出提示词块清单（供 UI 与自检）。
 *
 * @param {Object} state 插件状态
 * @param {string} [characterId] 角色 id，用于取该角色在预设里的顺序
 * @returns {{ identifier: string, label: string, order: number, enabled: boolean }[]} 块清单
 */
export function listPromptBlocks(state, characterId) {
  const preset = resolvePresetOrder(state || {}, characterId || '')
  return preset.order.map((item, index) => ({
    identifier: item.identifier,
    label: PROMPT_LABELS[item.identifier] || item.identifier,
    order: index,
    enabled: Boolean(item.enabled),
  }))
}

/**
 * 把装配器挂到插件状态上，并注册「@depth 内容」的系统提示词分节。
 *
 * 分工：
 *  - lib/prompt/inject.js 注册主分节 `sillytavern:roleplay`，内容来自 lib/prompt/render.js；
 *  - 本函数只额外注册 `sillytavern:depth`，把作者注释、角色卡 @depth 注释、@depth 世界书
 *    条目排到系统提示词最末（order 比主分节大一点点），实现 ST 的「贴着对话插话」。
 *
 * 主分节的内容也由本文件的 assemblePrompt 产出：render.js 会调 state.promptRuntime.assemble。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文
 * @param {Object} state 插件状态
 * @returns {void}
 * @throws {Error} state 为空时抛出
 */
export function registerAssembly(ctx, state) {
  if (!state || typeof state !== 'object') throw new Error('registerAssembly 需要插件状态')

  state.promptRuntime = {
    /**
     * 渲染当前会话的角色扮演文本。
     *
     * 返回的 systemPrompt 只含正文块（main / 世界书 / 角色定义 / 示例 / 后置指令）：
     * @depth 内容由本文件另行注册的 `sillytavern:depth` 分节输出，
     * 若这里也带上，主分节与深度分节会各放一遍，模型看到两份一样的条目。
     *
     * @param {Object} input
     * @param {Object} [input.state] 插件状态（缺省用闭包里的）
     * @param {Record<string, any>|null} [input.character] 角色卡
     * @param {string} [input.persona] persona 名字
     * @param {string} [input.sessionId] 会话 id
     * @param {Object} [input.binding] 会话绑定
     * @param {boolean} [input.dryRun=true] 是否干跑。
     *        真实生成路径（agent 注入系统提示词那一轮）必须传 false，
     *        否则 sticky / cooldown / delay 永远不落盘、永远不生效；
     *        查询预览、试跑脚本一律保持默认 true，避免污染会话元数据。
     * @returns {{ systemPrompt: string, depthPrompt: string, diagnostics: Record<string, any> }} 装配结果
     */
    assemble(input) {
      const source = input && typeof input === 'object' ? input : {}
      const activeState = source.state || state
      const sessionId = str(source.sessionId) || (activeState.data && activeState.data.activeSession) || 'default'
      let chat = null
      try {
        chat = createChatStore(activeState).read(sessionId)
      } catch {
        chat = null
      }
      let binding = source.binding
      if (!binding) {
        try {
          binding = getBinding(activeState, sessionId)
        } catch {
          binding = {}
        }
      }
      const result = assemblePrompt(activeState, chat, source.character || null, {
        sessionId,
        persona: source.persona,
        worldbooks: binding.worldbooks,
        dryRun: source.dryRun !== false,
      })
      return {
        systemPrompt: result.bodyPrompt,
        depthPrompt: result.depthPrompt,
        diagnostics: result.diagnostics,
      }
    },
  }

  // 注册 @depth 分节。systemPrompt 服务不存在（headless / 自检环境）时静默跳过，
  // 主分节由 inject.js 负责，这里拿不到服务不影响装配器本身可用。
  const systemPrompt = ctx && typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  const baseOrder = Number(state.config && state.config.promptSectionOrder)
  const order = Number.isFinite(baseOrder) ? baseOrder + 10 : 6510

  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      const register = () => systemPrompt.section({
        name: 'sillytavern:depth',
        order,
        // 内容里可能有 {{...}} 字面量，交给 DSH 插值会报错，宏已在本模块展开
        interpolate: false,
        text() {
          try {
            const result = state.promptRuntime.assemble({ state, sessionId: currentSessionId() })
            return result.depthPrompt || ''
          } catch (error) {
            const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
            if (logger && typeof logger.warn === 'function') {
              logger.warn('[dsh-sillytavern] @depth 分节装配失败：' + (error && error.message ? error.message : String(error)))
            }
            return ''
          }
        },
      })
      const disposer = register()
      if (ctx && typeof ctx.effect === 'function') ctx.effect(() => () => disposer())
    } catch (error) {
      // 分节重名等情况不能拖垮插件加载：装配器已经挂好，只是没有这一节
      const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[dsh-sillytavern] 注册 @depth 分节失败：' + (error && error.message ? error.message : String(error)))
      }
    }
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (state.promptRuntime && state.promptRuntime.assemble) delete state.promptRuntime
    })
  }
}
