/**
 * 通用舞台：AI 输出内容的承载面。
 *
 * 这里不预设任何玩法形态。舞台就是「一组面板」，每个面板的内容由模型决定：
 * 可以是一张格子地图、一段世界观说明、一个战斗时间线、一张关系图、
 * 一段数值看板，或者干脆什么都不放。形态随情境变，不随插件变。
 *
 * 关键约束：
 *   1. 内容归模型所有。插件只负责存、取、合并、渲染。
 *   2. 更新走增量（patch），不是每次整块重写。
 *   3. 面板与块的 id 由模型给，稳定 id 才能增量。
 *
 * 存储：state.layout.trpg/stage.json，按会话分键。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './store.js'
import { nowIso, shortId } from './util.js'

/** 面板内容种类。模型按需要选，插件不猜。 */
export const PANEL_KINDS = ['blocks', 'canvas', 'map', 'image', 'text', 'table']

/** 块的种类（blocks 面板用）。 */
export const BLOCK_KINDS = ['heading', 'text', 'list', 'table', 'meter', 'chips', 'divider', 'image', 'quote', 'steps']

/** 舞台文件的绝对路径。 */
function stageFile(state) {
  return join(state.layout.trpg, 'stage.json')
}

/** 读出全部舞台数据；没有就返回空表。 */
function readAll(state) {
  return readJson(stageFile(state), { version: 1, sessions: {} }) || { version: 1, sessions: {} }
}

/** 写回。 */
function writeAll(state, data) {
  writeJson(stageFile(state), data)
}

/**
 * 取一个会话的舞台。
 * @param {Object} state 插件状态
 * @param {string} sessionId 会话 id
 * @returns {{sessionId: string, panels: Array, updatedAt: string, revision: number}}
 */
export function getStage(state, sessionId) {
  const all = readAll(state)
  const entry = all.sessions[sessionId]
  if (!entry) return { sessionId, panels: [], updatedAt: '', revision: 0 }
  return {
    sessionId,
    panels: Array.isArray(entry.panels) ? entry.panels : [],
    updatedAt: entry.updatedAt || '',
    revision: Number(entry.revision) || 0,
  }
}

/** 存一个会话的舞台。 */
function saveStage(state, sessionId, panels) {
  const all = readAll(state)
  const prev = all.sessions[sessionId]
  const revision = (prev ? Number(prev.revision) || 0 : 0) + 1
  all.sessions[sessionId] = { panels, updatedAt: nowIso(), revision }
  writeAll(state, all)
  return revision
}

/**
 * 归一化一个块：补 id、校验 kind。
 * @param {Object} raw
 * @param {number} index
 * @returns {Object|null} 不识别的 kind 返回 null（跳过，不报错）
 */
export function normalizeBlock(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null
  const kind = String(raw.kind || raw.type || '').trim()
  if (!BLOCK_KINDS.includes(kind)) return null
  const block = {
    id: String(raw.id || ('b' + index)),
    kind,
  }
  if (raw.title !== undefined) block.title = String(raw.title)
  if (raw.text !== undefined) block.text = String(raw.text)
  if (raw.label !== undefined) block.label = String(raw.label)
  if (raw.unit !== undefined) block.unit = String(raw.unit)
  if (raw.icon !== undefined) block.icon = String(raw.icon)
  if (raw.value !== undefined && raw.value !== null && raw.value !== '') block.value = raw.value
  if (raw.max !== undefined && raw.max !== null && raw.max !== '') block.max = Number(raw.max)
  if (Array.isArray(raw.items)) block.items = raw.items
  if (Array.isArray(raw.columns)) block.columns = raw.columns
  if (Array.isArray(raw.rows)) block.rows = raw.rows
  if (raw.tone !== undefined) block.tone = String(raw.tone)
  if (raw.src !== undefined) block.src = String(raw.src)
  if (raw.href !== undefined) block.href = String(raw.href)
  // 其余自定义字段原样保留，模型可以塞自己的语义
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in block)) block[key] = value
  }
  return block
}

/**
 * 归一化一个面板。
 * @param {Object} raw
 * @param {number} index
 * @returns {Object|null}
 */
export function normalizePanel(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null
  const kind = String(raw.kind || 'blocks').trim()
  if (!PANEL_KINDS.includes(kind)) return null
  const panel = {
    id: String(raw.id || ('p' + index)),
    kind,
    title: raw.title === undefined ? '' : String(raw.title),
  }
  if (raw.subtitle !== undefined) panel.subtitle = String(raw.subtitle)
  if (raw.width !== undefined) panel.width = String(raw.width)

  if (kind === 'blocks') {
    const blocks = Array.isArray(raw.blocks) ? raw.blocks : []
    panel.blocks = blocks.map((block, i) => normalizeBlock(block, i)).filter(Boolean)
  } else if (kind === 'canvas') {
    panel.html = String(raw.html || '')
    if (raw.css !== undefined) panel.css = String(raw.css)
    if (raw.height !== undefined) panel.height = Number(raw.height)
  } else if (kind === 'map') {
    panel.map = raw.map && typeof raw.map === 'object' ? raw.map : { width: 0, height: 0, cells: [], tokens: [] }
  } else if (kind === 'image') {
    panel.src = String(raw.src || '')
    if (raw.caption !== undefined) panel.caption = String(raw.caption)
  } else if (kind === 'text') {
    panel.text = String(raw.text || '')
  } else if (kind === 'table') {
    panel.columns = Array.isArray(raw.columns) ? raw.columns : []
    panel.rows = Array.isArray(raw.rows) ? raw.rows : []
  }
  // 保留模型自定义字段
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in panel)) panel[key] = value
  }
  return panel
}

