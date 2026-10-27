/**
 * SillyTavern 角色卡解析、规范化与导出。
 *
 * 支持三种历史格式，统一收敛成 V2 形状（见 CONTRACTS.md 的 CharacterCard）：
 *  - V1：字段平铺在顶层（name/description/first_mes…）
 *  - V2：{ spec: 'chara_card_v2', data: {...} }
 *  - V3：{ spec: 'chara_card_v3', data: {...} }，多出 nickname / source 等字段
 *
 * 未知字段一律原样保留：V2 的未知 data 字段进 extensions，顶层与整个原始对象
 * 也留了一份，保证 serializeCharacter 之后不丢信息。
 */
import { createHash } from 'node:crypto'
import { safeName } from '../store.js'
import { isPng, readCharacterFromPng, writeCharacterToPng } from './png.js'

/** V2 规范里的标准 data 字段；其余键都算未知字段。 */
const KNOWN_DATA_FIELDS = new Set([
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions',
  'alternate_greetings', 'group_only_greetings', 'tags', 'creator',
  'character_version', 'extensions', 'character_book', 'nickname', 'source',
  'creation_date', 'modification_date', 'creator_notes_multilingual',
  'avatar',
])

/** 由内容算出稳定短 id：同名不同卡也不会互相覆盖。 */
function hashId(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 10)
}

