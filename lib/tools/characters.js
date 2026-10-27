/**
 * 角色卡工具。
 *
 * ST 的角色卡本体是一个 JSON 对象（V2 spec），PNG 卡只是把这段 JSON 塞进了
 * tEXt "chara" 块。插件落盘时统一存 JSON、单独抽头像 PNG，读写都不会丢字段。
 *
 * 工具命名一律 st_ 前缀；名字里有中文是给模型看的说明，不做本地化以外的加工。
 */
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { defineTool } from '../toolkit.js'
import { avatarUrlOf, bindCharacterToSession, characterStore, loadEngine, needExport, normalizeCardShape, resolveSessionId, touchCharacterUsage, worldbookStore } from './support.js'

/** 可编辑的卡片字段与中文说明，create/edit 两个工具共用。 */
const CARD_FIELDS = {
  name: { type: 'string', description: '角色名' },
  description: { type: 'string', description: '角色描述（外貌、身份、背景）' },
  personality: { type: 'string', description: '性格概述' },
  scenario: { type: 'string', description: '场景设定' },
  first_mes: { type: 'string', description: '开场白（角色说的第一句）' },
  mes_example: { type: 'string', description: '对话示例，ST 用 <START> 分隔' },
  creator_notes: { type: 'string', description: '作者备注（不给模型看）' },
  system_prompt: { type: 'string', description: '角色自己的 system prompt，覆盖全局主提示' },
  post_history_instructions: { type: 'string', description: '越狱/后置指令（ST 的 Post-History Instructions）' },
  alternate_greetings: { type: 'array', description: '备选开场白数组', items: { type: 'string' } },
  tags: { type: 'array', description: '标签数组', items: { type: 'string' } },
  creator: { type: 'string', description: '作者名' },
  character_version: { type: 'string', description: '版本号' },
}

/**
 * 从参数里挑出"这次真的要写"的卡片字段。
 * 只挑参数里出现过的键，避免局部编辑把没传的字段清空。
 * @param {Record<string, any>} args 工具参数
 * @returns {Record<string, any>} 只含定义字段的子集
 */
function pickCardFields(args) {
  const out = {}
  for (const key of Object.keys(CARD_FIELDS)) {
    if (args[key] !== undefined && args[key] !== null) out[key] = args[key]
  }
  return out
}

/**
 * 把一张卡渲染成工具返回的形态：卡片本身 + 头像 URL + 是否已绑定。
 * @param {Object} state 插件状态
 * @param {Record<string, any>} card 卡片
 * @param {string} [sessionId] 会话 id（用于回显绑定关系）
 * @returns {Record<string, any>} 返回给模型的对象
 */
function presentCard(state, card, sessionId) {
  const store = characterStore(state)
  const bound = sessionId && state.data.sessions && state.data.sessions[sessionId]
    ? state.data.sessions[sessionId].characterId || ''
    : ''
  return {
    ...card,
    avatarUrl: store.hasAvatar(card) ? avatarUrlOf(card) : '',
    hasAvatar: store.hasAvatar(card),
    boundToThisSession: Boolean(sessionId) && bound === card.id,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  }
}

/**
 * 角色卡的增删改查与绑定工具注册。
 * @param {Object} ctx Cordis 上下文（需要 ctx.tools.register）
 * @param {Object} state 插件共享状态
 * @returns {void}
 */
