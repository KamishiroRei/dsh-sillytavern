/**
 * 一键跑完三层验证。
 *
 *   node scripts/verify-all.mjs            # 假 ctx + 真实 ST 数据 + 真起 dsh web
 *   node scripts/verify-all.mjs --fast     # 跳过要起服务的 e2e
 *   node scripts/verify-all.mjs --only e2e # 只跑某一层（unit / st-import / e2e）
 *
 * 退出码：任何一层失败就是 1。输出保留每层自己的详细报告，这里只做汇总，
 * 并把失败归属（tavern-core / tavern-tools / trpg-gm / tavern-ui / lead）合到一张表里。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argv = process.argv.slice(2)
const FAST = argv.includes('--fast')
const onlyIndex = argv.indexOf('--only')
const ONLY = onlyIndex >= 0 ? String(argv[onlyIndex + 1] || '').trim() : ''

/** 三层验证：按从快到慢排列。 */
const LAYERS = [
  {
    id: 'unit',
    name: '假 ctx 契约自检',
    script: join(here, 'verify.mjs'),
    args: ['--quiet'],
    hint: '工具注册/契约/调用/路由/分节/落盘',
  },
  {
    id: 'st-import',
    name: '真实 SillyTavern 数据导入',
    script: join(here, 'verify-st-import.mjs'),
    args: [],
    hint: '24 张真卡、真世界书、真扫描',
  },
  {
    id: 'e2e',
    name: '真实 dsh web 端到端',
    script: join(here, 'verify-e2e.mjs'),
    args: [],
    hint: '真起服务，打 HTTP 接口',
    skip: FAST,
  },
]

/** 跑一个子进程脚本，返回 { code, output, ms }。 */
function runLayer(layer) {
  return new Promise(resolvePromise => {
    const started = Date.now()
    const child = spawn(process.execPath, [layer.script, ...layer.args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.on('error', error => resolvePromise({ code: -1, output: '拉不起来: ' + error.message, ms: Date.now() - started }))
    child.on('close', code => resolvePromise({ code: code === null ? -1 : code, output, ms: Date.now() - started }))
  })
}

const results = []
for (const layer of LAYERS) {
  if (ONLY && layer.id !== ONLY) continue
  if (layer.skip) {
    results.push({ layer, skipped: true, reason: '--fast' })
    console.log('\n=== ' + layer.name + '（跳过：--fast）===')
    continue
  }
  console.log('\n=== ' + layer.name + ' ===')
  console.log('    ' + layer.hint)
  const result = await runLayer(layer)
  // 完整输出照抄，方便定位
  for (const line of result.output.split('\n')) {
    if (line.includes('·') || line.includes('✓') || line.includes('✗') || line.includes('跳过')) continue
  }
  // 只打印失败段与汇总段，避免刷屏
  const lines = result.output.split('\n')
  const interesting = []
  let inTail = false
  for (const line of lines) {
    if (/^失败明细|^跳过 \(|^观察 \(|^通过 \d+ 项|^全部通过|^— /.test(line.trim()) || /^\s*【(tavern-core|tavern-tools|trpg-gm|tavern-ui|lead)】/.test(line) || /^\s{4}- /.test(line)) {
      inTail = true
      interesting.push(line)
    } else if (inTail && line.trim() === '') {
      interesting.push(line)
    }
  }
  console.log(interesting.length ? interesting.join('\n') : lines.filter(l => l.trim()).slice(-8).join('\n'))
  results.push({ layer, code: result.code, ms: result.ms, output: result.output })
}

/* ── 汇总 ── */
console.log('\n' + '='.repeat(60))
console.log('汇总')
console.log('='.repeat(60))

const owners = new Map()
let failedLayers = 0
for (const item of results) {
  if (item.skipped) {
    console.log('  ⋯ ' + item.layer.name + '  跳过（' + item.reason + '）')
    continue
  }
  const ok = item.code === 0
  if (!ok) failedLayers++
  const summary = /通过 (\d+) 项，失败 (\d+) 项，跳过 (\d+) 项/.exec(item.output)
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + item.layer.name + '  '
    + (summary ? summary[1] + ' 通过 / ' + summary[2] + ' 失败 / ' + summary[3] + ' 跳过' : '无法解析统计')
    + '  ' + Math.round(item.ms / 100) / 10 + 's')

  // 汇总失败归属
  const ownerBlocks = item.output.split('\n')
  let current = ''
  for (const line of ownerBlocks) {
    const ownerMatch = /^\s*【([^】]+)】\s*(\d+) 项/.exec(line)
    if (ownerMatch) { current = ownerMatch[1]; owners.set(current, owners.get(current) || []); continue }
    const itemMatch = /^\s{4}- (.+)$/.exec(line)
    if (itemMatch && current) owners.get(current).push({ layer: item.layer.id, text: itemMatch[1] })
  }
}

if (owners.size) {
  console.log('\n失败按负责人:')
  for (const [owner, items] of owners) {
    console.log('  【' + owner + '】' + items.length + ' 项')
    for (const item of items.slice(0, 12)) console.log('    [' + item.layer + '] ' + item.text)
    if (items.length > 12) console.log('    …还有 ' + (items.length - 12) + ' 项')
  }
}

const ran = results.filter(item => !item.skipped).length
console.log('\n共 ' + ran + ' 层，失败 ' + failedLayers + ' 层')
process.exitCode = failedLayers === 0 ? 0 : 1
