/**
 * 舞台工具：让模型自由决定「界面上放什么、怎么改」。
 *
 * 这里不做任何玩法假设。模型按当前情境自己设计：
 *   战斗时可能是格子地图 + 先攻列表 + 血量条；
 *   探索时可能是一张场景图 + 地点描述；
 *   社交时可能是人物关系图 + 态度表；
 *   也可能压根不需要面板。
 *
 * 三个工具：
 *   stage_publish  首次发布 / 整体替换（情境切换时用）
 *   stage_patch    按 id 增量修改（绝大多数时候用这个，便宜）
 *   stage_clear    清空
 * 另外 stage_get 用于读回当前内容（改之前先看）。
 */
import { defineTool } from '../toolkit.js'
import { sessionIdOf } from '../session.js'
import { getStage, publishStage, patchStage, clearStage, PANEL_KINDS, BLOCK_KINDS } from '../stage.js'

/** 解析会话 id；工具被无会话调用时落到 'default'。 */
function sid(exec) {
  return sessionIdOf(exec) || 'default'
}

/** 统一失败返回。 */
function failure(message) {
  return { ok: false, error: message }
}

/**
 * 注册舞台工具。
 * @param {Object} ctx cordis 上下文
 * @param {Object} state 插件状态
 */
export function registerStageTools(ctx, state) {
  ctx.tools.register(defineTool({
    name: 'stage_publish',
    description: [
      '设置中间舞台的内容。舞台是 AI 输出的一部分：你要展示什么、长什么样，由你决定。',
      '按情境自由设计面板，不要套固定模板——战斗、探索、对话、解谜各自该有各自的形状。',
      'panels 里每个面板的 kind 可选：' + PANEL_KINDS.join(' / ') + '。',
      'blocks 面板的块 kind：' + BLOCK_KINDS.join(' / ') + '。',
      'mode=replace 整体替换（情境完全切换时用），默认 merge 按 id 合并。',
      '情境没变只是内容变了的话，用 stage_patch 增量改，比这个便宜得多。',
    ].join(''),
    parameters: {
      panels: { type: 'array', items: { type: 'object' }, description: '面板数组' },
      panel: { type: 'object', description: '只发布一个面板时的快捷方式' },
      mode: { type: 'string', enum: ['merge', 'replace'], description: '默认 merge' },
      sessionId: { type: 'string', description: '指定会话；省略则用当前会话' },
    },
    async execute(args, exec) {
      const sessionId = args.sessionId || sid(exec)
      try {
        const result = publishStage(state, sessionId, {
          panels: args.panels,
          panel: args.panel,
          mode: args.mode || 'merge',
        })
        return {
          ok: true,
          sessionId,
          revision: result.revision,
          panels: result.panels.map((panel) => ({ id: panel.id, kind: panel.kind, title: panel.title })),
          summary: '舞台现有 ' + result.panels.length + ' 个面板',
        }
      } catch (error) {
        return failure('发布舞台失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'stage_patch',
    description: [
      '增量修改舞台，不重写整个面板。改数值、更新一格地图、换一行文字都用这个。',
      'operations 是操作数组，每个操作：',
      '{op:"set-panel", panelId, set:{title,subtitle,text,src,…}} — 改面板级字段；',
      '{op:"upsert-block", panelId, block:{id,kind,…}} — 按块 id 插入或更新；',
      '{op:"patch-block", panelId, blockId, set:{…}} — 改一个块的字段；',
      '{op:"remove-block", panelId, blockId} — 删块；',
      '{op:"replace-blocks", panelId, blocks:[…]} — 整块替换（块很多时也比整面板便宜）；',
      '{op:"remove-panel", panelId} — 删面板。',
      '块和面板都要用稳定 id，否则增量对不上。',
    ].join(''),
    parameters: {
      operations: { type: 'array', items: { type: 'object' }, description: '操作数组' },
      sessionId: { type: 'string', description: '指定会话；省略则用当前会话' },
    },
    async execute(args, exec) {
      const sessionId = args.sessionId || sid(exec)
      try {
        const result = patchStage(state, sessionId, args.operations || [])
        return {
          ok: true,
          sessionId,
          revision: result.revision,
          applied: result.applied,
          skipped: result.skipped,
          panelCount: result.panels.length,
        }
      } catch (error) {
        return failure('修改舞台失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'stage_get',
    description: '读回当前舞台内容。改之前先看，避免把已有内容覆盖掉。',
    parameters: {
      sessionId: { type: 'string', description: '指定会话；省略则用当前会话' },
    },
    async execute(args, exec) {
      const sessionId = args.sessionId || sid(exec)
      const stage = getStage(state, sessionId)
      return { ok: true, ...stage }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'stage_clear',
    description: '清空舞台。换场景、结束战斗、回到纯对话时用。',
    parameters: {
      sessionId: { type: 'string', description: '指定会话；省略则用当前会话' },
    },
    async execute(args, exec) {
      const sessionId = args.sessionId || sid(exec)
      const result = clearStage(state, sessionId)
      return { ok: true, sessionId, revision: result.revision }
    },
  }))
}
