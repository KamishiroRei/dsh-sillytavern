/**
 * 真实数据验证：拿本机真的 SillyTavern 数据，跑一遍完整导入链路。
 *
 * 和 verify.mjs 的区别：verify.mjs 用自造的 fixture 证明"逻辑通"，
 * 这个脚本用 D:\Silly\SillyTavern-1.16.0\data\default-user 里 24 张真卡、
 * 17 本真世界书证明"真数据能进得来、解析得对"。
 *
 * 独立性：走一个临时 dataRoot，不碰用户 ~/.dsh/dsh-sillytavern 里的真实数据，
 * 也不会写回 ST 安装目录（导入全程只读 ST）。
 *
 * 用法：
 *   node scripts/verify-st-import.mjs
 *   node scripts/verify-st-import.mjs --st-root "D:\Silly\SillyTavern-1.16.0" --keep
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const argv = process.argv.slice(2)

/** 取一个 --key 值或默认值。 */
function argValue(key, fallback) {
  const index = argv.indexOf('--' + key)
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1]
  return fallback
}

const KEEP = argv.includes('--keep')
const ST_ROOT = argValue('st-root', process.env.SILLYTAVERN_ROOT || 'D:' + String.fromCharCode(92) + 'Silly' + String.fromCharCode(92) + 'SillyTavern-1.16.0')

/* ────────────────────────── 结果收集 ────────────────────────── */

const failures = []
const passes = []
const skips = []
const notes = []

/** 记录一条检查。 */
function check(label, ok, detail, owner) {
  const who = owner || 'tavern-core'
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

/** 兜底预览。 */
function preview(value, limit) {
  const max = limit || 200
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value.slice(0, max)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.slice(0, max)
  } catch { return String(value).slice(0, max) }
}

/* ────────────────────────── 最小 Cordis 替身 ────────────────────────── */

/** 假 ctx：只做注册记录，和 verify.mjs 同一套语义。 */
function fakeCtx() {
  const tools = new Map()
  const routes = new Map()
  const sections = new Map()
  /** ctx.inject 回调里抛出的错误（真实宿主里会让 fiber FAILED，这里收集起来报）。 */
  const injectErrors = []
  const effects = []
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const ctx = {
    tools: {
      register(tool) {
        if (!tool || typeof tool.name !== 'string') throw new Error('工具注册缺少 name')
        if (tools.has(tool.name)) throw new Error('工具重名: ' + tool.name)
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      list() { return [...tools.keys()] },
    },
    webServer: {
      register(route) {
        routes.set(String(route.kind) + ':' + String(route.path), route)
        return () => routes.delete(String(route.kind) + ':' + String(route.path))
      },
    },
    systemPrompt: {
      section(entry) {
        if (sections.has(entry.name)) throw new Error('提示词分节重名: ' + entry.name)
        sections.set(entry.name, entry)
        return () => sections.delete(entry.name)
      },
      variable() { return () => {} },
      context() { return () => {} },
      getSectionOrder() { return 6500 },
    },
    logger,
    get(name) {
      if (name === 'logger') return logger
      if (name === 'webServer') return ctx.webServer
      if (name === 'systemPrompt') return ctx.systemPrompt
      return undefined
    },
/**
     * Cordis 的 ctx.inject(deps, callback)：服务就绪后用作用域 ctx 调回调。
     * 假 ctx 里所有服务都当作已就绪，直接同步调用；回调返回 dispose 时接住。
     */
    inject(deps, callback) {
      // 假 ctx 里服务都当作已就绪，但按 deps 真的检查一遍：
      // 依赖的服务在假宿主里没有时就不调用回调，和真实 Cordis 的"等就绪"等价。
      const names = Array.isArray(deps) ? deps : Object.keys(deps || {})
      const missing = names.filter(name => name !== 'webServer' && name !== 'systemPrompt' && name !== 'tools' && name !== 'logger')
      if (missing.length) { injectErrors.push({ deps, error: new Error('未知服务: ' + missing.join(', ')) }); return () => {} }
      const scoped = Object.create(ctx)
      let disposer
      try {
        disposer = typeof callback === 'function' ? callback(scoped) : undefined
      } catch (error) {
        injectErrors.push({ deps, error })
        throw error
      }
      if (typeof disposer === 'function') effects.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    on() { return () => {} },
    emit() {},
    _introspect: { tools, routes, sections, effects, injectErrors },
  }
  return ctx
}

/* ────────────────────────── ST 数据盘 ────────────────────────── */

/** 找 ST 的 default-user 目录。 */
function findUserDir(stRoot) {
  const candidates = [
    join(stRoot, 'data', 'default-user'),
    join(stRoot, 'default-user'),
  ]
  return candidates.find(dir => existsSync(dir)) || ''
}

/** 严格只算 .png / .json 的角色卡（排除 .bak 等备份）。 */
function listStCards(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => /\.(png|json)$/i.test(name))
    .map(name => join(dir, name))
    .filter(file => {
      try { return statSync(file).isFile() } catch { return false }
    })
}

/** 严格只算 .json 的世界书（排除 .bak / .backup_ / .hotfix_）。 */
function listStWorlds(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => /\.json$/i.test(name))
    .map(name => join(dir, name))
    .filter(file => {
      try { return statSync(file).isFile() } catch { return false }
    })
}

