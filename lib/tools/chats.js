/**
 * 聊天 / 会话工具。
 *
 * 一场对话 = 一个 DSH 会话（sessionId）在 <layout.chats>/ 下的一个 ChatSession 文件。
 * 消息结构与 ST 一致（role/name/content/time/swipes/swipeIndex/extra），
 * 因此能原样导出成 ST 的 JSONL 聊天记录。
 *
 * swipe / 重生成 / 导出的核心逻辑都在 lib/tools/support.js 里，HTTP 路由复用同一份，
 * 保证"模型调工具"和"前端点按钮"看到的行为完全一致。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '../toolkit.js'
import { safeName } from '../store.js'
import { estimateTokens, nowIso } from '../util.js'
import {
  avatarUrlOf, characterStore, createChatStore, regenerateLastReply, resolveSessionId,
  stExtraOf, swipeMessage, touchSession,
} from './support.js'

/**
 * 把 ChatSession 转成 ST 能直接导入的 JSONL 文本。
 * 首行是聊天元信息头，之后每行一条消息 —— 与 ST 的 chats/<角色>/xxx.jsonl 完全一致。
 * @param {Record<string, any>} chat ChatSession
 * @param {Record<string, any>} [card] 绑定的角色卡（用于写角色名）
 * @returns {string} JSONL 文本
 */
export function chatToStJsonl(chat, card) {
  const header = {
    chat_metadata: chat.metadata && typeof chat.metadata === 'object' ? { ...chat.metadata } : {},
    user_name: chat.persona || 'User',
    character_name: (card && card.name) || chat.title || chat.characterId || '',
  }
  // 场景是我们自己的扩展，ST 读不懂，导出时剔掉
  delete header.chat_metadata.scene
  const lines = [JSON.stringify(header)]
  for (const message of chat.messages || []) {
    const row = {
      name: message.name || (message.role === 'user' ? header.user_name : header.character_name),
      is_user: message.role === 'user',
      is_system: message.role === 'system',
      send_date: new Date(Number(message.time) || Date.now()).toISOString(),
      mes: message.content,
      extra: stExtraOf(message),
    }
    lines.push(JSON.stringify(row))
  }
  return lines.join('\n') + '\n'
}

/**
 * 会话状态、swipe、重生成、persona、导出、变量工具注册。
 * @param {Object} ctx Cordis 上下文
 * @param {Object} state 插件共享状态
 * @returns {void}
 */
