/**
 * 启动时的自动导入。
 *
 * 用户配了 sillyTavernRoot 且插件数据目录为空时，首次启动自动把 ST 的
 * 角色卡、世界书、预设拉进来 —— 让用户装完就能玩，不用先点按钮。
 *
 * 真正的导入实现由 lib/importer.js（tavern-tools）提供；本文件只做时机决策
 * 与失败隔离：导入失败不阻塞插件加载。
 */
import { existsSync, readdirSync } from 'node:fs'

/** 数据目录里是否已经有东西了。 */
export function hasImportedData(state) {
  const dirs = [state.layout.characters, state.layout.worlds]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      if (readdirSync(dir).length > 0) return true
    } catch { /* 读不到当作没有 */ }
  }
  return false
}

/**
 * 首次启动自动导入。
 * @param {Object} state
 * @returns {{ imported: boolean, reason?: string, report?: Object }}
 */
export async function autoImportOnStartup(state) {
  const stRoot = state.config.sillyTavernRoot
  if (!stRoot) return { imported: false, reason: '未配置 sillyTavernRoot' }
  if (hasImportedData(state)) return { imported: false, reason: '已有数据，跳过自动导入' }

  const importer = state.importer
  if (!importer || typeof importer.importFromSillyTavern !== 'function') {
    return { imported: false, reason: '导入器尚未就绪' }
  }
  try {
    const report = await importer.importFromSillyTavern(state, stRoot, { overwrite: false })
    return { imported: true, report }
  } catch (error) {
    return { imported: false, reason: error && error.message ? error.message : String(error) }
  }
}
