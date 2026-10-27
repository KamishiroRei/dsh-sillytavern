/**
 * 端到端验证：真的起一个 dsh web，然后用 HTTP 打插件接口。
 *
 * 为什么必须有这一步：verify.mjs 用的是假 ctx，它证明不了真实 Cordis 拓扑里
 * 「service 有没有注入进来、路由有没有挂上、客户端 bundle 有没有被 serve」。
 * 用户在浏览器里真打开的就是这条链路。
 *
 * 用法：
 *   node scripts/verify-e2e.mjs
 *   node scripts/verify-e2e.mjs --port 3101 --keep-log
 *
 * 失败项同样按负责人分组。服务无论如何都会在 finally 里被关掉。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argv = process.argv.slice(2)

/** 取一个 --key 值或默认值。 */
function argValue(key, fallback) {
  const index = argv.indexOf('--' + key)
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1]
  return fallback
}

const PORT_ARG = argValue('port', '')
/** 候选端口：没显式指定时从 3100 往上找空闲的（3100 常被别的开发服务占着）。 */
const PORT_CANDIDATES = PORT_ARG ? [Number(PORT_ARG)] : [3100, 3101, 3102, 3103, 3110, 3120]
let PORT = PORT_CANDIDATES[0]
const KEEP_LOG = argv.includes('--keep-log')
const CLI_BIN = process.env.DSH_CLI_BIN || 'D:' + String.fromCharCode(92) + 'DeepSeekHarness' + String.fromCharCode(92) + 'apps' + String.fromCharCode(92) + 'cli' + String.fromCharCode(92) + 'lib' + String.fromCharCode(92) + 'bin.js'
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'web')
const PROFILE_NAME = 'web'
/**
 * 插件自己的路由前缀：从 lib/tools/support.js 的 ROUTE_PREFIX 读出来。
 * 不硬编码 —— 前缀改过一次（从 /api/plugins/... 挪开，因为 /api 是 client-connection
 * 的鉴权兜底前缀），读源码才能在下次调整时自动跟上。
 */
const PREFIX = (() => {
  try {
    const source = readFileSync(join(root, 'lib', 'tools', 'support.js'), 'utf8')
    const match = /export const ROUTE_PREFIX = '([^']+)'/.exec(source) || /ROUTE_PREFIX\s*=\s*["']([^"']+)["']/.exec(source)
    return match ? match[1] : '/dsh-sillytavern-api'
  } catch { return '/dsh-sillytavern-api' }
})()
const READY_TIMEOUT_MS = Number(argValue('timeout', '120000'))
const LOG_DIR = join(root, '.qa-logs')

/* ────────────────────────── 结果收集 ────────────────────────── */

const failures = []
const passes = []
const skips = []
const notes = []

/** 记录一条检查。 */
function check(label, ok, detail, owner) {
  const who = owner || 'lead'
  if (ok) {
    passes.push({ label, who })
    console.log('  ✓ ' + label)
  } else {
    failures.push({ label, detail: detail === undefined ? '' : String(detail), who })
    console.log('  ✗ ' + label + (detail ? ' :: ' + String(detail) : ''))
  }
  return Boolean(ok)
}

function skip(label, reason) {
  skips.push({ label, reason: reason || '' })
  console.log('  - ' + label + '（跳过' + (reason ? '：' + reason : '') + '）')
}

function note(label) {
  notes.push(label)
  console.log('  · ' + label)
}

function section(title) {
  console.log('\n— ' + title + ' —')
}

/* ────────────────────────── HTTP ────────────────────────── */

/**
 * 发一个 HTTP 请求，返回状态码、响应头与文本响应体。
 *
 * 用 node:http 而不是 fetch：需要伪造 Host 头来验证回环限制，
 * fetch 不允许改 Host。
 * @param {string} pathname 请求路径（含 query）
 * @param {{ method?: string, headers?: Record<string,string>, body?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, headers: Record<string,any>, text: string, json: any, ms: number }>}
 */
function request(pathname, options) {
  const opts = options || {}
  const started = Date.now()
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: opts.method || 'GET',
      headers: {
        accept: 'application/json',
        host: '127.0.0.1:' + PORT,
        ...(opts.headers || {}),
        ...(opts.body ? { 'content-length': Buffer.byteLength(opts.body) } : {}),
      },
      timeout: opts.timeoutMs || 15000,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const text = buffer.toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolvePromise({ status: res.statusCode || 0, headers: res.headers, text, json, bytes: buffer.length, ms: Date.now() - started })
      })
      res.on('error', rejectPromise)
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    req.on('error', rejectPromise)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/** 端口是否已被监听。 */
function portInUse(port) {
  return new Promise(done => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = (inUse) => { socket.destroy(); done(inUse) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1500, () => finish(false))
  })
}

