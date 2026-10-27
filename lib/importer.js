/**
 * 从 SillyTavern 安装目录导入数据。
 *
 * 只读 ST 的 data/default-user，把它搬成插件自己的布局，导入后 ST 那边完全不动。
 * 导入是幂等的：同名已存在默认跳过，不覆盖用户改过的卡。
 */
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { isPng, readCharacterText } from './st/png.js'
import { readJson, writeJson, safeName } from './store.js'

/**
 * 解析一张角色卡文件 → 规范化角色卡；不支持时返回 null。
 * PNG 卡抽出图片作为头像一起存。
 * @param {string} file
 * @returns {{ card: Object, avatarBuffer: Buffer|null }|null}
 */
export function parseCardFile(file) {
  const buffer = readFileSync(file)
  if (isPng(buffer)) {
    const text = readCharacterText(buffer)
    if (!text) return null
    let raw
    try { raw = JSON.parse(text) } catch { return null }
    return { card: normalizeCard(raw, basename(file, extname(file))), avatarBuffer: buffer }
  }
  // JSON 卡
  let raw
  try { raw = JSON.parse(buffer.toString('utf8')) } catch { return null }
  return { card: normalizeCard(raw, basename(file, extname(file))), avatarBuffer: null }
}

/**
 * 把 V1 平铺 / V2 / V3 角色卡统一成插件内部结构。
 * @param {Object} raw
 * @param {string} fallbackName
 * @returns {Object}
 */
export function normalizeCard(raw, fallbackName) {
  if (!raw || typeof raw !== 'object') throw new Error('角色卡不是对象')
  const spec = typeof raw.spec === 'string' ? raw.spec : ''
  const data = spec.startsWith('chara_card') && raw.data && typeof raw.data === 'object' ? raw.data : raw

  const card = {
    // ST 原生字段名，保持可直接导出
    name: String(data.name || raw.name || fallbackName || '未命名').trim(),
    description: String(data.description || raw.description || ''),
    personality: String(data.personality || raw.personality || ''),
    scenario: String(data.scenario || raw.scenario || ''),
    first_mes: String(data.first_mes || raw.first_mes || raw.greeting || ''),
    mes_example: String(data.mes_example || raw.mes_example || ''),
    creator_notes: String(data.creator_notes || raw.creatorcomment || raw.creator_notes || ''),
    system_prompt: String(data.system_prompt || raw.system_prompt || ''),
    post_history_instructions: String(data.post_history_instructions || raw.post_history_instructions || ''),
    alternate_greetings: toStrArray(data.alternate_greetings ?? raw.alternate_greetings),
    tags: toStrArray(data.tags ?? raw.tags),
    creator: String(data.creator || raw.creator || ''),
    character_version: String(data.character_version || raw.character_version || ''),
    extensions: data.extensions && typeof data.extensions === 'object' ? data.extensions : {},
    character_book: data.character_book || null,
    // 插件侧附加
    id: '',
    avatar: '',
    created_at: Date.now(),
    source: 'sillytavern',
  }
  card.id = makeCardId(card.name)
  return card
}

function toStrArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

/** 由名字生成稳定 id：保留中文，去掉路径非法字符。 */
export function makeCardId(name) {
  const base = safeName(String(name || 'card')).replace(/\s+/g, '_')
  return base || 'card'
}

/**
 * 导入一个目录下的全部角色卡。
 * @returns {{ imported: string[], skipped: string[], failed: { file: string, reason: string }[] }} 导入/跳过/失败的文件名
 */
export function importCharacters(state, dir, overwrite = false) {
  const result = { imported: [], skipped: [], failed: [] }
  if (!existsSync(dir)) return result
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isFile()) continue
    const ext = extname(name).toLowerCase()
    if (ext !== '.png' && ext !== '.json') continue

    let parsed
    try { parsed = parseCardFile(full) } catch (error) {
      result.failed.push({ file: name, reason: error && error.message ? error.message : String(error) })
      continue
    }
    if (!parsed) { result.failed.push({ file: name, reason: '不是有效的角色卡' }); continue }

    const card = parsed.card
    const target = join(state.layout.characters, safeName(card.id) + '.json')
    if (existsSync(target) && !overwrite) { result.skipped.push(name); continue }

    // 头像：PNG 卡把原图作为头像存下来
    if (parsed.avatarBuffer) {
      const avatarFile = safeName(card.id) + '.png'
      mkdirSync(state.layout.avatars, { recursive: true })
      writeFileSync(join(state.layout.avatars, avatarFile), parsed.avatarBuffer)
      card.avatar = avatarFile
    }

    writeJson(target, card)
    result.imported.push(name)
  }
  return result
}