/** 任意值转字符串，null/undefined → ''。 */
function str(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

/** 任意值转字符串数组：数组原样过滤，单值包成数组，空 → []。 */
function strList(value) {
  if (Array.isArray(value)) return value.filter(v => v !== undefined && v !== null && String(v).trim() !== '').map(str)
  const text = str(value).trim()
  return text ? [text] : []
}

/** 深拷贝纯 JSON 数据；非 JSON 值退化成可序列化结果。 */
function cloneJson(value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

/**
 * 解析一段角色卡 JSON 文本。
 *
 * @param {string} rawText JSON 文本（可以是 BOM 开头）
 * @returns {Object} 尚未规范化的原始对象
 * @throws {Error} 文本为空、不是 JSON、或不是对象时抛出
 */
export function parseCharacterJson(rawText) {
  const text = str(rawText).replace(/^\uFEFF/, '').trim()
  if (!text) throw new Error('角色卡 JSON 为空')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error('角色卡 JSON 解析失败：' + (error && error.message ? error.message : String(error)))
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('角色卡 JSON 必须是对象')
  }
  return parsed
}

/**
 * 把 V1 / V2 / V3 形态统一成 CharacterCard。
 *
 * 未知字段不会丢：
 *  - V2/V3 的 data 里的非标准字段 → extensions
 *  - 原始对象整份 → card.raw，导出时按 V2 规则并回
 *  - 顶层 V1 遗留字段（talkativeness、fav、chat…）→ extensions 里同名键
 *
 * @param {Object} input 原始卡对象（或已规范化的卡，重复规范化是幂等的）
 * @param {string} [idHint] 期望的稳定 id；省略时由名字 + 内容散列生成
 * @returns {Object} CharacterCard
 * @throws {Error} 输入不是对象时抛出
 */
export function normalizeCharacter(input, idHint) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('角色卡必须是对象')
  }

  const source = input
  const data = source.data && typeof source.data === 'object' && !Array.isArray(source.data) ? source.data : null
  const spec = str(source.spec || (data && source.spec))

  // 顶层与 data 层逐字段回退：V2/V3 以 data 为准，V1 用顶层
  const pick = (field, fallback = '') => {
    if (data && data[field] !== undefined && data[field] !== null) return data[field]
    if (source[field] !== undefined && source[field] !== null) return source[field]
    return fallback
  }

  const name = str(pick('name')).trim()
  if (!name) throw new Error('角色卡缺少 name 字段')

  const extensions = {}
  const incomingExtensions = data && data.extensions && typeof data.extensions === 'object' ? data.extensions : null
  if (incomingExtensions) Object.assign(extensions, cloneJson(incomingExtensions))

  // ST 会放进 extensions 的那几个 V1 遗留字段。其余 V1 顶层字段（avatar / chat /
  // create_date / creatorcomment）由 serializeCharacter 直接写回顶层，不进 extensions，
  // 免得给导出结果添一堆无意义的扩展键。
  const legacyFields = ['talkativeness', 'fav', 'world', 'depth_prompt', 'depth_prompt_prompt',
    'depth_prompt_depth', 'depth_prompt_role']
  for (const field of legacyFields) {
    if (source[field] !== undefined && extensions[field] === undefined) extensions[field] = cloneJson(source[field])
  }

  // V2 data 里的非标准字段也并进 extensions，保证不丢
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (KNOWN_DATA_FIELDS.has(key)) continue
      if (extensions[key] === undefined) extensions[key] = cloneJson(value)
    }
  }

  const characterBook = pick('character_book', null)
  const card = {
    id: '',
    name,
    description: str(pick('description')),
    personality: str(pick('personality')),
    scenario: str(pick('scenario')),
    first_mes: str(pick('first_mes')),
    mes_example: str(pick('mes_example')),
    creator_notes: str(pick('creator_notes', source.creatorcomment)),
    system_prompt: str(pick('system_prompt')),
    post_history_instructions: str(pick('post_history_instructions')),
    alternate_greetings: strList(pick('alternate_greetings', [])),
    group_only_greetings: strList(pick('group_only_greetings', [])),
    tags: strList(pick('tags', source.tags)),
    creator: str(pick('creator')),
    character_version: str(pick('character_version')),
    extensions,
    character_book: characterBook && typeof characterBook === 'object' ? cloneJson(characterBook) : null,
    // V3 才有的字段：保留下来，导出时按 V3 处理
    nickname: str(pick('nickname')),
    source: strList(pick('source', [])),
    creation_date: pick('creation_date', undefined),
    modification_date: pick('modification_date', undefined),
    creator_notes_multilingual: cloneJson(pick('creator_notes_multilingual', undefined)),
    avatar: '',
    spec: spec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2',
    spec_version: str(source.spec_version) || (spec === 'chara_card_v3' ? '3.0' : '2.0'),
    /** 原始对象：导出时按 V2 规则把未知顶层字段并回去。 */
    raw: cloneJson(source),
  }

  // id：显式给出优先，其次沿用已有 id，最后按「名字 + 关键内容」散列
  const hinted = str(idHint).trim() || str(source.id).trim()
  card.id = hinted ? safeName(hinted) : safeName(name, 'character') + '-' + hashId([name, card.description, card.first_mes, card.scenario].join('\u0000'))

  return card
}

/**
 * 解析一份角色卡文件内容（PNG 卡或 JSON 卡）。
 *
 * PNG 卡：从 tEXt 块里取 chara(V2) / ccv3(V3)，V3 优先；图本身作为头像返回。
 * JSON 卡：按文本解析，没有头像。
 *
 * @param {Buffer|Uint8Array|string} buffer 文件字节，或已经是字符串的 JSON
 * @param {string} [filenameHint] 文件名，用于在没有 name 时兜底、以及生成 id
 * @returns {{ card: Object, avatarPng: Buffer|null }}
 * @throws {Error} 既不是 PNG 也不是可解析的 JSON 时抛出
 */
