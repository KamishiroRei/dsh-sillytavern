/**
 * dsh-sillytavern bundle 入口。
 *
 * 插件以源码 ESM 直接加载：DSH profile loader 用 Node 的 ESM 解析，
 * 没有 tsc/tsdown 构建步骤。改完 lib/ 下文件重启即生效。
 */
export { apply, name, inject, Config } from './plugin.js'
