/**
 * 世界书（World Info / Lorebook）工具。
 *
 * 全部按 ST 的语义工作：条目存 ST 原生字段，扫描走 lib/st/worldbook.js 的
 * scanWorldInfo（关键词递归、constant 常驻、position/depth 分槽、概率与预算裁剪），
 * 这里只负责把文件、会话上下文和参数喂进去，再把结果整理成模型能读的样子。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { defineTool } from '../toolkit.js'
import { activeWorldbookNames, bookEnabled, loadEngine, needExport, normalizeWorldbookEntry, resolveSessionId, scanWorldbooksForText, setBookEnabled, worldbookStore } from './support.js'

/** 世界书条目的可写字段（全部 ST 字段，中文说明）。 */
const ENTRY_FIELDS = {
  key: { type: 'array', description: '主关键词数组，命中任意一个即触发', items: { type: 'string' } },
  keysecondary: { type: 'array', description: '次关键词数组，配合 selectiveLogic 做组合判断', items: { type: 'string' } },
  content: { type: 'string', description: '条目正文，命中时插入提示词' },
  comment: { type: 'string', description: '条目标题/备注（给人看，不进提示词）' },
  constant: { type: 'boolean', description: '常驻条目：不看关键词，每轮都插入' },
  selective: { type: 'boolean', description: '是否启用主/次关键词的组合逻辑' },
  selectiveLogic: { type: 'number', description: '组合逻辑：0=AND_ANY(主命中且任一从命中) 1=NOT_ALL 2=NOT_ANY 3=AND_ALL' },
  order: { type: 'number', description: '插入排序，数字越小越靠前' },
  position: { type: 'number', description: '插入位置：0=角色定义前 1=角色定义后 2=作者注释顶 3=作者注释底 4=按深度插入聊天' },
  depth: { type: 'number', description: 'position=4 时的插入深度（往回数第几条消息）' },
  role: { type: 'number', description: '插入角色：0=system 1=user 2=assistant' },
  probability: { type: 'number', description: '触发概率百分比（useProbability=true 时生效）' },
  useProbability: { type: 'boolean', description: '是否启用概率触发' },
  disable: { type: 'boolean', description: '是否禁用该条目' },
  group: { type: 'string', description: '条目组名（同组只出一条）' },
  groupWeight: { type: 'number', description: '组内权重' },
  groupOverride: { type: 'boolean', description: '组内是否必选' },
  useGroupScoring: { type: 'boolean', description: '是否用组评分选择，null=继承全局' },
  scanDepth: { type: 'number', description: '扫描多少条历史消息，null=继承全局设置' },
  caseSensitive: { type: 'boolean', description: '是否区分大小写，null=继承全局' },
  matchWholeWords: { type: 'boolean', description: '是否整词匹配，null=继承全局' },
  excludeRecursion: { type: 'boolean', description: '不参与递归扫描' },
  preventRecursion: { type: 'boolean', description: '命中后不触发后续递归' },
  delayUntilRecursion: { type: 'boolean', description: '只在递归层级及以下才启用' },
  ignoreBudget: { type: 'boolean', description: '无视 token 预算强制插入' },
  sticky: { type: 'number', description: '命中后保持 N 轮仍生效' },
  cooldown: { type: 'number', description: '触发后冷却 N 轮' },
  delay: { type: 'number', description: '开局 N 条消息后才可能触发' },
  automationId: { type: 'string', description: '自动化 id，留空即可' },
}

/**
 * 只挑参数里真正出现过的条目字段。
 * @param {Record<string, any>} args 工具参数
 * @returns {Record<string, any>} 字段子集
 */
function pickEntryFields(args) {
  const out = {}
  for (const key of Object.keys(ENTRY_FIELDS)) {
    if (args[key] !== undefined && args[key] !== null) out[key] = args[key]
  }
  return out
}

/**
 * 给一本书分配下一个可用 uid（取最大值 +1，与 ST 的分配方式一致）。
 * @param {{ entries: Record<string, any> }} book 书
 * @returns {number} 新 uid
 */