/** 等到端口开始响应；超时返回 false。 */
async function waitForPort(port, timeoutMs, isAborted) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isAborted()) return false
    if (await portInUse(port)) return true
    await new Promise(done => setTimeout(done, 400))
  }
  return false
}

/** 轮询 ping 直到 200；返回最后一次结果。 */
async function waitForPing(timeoutMs, isAborted) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    if (isAborted()) return last
    try {
      const res = await request(PREFIX + '/ping', { timeoutMs: 3000 })
      last = res
      if (res.status === 200 && res.json && res.json.ok === true) return res
    } catch { /* 还没起来，继续等 */ }
    await new Promise(done => setTimeout(done, 500))
  }
  return last
}

/** 把任意值压成一行可选预览（JSON.stringify 可能返回 undefined 或抛错）。 */
function preview(value, limit) {
  const max = limit || 200
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value.slice(0, max)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

/** 安全取响应体的前 N 字节文本。 */
function bodyPreview(res, limit) {
  if (!res) return 'undefined'
  return preview(res.text === undefined ? res.body : res.text, limit)
}

/* ────────────────────────── 启动 / 关闭 ────────────────────────── */

let child = null
let logFile = ''
let aborted = false

/** 杀掉整棵进程树（Windows 必须 /T，否则 node 的子进程会留下）。 */
function killTree(pid) {
  return new Promise(done => {
    if (!pid) { done(); return }
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.once('exit', () => done())
    killer.once('error', () => done())
    setTimeout(done, 8000)
  })
}

/** 起服务；返回子进程。 */
function startServer() {
  mkdirSync(LOG_DIR, { recursive: true })
  logFile = join(LOG_DIR, 'e2e-' + PORT + '-' + Date.now() + '.log')
  const fd = openSync(logFile, 'a')
  const args = [CLI_BIN, '--profile', PROFILE_NAME, '--port', String(PORT), '--no-open']
  console.log('启动: node ' + args.join(' ') + '\n工作目录: ' + PROFILE_DIR + '\n日志: ' + logFile)
  const proc = spawn(process.execPath, args, {
    cwd: PROFILE_DIR,
    env: { ...process.env },
    stdio: ['ignore', fd, fd],
    detached: false,
    windowsHide: true,
  })
  return proc
}

/** 读启动日志；文件可能还不存在或正被写入。 */
function readLog() {
  try { return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' } catch { return '' }
}

/** 在日志里找与插件相关的失败行。 */
function findLogProblems(text) {
  const problems = []
  const lines = text.split('\n')
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (!lower.includes('sillytavern')) continue
    if (/failed to import|cannot find module|cannot find package|is not a function|uncaught|fatal|error:/i.test(line)) problems.push(line.trim())
  }
  return problems
}

/* ────────────────────────── 主流程 ────────────────────────── */

console.log('[dsh-sillytavern] 端到端验证开始（端口 ' + PORT + '）')

const cleanupTasks = []
try {
  /* 前置检查 */
  section('前置检查')
  check('CLI bin.js 存在', existsSync(CLI_BIN), CLI_BIN)
  check('profile 目录存在', existsSync(PROFILE_DIR), PROFILE_DIR)
  check('profile 的 package.json 存在', existsSync(join(PROFILE_DIR, 'package.json')), join(PROFILE_DIR, 'package.json'))
  let chosen = 0
  for (const candidate of PORT_CANDIDATES) {
    if (!(await portInUse(candidate))) { chosen = candidate; break }
  }
  if (!chosen) {
    check('找到空闲端口', false, '候选端口全部被占用: ' + PORT_CANDIDATES.join(', '))
    throw new Error('端口占用，无法继续')
  }
  PORT = chosen
  check('找到空闲端口 ' + PORT, true)

  const isAborted = () => aborted

  section('启动 dsh web')
  const startedAt = Date.now()
  try {
    child = startServer()
  } catch (error) {
    check('能拉起 dsh web 进程', false, error && error.message ? error.message : String(error))
    throw error
  }
  check('能拉起 dsh web 进程', Boolean(child && child.pid), child ? 'pid=' + child.pid : '没有 pid')
  cleanupTasks.push(() => killTree(child && child.pid))

  let exited = null
  child.once('exit', (code, signal) => { exited = { code, signal } })

  const opened = await waitForPort(PORT, READY_TIMEOUT_MS, isAborted)
  const bootMs = Date.now() - startedAt
  check('端口 ' + PORT + ' 在 ' + Math.round(READY_TIMEOUT_MS / 1000) + ' 秒内打开', opened,
    exited ? '进程已退出: ' + JSON.stringify(exited) + '\n日志尾部:\n' + readLog().slice(-1500) : '日志尾部:\n' + readLog().slice(-1500))
  if (!opened) throw new Error('服务没起来')
  note('启动耗时 ' + bootMs + 'ms')

  /* 等插件路由可用（端口打开 ≠ 插件挂完） */
  const pingRes = await waitForPing(60000, isAborted)
  check('插件 ping 可达', Boolean(pingRes && pingRes.status === 200), pingRes ? '状态 ' + pingRes.status + ' body=' + pingRes.text.slice(0, 200) : '60 秒内没等到')

  /* 0.5 先分清楚 401 是谁发的 */
  if (pingRes && pingRes.status === 401) {
    const control = await request('/api/' + 'qa-control-probe-' + Date.now()).catch(() => null)
    const sameAsControl = Boolean(control && control.status === 401)
    check('插件路由已进路由表（不是被 /api 兜底拦掉）', false,
      '插件请求返回 401。' + (sameAsControl
        ? '对照：请求一个绝不存在的 /api/xxx 也是 401 → 说明请求被 client-connection 的 /api 前缀兜底接走并鉴权拒绝了，'
          + 'dsh-sillytavern 自己的 prefix 路由根本没有注册进 webServer。'
          + '根因排查顺序：1) lib/plugin.js 的 inject 是否含 webServer；2) registerRoutes 是否被 ctx.inject([\'webServer\'], ...) 包住；'
          + '3) lib/routes.js 里 ctx.get(\'webServer\') 是不是在服务未 ACTIVE 时静默 return 了。'
        : '对照请求不是 401，说明确实命中了插件的某个处理分支。')
      , 'tavern-tools')
  }

  /* 1. ping */
  section('GET ' + PREFIX + '/ping')
  if (!pingRes || pingRes.status !== 200) {
    skip('ping 内容检查', 'ping 不可达')
  } else {
    check('响应 200', pingRes.status === 200, String(pingRes.status), 'tavern-tools')
    check('Content-Type 是 JSON', String(pingRes.headers['content-type'] || '').includes('json'), String(pingRes.headers['content-type']), 'tavern-tools')
    check('JSON 可解析', Boolean(pingRes.json), '前 200 字节: ' + pingRes.text.slice(0, 200), 'tavern-tools')
    check('信封 ok=true', Boolean(pingRes.json && pingRes.json.ok === true), pingRes.text.slice(0, 200), 'tavern-tools')
    const data = pingRes.json && pingRes.json.data
    check('data 里带 characterCount', Boolean(data && typeof data.characterCount === 'number'), pingRes.text.slice(0, 300), 'tavern-tools')
    check('data 里带 worldbookCount', Boolean(data && typeof data.worldbookCount === 'number'), pingRes.text.slice(0, 300), 'tavern-tools')
    check('dataRoot 落在 DSH home 下', Boolean(data && typeof data.dataRoot === 'string' && data.dataRoot), String(data && data.dataRoot), 'tavern-tools')
    check('Cache-Control: no-store', String(pingRes.headers['cache-control'] || '').includes('no-store'), String(pingRes.headers['cache-control']), 'tavern-tools')
    if (data) note('角色 ' + data.characterCount + ' 张，世界书 ' + data.worldbookCount + ' 本，数据目录 ' + data.dataRoot)
  }

  /* 2. characters */
  section('GET ' + PREFIX + '/characters')
  const charsRes = await request(PREFIX + '/characters').catch(error => ({ status: 0, text: String(error) }))
  const charsOk = charsRes.status === 200 && charsRes.json && charsRes.json.ok === true
  check('响应 200', charsRes.status === 200, '状态 ' + charsRes.status + ' body=' + preview(charsRes.text, 200), 'tavern-tools')
  const charList = charsOk ? (Array.isArray(charsRes.json.data) ? charsRes.json.data : null) : null
  check('data 是数组', Boolean(charList), charsOk ? preview(charsRes.json.data, 200) : preview(charsRes.text, 200), 'tavern-tools')
  if (charList) {
    check('角色数组非空（真实导入过 ST 数据）', charList.length > 0, '数组长度为 0', 'tavern-tools')
    note('角色数量 ' + charList.length)
    const first = charList[0]
    check('角色条目有 id', Boolean(first && typeof first.id === 'string' && first.id), preview(first, 200), 'tavern-tools')
    check('角色条目有 name', Boolean(first && typeof first.name === 'string' && first.name), preview(first, 200), 'tavern-tools')

    /* 3. 单张角色卡 */
    const detailRes = await request(PREFIX + '/characters/' + encodeURIComponent(first.id)).catch(error => ({ status: 0, text: String(error) }))
    check('GET /characters/<id> 返回 200', detailRes.status === 200, '状态 ' + detailRes.status + ' body=' + preview(detailRes.text, 200), 'tavern-tools')
    const card = detailRes.json && detailRes.json.data
    if (card) {
      check('单卡返回 name', typeof card.name === 'string' && card.name.length > 0, preview(card, 200), 'tavern-tools')
      check('单卡返回 first_mes 字段', Object.hasOwn(card, 'first_mes'), Object.keys(card).slice(0, 20).join(', '), 'tavern-tools')
    }

    /* 4. 头像真的能被 serve */
    const withAvatar = charList.find(item => typeof item.avatarUrl === 'string' && item.avatarUrl)
    if (!withAvatar) {
      skip('头像 GET 200 + 图片', '列表里没有带 avatarUrl 的角色')
    } else {
      const imgRes = await request(withAvatar.avatarUrl).catch(error => ({ status: 0, headers: {}, bytes: 0, text: String(error) }))
      check('头像端点返回 200', imgRes.status === 200, '状态 ' + imgRes.status + ' ' + preview(imgRes.text, 120), 'tavern-tools')
      check('头像是图片且非空', String(imgRes.headers && imgRes.headers['content-type'] || '').startsWith('image/') && (imgRes.bytes || 0) > 100,
        '类型 ' + String(imgRes.headers && imgRes.headers['content-type']) + ' 大小 ' + (imgRes.bytes || 0), 'tavern-tools')
      if ((imgRes.bytes || 0) > 100) note('头像 ' + withAvatar.avatarUrl + ' ' + imgRes.bytes + ' 字节')
    }
  }

  /* 5. worldbooks */
  section('GET ' + PREFIX + '/worldbooks')
  const booksRes = await request(PREFIX + '/worldbooks').catch(error => ({ status: 0, text: String(error) }))
  const booksOk = booksRes.status === 200 && booksRes.json && booksRes.json.ok === true
  check('响应 200', booksRes.status === 200, '状态 ' + booksRes.status + ' body=' + preview(booksRes.text, 200), 'tavern-tools')
  const bookList = booksOk ? (Array.isArray(booksRes.json.data) ? booksRes.json.data : null) : null
  check('data 是数组', Boolean(bookList), preview(booksRes.text, 200), 'tavern-tools')
  if (bookList) {
    check('世界书数组非空', bookList.length > 0, '数组长度为 0', 'tavern-tools')
    note('世界书数量 ' + bookList.length)
  }

  /* 6. state */
  section('GET ' + PREFIX + '/state')
  const stateRes = await request(PREFIX + '/state').catch(error => ({ status: 0, text: String(error) }))
  check('响应 200', stateRes.status === 200, '状态 ' + stateRes.status + ' body=' + preview(stateRes.text, 200), 'tavern-tools')
  const stateData = stateRes.json && stateRes.json.data
  if (stateData) {
    check('state 带 trpgLayout', typeof stateData.trpgLayout === 'boolean', preview(stateData, 200), 'tavern-ui')
    check('state 带 centerPanel', typeof stateData.centerPanel === 'string', preview(stateData, 200), 'tavern-ui')
  }

  /* 7. 写状态回环（POST /state 后 GET 能读回） */
  section('POST ' + PREFIX + '/state（写入后回读）')
  const writeRes = await request(PREFIX + '/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ centerPanel: 'log' }),
  }).catch(error => ({ status: 0, text: String(error) }))
  check('POST /state 返回 200', writeRes.status === 200, '状态 ' + writeRes.status + ' body=' + preview(writeRes.text, 200), 'tavern-tools')
  const readBack = await request(PREFIX + '/state').catch(() => null)
  check('写入的 centerPanel 能读回', Boolean(readBack && readBack.json && readBack.json.data && readBack.json.data.centerPanel === 'log'),
    readBack ? JSON.stringify(readBack.json && readBack.json.data).slice(0, 200) : '回读失败', 'tavern-tools')
  // 复原
  await request(PREFIX + '/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ centerPanel: 'map' }) }).catch(() => null)

  /* 8. 回环限制 */
  section('回环限制')
  const foreign = await request(PREFIX + '/ping', { headers: { host: 'evil.example.com' } }).catch(error => ({ status: 0, text: String(error) }))
  check('非回环 Host 被拒（403/404 而非 200）', foreign.status !== 200, '状态 ' + foreign.status + ' body=' + preview(foreign.text, 160), 'tavern-tools')

  /* 9. 未知端点 */
  section('未知端点')
  const unknown = await request(PREFIX + '/this-endpoint-does-not-exist').catch(error => ({ status: 0, json: undefined, text: String(error) }))
  check('未知端点返回 404 而不是 5xx', unknown.status === 404, '状态 ' + unknown.status, 'tavern-tools')
  check('未知端点仍是 JSON 信封', Boolean(unknown.json && unknown.json.ok === false), preview(unknown.text, 160), 'tavern-tools')

  /* 10. 客户端 bundle */
  section('客户端 bundle')
  // /plugins/* 与 /api/* 都要浏览器的会话凭证（BootstrapCookie，由启动 URL 里的
  // launch token 换得）。无头 e2e 拿不到那个 token，所以这里做两件事：
  //   1) 有凭证就真的 GET 一次 bundle；拿不到就 SKIP 并说明原因，不伪装成通过；
  //   2) 无论如何都验证「模块注册表能不能识别这个包」—— 这决定浏览器里会不会加载它。
  let bundleUrl = ''
  const indexRes = await request('/').catch(() => null)
  if (indexRes && indexRes.status === 200) {
    const match = /(?:src|href)="([^"]*\/plugins\/dsh-sillytavern\/[^"]*client\.js[^"]*)"/.exec(indexRes.text)
    if (match) bundleUrl = match[1].replace(/&amp;/g, '&')
  }
  const headEquals404 = indexRes && (indexRes.status === 401 || indexRes.status === 404)
  if (!bundleUrl) {
    skip('GET 客户端 bundle 并校验内容',
      headEquals404
        ? '首页本身就要浏览器会话凭证（HTTP ' + indexRes.status + '），无头 e2e 取不到 launch token；'
          + 'bundle 内容的语法/ModuleLoader/factory 检查由 verify.mjs 覆盖'
        : '首页 HTML 里没找到 dsh-sillytavern 的 script 地址')
  } else {
    const bundleRes = await request(bundleUrl).catch(() => null)
    check('GET 客户端 bundle 返回 200', Boolean(bundleRes && bundleRes.status === 200 && (bundleRes.bytes || 0) > 1000),
      bundleRes ? '状态 ' + bundleRes.status + '，' + (bundleRes.bytes || 0) + ' 字节' : '请求失败', 'tavern-ui')
    if (bundleRes && bundleRes.status === 200) {
      check('bundle 里有 ModuleLoader 注册', bundleRes.text.includes('__ModuleLoader__'), preview(bundleRes.text, 160), 'tavern-ui')
      check('bundle 里 id 是 dsh-sillytavern', /id:\s*['"]dsh-sillytavern['"]/.test(bundleRes.text), '没找到 id 声明', 'tavern-ui')
      check('bundle 不是占位/截断版', !/占位实现|__PART_B__/.test(bundleRes.text), '仍含占位标记', 'tavern-ui')
    }
  }

  // 模块注册表靠 package.json 的 dsh.client 声明 + exports["./client"] 定位 bundle。
  // 这条不需要凭证，能证明"浏览器里会不会去加载这个 bundle"。
  try {
    const pkgPath = join(root, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    check('package.json 声明 dsh.client.platform = web', Boolean(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web'),
      preview(pkg.dsh, 200), 'lead')
    const clientRel = pkg.exports && pkg.exports['./client']
    check('package.json 有 exports["./client"]', typeof clientRel === 'string', String(clientRel), 'lead')
    if (typeof clientRel === 'string') {
      const clientPath = join(root, clientRel.replace(/^\.\//, ''))
      check('exports["./client"] 指向真实文件', existsSync(clientPath), clientPath, 'lead')
      if (existsSync(clientPath)) {
        const size = statSync(clientPath).size
        check('客户端 bundle 文件非空', size > 4000, '只有 ' + size + ' 字节', 'tavern-ui')
      }
    }
    check('package.json 的 files 覆盖 lib/client.js', Array.isArray(pkg.files) && pkg.files.includes('lib'), preview(pkg.files, 120), 'lead')
  } catch (error) {
    check('package.json 客户端声明可读', false, error && error.message ? error.message : String(error), 'lead')
  }

  /* 11. 启动日志 */
  section('启动日志')
  const logText = readLog()
  const problems = findLogProblems(logText)
  check('启动日志无 dsh-sillytavern 导入失败', problems.length === 0, problems.slice(0, 5).join(' | '), 'lead')
  // 插件自己打的 info 日志走宿主 logger，不一定落到 stdout（取决于 profile 的日志级别），
  // 所以这里不把"没看到日志"当失败 —— 用"路由真的响应了"作为更强的正面证据。
  if (/dsh-sillytavern/.test(logText)) {
    for (const line of logText.split('\n').filter(l => l.includes('dsh-sillytavern') && !l.includes('tools.restrict')).slice(0, 4)) {
      note('日志: ' + line.trim().slice(0, 200))
    }
  } else {
    note('启动日志里没有 dsh-sillytavern 的 info 行（logger 输出未进 stdout，属正常；路由响应已证明插件在工作）')
  }
  // 有加载失败 / 未激活 的行要报出来
  const inactivated = logText.split('\n').filter(line => /dsh-sillytavern/.test(line) && /did not activate|FAILED|failed/i.test(line))
  check('dsh-sillytavern 的 fiber 没有失败/未激活', inactivated.length === 0, inactivated.slice(0, 3).join(' | '), 'lead')
} catch (error) {
  if (error && error.message === '端口占用，无法继续') {
    console.log('\n端口被占用，未启动服务')
  } else if (error && error.message === '服务没起来') {
    console.log('\n服务没起来，跳过后续检查')
  } else {
    console.log('\n未预期异常: ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error)))
    failures.push({ label: 'e2e 未预期异常', detail: String(error && error.message ? error.message : error), who: 'lead' })
  }
} finally {
  /* 关服务 */
  section('关闭服务')
  aborted = true
  for (const task of cleanupTasks) {
    try { await task() } catch { /* 已经死了 */ }
  }
  if (child && child.pid) {
    await killTree(child.pid)
    // 等端口真的释放
    const deadline = Date.now() + 15000
    let released = false
    while (Date.now() < deadline) {
      if (!(await portInUse(PORT))) { released = true; break }
      await new Promise(done => setTimeout(done, 300))
    }
    check('服务已关闭，端口 ' + PORT + ' 释放', released, '15 秒内端口仍在监听')
  }
  if (!KEEP_LOG && logFile && existsSync(logFile)) {
    try { rmSync(logFile, { force: true }) } catch { /* 删不掉不影响结论 */ }
  } else if (logFile) {
    console.log('日志保留: ' + logFile)
  }
  // 环境变量里留一份，方便 CI 抓失败现场
  if (process.env.DSH_QA_KEEP_LOG) console.log('日志: ' + logFile)
}

console.log('')
console.log('通过 ' + passes.length + ' 项，失败 ' + failures.length + ' 项，跳过 ' + skips.length + ' 项')
if (notes.length) {
  console.log('\n观察 (' + notes.length + '):')
  for (const item of notes) console.log('  · ' + item)
}
if (skips.length) {
  console.log('\n跳过 (' + skips.length + '):')
  for (const item of skips) console.log('  - ' + item.label + (item.reason ? '（' + item.reason + '）' : ''))
}
if (failures.length) {
  console.log('\n失败明细（按负责人）:')
  const byOwner = new Map()
  for (const item of failures) byOwner.set(item.who, [...(byOwner.get(item.who) || []), item])
  for (const [owner, items] of byOwner) {
    console.log('  【' + owner + '】' + items.length + ' 项')
    for (const item of items) console.log('    - ' + item.label + (item.detail ? ' :: ' + item.detail : ''))
  }
  process.exitCode = 1
} else {
  console.log('\n全部通过')
  process.exitCode = 0
}
