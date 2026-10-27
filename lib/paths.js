/**
 * 数据根目录与 SillyTavern 导入源解析。
 *
 * 插件自己的数据放 DSH home 下的 dsh-sillytavern/；
 * 用户在 config.sillyTavernRoot 指定的 ST 安装目录只读导入，
 * 导入是显式动作，不会自动搬运。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** DSH home；优先 DSH_HOME，其次 ~/.dsh。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() ? resolve(env) : join(homedir(), '.dsh')
}

/** 插件数据目录布局。 */
export function dataLayout(root) {
  return {
    root,
    characters: join(root, 'characters'),
    avatars: join(root, 'avatars'),
    worlds: join(root, 'worlds'),
    chats: join(root, 'chats'),
    groups: join(root, 'groups'),
    presets: join(root, 'presets'),
    regex: join(root, 'regex'),
    quickReplies: join(root, 'quick-replies'),
    personas: join(root, 'personas'),
    trpg: join(root, 'trpg'),
    settings: join(root, 'settings.json'),
    bindings: join(root, 'bindings.json'),
    state: join(root, 'state.json'),
  }
}

/** 确保目录存在，返回布局。 */
export function ensureLayout(root) {
  const layout = dataLayout(root)
  for (const key of ['root','characters','avatars','worlds','chats','groups','presets','regex','quickReplies','personas','trpg']) {
    mkdirSync(layout[key], { recursive: true })
  }
  return layout
}

/** 一个 SillyTavern 安装目录里 default-user 的数据位置。 */
export function stUserDirs(stRoot) {
  if (!stRoot || !stRoot.trim()) return null
  const root = resolve(stRoot)
  const data = join(root, 'data')
  const candidates = []
  if (existsSync(data)) {
    // data/<user>/ 每个子目录都可能是一套用户数据
    try {
      const { readdirSync, statSync } = require('node:fs')
      void readdirSync; void statSync
    } catch { /* 只用下面的静态候选 */ }
    candidates.push(join(data, 'default-user'))
  }
  candidates.push(join(root, 'default-user'))
  const found = candidates.find(p => existsSync(p))
  if (!found) return null
  return {
    root: found,
    characters: join(found, 'characters'),
    worlds: join(found, 'worlds'),
    chats: join(found, 'chats'),
    groups: join(found, 'groups'),
    presets: join(found, 'OpenAI Settings'),
    quickReplies: join(found, 'QuickReplies'),
    personas: join(found, 'user'),
    themes: join(found, 'themes'),
  }
}

/** 绝对化一个用户给的路径。 */
export function absPath(p, cwd = process.cwd()) {
  return isAbsolute(p) ? p : resolve(cwd, p)
}