export function parseCharacterBuffer(buffer, filenameHint) {
  const hintName = str(filenameHint).replace(/\.[^.]+$/, '').trim()
  const bytes = typeof buffer === 'string' ? Buffer.from(buffer, 'utf8') : Buffer.from(buffer)

  if (isPng(bytes)) {
    const text = readCharacterFromPng(bytes)
    if (!text) throw new Error('PNG 里没有角色卡数据（缺少 chara / ccv3 文本块）')
    // V3 优先，与 ST 的读取顺序一致
    const rawText = text.ccv3 || text.json
    const parsed = parseCharacterJson(rawText)
    const card = normalizeCharacter(parsed, hintName)
    if (!card.name && hintName) card.name = hintName
    return { card, avatarPng: bytes }
  }

  // 有些卡是「PNG 被截断」或带 BOM 的 JSON，先按文本试
  const asText = bytes.toString('utf8')
  const looksJson = /^[\uFEFF\s]*\{/.test(asText)
  if (!looksJson) {
    throw new Error('无法识别的角色卡格式：既不是 PNG，也不是 JSON 对象')
  }
  const parsed = parseCharacterJson(asText)
  return { card: normalizeCharacter(parsed, hintName || undefined), avatarPng: null }
}

/**
 * 按 ST V2 规范导出角色卡 JSON 文本（能被 SillyTavern 直接导入）。
 *
 * 输出结构：顶层保留 V2 的平铺镜像字段 + spec/spec_version + data 全量，
 * 以及原卡里 ST 不认识的顶层字段（原样带回来）。
 *
 * @param {Object} card normalizeCharacter 的结果
 * @returns {string} 带两空格缩进的 JSON 文本
 * @throws {Error} card 为空时抛出
 */
export function serializeCharacter(card) {
  if (!card || typeof card !== 'object') throw new Error('导出角色卡需要先规范化')
  const isV3 = card.spec === 'chara_card_v3'

  const extensions = cloneJson(card.extensions || {})
  const data = {
    name: card.name || '',
    description: card.description || '',
    personality: card.personality || '',
    scenario: card.scenario || '',
    first_mes: card.first_mes || '',
    mes_example: card.mes_example || '',
    creator_notes: card.creator_notes || '',
    system_prompt: card.system_prompt || '',
    post_history_instructions: card.post_history_instructions || '',
    alternate_greetings: Array.isArray(card.alternate_greetings) ? card.alternate_greetings.slice() : [],
    tags: Array.isArray(card.tags) ? card.tags.slice() : [],
    creator: card.creator || '',
    character_version: card.character_version || '',
    extensions,
  }

  if (Array.isArray(card.group_only_greetings) && card.group_only_greetings.length) {
    data.group_only_greetings = card.group_only_greetings.slice()
  }
  if (card.character_book) data.character_book = cloneJson(card.character_book)
  if (card.creator_notes_multilingual) data.creator_notes_multilingual = cloneJson(card.creator_notes_multilingual)

  if (isV3) {
    if (card.nickname) data.nickname = card.nickname
    if (Array.isArray(card.source) && card.source.length) data.source = card.source.slice()
    if (card.creation_date !== undefined) data.creation_date = card.creation_date
    if (card.modification_date !== undefined) data.modification_date = card.modification_date
  }

  // 顶层镜像（ST 的 charaFormatData 写出来的形状）
  const raw = card.raw && typeof card.raw === 'object' ? cloneJson(card.raw) : {}
  delete raw.data
  delete raw.spec
  delete raw.spec_version
  delete raw.json_data

  const out = {
    ...raw,
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    creatorcomment: data.creator_notes,
    avatar: str(raw.avatar) || 'none',
    talkativeness: str(raw.talkativeness) || '0.5',
    fav: raw.fav === true || raw.fav === 'true',
    tags: data.tags,
    spec: isV3 ? 'chara_card_v3' : 'chara_card_v2',
    spec_version: isV3 ? '3.0' : '2.0',
    data,
  }

  return JSON.stringify(out, null, 2)
}

/**
 * 把角色卡写成 PNG（头像 + 内嵌 tEXt 数据）。
 *
 * 没有底图时返回 null——插件没有内置兜底图，调用方应改为只存 JSON。
 * 写入的是 ST 的 V2 规范：chara 块总是写，ccv3 块只在 V3 卡时写。
 *
 * @param {Object} card normalizeCharacter 的结果
 * @param {Buffer} [avatarPng] 头像 PNG 字节
 * @returns {Buffer|null} PNG 字节；没有头像图时 null
 * @throws {Error} 头像不是 PNG、或卡序列化失败时抛出
 */
export function buildCharacterPng(card, avatarPng) {
  if (!avatarPng || !avatarPng.length) return null
  const buffer = Buffer.from(avatarPng)
  if (!isPng(buffer)) throw new Error('头像不是 PNG，无法写入角色卡数据')

  const v2Text = serializeCharacter(card)
  const payload = { chara: v2Text }
  if (card.spec === 'chara_card_v3') {
    // ccv3 与 chara 内容一致，只改 spec 标记，避免 ST 读到两份不一致的数据
    const v3 = JSON.parse(v2Text)
    v3.spec = 'chara_card_v3'
    v3.spec_version = '3.0'
    payload.ccv3 = JSON.stringify(v3)
  }
  return writeCharacterToPng(buffer, payload)
}

/**
 * 把角色卡转成提示词块数组，顺序即 ST PromptManager 的默认顺序。
 *
 * 只输出「卡片本身提供的」内容，不做世界书扫描（那是 worldbook.js 的事），
 * 也不做宏展开（调用方用 macros.js）。空块会被跳过。
 *
 * identifier 用 ST 的原名，便于 UI 与预设对齐：
 * charDescription / charPersonality / scenario / personaDescription /
 * dialogueExamples / enhanceDefinitions / main / nsfw / jailbreak。
 *
 * @param {Object} card normalizeCharacter 的结果
 * @param {Object} [options]
 * @param {string} [options.persona]  用户 persona 描述
 * @param {string} [options.mainPrompt] 覆盖 main 块（默认用 ST 的默认主提示）
 * @param {string} [options.nsfwPrompt] 辅助提示（默认空，空块会被跳过）
 * @param {boolean} [options.enhanceDefinitions] 是否输出 enhanceDefinitions 块（默认 false）
 * @param {string} [options.jailbreak] 覆盖 jailbreak（默认取卡的 post_history_instructions）
 * @param {string} [options.dialogueExamples] 覆盖对话示例（默认取 mes_example）
 * @returns {{ identifier: string, text: string }[]} 非空块数组
 */
export function characterPromptBlocks(card, options = {}) {
  if (!card || typeof card !== 'object') return []
  const opts = options && typeof options === 'object' ? options : {}
  const name = str(card.name) || 'Character'
  const persona = str(opts.persona)

  const defaultMain = 'Write ' + name + "'s next reply in a fictional chat between " + name + ' and {{user}}.'
  const mainPrompt = opts.mainPrompt !== undefined ? str(opts.mainPrompt) : defaultMain
  const nsfwPrompt = str(opts.nsfwPrompt)
  const jailbreak = opts.jailbreak !== undefined ? str(opts.jailbreak) : str(card.post_history_instructions)
  const dialogueExamples = opts.dialogueExamples !== undefined ? str(opts.dialogueExamples) : str(card.mes_example)

  const enhance = opts.enhanceDefinitions === true
    ? "If you have more knowledge of " + name + ", add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute."
    : ''

  const blocks = [
    { identifier: 'main', text: mainPrompt },
    // worldInfoBefore / worldInfoAfter 由世界书扫描插入，不在这里
    { identifier: 'personaDescription', text: persona },
    { identifier: 'charDescription', text: str(card.description) },
    { identifier: 'charPersonality', text: str(card.personality) },
    { identifier: 'scenario', text: str(card.scenario) },
    { identifier: 'enhanceDefinitions', text: enhance },
    { identifier: 'nsfw', text: nsfwPrompt },
    { identifier: 'dialogueExamples', text: dialogueExamples },
    // chatHistory 由调用方插入
    { identifier: 'jailbreak', text: jailbreak },
  ]

  return blocks.filter(block => str(block.text).trim() !== '')
}
