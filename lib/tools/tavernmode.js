/**
 * 酒馆模式的三段式界面。
 *
 *  1. Lobby —— 还没选模组：只显示角色卡（= 模组）选择，不显示别的东西。
 *  2. TopBar —— 进入之后：一条横幅，装世界书开关、当前角色、舞台切换。
 *  3. 左栏 —— 精简成「队伍」一列，不再堆世界书（世界书挪到横幅）。
 *
 * 设计意图（用户明确要求）：
 *  - 先选模组再进去，进去以后左侧不要多余内容
 *  - 世界书开关放顶部横幅，随时可切
 *  - 完全按 SillyTavern 的心智模型：角色卡 = 一个故事，世界书是它的附属
 */
import { defineTool } from '../toolkit.js'
import { sessionIdOf } from '../session.js'
import { getBinding, setBinding } from '../session.js'
import { getStage } from '../stage.js'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, safeName } from '../store.js'

/** 解析会话 id。 */
function sid(exec) {
  return sessionIdOf(exec) || 'default'
}

/** 读一张角色卡（供 lobby 展示用）。 */
function readCard(state, id) {
  const file = join(state.layout.characters, safeName(id) + '.json')
  if (!existsSync(file)) return null
  return readJson(file, null)
}

/** 列出全部角色卡（模组）。 */
function listCards(state) {
  const dir = state.layout.characters
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const card = readJson(join(dir, name), null)
    if (!card) continue
    out.push({
      id: String(card.id || name.replace(/\.json$/, '')),
      name: String(card.name || ''),
      description: String(card.description || '').slice(0, 160),
      scenario: String(card.scenario || '').slice(0, 160),
      hasAvatar: Boolean(card.avatar),
      tags: Array.isArray(card.tags) ? card.tags : [],
      hasBook: Boolean(card.character_book),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/**
 * 注册「酒馆模式」的会话状态工具。
 *
 * 这些工具不负责渲染 —— 渲染在客户端。它们只负责「这个会话是不是已经进入
 * 酒馆模式、用的是哪个角色、该切换哪个世界书」这层状态，让前端能据此决定
 * 显示 Lobby 还是 TopBar。
 * @param {Object} ctx
 * @param {Object} state
 */
export function registerTavernModeTools(ctx, state) {
  ctx.tools.register(defineTool({
    name: 'tavern_lobby',
    description: '列出可选的角色卡（模组）。进入酒馆模式前先让用户挑一个。',
    parameters: {},
    async execute() {
      const cards = listCards(state)
      return { total: cards.length, cards }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavern_enter',
    description: [
      '进入酒馆模式：选定一个角色卡（模组），把它的开场白放进会话，',
      '并启用它自带的世界书。进入之后就不要再列角色卡了。',
    ].join(''),
    parameters: {
      character: { type: 'string', description: '角色 id 或名字', required: true },
      persona: { type: 'string', description: '用户角色名（ST 的 persona）' },
      worldbooks: {
        type: 'array',
        description: '本局启用的世界书（省略则用角色卡内嵌书 + 全局启用）',
        items: { type: 'string' },
      },
      sessionId: { type: 'string', description: '指定会话；省略则用当前会话' },
    },
    async execute(args, exec) {
      const sessionId = args.sessionId || sid(exec)
      const id = String(args.character)
      const card = readCard(state, id)
      if (!card) throw new Error('找不到角色卡：' + id)
      const patch = { characterId: id, entered: true }
      if (args.persona !== undefined) patch.persona = String(args.persona)
      if (Array.isArray(args.worldbooks)) patch.worldbooks = args.worldbooks.map(String)
      setBinding(state, sessionId, patch)
      state.save()
      return {
        entered: true,
        sessionId,
        characterId: id,
        characterName: card.name,
        worldbooks: Array.isArray(args.worldbooks) ? args.worldbooks : [],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tavern_state',
    description: '读当前会话的酒馆模式状态：是否已进入、用的哪个角色、启用了哪些世界书。',
    parameters: {},
    async execute(_args, exec) {
      const sessionId = sid(exec)
      const binding = getBinding(state, sessionId)
      const card = binding.characterId ? readCard(state, binding.characterId) : null
      const stage = getStage(state, sessionId)
      return {
        sessionId,
        entered: Boolean(binding.entered || binding.characterId),
        characterId: binding.characterId || '',
        characterName: card ? card.name : '',
        persona: binding.persona || '',
        worldbooks: Array.isArray(binding.worldbooks) ? binding.worldbooks : [],
        stagePanels: stage.panels.length,
      }
    },
  }))
}