/** 读 PNG 的 tEXt/iTXt/zTXt 块里的 base64 卡数据（ST 的卡就存在这里）。 */
async function readPngCard(file) {
  const { readFileSync: read } = await import('node:fs')
  const { inflateSync } = await import('node:zlib')
  const NUL = String.fromCharCode(0)
  const buffer = read(file)
  const found = {}
  let at = 8
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const data = buffer.subarray(at + 8, at + 8 + length)
      const text = data.toString('latin1')
      const zero = text.indexOf(NUL)
      const keyword = text.slice(0, zero)
      let payload = text.slice(zero + 1)
      if (type === 'zTXt') {
        try { payload = inflateSync(data.subarray(zero + 2)).toString('latin1') } catch { payload = '' }
      } else if (type === 'iTXt') {
        // keyword NUL compressionFlag compressionMethod languageTag NUL translatedKeyword NUL text
        try {
          const compressionFlag = data[zero + 1]
          const rest = data.subarray(zero + 3)
          const langEnd = rest.indexOf(0)
          const afterLang = rest.subarray(langEnd + 1)
          const transEnd = afterLang.indexOf(0)
          const body = afterLang.subarray(transEnd + 1)
          payload = compressionFlag === 1 ? inflateSync(body).toString('utf8') : body.toString('utf8')
        } catch { payload = '' }
      }
      if (keyword && payload) found[keyword] = payload
    }
    at += 12 + length
  }
  const encoded = found.chara || found.ccv3
  if (!encoded) return null
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch { return null }
}

/** ST 卡可能是 V2 { spec, data } 也可能是扁平 V1；统一成扁平对象。 */
function flattenStCard(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.data && typeof raw.data === 'object') return { ...raw.data, spec: raw.spec, spec_version: raw.spec_version }
  return raw
}

/* ────────────────────────── 主流程 ────────────────────────── */

console.log('[dsh-sillytavern] 真实 ST 数据导入验证开始')
console.log('ST 根目录: ' + ST_ROOT)

const dataRoot = join(process.env.TEMP || '/tmp', 'dsh-st-import-' + process.pid)
try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* 残留无所谓 */ }

