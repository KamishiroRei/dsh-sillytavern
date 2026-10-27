/**
 * 轻量 JSON 文档存储。
 *
 * 每个集合一个目录、每个实体一个 .json 文件，写入走临时文件 + rename，
 * 保证进程被杀时不会留下半截文件。会话级只读数据（角色卡、世界书）
 * 直接读文件，不做常驻缓存以外的同步。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

/** 读取 JSON；文件不存在返回 fallback。损坏时抛错并在信息里带上路径。 */
export function readJson(file, fallback = undefined) {
  if (!existsSync(file)) return fallback
  const text = readFileSync(file, 'utf8')
  if (!text.trim()) return fallback
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error('JSON 解析失败: ' + file + ' :: ' + (error && error.message ? error.message : String(error)))
  }
}

/** 原子写 JSON。 */
export function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 删除文件（不存在时静默）。 */
export function removeFile(file) {
  if (existsSync(file)) unlinkSync(file)
}

/** 安全文件名：去掉路径分隔符与保留字符。 */
export function safeName(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || fallback
}

/** 一个目录下的 JSON 文件列表（按 mtime 倒序）。 */
export function listJsonFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(n => extname(n).toLowerCase() === '.json')
    .map(n => {
      const full = join(dir, n)
      let mtime = 0
      try { mtime = statSync(full).mtimeMs } catch { mtime = 0 }
      return { name: basename(full, extname(full)), file: full, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

/**
 * 建一个集合：目录 + 单文件实体。
 * @param {string} dir 集合目录
 */
export function collection(dir) {
  return {
    dir,
    list() { return listJsonFiles(dir) },
    read(id) { return readJson(join(dir, safeName(id) + '.json')) },
    write(id, value) { writeJson(join(dir, safeName(id) + '.json'), value); return value },
    remove(id) { removeFile(join(dir, safeName(id) + '.json')) },
    has(id) { return existsSync(join(dir, safeName(id) + '.json')) },
  }
}

/** 创建插件共享状态。 */
export function createStore(ctx, config) {
  return {
    config,
    ctx,
    /** 运行期状态：当前会话绑定的角色等，落 state.json。 */
    state: { version: 1 },
    /** 内存缓存：profile id -> 已解析对象。 */
    cache: new Map(),
  }
}
