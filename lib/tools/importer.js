/**
 * ST 安装目录导入工具。
 *
 * 真正的导入实现在 lib/importer.js（lead 维护）：只读扫描 ST 的 data/default-user，
 * 把角色卡、世界书、预设、快速回复、人格、正则搬进插件自己的布局，ST 那边不动。
 * 这里只做两件事：把导入器挂到 state 上（lib/bootstrap.js 的首次启动自动导入靠它），
 * 以及把导入/探测暴露成模型可见的工具。
 */
import { defineTool } from '../toolkit.js'
import { importFromSillyTavern, probeSillyTavern } from '../importer.js'

/**
 * 当前可用的 ST 安装目录：显式参数优先，其次配置。
 * @param {Object} state 插件状态
 * @param {string} [explicit] 工具参数里的 stRoot
 * @returns {string} 安装目录；都没有时返回空串
 */
function resolveStRoot(state, explicit) {
  const fromArgs = String(explicit || '').trim()
  if (fromArgs) return fromArgs
  return String((state.config && state.config.sillyTavernRoot) || '').trim()
}

/**
 * 把一份导入报告压成模型好读的样子。
 * @param {Record<string, any>} report lib/importer.js 的原始报告
 * @returns {Record<string, any>} 精简报告
 */
function presentReport(report) {
  const failed = Array.isArray(report.charactersFailed)
    ? report.charactersFailed.map(item => ({ file: item.file, reason: item.reason }))
    : []
  return {
    source: report.source,
    characters: report.characters || 0,
    charactersSkipped: report.charactersSkipped || 0,
    charactersFailed: failed,
    worlds: report.worlds || 0,
    worldsSkipped: report.worldsSkipped || 0,
    presets: report.presets || 0,
    quickReplies: report.quickReplies || 0,
    personas: report.personas || 0,
    regex: report.regex || 0,
    themes: report.themes || 0,
  }
}

/**
 * ST 导入工具注册，并把导入器挂到 state.importer 上。
 * @param {Object} ctx Cordis 上下文
 * @param {Object} state 插件共享状态
 * @returns {void}
 */
export function registerImportTools(ctx, state) {
  // lib/bootstrap.js 通过 state.importer 触发首次启动自动导入；这里必须挂上。
  state.importer = { importFromSillyTavern, probeSillyTavern }

  ctx.tools.register(defineTool({
    name: 'st_import_sillytavern',
    description: '把 SillyTavern 安装目录里的数据（角色卡、世界书、预设、快速回复、人格、正则、主题）导入到本插件。只读 ST 那边，不会改动原文件；同名内容默认跳过，不覆盖。',
    parameters: {
      stRoot: { type: 'string', description: 'SillyTavern 安装目录；省略则用配置里的 sillyTavernRoot' },
      overwrite: { type: 'boolean', description: '同名已存在时是否覆盖，默认 false', default: false },
      dryRun: { type: 'boolean', description: '只探测不写入，默认 false', default: false },
    },
    async execute(args) {
      const stRoot = resolveStRoot(state, args.stRoot)
      if (!stRoot) {
        throw new Error('没有配置 SillyTavern 安装目录。请传 stRoot，或在插件配置里设置 sillyTavernRoot。')
      }
      if (args.dryRun) {
        const probe = probeSillyTavern(stRoot)
        if (!probe.ok) throw new Error('探测失败：' + probe.reason + '（目录：' + stRoot + '）')
        return {
          dryRun: true,
          stRoot,
          probe,
          note: '这是探测结果，没有写入任何文件。去掉 dryRun 才真正导入。',
        }
      }
      const report = await importFromSillyTavern(state, stRoot, { overwrite: Boolean(args.overwrite) })
      if (state.invalidate) state.invalidate()
      return { dryRun: false, imported: presentReport(report) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'st_list_st_sources',
    description: '探测配置的 SillyTavern 安装目录里有哪些可导入内容（只读，不写入）。用于导入前自检路径是否正确。',
    parameters: {
      stRoot: { type: 'string', description: 'SillyTavern 安装目录；省略则用配置里的 sillyTavernRoot' },
    },
    async execute(args) {
      const configured = String((state.config && state.config.sillyTavernRoot) || '').trim()
      const stRoot = resolveStRoot(state, args.stRoot)
      if (!stRoot) {
        return {
          ok: false,
          configuredRoot: '',
          reason: '没有配置 SillyTavern 安装目录。请传 stRoot，或在插件配置里设置 sillyTavernRoot。',
        }
      }
      const probe = probeSillyTavern(stRoot)
      if (!probe.ok) {
        return { ok: false, configuredRoot: stRoot, isDefaultRoot: false, reason: probe.reason }
      }
      return { ok: true, configuredRoot: stRoot, isDefaultRoot: stRoot === configured, probe }
    },
  }))
}