export function registerChatTools(ctx, state) {
  const chats = createChatStore(state)
  const cards = characterStore(state)

  ctx.tools.register(defineTool({
    name: 'st_get_chat_state',
    description: '读当前会话的酒馆状态：绑定的角色卡、persona、消息条数、最近几条消息、世界书、场景、变量、作者注释与 token 估算。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
      messageLimit: { type: 'number', description: '返回最近几条消息，默认 20', default: 20 },
    },
    async execute(args, exec) {
      const sessionId = resolveSessionId(state, args, exec)
      touchSession(state, sessionId)
      const chat = chats.ensure(sessionId)
      const binding = (state.data.sessions && state.data.sessions[sessionId]) || {}
      const card = chat.characterId ? cards.read(chat.characterId) : null
      const limit = args.messageLimit || 20
      const visible = chat.messages.filter(message => !message.hidden)
      const recent = chat.messages.slice(-limit).map(message => ({
        id: message.id,
        role: message.role,
        name: message.name,
        content: message.content.length > 500 ? message.content.slice(0, 500) + '…' : message.content,
        time: message.time,
        hidden: message.hidden,
        swipeIndex: message.swipeIndex,
        swipes: message.swipes.length + (message.content ? 1 : 0),
      }))
      return {
        sessionId,
        title: chat.title || (card ? card.name : ''),
        characterId: chat.characterId || binding.characterId || '',
        characterName: card ? card.name : '',
        avatarUrl: card && cards.hasAvatar(card) ? avatarUrlOf(card) : '',
        persona: chat.persona || binding.persona || '',
        messageCount: chat.messages.length,
        visibleCount: visible.length,
        estimatedTokens: estimateTokens(chat.messages.map(message => message.content).join('\n')),
        worldbooks: Array.isArray(binding.worldbooks) ? binding.worldbooks : [],
        scene: chat.metadata.scene || null,
        authorNote: chat.metadata.authorNote || state.data.authorNote || null,
        variableCount: Object.keys(chat.variables || {}).length,
        variables: chat.variables || {},
        recentMessages: recent,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_swipe',
    description: '切换最后一条（或指定）AI 回复的 swipe 分支：direction=1 下一个、-1 上一个；给 content 则追加一条新 swipe 并切过去。返回当前生效的文本。',
    parameters: {
      direction: { type: 'number', description: '切换方向：1=下一个，-1=上一个', enum: [1, -1] },
      content: { type: 'string', description: '追加一条新 swipe 的正文；给了就忽略 direction' },
      messageId: { type: 'string', description: '目标消息 id，省略则操作最后一条 AI 消息' },
      index: { type: 'number', description: '直接跳到第几条 swipe（从 0 开始）' },
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
    },
    async execute(args, exec) {
      const sessionId = resolveSessionId(state, args, exec)
      return swipeMessage(state, sessionId, args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_regenerate',
    description: '重生成最后一条 AI 回复：把现有内容存进 swipe 历史，清空当前正文并标记待生成；返回装配好的提示词上下文，供模型据此写出新回复后用 st_swipe 的 content 参数写回。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
      keepOldSwipe: { type: 'boolean', description: '是否把旧内容保留成一条 swipe（默认 true）', default: true },
    },
    async execute(args, exec) {
      const sessionId = resolveSessionId(state, args, exec)
      return regenerateLastReply(state, sessionId, { keepOldSwipe: args.keepOldSwipe !== false })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_set_persona',
    description: '设置用户 persona（ST 的 User Persona：名字 + 描述）。可以只改当前会话，也可以存成全局 persona 供以后复用。',
    parameters: {
      name: { type: 'string', description: 'persona 名字', required: true },
      description: { type: 'string', description: 'persona 描述（身份、外貌、背景）' },
      avatar: { type: 'string', description: '头像文件名（已存在的头像）' },
      scope: { type: 'string', description: 'global=写入 persona 库并设为默认；session=只对本会话生效', enum: ['global', 'session'], default: 'session' },
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
    },
    async execute(args, exec) {
      const name = String(args.name || '').trim()
      if (!name) throw new Error('persona 名字不能为空')
      const record = {
        name,
        description: args.description === undefined ? '' : String(args.description),
        avatar: args.avatar === undefined ? '' : String(args.avatar),
        updatedAt: nowIso(),
      }
      const scope = args.scope === 'global' ? 'global' : 'session'
      if (scope === 'global') {
        state.data.personas = state.data.personas || {}
        state.data.personas[name] = { ...(state.data.personas[name] || {}), ...record }
        state.data.personas.default = name
      }
      const sessionId = resolveSessionId(state, args, exec)
      const chat = chats.ensure(sessionId)
      chat.persona = name
      chat.metadata.personaDescription = record.description
      chats.write(sessionId, chat)
      state.data.sessions = state.data.sessions || {}
      state.data.sessions[sessionId] = { ...(state.data.sessions[sessionId] || {}), persona: name }
      state.save()
      return { sessionId, persona: name, scope, description: record.description, avatar: record.avatar }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_export_chat',
    description: '把会话导出成 SillyTavern 能直接导入的 JSONL 聊天记录，返回写入的绝对路径。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
      fileName: { type: 'string', description: '输出文件名（不含扩展名），默认用角色名 + 时间戳' },
    },
    async execute(args, exec) {
      const sessionId = resolveSessionId(state, args, exec)
      const chat = chats.read(sessionId)
      if (!chat) throw new Error('会话 "' + sessionId + '" 还没有聊天记录，无法导出。')
      const card = chat.characterId ? cards.read(chat.characterId) : null
      const text = chatToStJsonl(chat, card)
      const outDir = join(state.layout.root, 'exports')
      mkdirSync(outDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const base = safeName(String(args.fileName || ((card ? card.name : 'chat') + ' - ' + stamp)), 'chat')
      const target = join(outDir, base + '.jsonl')
      writeFileSync(target, text, 'utf8')
      return {
        exported: true,
        path: target,
        messages: chat.messages.length,
        bytes: Buffer.byteLength(text),
        format: 'sillytavern-jsonl',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_get_variables',
    description: '读当前会话的变量表（ST 的 setvar / MVU 变量），返回全部键值与类型。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
      prefix: { type: 'string', description: '只返回以该前缀开头的变量' },
    },
    async execute(args, exec) {
      const sessionId = resolveSessionId(state, args, exec)
      const chat = chats.ensure(sessionId)
      const prefix = String(args.prefix || '')
      const variables = {}
      for (const [key, value] of Object.entries(chat.variables || {})) {
        if (prefix && !key.startsWith(prefix)) continue
        variables[key] = value
      }
      return { sessionId, count: Object.keys(variables).length, variables }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_list_variables',
    description: '列出当前会话变量表的明细：键、值、类型、值长度，便于按类型筛选或统计。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
      type: { type: 'string', description: '只列某种类型的变量', enum: ['string', 'number', 'boolean', 'object', 'array'] },
    },
    async execute(args, exec) {
      const sessionId = resolveSessionId(state, args, exec)
      const chat = chats.ensure(sessionId)
      const rows = []
      for (const [key, value] of Object.entries(chat.variables || {})) {
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
        if (args.type && type !== args.type) continue
        rows.push({
          key,
          type,
          value: typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
          preview: typeof value === 'string' && value.length > 120 ? value.slice(0, 120) + '…' : undefined,
        })
      }
      rows.sort((a, b) => a.key.localeCompare(b.key))
      return { sessionId, count: rows.length, variables: rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_set_variable',
    description: '设置 / 增加 / 删除一个会话变量（ST 的 setvar / addvar / delvar）。value 传 null 表示删除该变量。',
    parameters: {
      key: { type: 'string', description: '变量名', required: true },
      value: { type: 'string', description: '变量值（字符串/数字/布尔）；传 null 删除' },
      mode: { type: 'string', description: 'set=覆盖，add=数值累加或数组追加，push=追加到数组', enum: ['set', 'add', 'push'], default: 'set' },
      numeric: { type: 'boolean', description: 'value 按数字解析（mode=add 时默认开启）' },
      sessionId: { type: 'string', description: '会话 id，省略则用当前会话' },
    },
    async execute(args, exec) {
      const key = String(args.key || '').trim()
      if (!key) throw new Error('变量名不能为空')
      const sessionId = resolveSessionId(state, args, exec)
      const chat = chats.ensure(sessionId)
      chat.variables = chat.variables || {}
      const mode = args.mode || 'set'
      const raw = args.value
      if (raw === null) {
        const existed = Object.prototype.hasOwnProperty.call(chat.variables, key)
        delete chat.variables[key]
        chats.write(sessionId, chat)
        return { sessionId, key, deleted: existed, exists: false }
      }
      let value = raw
      if (args.numeric || mode === 'add') {
        const n = Number(raw)
        value = Number.isFinite(n) ? n : raw
      }
      if (mode === 'add') {
        const current = Number(chat.variables[key])
        const delta = Number(value)
        if (!Number.isFinite(delta)) throw new Error('mode=add 时 value 必须是数字，收到：' + String(raw))
        value = (Number.isFinite(current) ? current : 0) + delta
      } else if (mode === 'push') {
        const current = chat.variables[key]
        const list = Array.isArray(current) ? current.slice() : current === undefined || current === null ? [] : [current]
        list.push(value)
        value = list
      }
      chat.variables[key] = value
      chats.write(sessionId, chat)
      return { sessionId, key, value, mode, count: Object.keys(chat.variables).length }
    },
  }))
}
