/**
 * 预设 / 作者注释 / 正则脚本工具。
 *
 * 预设就是 SillyTavern 的 "OpenAI Settings" JSON：里面既有采样参数，也有
 * prompts 数组（每一段提示词的开关、角色、注入位置）和 prompt_order。
 * 我们原样保存、原样读回，只额外记录"当前用哪一份"。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { defineTool } from '../toolkit.js'
import { listJsonFiles, readJson, safeName, writeJson } from '../store.js'
import { nowIso, shortId, toList } from '../util.js'
import { createChatStore, loadEngine, regexStore, resolveSessionId } from './support.js'

/** 预设里可以整块替换的提示词段名（对应 ST prompt_order 里的 identifier）。 */
const PROMPT_IDENTIFIERS = [
  'main', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality',
  'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory', 'jailbreak',
  'enhanceDefinitions', 'nsfw',
]

/**
 * 预设仓库：<layout.presets>/<name>.json。文件名与 ST 的 "OpenAI Settings" 一致。
 * @param {Object} state 插件状态
 * @returns {Object} 仓库对象
 */
export function presetStore(state) {
  const dir = state.layout.presets
  return {
    dir,
    names() { return listJsonFiles(dir).map(item => item.name) },
    /**
     * 读一份预设。
     * @param {string} name 预设名
     * @returns {Record<string, any>|null} 不存在返回 null
     */
    read(name) { return readJson(join(dir, safeName(name, 'preset') + '.json')) },
    /**
     * 写一份预设（原样保存 ST 结构）。
     * @param {string} name 预设名
     * @param {Record<string, any>} value 预设内容
     * @returns {Record<string, any>} 落盘后的内容
     */
    write(name, value) {
      writeJson(join(dir, safeName(name, 'preset') + '.json'), value)
      return value
    },
    /**
     * 解析预设名（支持唯一子串）。
     * @param {string} query 名字或子串
     * @returns {string|null} 命中返回名字，无命中返回 null
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
      if (loose.length > 1) throw new Error('"' + text + '" 匹配到多份预设：' + loose.join('、') + '。请传完整名字。')
      return null
    },
  }
}

/**
 * 当前生效的预设名。
 * @param {Object} state 插件状态
 * @returns {string} 预设名，未设置时为空串
 */
export function activePresetName(state) {
  return (state.data.presets && state.data.presets.active) || ''
}

/**
 * 读当前生效预设的 prompts / prompt_order，供装配层使用。
 * @param {Object} state 插件状态
 * @returns {{ name: string, prompts: Array<Record<string, any>>, order: Array<Record<string, any>> }} 预设片段
 */
export function activePreset(state) {
  const name = activePresetName(state)
  if (!name) return { name: '', prompts: [], order: [] }
  const raw = presetStore(state).read(name)
  if (!raw) return { name: '', prompts: [], order: [] }
  return {
    name,
    prompts: Array.isArray(raw.prompts) ? raw.prompts : [],
    order: Array.isArray(raw.prompt_order) && raw.prompt_order[0] && Array.isArray(raw.prompt_order[0].order)
      ? raw.prompt_order[0].order
      : [],
  }
}

/**
 * 预设、作者注释、场景、正则脚本工具注册。
 * @param {Object} ctx Cordis 上下文
 * @param {Object} state 插件共享状态
 * @returns {void}
 */
export function registerPromptTools(ctx, state) {
  const presets = presetStore(state)
  const regex = regexStore(state)

  ctx.tools.register(defineTool({
    name: 'st_list_presets',
    description: '列出可用的 SillyTavern 预设（OpenAI Settings JSON），标出当前生效的那一份。',
    parameters: {
      query: { type: 'string', description: '按预设名做子串过滤' },
    },
    async execute(args) {
      const query = String(args.query || '').trim().toLowerCase()
      const active = activePresetName(state)
      const rows = []
      for (const name of presets.names()) {
        if (query && !name.toLowerCase().includes(query)) continue
        const raw = presets.read(name) || {}
        rows.push({
          name,
          active: name === active,
          prompts: Array.isArray(raw.prompts) ? raw.prompts.length : 0,
          model: String(raw.openai_model || raw.claude_model || raw.custom_model || ''),
          temperature: typeof raw.temperature === 'number' ? raw.temperature : null,
        })
      }
      return { total: rows.length, active, presets: rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_get_preset',
    description: '读一份预设的细节：采样参数、提示词段（prompts）与装配顺序（prompt_order）。不给名字时读当前生效的那份。',
    parameters: {
      name: { type: 'string', description: '预设名；省略则读当前生效的预设' },
      includePrompts: { type: 'boolean', description: '是否返回完整 prompts 正文，默认 true', default: true },
      promptIdentifier: { type: 'string', description: '只取某一段提示词，例如 main / jailbreak', enum: PROMPT_IDENTIFIERS },
    },
    async execute(args) {
      const name = args.name ? presets.resolve(args.name) : activePresetName(state)
      if (!name) throw new Error('没有指定预设，且当前没有生效的预设（可用 st_set_preset 设置）。')
      const raw = presets.read(name)
      if (!raw) throw new Error('预设 "' + name + '" 不存在。')
      if (args.promptIdentifier) {
        const prompts = Array.isArray(raw.prompts) ? raw.prompts : []
        const hit = prompts.find(item => item && item.identifier === args.promptIdentifier)
        if (!hit) throw new Error('预设 "' + name + '" 里没有标识符为 "' + args.promptIdentifier + '" 的提示词段')
        return { name, prompt: hit }
      }
      const summary = {
        name,
        active: name === activePresetName(state),
        temperature: raw.temperature,
        top_p: raw.top_p,
        presence_penalty: raw.presence_penalty,
        frequency_penalty: raw.frequency_penalty,
        openai_max_context: raw.openai_max_context,
        openai_max_tokens: raw.openai_max_tokens,
        model: raw.openai_model || raw.claude_model || raw.custom_model || '',
        promptOrder: Array.isArray(raw.prompt_order) && raw.prompt_order[0] ? raw.prompt_order[0].order || [] : [],
        promptCount: Array.isArray(raw.prompts) ? raw.prompts.length : 0,
      }
      if (args.includePrompts !== false) summary.prompts = Array.isArray(raw.prompts) ? raw.prompts : []
      return summary
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_set_preset',
    description: '导入 / 覆盖 / 切换预设。传 path 从磁盘 JSON 导入；传 name 且已存在则切换到它；两者都给则先导入再切换。',
    parameters: {
      path: { type: 'string', description: '预设 JSON 文件绝对路径' },
      name: { type: 'string', description: '预设名（导入时作为保存名；切换时作为目标名）' },
      activate: { type: 'boolean', description: '导入后是否设为当前生效预设，默认 true', default: true },
      order: { type: 'array', description: '可选：覆盖 prompt_order 的段顺序（identifier 数组）', items: { type: 'string' } },
    },
    async execute(args) {
      let target = args.name ? String(args.name).trim() : ''
      if (args.path) {
        const file = String(args.path).trim()
        if (!existsSync(file)) throw new Error('文件不存在：' + file)
        if (!statSync(file).isFile()) throw new Error('不是文件：' + file)
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        if (!raw || typeof raw !== 'object') throw new Error('预设文件内容不是 JSON 对象：' + file)
        target = target || basename(file, extname(file))
        presets.write(target, raw)
      }
      if (!target) throw new Error('必须给 path 或 name 其中之一')
      const resolved = presets.resolve(target) || target
      const raw = presets.read(resolved)
      if (!raw) throw new Error('预设 "' + resolved + '" 不存在，无法切换。可用 st_list_presets 查看。')
      if (Array.isArray(args.order) && args.order.length > 0) {
        raw.prompt_order = [{ character_id: 100001, order: args.order.map(identifier => ({ identifier, enabled: true })) }]
        presets.write(resolved, raw)
      }
      if (args.activate !== false) {
        state.data.presets = state.data.presets || {}
        state.data.presets.active = resolved
        state.save()
        if (state.invalidate) state.invalidate('preset')
      }
      return {
        saved: Boolean(args.path),
        active: activePresetName(state),
        name: resolved,
        prompts: Array.isArray(raw.prompts) ? raw.prompts.length : 0,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_set_author_note',
    description: '设置作者注释（Author\'s Note）：一段会按深度插进聊天历史的指令。也可查看当前设置；text 传空串表示清除。',
    parameters: {
      text: { type: 'string', description: '注释正文；空串表示清除' },
      depth: { type: 'number', description: '插在倒数第几条消息处，默认用配置值', minimum: 0, maximum: 100 },
      role: { type: 'string', description: '以谁的口吻插入', enum: ['system', 'user', 'assistant'], default: 'system' },
      sessionId: { type: 'string', description: '会话 id；给了就只对本会话生效，不给则改全局默认' },
      frequency: { type: 'number', description: '每隔 N 条消息插入一次，默认每轮（1）', minimum: 1, maximum: 100 },
    },
    async execute(args, exec) {
      const patch = {}
      if (args.text !== undefined) patch.text = String(args.text)
      if (args.depth !== undefined) patch.depth = Math.trunc(args.depth)
      if (args.role !== undefined) patch.role = args.role
      if (args.frequency !== undefined) patch.frequency = Math.trunc(args.frequency)
      const wantsSession = Boolean(args.sessionId)
      if (wantsSession) {
        const sessionId = resolveSessionId(state, args, exec)
        const chats = createChatStore(state)
        const chat = chats.ensure(sessionId)
        chat.metadata.authorNote = { ...(chat.metadata.authorNote || {}), ...patch, updatedAt: nowIso() }
        chats.write(sessionId, chat)
        return { scope: 'session', sessionId, authorNote: chat.metadata.authorNote }
      }
      state.data.authorNote = { ...(state.data.authorNote || {}), ...patch, updatedAt: nowIso() }
      if (state.data.authorNote.depth === undefined) state.data.authorNote.depth = state.config.authorNoteDepth
      state.save()
      return { scope: 'global', authorNote: state.data.authorNote }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_set_scene',
    description: '设置当前场景（跑团/剧情用）：地点、时间、氛围、在场角色。写入会话的 scene 字段，装配提示词与会话状态都会用到。',
    parameters: {
      location: { type: 'string', description: '地点' },
      time: { type: 'string', description: '故事内时间，例如"第三日黄昏"' },
      weather: { type: 'string', description: '天气/环境' },
      mood: { type: 'string', description: '氛围基调' },
      present: { type: 'array', description: '在场角色名数组', items: { type: 'string' } },
      notes: { type: 'string', description: '给 GM 的补充备注' },
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
      clear: { type: 'boolean', description: 'true=清空场景', default: false },
    },
    async execute(args, exec) {
      const sessionId = resolveSessionId(state, args, exec)
      const chats = createChatStore(state)
      const chat = chats.ensure(sessionId)
      if (args.clear) {
        chat.metadata.scene = null
        chats.write(sessionId, chat)
        return { sessionId, scene: null, cleared: true }
      }
      const prev = chat.metadata.scene || {}
      const scene = {
        location: args.location !== undefined ? String(args.location) : prev.location || '',
        time: args.time !== undefined ? String(args.time) : prev.time || '',
        weather: args.weather !== undefined ? String(args.weather) : prev.weather || '',
        mood: args.mood !== undefined ? String(args.mood) : prev.mood || '',
        present: Array.isArray(args.present) ? args.present.map(String) : prev.present || [],
        notes: args.notes !== undefined ? String(args.notes) : prev.notes || '',
        updatedAt: nowIso(),
      }
      chat.metadata.scene = scene
      chats.write(sessionId, chat)
      return { sessionId, scene }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_apply_regex',
    description: '管理 ST 正则脚本：action=list 列出，add 新增一条，remove 按名字或 id 删除，toggle 启用/停用。脚本按 ST 的 placement（1=用户输入 2=AI 输出 3=斜杠命令 5=世界书 6=显示）作用在对应文本上。',
    parameters: {
      action: { type: 'string', description: '要执行的操作', enum: ['list', 'add', 'remove', 'toggle'], default: 'list' },
      scriptName: { type: 'string', description: '脚本名（add 时必填；remove/toggle 时用来定位）' },
      id: { type: 'string', description: '脚本 id（remove/toggle 时可用，优先于 scriptName）' },
      findRegex: { type: 'string', description: '匹配正则，例如 /abc(\\s+)/g' },
      replaceString: { type: 'string', description: '替换文本，可用 $1 引用分组' },
      placement: { type: 'array', description: '作用位置数组，ST 值为 1/2/3/5/6', items: { type: 'number' } },
      disabled: { type: 'boolean', description: '是否停用，默认 false' },
      markdownOnly: { type: 'boolean', description: '只在显示时替换' },
      promptOnly: { type: 'boolean', description: '只在装配提示词时替换' },
      runOnEdit: { type: 'boolean', description: '编辑消息时也执行' },
      trimStrings: { type: 'array', description: '替换后要去掉的字符串', items: { type: 'string' } },
      substituteRegex: { type: 'number', description: 'ST 的宏替换模式：0=不替换 1=替换 2=替换并转义' },
      enabled: { type: 'boolean', description: 'toggle 时的目标状态' },
    },
    async execute(args) {
      const scripts = regex.read()
      const action = args.action || 'list'
      if (action === 'list') {
        return {
          total: scripts.length,
          scripts: scripts.map(script => ({
            id: script.id,
            scriptName: script.scriptName,
            disabled: Boolean(script.disabled),
            findRegex: script.findRegex,
            replaceString: script.replaceString,
            placement: toList(script.placement).map(Number),
            markdownOnly: Boolean(script.markdownOnly),
            promptOnly: Boolean(script.promptOnly),
          })),
        }
      }
      if (action === 'add') {
        const scriptName = String(args.scriptName || '').trim()
        if (!scriptName) throw new Error('add 必须给 scriptName')
        if (!args.findRegex) throw new Error('add 必须给 findRegex')
        const engine = await loadEngine('regex')
        const entry = {
          id: args.id || shortId('regex'),
          scriptName,
          findRegex: args.findRegex,
          replaceString: args.replaceString === undefined ? '' : String(args.replaceString),
          trimStrings: Array.isArray(args.trimStrings) ? args.trimStrings.map(String) : [],
          placement: Array.isArray(args.placement) && args.placement.length ? args.placement.map(Number) : [2],
          disabled: Boolean(args.disabled),
          markdownOnly: Boolean(args.markdownOnly),
          promptOnly: Boolean(args.promptOnly),
          runOnEdit: Boolean(args.runOnEdit),
          substituteRegex: args.substituteRegex === undefined ? 0 : Number(args.substituteRegex),
        }
        let next = scripts.concat([entry])
        if (typeof engine.normalizeRegexScripts === 'function') {
          next = await engine.normalizeRegexScripts(next)
        }
        regex.write(next)
        return { added: true, script: entry, total: next.length }
      }
      const key = String(args.id || args.scriptName || '').trim()
      if (!key) throw new Error(action + ' 必须给 id 或 scriptName')
      const index = scripts.findIndex(script => String(script.id || '') === key || String(script.scriptName || '') === key)
      if (index < 0) throw new Error('找不到正则脚本 "' + key + '"')
      if (action === 'remove') {
        const [removed] = scripts.splice(index, 1)
        regex.write(scripts)
        return { removed: true, script: removed, total: scripts.length }
      }
      const target = args.enabled !== undefined ? Boolean(args.enabled) : Boolean(scripts[index].disabled)
      scripts[index].disabled = !target
      regex.write(scripts)
      return { toggled: true, scriptName: scripts[index].scriptName, disabled: scripts[index].disabled, total: scripts.length }
    },
  }))
}