/**
 * 发布/替换面板。model 传 panels 时整体替换；只传一个 panel 时按 id 合并。
 * @param {Object} state
 * @param {string} sessionId
 * @param {{panels?: Array, panel?: Object, mode?: 'merge'|'replace'}} input
 * @returns {{panels: Array, revision: number, changed: number}}
 */
export function publishStage(state, sessionId, input = {}) {
  const current = getStage(state, sessionId).panels
  const mode = input.mode === 'replace' ? 'replace' : 'merge'
  let next

  if (Array.isArray(input.panels)) {
    const normalized = input.panels.map((panel, i) => normalizePanel(panel, i)).filter(Boolean)
    next = mode === 'replace' ? normalized : mergePanels(current, normalized)
  } else if (input.panel) {
    const one = normalizePanel(input.panel, current.length)
    next = one ? mergePanels(current, [one]) : current.slice()
  } else {
    next = current.slice()
  }

  const revision = saveStage(state, sessionId, next)
  return { panels: next, revision, changed: next.length }
}

/** 按 id 合并面板；同 id 后者覆盖，新 id 追加。 */
function mergePanels(current, incoming) {
  const map = new Map(current.map((panel) => [panel.id, panel]))
  for (const panel of incoming) map.set(panel.id, panel)
  return [...map.values()]
}

/**
 * 增量修改：按面板 id + 操作指令改，不重写整块。
 *
 * 支持的操作：
 *   set-panel      改面板级字段（title/subtitle/text/src…）
 *   replace-blocks 整体换掉 blocks（块多时仍比整面板便宜）
 *   upsert-block   按 block.id 插入或更新一个块
 *   remove-block   删一个块
 *   patch-block    改一个块的字段
 *   remove-panel   删面板
 *
 * @param {Object} state
 * @param {string} sessionId
 * @param {Array<{op: string, panelId: string, blockId?: string, set?: Object, block?: Object}>} operations
 * @returns {{panels: Array, revision: number, applied: number, skipped: string[]}}
 */
export function patchStage(state, sessionId, operations) {
  const current = getStage(state, sessionId).panels
  const panels = current.map((panel) => ({ ...panel }))
  const byId = new Map(panels.map((panel) => [panel.id, panel]))
  const skipped = []
  let applied = 0

  for (const raw of Array.isArray(operations) ? operations : []) {
    const op = raw && typeof raw === 'object' ? String(raw.op || '').trim() : ''
    const panelId = raw && raw.panelId !== undefined ? String(raw.panelId) : ''
    if (!op) { skipped.push('缺少 op'); continue }

    if (op === 'remove-panel') {
      const at = panels.findIndex((panel) => panel.id === panelId)
      if (at < 0) { skipped.push('面板不存在: ' + panelId); continue }
      panels.splice(at, 1)
      byId.delete(panelId)
      applied += 1
      continue
    }

    const panel = byId.get(panelId)
    if (!panel) { skipped.push('面板不存在: ' + panelId); continue }

    if (op === 'set-panel') {
      Object.assign(panel, raw.set && typeof raw.set === 'object' ? raw.set : {})
      applied += 1
      continue
    }

    if (op === 'replace-blocks') {
      const list = Array.isArray(raw.blocks) ? raw.blocks : []
      panel.kind = 'blocks'
      panel.blocks = list.map((block, i) => normalizeBlock(block, i)).filter(Boolean)
      applied += 1
      continue
    }

    if (op === 'upsert-block') {
      const block = normalizeBlock(raw.block, (panel.blocks || []).length)
      if (!block) { skipped.push('块不合法: ' + JSON.stringify(raw.block).slice(0, 40)); continue }
      panel.kind = 'blocks'
      panel.blocks ||= []
      const at = panel.blocks.findIndex((item) => item.id === block.id)
      if (at >= 0) panel.blocks[at] = block
      else panel.blocks.push(block)
      applied += 1
      continue
    }

    if (op === 'remove-block') {
      const blockId = String(raw.blockId || '')
      panel.blocks ||= []
      const before = panel.blocks.length
      panel.blocks = panel.blocks.filter((item) => item.id !== blockId)
      if (panel.blocks.length === before) skipped.push('块不存在: ' + blockId)
      else applied += 1
      continue
    }

    if (op === 'patch-block') {
      const blockId = String(raw.blockId || '')
      panel.blocks ||= []
      const block = panel.blocks.find((item) => item.id === blockId)
      if (!block) { skipped.push('块不存在: ' + blockId); continue }
      Object.assign(block, raw.set && typeof raw.set === 'object' ? raw.set : {})
      applied += 1
      continue
    }

    skipped.push('未知 op: ' + op)
  }

  const revision = saveStage(state, sessionId, panels)
  return { panels, revision, applied, skipped }
}

/** 清空一个会话的舞台。 */
export function clearStage(state, sessionId) {
  const revision = saveStage(state, sessionId, [])
  return { panels: [], revision }
}

/** 列出所有有舞台内容的会话（调试与客户端的会话切换用）。 */
export function listStageSessions(state) {
  const all = readAll(state)
  return Object.entries(all.sessions || {}).map(([sessionId, entry]) => ({
    sessionId,
    panels: Array.isArray(entry.panels) ? entry.panels.length : 0,
    updatedAt: entry.updatedAt || '',
  }))
}