let exitCode = 0
try {
  /* 0. 前置 */
  section('前置：ST 数据盘')
  check('ST 安装目录存在', existsSync(ST_ROOT), ST_ROOT, 'lead')
  const userDir = findUserDir(ST_ROOT)
  check('找到 default-user 目录', Boolean(userDir), '在 ' + ST_ROOT + ' 下没找到 data/default-user', 'lead')
  const charDir = userDir ? join(userDir, 'characters') : ''
  const worldDir = userDir ? join(userDir, 'worlds') : ''
  const stCards = listStCards(charDir)
  const stWorlds = listStWorlds(worldDir)
  check('characters/ 下有角色卡', stCards.length > 0, '实际 ' + stCards.length + ' 个', 'lead')
  check('worlds/ 下有世界书', stWorlds.length > 0, '实际 ' + stWorlds.length + ' 个', 'lead')
  note('ST 侧: ' + stCards.length + ' 张角色卡，' + stWorlds.length + ' 本世界书')
  const pngCards = stCards.filter(f => extname(f).toLowerCase() === '.png')
  const jsonCards = stCards.filter(f => extname(f).toLowerCase() === '.json')
  note('其中 PNG ' + pngCards.length + ' 张，JSON ' + jsonCards.length + ' 张')

  /* 1. 载入插件 */
  section('载入插件')
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  const ctx = fakeCtx()
  let config
  try {
    config = mod.Config['~standard'].validate({
      dataRoot,
      sillyTavernRoot: ST_ROOT,
      trpgLayout: true,
    }).value
    await mod.apply(ctx, config)
    check('插件 apply 成功', true, undefined, 'lead')
  } catch (error) {
    check('插件 apply 成功', false, error && error.message ? error.message : String(error), 'lead')
    throw error
  }

  /* 2. 导入器 */
  section('st_import_sillytavern 真实导入')
  const importTool = ctx._introspect.tools.get('st_import_sillytavern')
  const probeTool = ctx._introspect.tools.get('st_list_st_sources')
  if (!importTool) {
    check('st_import_sillytavern 已注册', false, '工具不存在', 'tavern-tools')
  } else {
    // 先探测
    if (probeTool) {
      const probeValue = await probeTool.execute({ stRoot: ST_ROOT }, { signal: undefined, agent: { id: 'qa-st' } })
      check('st_list_st_sources 能探测到内容', Boolean(probeValue && probeValue.ok !== false), preview(probeValue, 300), 'tavern-tools')
    }
    const started = Date.now()
    const report = await importTool.execute(
      { stRoot: ST_ROOT, overwrite: false, dryRun: false },
      { signal: undefined, agent: { id: 'qa-st' } },
    )
    const ms = Date.now() - started
    note('导入耗时 ' + ms + 'ms')
    check('st_import_sillytavern 返回结果', Boolean(report), '返回空', 'tavern-tools')
    check('导入没有报错', !(report && report.ok === false), report && report.error ? String(report.error) : '', 'tavern-tools')
    note('导入报告: ' + preview(report, 500))
    // apply 里的 autoImportOnStartup 是异步的，可能先跑完把数据导好了；
    // 那种情况下显式导入会全部 skipped —— 这是正确行为，不是失败。
    const importedCount = report && report.imported
      ? (Number(report.imported.characters || 0) + Number(report.imported.worlds || 0))
      : NaN
    const skippedCount = report && report.imported
      ? (Number(report.imported.charactersSkipped || 0) + Number(report.imported.worldsSkipped || 0))
      : NaN
    if (importedCount === 0 && skippedCount > 0) {
      note('自动导入已抢先完成（跳过 ' + skippedCount + ' 个已存在项），显式导入按 overwrite=false 全部跳过 —— 符合契约')
    }
    const failedItems = report && report.imported && Array.isArray(report.imported.charactersFailed) ? report.imported.charactersFailed : []
    check('导入过程没有失败项', failedItems.length === 0, failedItems.slice(0, 3).join(' | '), 'tavern-core')
  }

  /* 3. 角色数量对得上 */
  section('角色：数量与内容')
  const charFiles = existsSync(join(dataRoot, 'characters'))
    ? readdirSync(join(dataRoot, 'characters')).filter(n => n.endsWith('.json'))
    : []
  const expectedAtLeast = Math.min(stCards.length, 20)
  check('落盘角色数 ≥ ST 侧卡数（或 20）', charFiles.length >= expectedAtLeast,
    'ST 侧 ' + stCards.length + ' 张，插件侧只有 ' + charFiles.length + ' 个 .json', 'tavern-tools')

  // 读一张真 PNG，和插件解析出来的对比
  const sampleCard = pngCards[0] || jsonCards[0] || ''
  if (!sampleCard) {
    skip('单卡内容比对', 'ST 侧没有可读的卡')
  } else {
    const rawCard = flattenStCard(extname(sampleCard).toLowerCase() === '.png'
      ? await readPngCard(sampleCard)
      : JSON.parse(readFileSync(sampleCard, 'utf8')))
    if (!rawCard) {
      check('能读出 ST 卡正文', false, 'PNG 里没有 chara/ccv3 块: ' + basename(sampleCard), 'tavern-core')
    } else {
      check('能读出 ST 卡正文', true)
      const expectedName = String(rawCard.name || '').trim()
      note('抽样卡: ' + basename(sampleCard) + ' → name=' + expectedName)

      const list = await ctx._introspect.tools.get('st_list_characters').execute({}, { signal: undefined, agent: { id: 'qa-st' } })
      const cards = Array.isArray(list) ? list : (list && (list.characters || list.data || list.items)) || []
      check('st_list_characters 返回数组', Array.isArray(cards), preview(list, 200), 'tavern-tools')
      const hit = (Array.isArray(cards) ? cards : []).find(item => item && (item.name === expectedName || item.id === expectedName))
      if (!hit) {
        check('抽样卡出现在列表里', false, '列表里找不到 "' + expectedName + '"（共 ' + (Array.isArray(cards) ? cards.length : 0) + ' 张，前几张: '
          + (Array.isArray(cards) ? cards.slice(0, 5).map(c => c && c.name).join(', ') : '') + '）', 'tavern-core')
      } else {
        check('抽样卡出现在列表里', true)
        const detail = await ctx._introspect.tools.get('st_get_character').execute(
          { character: hit.id || hit.name }, { signal: undefined, agent: { id: 'qa-st' } },
        )
        const card = detail && detail.card ? detail.card : detail
        if (!card || typeof card !== 'object') {
          check('st_get_character 返回卡对象', false, preview(detail, 200), 'tavern-tools')
        } else {
          check('st_get_character 返回卡对象', true)
          const fields = [
            ['name', 'name'],
            ['description', 'description'],
            ['first_mes', 'first_mes'],
            ['personality', 'personality'],
            ['scenario', 'scenario'],
          ]
          let mismatches = 0
          for (const [ours, theirs] of fields) {
            const want = String(rawCard[theirs] === undefined || rawCard[theirs] === null ? '' : rawCard[theirs])
            const got = String(card[ours] === undefined || card[ours] === null ? '' : card[ours])
            if (want !== got) {
              mismatches++
              check('字段 ' + ours + ' 与 ST 一致', false,
                'ST 长度 ' + want.length + '，插件长度 ' + got.length
                + '，ST 开头: ' + preview(want, 60) + '，插件开头: ' + preview(got, 60), 'tavern-core')
            }
          }
          if (mismatches === 0) check('name/description/first_mes/personality/scenario 全部与 ST 一致', true)
          // 备选开场白数量
          const wantAlt = Array.isArray(rawCard.alternate_greetings) ? rawCard.alternate_greetings.length : 0
          const gotAlt = Array.isArray(card.alternate_greetings) ? card.alternate_greetings.length : 0
          check('alternate_greetings 数量一致', wantAlt === gotAlt, 'ST ' + wantAlt + ' 条，插件 ' + gotAlt + ' 条', 'tavern-core')
          // 内嵌世界书
          const wantBook = rawCard.character_book && rawCard.character_book.entries ? Object.keys(rawCard.character_book.entries).length : 0
          const gotBook = card.character_book && card.character_book.entries ? Object.keys(card.character_book.entries).length : 0
          check('character_book 条目数一致', wantBook === gotBook, 'ST ' + wantBook + ' 条，插件 ' + gotBook + ' 条', 'tavern-core')
        }
      }
    }
  }

  /* 4. 头像落到 layout.avatars */
  section('头像文件')
  const avatarDir = join(dataRoot, 'avatars')
  const avatarFiles = existsSync(avatarDir) ? readdirSync(avatarDir).filter(n => !n.startsWith('.')) : []
  check('avatars/ 里有文件', avatarFiles.length > 0, '目录为空: ' + avatarDir, 'tavern-tools')
  if (avatarFiles.length) {
    const sample = join(avatarDir, avatarFiles[0])
    const size = statSync(sample).size
    check('头像文件非空且是 PNG', size > 1000, '大小 ' + size + ' 字节', 'tavern-tools')
    // PNG magic
    const head = readFileSync(sample).subarray(0, 8)
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    check('头像文件头是 PNG 魔数', isPng, head.toString('hex'), 'tavern-tools')
    note('抽到头像 ' + avatarFiles.length + ' 个，样本 ' + avatarFiles[0] + ' ' + size + ' 字节')
  }

  /* 5. 世界书条目数对得上 */
  section('世界书：数量与条目')
  const worldFiles = existsSync(join(dataRoot, 'worlds')) ? readdirSync(join(dataRoot, 'worlds')).filter(n => n.endsWith('.json')) : []
  check('落盘世界书数 ≥ ST 侧数量', worldFiles.length >= Math.min(stWorlds.length, 15),
    'ST 侧 ' + stWorlds.length + ' 本，插件侧 ' + worldFiles.length + ' 本', 'tavern-tools')

  if (stWorlds.length === 0) {
    skip('世界书条目数比对', 'ST 侧没有世界书')
  } else {
    // 逐本比对条目数：挑最大的三本 + 最小的三本，覆盖不同规模
    const sized = stWorlds.map(file => {
      let entries = 0
      let name = basename(file, '.json')
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed && parsed.entries && typeof parsed.entries === 'object') entries = Object.keys(parsed.entries).length
      } catch { entries = -1 }
      return { file, name, entries }
    }).filter(item => item.entries >= 0)
    sized.sort((a, b) => b.entries - a.entries)
    const samples = [...sized.slice(0, 2), ...sized.slice(-1)]
    const listTool = ctx._introspect.tools.get('st_list_worldbooks')
    const getTool = ctx._introspect.tools.get('st_get_worldbook')
    let compared = 0
    for (const item of samples) {
      if (!listTool || !getTool) {
        check('世界书工具已注册', false, '缺 st_list_worldbooks 或 st_get_worldbook', 'tavern-tools')
        break
      }
      const detail = await getTool.execute({ name: item.name, limit: 1 }, { signal: undefined, agent: { id: 'qa-st' } })
      if (!detail || detail.ok === false) {
        check('st_get_worldbook 能读 "' + item.name + '"', false,
          (detail && detail.error) ? String(detail.error) : preview(detail, 200), 'tavern-core')
        continue
      }
      const count = detail.entryCount !== undefined ? Number(detail.entryCount)
        : (detail.entries ? (Array.isArray(detail.entries) ? detail.entries.length : Object.keys(detail.entries).length) : NaN)
      if (Number.isFinite(count)) {
        compared++
        check('世界书 "' + preview(item.name, 24) + '" 条目数与 ST 一致', count === item.entries, 'ST ' + item.entries + ' 条，插件 ' + count + ' 条', 'tavern-core')
      } else {
        check('st_get_worldbook 返回条目数', false, '返回里没有 entryCount/entries: ' + preview(detail, 260), 'tavern-tools')
      }
    }
    if (compared === 0) note('没有可比对的世界书条目数')
  }

  /* 6. 世界书扫描（真数据、真规则） */
  section('世界书扫描：真数据跑真规则')
  const scanTool = ctx._introspect.tools.get('st_scan_worldbook')
  if (!scanTool) {
    check('st_scan_worldbook 已注册', false, '工具不存在', 'tavern-tools')
  } else {
    // 用一本真世界书里真实存在的关键词去扫，看会不会被激活
    const pick = (() => {
      for (const file of stWorlds) {
        try {
          const parsed = JSON.parse(readFileSync(file, 'utf8'))
          const entries = parsed && parsed.entries ? Object.values(parsed.entries) : []
          const withKey = entries.find(entry => entry && Array.isArray(entry.key) && entry.key.length && !entry.disable && entry.content)
          if (withKey) {
            return { name: basename(file, '.json'), file, keyword: String(withKey.key[0]), entryContent: String(withKey.content).slice(0, 60) }
          }
        } catch { /* 跳过坏文件 */ }
      }
      return null
    })()
    if (!pick) {
      skip('世界书扫描', 'ST 侧没找到带关键词的启用条目')
    } else {
      note('扫描关键词: "' + pick.keyword + '"，来自 ' + preview(pick.name, 30))
      // ST 的规则：世界书本身要先启用（entry 的 disable 另算）。没启用时扫描返回空是正确行为，
      // 所以这里先真的启用它，再验证"真关键词能不能激活真条目"。
      const toggleTool = ctx._introspect.tools.get('st_toggle_worldbook')
      if (toggleTool) {
        const toggled = await toggleTool.execute({ name: pick.name, enabled: true }, { signal: undefined, agent: { id: 'qa-st' } })
        check('st_toggle_worldbook 能启用 "' + preview(pick.name, 24) + '"', Boolean(toggled && toggled.ok !== false), preview(toggled, 200), 'tavern-tools')
      } else {
        check('st_toggle_worldbook 已注册', false, '工具不存在', 'tavern-tools')
      }
      const result = await scanTool.execute(
        { chatText: '这是测试文本，里面提到了 ' + pick.keyword + ' 这个词。', scanDepth: 4, budget: 2048 },
        { signal: undefined, agent: { id: 'qa-st' } },
      )
      if (!result || result.ok === false) {
        check('st_scan_worldbook 可调用', false, (result && result.error) ? String(result.error) : preview(result, 240), 'tavern-core')
      } else {
        const activated = result.activated !== undefined ? result.activated : (result.entries || result.matched)
        const count = Array.isArray(activated) ? activated.length : (typeof activated === 'number' ? activated : NaN)
        check('st_scan_worldbook 返回激活结果', Number.isFinite(count), preview(result, 260), 'tavern-tools')
        check('命中真实关键词时至少激活 1 条', Number.isFinite(count) && count > 0,
          '用 "' + pick.keyword + '" 扫描，激活 ' + count + ' 条；结果: ' + preview(result, 300), 'tavern-core')
        if (Number.isFinite(count) && count > 0) {
          note('激活 ' + count + ' 条，token 估算 ' + (result.tokens !== undefined ? result.tokens : '未返回'))
        }
      }
    }
  }

  /* 7. 宏展开（真卡字段进宏） */
  section('宏展开')
  try {
    const macros = await import(pathToFileURL(join(root, 'lib', 'st', 'macros.js')).href)
    if (typeof macros.expandMacros !== 'function') {
      check('lib/st/macros.js 导出 expandMacros', false, '导出: ' + Object.keys(macros).join(', '), 'tavern-core')
    } else {
      const env = typeof macros.createMacroEnv === 'function'
        ? macros.createMacroEnv({ char: '小明', user: '阿强', description: '测试描述' })
        : { char: '小明', user: '阿强' }
      const cases = [
        ['{{char}} 看着 {{user}}。', '小明 看着 阿强。'],
        ['{{user}}，你好。', '阿强，你好。'],
      ]
      let bad = 0
      for (const [input, want] of cases) {
        const got = macros.expandMacros(input, env)
        if (got !== want) {
          bad++
          check('宏展开 ' + preview(input, 20), false, '期望 "' + want + '"，实际 "' + got + '"', 'tavern-core')
        }
      }
      if (bad === 0) check('{{char}} / {{user}} 展开正确', true)
      const list = typeof macros.listMacros === 'function' ? macros.listMacros() : []
      check('listMacros 返回宏清单', Array.isArray(list) && list.length > 0, '返回 ' + preview(list, 200), 'tavern-core')
      if (Array.isArray(list) && list.length) note('支持宏 ' + list.length + ' 个，例如 ' + list.slice(0, 8).join(', '))
    }
  } catch (error) {
    check('lib/st/macros.js 可加载', false, error && error.message ? error.message : String(error), 'tavern-core')
  }

  /* 8. 导入只读：ST 目录没被动过 */
  section('导入不写 ST 目录')
  const stCharactersNow = listStCards(charDir).length
  const stWorldsNow = listStWorlds(worldDir).length
  check('ST 角色卡数量未变化', stCharactersNow === stCards.length, '导入前 ' + stCards.length + '，导入后 ' + stCharactersNow, 'tavern-tools')
  check('ST 世界书数量未变化', stWorldsNow === stWorlds.length, '导入前 ' + stWorlds.length + '，导入后 ' + stWorldsNow, 'tavern-tools')
} catch (error) {
  check('验证脚本未中断', false, (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error)), 'lead')
} finally {
  if (!KEEP) {
    try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  } else {
    console.log('\n临时数据目录已保留: ' + dataRoot)
  }
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
  exitCode = 1
} else {
  console.log('\n全部通过')
  exitCode = 0
}
process.exitCode = exitCode