function nextUid(book) {
  let max = -1
  for (const key of Object.keys(book.entries || {})) {
    const n = Number(key)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

/**
 * 世界书的列表、增删、条目管理与试扫描工具注册。
 * @param {Object} ctx Cordis 上下文
 * @param {Object} state 插件共享状态
 * @returns {void}
 */
export function registerWorldbookTools(ctx, state) {
  const books = worldbookStore(state)

  ctx.tools.register(defineTool({
    name: 'st_list_worldbooks',
    description: '列出本地世界书（Lorebook）：书名、条目数、是否启用、是否是当前会话生效的书。',
    parameters: {
      query: { type: 'string', description: '按书名做不区分大小写的子串过滤' },
      limit: { type: 'number', description: '最多返回几本，默认 100', default: 100, minimum: 1, maximum: 500 },
      sessionId: { type: 'string', description: '会话 id，用于标出本会话生效的书' },
    },
    async execute(args, exec) {
      const query = String(args.query || '').trim().toLowerCase()
      let sessionId = ''
      try { sessionId = resolveSessionId(state, args, exec) } catch { sessionId = '' }
      const active = sessionId ? activeWorldbookNames(state, sessionId) : []
      const rows = []
      for (const name of books.names()) {
        if (query && !name.toLowerCase().includes(query)) continue
        rows.push({
          name,
          entries: books.count(name),
          enabled: bookEnabled(state, name),
          activeInSession: active.includes(name),
        })
      }
      return { total: rows.length, worldbooks: rows.slice(0, args.limit || 100) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_get_worldbook',
    description: '读一本世界书的元信息与条目列表；给 entryUid 时返回该条目的全部 ST 字段。',
    parameters: {
      name: { type: 'string', description: '书名（支持唯一子串）', required: true },
      entryUid: { type: 'number', description: '条目 uid，给定时只返回这一条' },
      limit: { type: 'number', description: '不指定 entryUid 时最多列几条，默认 50', default: 50, minimum: 1, maximum: 500 },
      keyword: { type: 'string', description: '按关键词/标题/正文过滤条目' },
    },
    async execute(args) {
      const name = books.resolve(args.name)
      if (!name) throw new Error('找不到世界书 "' + args.name + '"。可用 st_list_worldbooks 查看。')
      const book = books.read(name)
      if (!book) throw new Error('世界书文件损坏或已被删除：' + name)
      if (args.entryUid !== undefined && args.entryUid !== null) {
        const entry = book.entries[String(args.entryUid)]
        if (!entry) throw new Error('世界书 "' + name + '" 里没有 uid=' + args.entryUid + ' 的条目')
        return { name, enabled: bookEnabled(state, name), entry }
      }
      const keyword = String(args.keyword || '').trim().toLowerCase()
      const rows = []
      for (const [key, entry] of Object.entries(book.entries)) {
        if (keyword) {
          const haystack = [entry.comment, entry.content, ...(entry.key || [])].join(' ').toLowerCase()
          if (!haystack.includes(keyword)) continue
        }
        rows.push({
          uid: Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : Number(key),
          comment: entry.comment,
          key: entry.key,
          constant: entry.constant,
          disable: entry.disable,
          position: entry.position,
          order: entry.order,
          depth: entry.depth,
          contentLength: String(entry.content || '').length,
        })
      }
      rows.sort((a, b) => a.order - b.order || a.uid - b.uid)
      return {
        name,
        enabled: bookEnabled(state, name),
        entryCount: Object.keys(book.entries).length,
        matched: rows.length,
        entries: rows.slice(0, args.limit || 50),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_create_worldbook',
    description: '新建一本空世界书（同名已存在时报错）。建好后用 st_add_worldbook_entry 加条目。',
    parameters: {
      name: { type: 'string', description: '书名', required: true },
      overwrite: { type: 'boolean', description: '已存在时是否覆盖，默认 false', default: false },
      enable: { type: 'boolean', description: '创建后是否立即启用，默认 true', default: true },
    },
    async execute(args) {
      const name = String(args.name || '').trim()
      if (!name) throw new Error('世界书名不能为空')
      if (books.has(name) && !args.overwrite) {
        throw new Error('世界书 "' + name + '" 已存在。需要覆盖请传 overwrite=true。')
      }
      books.write(name, { entries: {} })
      const enabled = args.enable !== false
      setBookEnabled(state, name, enabled)
      return { created: true, name, enabled, entries: 0 }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_import_worldbook',
    description: '从磁盘导入 SillyTavern 世界书 JSON（ST 导出的 .json 或 worlds/ 下的文件）。默认不覆盖同名书。',
    parameters: {
      path: { type: 'string', description: '世界书文件绝对路径', required: true },
      name: { type: 'string', description: '导入后的书名，默认用文件名' },
      overwrite: { type: 'boolean', description: '同名书已存在时是否覆盖，默认 false', default: false },
      enable: { type: 'boolean', description: '导入后是否启用，默认 false', default: false },
    },
    async execute(args) {
      const file = String(args.path || '').trim()
      if (!file) throw new Error('必须给 path')
      if (!existsSync(file)) throw new Error('文件不存在：' + file)
      if (!statSync(file).isFile()) throw new Error('不是文件：' + file)
      const name = String(args.name || basename(file, extname(file))).trim()
      if (!name) throw new Error('无法确定世界书名，请显式传 name')
      if (books.has(name) && !args.overwrite) {
        throw new Error('世界书 "' + name + '" 已存在。需要覆盖请传 overwrite=true。')
      }
      const engine = await loadEngine('worldbook')
      const normalize = needExport(engine, 'normalizeWorldbook', 'lib/st/worldbook.js')
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const normalized = await normalize(raw)
      const written = books.write(name, { entries: normalized.entries || {} })
      if (args.enable) setBookEnabled(state, name, true)
      return {
        imported: true,
        name,
        entries: Object.keys(written.entries).length,
        enabled: bookEnabled(state, name),
        source: file,
        overwritten: Boolean(args.overwrite),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_add_worldbook_entry',
    description: '往世界书里加一条条目，字段与 SillyTavern 一致（关键词、正文、常驻、位置、深度、概率、分组等）。默认追加，也可用 entryUid 修改已有条目。',
    parameters: {
      name: { type: 'string', description: '书名（支持唯一子串）', required: true },
      entryUid: { type: 'number', description: '要修改的条目 uid；省略则新建一条' },
      ...ENTRY_FIELDS,
    },
    async execute(args) {
      const name = books.resolve(args.name)
      if (!name) throw new Error('找不到世界书 "' + args.name + '"。')
      const book = books.read(name)
      if (!book) throw new Error('世界书文件损坏或已被删除：' + name)
      const fields = pickEntryFields(args)
      const editing = args.entryUid !== undefined && args.entryUid !== null
      const uid = editing ? Number(args.entryUid) : nextUid(book)
      if (editing && !book.entries[String(uid)]) {
        throw new Error('世界书 "' + name + '" 里没有 uid=' + uid + ' 的条目')
      }
      const base = editing ? book.entries[String(uid)] : {}
      const entry = normalizeWorldbookEntry({ ...base, ...fields }, uid)
      book.entries[String(uid)] = entry
      books.write(name, { entries: book.entries })
      const warnings = []
      if (!String(entry.content || '').trim()) warnings.push('条目正文为空，这条不会对模型产生任何作用')
      if (!entry.constant && entry.key.length === 0) warnings.push('既没有 key 也不是 constant，这条永远不会被激活')
      return { saved: true, name, uid, editing, entry, ...(warnings.length ? { warnings } : {}) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_toggle_worldbook',
    description: '启用/停用一本世界书；给 entryUid 时改为启用/停用该条目（条目的 disable 字段）。',
    parameters: {
      name: { type: 'string', description: '书名（支持唯一子串）', required: true },
      enabled: { type: 'boolean', description: 'true=启用，false=停用', required: true },
      entryUid: { type: 'number', description: '给定时操作单条条目而不是整本书' },
    },
    async execute(args) {
      const name = books.resolve(args.name)
      if (!name) throw new Error('找不到世界书 "' + args.name + '"。')
      if (args.entryUid !== undefined && args.entryUid !== null) {
        const book = books.read(name)
        if (!book) throw new Error('世界书文件损坏或已被删除：' + name)
        const entry = book.entries[String(args.entryUid)]
        if (!entry) throw new Error('世界书 "' + name + '" 里没有 uid=' + args.entryUid + ' 的条目')
        entry.disable = !args.enabled
        books.write(name, { entries: book.entries })
        return { name, entryUid: Number(args.entryUid), entryDisabled: entry.disable, enabled: args.enabled }
      }
      const result = setBookEnabled(state, name, args.enabled)
      return { name: result.name, enabled: result.enabled, scope: 'book' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_scan_worldbook',
    description: '用给定聊天文本试跑一次世界书扫描，返回会被激活的条目与插入位置。不传 chatText 时用当前会话最近的聊天记录。',
    parameters: {
      chatText: { type: 'string', description: '用来试扫描的聊天文本（多条用换行分隔）；省略则读当前会话' },
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
      books: { type: 'array', description: '只扫这几本书（书名）；省略则扫当前会话生效的世界书', items: { type: 'string' } },
      scanDepth: { type: 'number', description: '扫描最近多少条消息，默认用配置值', minimum: 1, maximum: 100 },
      budget: { type: 'number', description: 'token 预算，默认用配置值', minimum: 0 },
      maxRecursionDepth: { type: 'number', description: '递归扫描最大层数，默认 3', minimum: 0, maximum: 20 },
    },
    async execute(args, exec) {
      let sessionId = ''
      try { sessionId = resolveSessionId(state, args, exec) } catch { sessionId = '' }

      let names = []
      if (Array.isArray(args.books) && args.books.length > 0) {
        names = args.books.map(value => {
          const resolved = books.resolve(value)
          if (!resolved) throw new Error('找不到世界书 "' + value + '"')
          return resolved
        })
      } else if (sessionId) {
        names = activeWorldbookNames(state, sessionId)
      }
      if (names.length === 0) {
        return {
          activated: [], tokens: 0, before: [], after: [], atDepth: [], anTop: [], anBottom: [],
          scannedBooks: [], scannedMessages: 0,
          note: '当前没有生效的世界书：先用 st_toggle_worldbook 启用，或给 books 参数指定。',
        }
      }
      return scanWorldbooksForText(state, {
        names,
        text: args.chatText,
        sessionId,
        scanDepth: args.scanDepth,
        budget: args.budget,
        maxRecursionDepth: args.maxRecursionDepth,
      })
    },
  }))
}
