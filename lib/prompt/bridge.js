/**
 * 提示词桥：把 prompt/inject.js 与 prompt/render.js 接到插件的 apply 上。
 *
 * 与 prompt/assembly.js 的分工：
 *  - assembly.js（tavern-core）负责 ST 原生的分块装配顺序与内容
 *  - 本文件负责事件桥、系统提示词分节注册，以及没有 assembly 时的兜底
 *
 * 两者并存：assembly 提供 state.promptRuntime，本文件把它接进 DSH。
 */
import { registerPromptInjection, currentSessionId } from './inject.js'
import { renderSessionPrompt, loadCharacter, listCharacters } from './render.js'
import { getBinding } from '../session.js'

/**
 * 注册提示词桥。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Object} state
 * @returns {{ registered: boolean }}
 */
export function registerPromptBridge(ctx, state) {
  const result = registerPromptInjection(ctx, state, renderSessionPrompt)

  const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
  if (logger && typeof logger.info === 'function') {
    logger.info('[dsh-sillytavern] 提示词装配 ' + (result.registered
      ? '已接入 systemPrompt'
      : '未找到 systemPrompt 服务，仅保留工具能力'))
  }
  return result
}

/**
 * 供工具与路由复用：装配一次当前会话的完整提示。
 * @param {Object} state
 * @param {string} [sessionId] 省略时用当前活跃会话
 * @returns {{ systemPrompt: string, characterId: string|null, sessionId: string|undefined }}
 */
export function assembleCurrentPrompt(state, sessionId) {
  const id = sessionId || currentSessionId()
  const binding = getBinding(state, id)
  return {
    systemPrompt: renderSessionPrompt(state, id),
    characterId: binding.characterId || null,
    sessionId: id,
  }
}

/** 供路由用：列出所有可绑定角色。 */
export function availableCharacters(state) {
  return listCharacters(state).map(c => ({
    id: c.id,
    name: c.name,
    avatar: c.avatar || null,
    tags: Array.isArray(c.tags) ? c.tags : [],
    scenario: c.scenario || '',
  }))
}

export { loadCharacter, currentSessionId }
