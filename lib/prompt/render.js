/**
 * 会话渲染：把一个会话「该看到什么」拼成注进系统提示词的文本。
 *
 * 这是 assembly.js 的最终出口：先由它调用世界书扫描、宏展开、正则清洗，
 * 再由这里按 ST 的 PromptManager 顺序排成一段完整文本。
 *
 * 关键是「按当前绑定角色现算」：角色卡、世界书、作者注释、跑团状态
 * 都会变，所以每次装配都重新算，不缓存成品。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, safeName } from '../store.js'
import { getBinding, personaOf } from '../session.js'

/** 拼一段带标题的块；空内容返回空串。 */
function block(title, body) {
  const text = String(body || '').trim()
  if (!text) return ''
  return '## ' + title + '\n\n' + text
}

/** 把数组里的非空块用空行连起来。 */
function joinBlocks(parts) {
  return parts.filter(Boolean).join('\n\n')
}

/**
 * 读一张角色卡。带缓存，卡文件被改写后由 cache key 的 mtime 失效。
 * @returns {Object|null}
 */
export function loadCharacter(state, characterId) {
  if (!characterId) return null
  const file = join(state.layout.characters, safeName(characterId) + '.json')
  const cacheKey = 'char:' + file
  let mtime = 0
  try { mtime = statSync(file).mtimeMs } catch { mtime = 0 }
  const cached = state.cache.get(cacheKey)
  if (cached && cached.mtime === mtime) return cached.value
  const value = readJson(file, null)
  state.cache.set(cacheKey, { mtime, value })
  return value
}

/** 列出全部角色卡（id 从小到大，稳定顺序）。 */
export function listCharacters(state) {
  if (!existsSync(state.layout.characters)) return []
  return readdirSync(state.layout.characters)
    .filter(n => n.endsWith('.json'))
    .map(n => n.slice(0, -5))
    .sort()
    .map(id => loadCharacter(state, id))
    .filter(Boolean)
}

/**
 * 渲染一次会话的注入文本。
 *
 * @param {Object} state          插件状态
 * @param {string|undefined} sessionId
 * @returns {string} 注入到系统提示词的完整文本；没有绑定角色时返回空串
 */
export function renderSessionPrompt(state, sessionId) {
  if (!state.config.injectSystemPrompt) return ''
  const binding = getBinding(state, sessionId)
  const character = loadCharacter(state, binding.characterId)
  const persona = personaOf(state, sessionId)

  const parts = []

  // 1) 跑团 GM 规则（有跑团存档时才注入）
  if (binding.trpg) {
    parts.push(block('跑团模式', renderTrpgRules(state, binding.trpg)))
  }

  // 2) 角色卡
  if (character) {
    parts.push(block('角色扮演', renderCharacter(state, character, persona, sessionId, binding)))
  }

  // 3) 会话级附加（场景、作者注释）由 renderCharacter 内部处理

  return joinBlocks(parts)
}

/** 跑团规则文本：由 trpg-gm 提供 GM_SYSTEM_PROMPT；拿不到就不注入。 */
function renderTrpgRules(state, trpgBinding) {
  const runtime = state.trpgRuntime
  if (!runtime || typeof runtime.gmPrompt !== 'function') return ''
  try {
    return runtime.gmPrompt(trpgBinding) || ''
  } catch {
    return ''
  }
}

/** 角色卡本体 + 世界书 + 示例 + 作者注释。 */
function renderCharacter(state, character, persona, sessionId, binding) {
  const runtime = state.promptRuntime
  if (runtime && typeof runtime.assemble === 'function') {
    try {
      // dryRun: false —— 这是真实对话路径，世界书的 sticky/cooldown/delay
      // 必须落地，否则定时效果永远不生效。试跑路径（工具里）仍传 true。
      const assembled = runtime.assemble({ state, character, persona, sessionId, binding, dryRun: false })
      return assembled && assembled.systemPrompt ? assembled.systemPrompt : ''
    } catch (error) {
      const logger = typeof state.ctx.get === 'function' ? state.ctx.get('logger') : undefined
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[dsh-sillytavern] 角色提示词装配失败：' + (error && error.message ? error.message : String(error)))
      }
    }
  }
  // runtime 还没接上时的最小兜底：直接给角色定义，保证不会完全没有角色信息。
  return fallbackCharacterText(character, persona)
}

/** 没有装配器时的最小角色文本。 */
function fallbackCharacterText(character, persona) {
  const name = character.name || '角色'
  const lines = []
  lines.push('你在扮演 **' + name + '**，与 **' + persona + '** 对话。')
  if (character.description) lines.push('### ' + name + '\n\n' + character.description)
  if (character.personality) lines.push('### 性格\n\n' + character.personality)
  if (character.scenario) lines.push('### 场景\n\n' + character.scenario)
  if (character.system_prompt) lines.push(character.system_prompt)
  if (character.mes_example) lines.push('### 对话示例\n\n' + character.mes_example)
  if (character.post_history_instructions) lines.push(character.post_history_instructions)
  return lines.join('\n\n')
}
