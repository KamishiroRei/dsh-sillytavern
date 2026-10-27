/**
 * 会话管理工具：ST 的「新聊天 / 切换聊天 / 删除聊天」那套。
 *
 * 一个角色可以有多个聊天存档（ST 的 chats/<角色>/<时间戳>.jsonl），
 * 这里把同样的能力给模型：开新档、列档、改名、删除。
 */
import { defineTool } from '../toolkit.js'
import { existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createChatStore } from './support.js'
import { setBinding } from '../session.js'

/** 角色 id 解析：先按 id，再按名字精确，最后按包含。 */
function resolveCharacterId(state, input) {
  const dir = state.layout.characters
  if (!existsSync(dir)) return ''
  const raw = String(input || '')
  const ids = readdirSync(dir).filter(n => n.endsWith('.json')).map(n => n.replace(/\.json$/, ''))
  if (ids.includes(raw)) return raw
  const lower = raw.toLowerCase()
  const exact = ids.find(id => id.toLowerCase() === lower)
  if (exact) return exact
  return ids.find(id => id.toLowerCase().includes(lower)) || ''
}

/** 列出聊天存档（可按角色过滤）。 */
function listChatsOf(state, characterId) {
  const dir = state.layout.chats
  if (!existsSync(dir)) return []
  const chats = createChatStore(state)
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const sessionId = name.replace(/\.jsonl$/, '')
    const chat = chats.read(sessionId)
    if (!chat) continue
    if (characterId && chat.characterId !== characterId) continue
    const first = (chat.messages || []).find(m => !m.hidden)
    out.push({
      sessionId,
      characterId: chat.characterId || '',
      messageCount: (chat.messages || []).length,
      firstLine: first ? String(first.content || '').slice(0, 60) : '',
      updatedAt: chat.updatedAt || 0,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 注册会话管理工具。
 * @param {Object} ctx cordis 上下文
 * @param {Object} state 插件状态
 */
export function registerChatManageTools(ctx, state) {
  ctx.tools.register(defineTool({
    name: 'st_list_chats',
    description: '列出聊天存档（可按角色过滤）。一个角色可以有多个存档，相当于 ST 的「聊天历史」。',
    parameters: {
      character: { type: 'string', description: '角色 id 或名字，省略则列出全部' },
    },
    async execute(args) {
      let characterId = ''
      if (args.character) characterId = resolveCharacterId(state, args.character)
      const chats = listChatsOf(state, characterId)
      return { total: chats.length, chats }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_new_chat',
    description: '开一个新的聊天存档并绑定角色。开档后可以用 st_bind_character 触发开场白。',
    parameters: {
      character: { type: 'string', description: '角色 id 或名字', required: true },
      title: { type: 'string', description: '存档名，省略用角色名 + 时间' },
      persona: { type: 'string', description: '用户角色名（ST 的 persona）' },
    },
    async execute(args) {
      const id = resolveCharacterId(state, args.character)
      if (!id) throw new Error('找不到角色卡 "' + args.character + '"')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const sessionId = String(args.title || (id + ' - ' + stamp))
      const chats = createChatStore(state)
      chats.write(sessionId, { characterId: id, title: args.title || id, messages: [] })
      const patch = { characterId: id }
      if (args.persona !== undefined) patch.persona = String(args.persona)
      setBinding(state, sessionId, patch)
      state.save()
      return { sessionId, characterId: id, created: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_rename_chat',
    description: '重命名一个聊天存档。',
    parameters: {
      sessionId: { type: 'string', description: '要改的存档', required: true },
      title: { type: 'string', description: '新名字', required: true },
    },
    async execute(args) {
      const from = join(state.layout.chats, args.sessionId + '.jsonl')
      if (!existsSync(from)) throw new Error('存档不存在：' + args.sessionId)
      const to = join(state.layout.chats, String(args.title) + '.jsonl')
      if (existsSync(to)) throw new Error('目标名字已存在：' + args.title)
      renameSync(from, to)
      return { renamed: true, from: args.sessionId, to: String(args.title) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_delete_chat',
    description: '删除一个聊天存档。不可恢复，删除前请确认。',
    parameters: {
      sessionId: { type: 'string', description: '要删的存档', required: true },
      confirm: { type: 'boolean', description: '确认删除，必须为 true' },
    },
    async execute(args) {
      if (args.confirm !== true) return { ok: false, error: '删除不可恢复，确认请传 confirm=true' }
      const file = join(state.layout.chats, args.sessionId + '.jsonl')
      if (!existsSync(file)) return { ok: false, error: '存档不存在：' + args.sessionId }
      unlinkSync(file)
      return { deleted: true, sessionId: args.sessionId }
    },
  }))
}