export function registerCharacterTools(ctx, state) {
  const store = characterStore(state)

  ctx.tools.register(defineTool({
    name: 'st_list_characters',
    description: '列出本地酒馆角色卡。可按名字/标签/作者过滤，返回 id、名字、头像 URL、标签与最后使用时间。',
    parameters: {
      query: { type: 'string', description: '按名字/标签/作者做不区分大小写的子串过滤' },
      limit: { type: 'number', description: '最多返回几张，默认 50', default: 50, minimum: 1, maximum: 500 },
    },
    async execute(args) {
      const rows = []
      const usage = state.data.characterUsage || {}
      const query = String(args.query || '').trim().toLowerCase()
      const limit = args.limit || 50
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
          tags: card.tags,
          creator: card.creator,
          avatar: card.avatar,
          hasAvatar: store.hasAvatar(card),
          avatarUrl: store.hasAvatar(card) ? avatarUrlOf(card) : '',
          hasCharacterBook: Boolean(card.character_book),
          alternateGreetings: card.alternate_greetings.length,
          lastUsedAt: usage[card.id] ? new Date(usage[card.id]).toISOString() : '',
          updatedAt: card.updatedAt,
        })
      }
      rows.sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)) || a.name.localeCompare(b.name))
      return { total: rows.length, characters: rows.slice(0, limit) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_get_character',
    description: '读一张角色卡的完整字段（含描述/性格/场景/开场白/对话示例/备选开场白/内嵌世界书/扩展字段）与头像地址。',
    parameters: {
      character: { type: 'string', description: '角色 id 或名字（也接受唯一子串）', required: true },
      sessionId: { type: 'string', description: '会话 id，用于回显它是否绑定在本会话' },
    },
    async execute(args, exec) {
      const id = store.resolve(args.character)
      if (!id) throw new Error('找不到角色卡 "' + args.character + '"。可用 st_list_characters 查看现有角色。')
      const card = store.read(id)
      if (!card) throw new Error('角色卡文件损坏或已被删除：' + id)
      let sessionId = ''
      try { sessionId = resolveSessionId(state, args, exec) } catch { sessionId = '' }
      return presentCard(state, card, sessionId)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_create_character',
    description: '从零创建一张角色卡。至少给名字，其余字段可后补；创建后可用 st_bind_character 绑定到当前会话。',
    parameters: {
      ...CARD_FIELDS,
      name: { ...CARD_FIELDS.name, required: true },
    },
    async execute(args) {
      const name = String(args.name || '').trim()
      if (!name) throw new Error('创建角色卡必须给 name')
      const id = store.nextId(name)
      const fields = pickCardFields(args)
      const card = store.write(id, normalizeCardShape({ ...fields, name }, id))
      return { created: true, id: card.id, character: presentCard(state, card) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_edit_character',
    description: '局部修改角色卡字段：只改传入的字段，没传的保持原样。可改名、改描述、换开场白、加备选开场白等。',
    parameters: {
      character: { type: 'string', description: '要改的角色 id 或名字', required: true },
      ...CARD_FIELDS,
    },
    async execute(args) {
      const id = store.resolve(args.character)
      if (!id) throw new Error('找不到角色卡 "' + args.character + '"。')
      const current = store.read(id)
      if (!current) throw new Error('角色卡文件损坏或已被删除：' + id)
      const patch = pickCardFields(args)
      if (Object.keys(patch).length === 0) {
        return { changed: false, reason: '没有传入任何可编辑字段', character: presentCard(state, current) }
      }
      const card = store.write(id, { ...current, ...patch })
      return { changed: true, id, changedFields: Object.keys(patch), character: presentCard(state, card) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_import_character',
    description: '从磁盘文件导入 SillyTavern 角色卡（PNG 卡或 JSON 卡）。PNG 卡会自动抽出头像。默认不覆盖同名卡。',
    parameters: {
      path: { type: 'string', description: '角色卡文件绝对路径（.png 或 .json）', required: true },
      overwrite: { type: 'boolean', description: '同名卡已存在时是否覆盖，默认 false', default: false },
      import_character_book: { type: 'boolean', description: '卡里内嵌的世界书是否一并导入成独立世界书，默认 true', default: true },
    },
    async execute(args) {
      const file = String(args.path || '').trim()
      if (!file) throw new Error('必须给 path')
      if (!existsSync(file)) throw new Error('文件不存在：' + file)
      if (!statSync(file).isFile()) throw new Error('不是文件：' + file)
      const engine = await loadEngine('character')
      const parse = needExport(engine, 'parseCharacterBuffer', 'lib/st/character.js')
      const buffer = readFileSync(file)
      const parsed = await parse(buffer, basename(file))
      if (!parsed || !parsed.card) throw new Error('角色卡解析失败：' + file)
      const card = normalizeCardShape(parsed.card, '')
      const name = String(card.name || basename(file, extname(file))).trim()
      const existingId = store.resolve(name)
      if (existingId && !args.overwrite) {
        throw new Error('已存在同名角色卡 "' + name + '"（id=' + existingId + '）。需要覆盖请传 overwrite=true。')
      }
      // 引擎按「名字 + 关键内容」散列出 id，同名不同内容的卡能共存；撞了才追加序号。
      const id = existingId || store.idFor(parsed.card && parsed.card.id, name)
      card.name = name
      if (parsed.avatarPng) {
        card.avatar = store.writeAvatar(id, parsed.avatarPng, '.png')
      } else {
        // 没有图的卡（JSON 卡、或被剥掉 tEXt 的卡）不能把已有头像清掉：
        // 覆盖导入时必须保留原头像，否则角色列表会突然全变成无头像。
        const previous = store.read(id)
        card.avatar = (previous && previous.avatar) || card.avatar || ''
      }
      const saved = store.write(id, card)

      let importedBook = ''
      if (args.import_character_book !== false && saved.character_book && saved.character_book.entries) {
        const books = worldbookStore(state)
        const bookName = books.has(name) ? name + ' - 内嵌世界书' : name
        if (!books.has(bookName) || args.overwrite) {
          const entries = {}
          const rawEntries = saved.character_book.entries
          const list = Array.isArray(rawEntries) ? rawEntries : Object.values(rawEntries || {})
          list.forEach((entry, index) => {
            if (!entry || typeof entry !== 'object') return
            entries[String(index)] = { ...entry, uid: index }
          })
          if (Object.keys(entries).length > 0) {
            books.write(bookName, { entries })
            importedBook = bookName
          }
        }
      }
      return {
        imported: true,
        source: file,
        id: saved.id,
        character: presentCard(state, saved),
        importedWorldbook: importedBook,
        overwritten: Boolean(existingId),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_export_character',
    description: '把角色卡导出成 SillyTavern 能直接导入的文件：默认导出 PNG 卡（带 tEXt chara 块），也可导出 V2 JSON。返回写入的绝对路径。',
    parameters: {
      character: { type: 'string', description: '角色 id 或名字', required: true },
      format: { type: 'string', description: '导出格式', enum: ['png', 'json'], default: 'png' },
      fileName: { type: 'string', description: '输出文件名（不含扩展名），默认用角色名' },
    },
    async execute(args) {
      const id = store.resolve(args.character)
      if (!id) throw new Error('找不到角色卡 "' + args.character + '"。')
      const card = store.read(id)
      if (!card) throw new Error('角色卡文件损坏或已被删除：' + id)
      const outDir = join(state.layout.root, 'exports')
      mkdirSync(outDir, { recursive: true })
      const base = String(args.fileName || card.name || id).trim() || id
      const format = args.format === 'json' ? 'json' : 'png'
      const engine = await loadEngine('character')

      if (format === 'json') {
        const serialize = needExport(engine, 'serializeCharacter', 'lib/st/character.js')
        const text = serialize(card)
        const target = join(outDir, base.replace(/[<>:"/\\|?*]/g, '_') + '.json')
        writeFileSync(target, text, 'utf8')
        return { exported: true, format: 'json', path: target, bytes: Buffer.byteLength(text) }
      }

      const build = needExport(engine, 'buildCharacterPng', 'lib/st/character.js')
      const avatar = store.hasAvatar(card) ? store.readAvatar(card.avatar) : null
      const buffer = avatar ? await build(card, avatar) : null
      const safeBase = base.replace(/[<>:"/\\|?*]/g, '_')
      if (!buffer || !buffer.length) {
        // 没有头像图就没有 PNG 底图可写。与其报错，不如把能用的 JSON 卡导出去并说明原因。
        const serialize = needExport(engine, 'serializeCharacter', 'lib/st/character.js')
        const text = serialize(card)
        const target = join(outDir, safeBase + '.json')
        writeFileSync(target, text, 'utf8')
        return {
          exported: true,
          format: 'json',
          requestedFormat: 'png',
          path: target,
          bytes: Buffer.byteLength(text),
          note: '这张卡没有头像图片，PNG 卡需要一张底图；已改为导出 ST V2 JSON（同样能直接被 ST 导入）。先用 st_import_character 导入带图的 PNG 卡，或给卡补一张头像，就能导出 PNG。',
        }
      }
      const target = join(outDir, safeBase + '.png')
      writeFileSync(target, buffer)
      return { exported: true, format: 'png', path: target, bytes: buffer.length, usedAvatar: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_bind_character',
    description: '把角色卡绑定到当前会话（写入会话绑定，并记为最近使用角色）。之后装配提示词与聊天都以这张卡为准。',
    parameters: {
      character: { type: 'string', description: '角色 id 或名字', required: true },
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
      persona: { type: 'string', description: '本会话使用的用户角色名（ST 的 persona），可选' },
      worldbooks: { type: 'array', description: '本会话要启用的世界书名（省略则用全局启用的世界书）', items: { type: 'string' } },
    },
    async execute(args, exec) {
      const id = store.resolve(args.character)
      if (!id) throw new Error('找不到角色卡 "' + args.character + '"。')
      const card = store.read(id)
      if (!card) throw new Error('角色卡文件损坏或已被删除：' + id)
      const sessionId = resolveSessionId(state, args, exec)
      const result = bindCharacterToSession(state, sessionId, id)
      const patch = {}
      if (args.persona !== undefined) patch.persona = String(args.persona)
      if (Array.isArray(args.worldbooks)) patch.worldbooks = args.worldbooks.map(name => String(name))
      if (Object.keys(patch).length > 0) {
        state.data.sessions[sessionId] = { ...state.data.sessions[sessionId], ...patch }
        state.save()
      }
      touchCharacterUsage(state, id)
      state.save()
      return {
        bound: true,
        sessionId: result.sessionId,
        characterId: id,
        characterName: card.name,
        avatarUrl: store.hasAvatar(card) ? avatarUrlOf(card) : '',
        persona: args.persona !== undefined ? String(args.persona) : (state.data.sessions[sessionId].persona || ''),
        worldbooks: Array.isArray(args.worldbooks) ? args.worldbooks : [],
        firstMes: card.first_mes ? String(card.first_mes).slice(0, 200) : '',
      }
    },
  }))
}