/**
 * 导入世界书。ST 的 world 文件就是 { entries: { "0": {...} } }。
 * @returns {{ imported: string[], skipped: string[] }}
 */
export function importWorldbooks(state, dir, overwrite = false) {
  const result = { imported: [], skipped: [] }
  if (!existsSync(dir)) return result
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isFile() || extname(name).toLowerCase() !== '.json') continue

    const worldName = basename(name, extname(name))
    const target = join(state.layout.worlds, safeName(worldName) + '.json')
    if (existsSync(target) && !overwrite) { result.skipped.push(worldName); continue }

    const raw = readJson(full, null)
    if (!raw || typeof raw !== 'object' || !raw.entries) { result.skipped.push(worldName); continue }
    writeJson(target, { ...raw, name: raw.name || worldName })
    result.imported.push(worldName)
  }
  return result
}

/** 复制一个目录里的指定扩展名文件。 */
function copyFiles(srcDir, dstDir, predicate) {
  const result = { imported: [], skipped: [] }
  if (!existsSync(srcDir)) return result
  mkdirSync(dstDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const full = join(srcDir, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isFile() || !predicate(name)) continue
    const target = join(dstDir, name)
    if (existsSync(target)) { result.skipped.push(name); continue }
    writeFileSync(target, readFileSync(full))
    result.imported.push(name)
  }
  return result
}

/**
 * 全量导入：角色卡、世界书、预设、快速回复、人格、主题。
 * @param {Object} state
 * @param {string} stRoot SillyTavern 安装目录
 * @param {{ overwrite?: boolean }} [options]
 */
export async function importFromSillyTavern(state, stRoot, options = {}) {
  const overwrite = Boolean(options.overwrite)
  const root = String(stRoot || state.config.sillyTavernRoot || '').trim()
  if (!root) throw new Error('未配置 SillyTavern 安装目录')

  const dataRoot = join(root, 'data')
  const userDir = existsSync(join(dataRoot, 'default-user'))
    ? join(dataRoot, 'default-user')
    : (existsSync(dataRoot) && readdirSync(dataRoot).length > 0
      ? join(dataRoot, readdirSync(dataRoot).find(n => {
        try { return statSync(join(dataRoot, n)).isDirectory() } catch { return false }
      }) || 'default-user')
      : join(root, 'default-user'))

  if (!existsSync(userDir)) throw new Error('找不到 SillyTavern 用户数据目录：' + userDir)

  const characters = importCharacters(state, join(userDir, 'characters'), overwrite)
  const worlds = importWorldbooks(state, join(userDir, 'worlds'), overwrite)
  const presets = copyFiles(join(userDir, 'OpenAI Settings'), state.layout.presets, n => n.endsWith('.json'))
  const quickReplies = copyFiles(join(userDir, 'QuickReplies'), state.layout.quickReplies, n => n.endsWith('.json'))
  const personas = copyFiles(join(userDir, 'user'), state.layout.personas, n => n.endsWith('.json'))
  const regex = copyFiles(join(userDir, 'extensions', 'regex'), state.layout.regex, n => n.endsWith('.json'))
  const themes = copyFiles(join(userDir, 'themes'), join(state.layout.root, 'themes'), n => n.endsWith('.json'))

  state.invalidate('char:')
  state.invalidate('world:')

  return {
    source: userDir,
    characters: characters.imported.length,
    charactersSkipped: characters.skipped.length,
    charactersFailed: characters.failed,
    worlds: worlds.imported.length,
    worldsSkipped: worlds.skipped.length,
    presets: presets.imported.length,
    quickReplies: quickReplies.imported.length,
    personas: personas.imported.length,
    regex: regex.imported.length,
    themes: themes.imported.length,
  }
}

/**
 * 探测一个 ST 目录有哪些可导入内容（不写入）。
 * @param {string} stRoot
 */
export function probeSillyTavern(stRoot) {
  const root = String(stRoot || '').trim()
  if (!root) return { ok: false, reason: '未配置目录' }
  const dataRoot = join(root, 'data')
  const candidate = existsSync(join(dataRoot, 'default-user')) ? join(dataRoot, 'default-user') : null
  if (!candidate) return { ok: false, reason: '找不到 data/default-user' }
  const count = (sub, exts) => {
    const dir = join(candidate, sub)
    if (!existsSync(dir)) return 0
    return readdirSync(dir).filter(n => exts.some(e => n.toLowerCase().endsWith(e))).length
  }
  return {
    ok: true,
    root: candidate,
    characters: count('characters', ['.png', '.json']),
    worlds: count('worlds', ['.json']),
    presets: count('OpenAI Settings', ['.json']),
    quickReplies: count('QuickReplies', ['.json']),
    personas: count('user', ['.json']),
    themes: count('themes', ['.json']),
  }
}
