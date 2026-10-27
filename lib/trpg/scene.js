/**
 * 场景：当前所在的"幕"。
 *
 * 跑团的每一幕都应该有一个场景描述（地点、时间、天气、氛围），
 * 三栏布局的中间舞台拿它渲染插图与文字，右侧对话拿它给模型提供上下文。
 *
 * 与地图的分工：
 *   - 需要玩家在地图上走动/战斗 → 用地图（map.js）
 *   - 只是叙事/氛围/过场展示 → 用场景（本模块）
 * 两者可以同时存在，互不覆盖。
 */
import { nowIso } from '../util.js'
import { makeId } from './persist.js'

/** 一天中的时段，给模型与前端做氛围提示。 */
export const TIMES_OF_DAY = ['黎明', '清晨', '上午', '正午', '下午', '黄昏', '夜晚', '深夜']

/** 常见天气。 */
export const WEATHERS = ['晴朗', '多云', '阴天', '小雨', '暴雨', '雷暴', '大雪', '浓雾', '风沙', '闷热', '寒潮']

/**
 * 建一个场景。
 * @param {{
 *   name?: string, description?: string, image?: string,
 *   weather?: string, timeOfDay?: string, ambiance?: string,
 *   notes?: string, id?: string,
 * }} [input]
 * @returns {Object} 场景对象 { id, name, description, image, weather, timeOfDay, ambiance, notes, updatedAt }
 */
export function createScene(input = {}) {
  const name = String(input.name || '').trim() || '未命名场景'
  return {
    id: String(input.id || makeId('scene')),
    name,
    description: String(input.description || ''),
    image: String(input.image || ''),
    weather: String(input.weather || ''),
    timeOfDay: String(input.timeOfDay || ''),
    ambiance: String(input.ambiance || ''),
    notes: String(input.notes || ''),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

/**
 * 更新场景。只改给出的字段；空字符串是合法值（表示清空该字段）。
 * @param {Object} scene 现有场景（不会被就地修改）
 * @param {{
 *   name?: string, description?: string, image?: string, weather?: string,
 *   timeOfDay?: string, ambiance?: string, notes?: string, clear?: string[],
 * }} patch 变更；clear 列出要清空的字段名
 * @returns {{ scene: Object, changes: Array<{field: string, before: any, after: any}> }}
 * @throws {Error} 传入的不是场景对象时抛中文错误
 */
export function updateScene(scene, patch = {}) {
  if (!scene || typeof scene !== 'object') throw new Error('updateScene 需要一个场景对象')
  const next = { ...scene }
  const changes = []
  const fields = ['name', 'description', 'image', 'weather', 'timeOfDay', 'ambiance', 'notes']
  for (const field of fields) {
    if (patch[field] === undefined || patch[field] === null) continue
    const value = String(patch[field])
    if (field === 'name' && !value.trim()) continue // 名字不能被空值覆盖
    if (next[field] === value) continue
    changes.push({ field, before: next[field], after: value })
    next[field] = value
  }
  const clear = Array.isArray(patch.clear) ? patch.clear : []
  for (const field of clear) {
    if (!fields.includes(field) || field === 'name') continue
    if (!next[field]) continue
    changes.push({ field, before: next[field], after: '' })
    next[field] = ''
  }
  if (changes.length) next.updatedAt = nowIso()
  return { scene: next, changes }
}

/**
 * 设置场景插图（本地文件路径或 URL）。
 * @param {Object} scene 场景
 * @param {string} image 图片路径/URL；空字符串表示清除插图
 * @returns {{ scene: Object, changes: Array<Object> }}
 */
export function setSceneImage(scene, image) {
  return updateScene(scene, { image: String(image || '') })
}

/**
 * 场景的展示视图（前端中间舞台用）。
 * 同时给权威字段名与常用别名：tavern-ui 用 title/text/url，其他调用方用 name/description/image。
 * @param {Object} scene 场景
 * @returns {Object|null} { id, name, title, description, text, image, url, weather, timeOfDay, ambiance, notes, updatedAt }
 */
export function sceneView(scene) {
  if (!scene) return null
  return {
    id: scene.id,
    name: scene.name,
    title: scene.name,
    description: scene.description,
    text: scene.description,
    image: scene.image,
    url: scene.image,
    weather: scene.weather,
    timeOfDay: scene.timeOfDay,
    ambiance: scene.ambiance,
    notes: scene.notes,
    updatedAt: scene.updatedAt,
  }
}

/**
 * 场景 → 给模型看的一行上下文（插进系统提示词或工具返回里）。
 * @param {Object} scene 场景
 * @returns {string} 例如 '【场景】酒馆大厅 · 黄昏 · 小雨 · 嘈杂的人声混着木头烟味'
 */
export function describeScene(scene) {
  if (!scene) return ''
  const parts = [scene.name]
  if (scene.timeOfDay) parts.push(scene.timeOfDay)
  if (scene.weather) parts.push(scene.weather)
  const head = '【场景】' + parts.join(' · ')
  const extras = [scene.ambiance, scene.description].filter(Boolean)
  return extras.length ? head + '\n' + extras.join('\n') : head
}
