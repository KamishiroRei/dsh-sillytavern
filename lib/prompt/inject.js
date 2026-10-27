/**
 * 把酒馆提示词接进 DSH 的系统提示词管线。
 *
 * 两条路一起用，互为兜底：
 *  1. ctx.systemPrompt.section()：注册一个 text 为函数的 section，每次装配时
 *     按「当前活跃会话绑定的角色」重新生成。这是主路径。
 *  2. agent/created + agent/pre-step：记下 agent.id → sessionId 的映射，并
 *     在每次 step 前记住当前活跃 agent，供 section 的函数式 text 读取。
 *
 * 没有 systemPrompt 服务时（headless 等）不报错，只是不注入。
 */
import { getBinding, personaOf } from '../session.js'

/** 进程内：agent id → session id。section 的 text 函数靠它定位当前会话。 */
const activeByAgent = new Map()
/** 最近一次进入 step 的 agent id；单会话场景下这就是"当前"。 */
let currentAgentId = null

/** 取 section 该用的会话 id。 */
export function activeSessionId() {
  if (currentAgentId && activeByAgent.has(currentAgentId)) return activeByAgent.get(currentAgentId)
  const first = activeByAgent.values().next()
  return first.done ? undefined : first.value
}

/** 从 agent 对象里抽 session id。 */
function sessionIdFromAgent(agent) {
  const session = agent && agent.session
  if (!session) return undefined
  if (typeof session.id === 'string') return session.id
  if (session.id && typeof session.id.toString === 'function') return String(session.id)
  return undefined
}

/**
 * 注册事件监听与系统提示词分节。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Object} state
 * @param {(state: Object, sessionId: string|undefined) => string} renderSection
 *        由 assembly.js 提供：给定会话，返回这一轮该注入的角色/世界书/跑团文本
 */
export function registerPromptInjection(ctx, state, renderSection) {
  const offCreated = ctx.on('agent/created', payload => {
    const agent = payload && payload.agent
    if (!agent) return
    const id = sessionIdFromAgent(agent)
    if (id) {
      activeByAgent.set(agent.id || id, id)
      currentAgentId = agent.id || id
    }
  })

  const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = payload && payload.agent
    if (agent) {
      const id = sessionIdFromAgent(agent) || activeByAgent.get(agent.id)
      if (id) {
        activeByAgent.set(agent.id, id)
        currentAgentId = agent.id
      }
    }
    return decision
  })

  const offDisposed = ctx.on('agent/disposed', payload => {
    const agent = payload && payload.agent
    if (!agent) return
    if (currentAgentId === agent.id) currentAgentId = null
    activeByAgent.delete(agent.id)
  })

  ctx.effect(() => () => {
    offCreated()
    offPreStep()
    offDisposed()
    activeByAgent.clear()
    currentAgentId = null
  })

  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (!systemPrompt || typeof systemPrompt.section !== 'function') return { registered: false }

  const order = Number(state.config.promptSectionOrder) || 6500
  systemPrompt.section({
    name: 'sillytavern:roleplay',
    order,
    // interpolate=false：角色卡与世界中可能含 {{...}} 字面量（宏语法），
    // 交给 DSH 的变量插值会被误当成未定义变量而导致装配失败。
    interpolate: false,
    text() {
      try {
        return renderSection(state, activeSessionId())
      } catch (error) {
        // 装配失败不能炸掉整个请求：退回空分节，把原因写进日志。
        const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[dsh-sillytavern] 提示词装配失败：' + (error && error.message ? error.message : String(error)))
        }
        return ''
      }
    },
  })

  return { registered: true }
}

/** 供工具与路由查询：当前会话 id。 */
export function currentSessionId() {
  return activeSessionId()
}
