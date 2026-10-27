/**
 * GM 协议：让模型用**标记**说话，系统把标记渲染成界面。
 *
 * 铁律（来自 TrpgRecode 的 gm-standard / gm-protocol）：
 *   - AI 只写标记，前端渲染界面；模型不写 HTML/CSS。
 *   - 骰子与判定由引擎算，模型只负责描述。
 *   - HP/资源/物品/状态由工具精确更新，不允许模型自己编数字。
 *
 * 本模块提供三件事：
 *   1. parseGmMarkers(text)  从模型回复里拆出结构化请求，返回干净正文
 *   2. GM_SYSTEM_PROMPT      注入给模型的带团规则（中文，800~1500 字）
 *   3. formatCheckBlock()    把判定结果排成用户熟悉的 <dice> 六行块
 *
 * 同时支持两套写法，老习惯不丢：
 *   方括号写法（简短，适合普通对话）
 *     [判定] 感知 (DC 15)
 *     [状态] 生命 -8 → 24/32
 *     [获得] 生锈的钥匙 x1
 *     [地图] 移动到 (5,3)
 *     [选项] 推门进去 | 绕到后巷 | 原地观察
 *   TrpgRecode 的块写法（信息更全，适合正式结算）
 *     <dice> 六行块 </dice>
 *     <battlecheck> 七行块 </battlecheck>
 *     <UpdateVariable><Analysis>…</Analysis><JSONPatch>[…]</JSONPatch></UpdateVariable>
 *     [[turn:end]]、[[event:hit|A|B|detail]]、[[map:bg:path]]、<portrait>、<illustration>
 */

/** 方括号标记名，全部大小写不敏感。 */
const BRACKET_TAGS = ['判定', '状态', '获得', '失去', '地图', '选项', '事件', '场景']

/**
 * 从一行里拆「标记名 + 内容」。
 * @param {string} line 单行文本
 * @returns {{ tag: string, body: string }|null} 不是标记行返回 null
 */
function readBracketLine(line) {
  const match = /^\s*[【[]\s*([^】\]]{1,8})\s*[】\]]\s*(.*)$/.exec(line)
  if (!match) return null
  const tag = match[1].trim()
  if (!BRACKET_TAGS.includes(tag)) return null
  return { tag, body: match[2].trim() }
}

/** 解析「(DC 15)」这类难度尾巴，返回 { text, dc }。 */
function splitDc(body) {
  let text = String(body || '')
  let dc = null
  let targetValue = null
  const dcMatch = /[（(]\s*(?:dc|难度|DC|Difficulty)\s*[:：]?\s*(\d+)\s*[)）]/i.exec(text)
  if (dcMatch) {
    dc = Number.parseInt(dcMatch[1], 10)
    text = text.replace(dcMatch[0], '').trim()
  }
  const targetMatch = /[（(]\s*(?:目标值|目标|技能值|TV)\s*[:：]?\s*(\d+)\s*[)）]/i.exec(text)
  if (targetMatch) {
    targetValue = Number.parseInt(targetMatch[1], 10)
    text = text.replace(targetMatch[0], '').trim()
  }
  // 也接受裸的 "DC 15" 写在行尾
  if (dc === null) {
    const bare = /(?:^|\s)(?:dc|难度)\s*[:：]?\s*(\d+)\s*$/i.exec(text)
    if (bare) {
      dc = Number.parseInt(bare[1], 10)
      text = text.slice(0, bare.index).trim()
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), dc, targetValue }
}

/** 解析「-8 → 24/32」这类生命变动。 */
function parseHpChange(body) {
  const text = String(body || '')
  // 写法一：生命 -8 → 24/32
  const arrow = /^(生命|hp|HP|血量|生命值)\s*([+-]\s*\d+)\s*(?:→|->|=>|=|变成?)\s*(\d+)\s*\/\s*(\d+)$/i.exec(text)
  if (arrow) {
    return { field: 'hp', delta: Number.parseInt(arrow[2].replace(/\s+/g, ''), 10), cur: Number.parseInt(arrow[3], 10), max: Number.parseInt(arrow[4], 10) }
  }
  // 写法二：生命 -8
  const bare = /^(生命|hp|HP|血量|生命值)\s*([+-]\s*\d+)\s*$/i.exec(text)
  if (bare) return { field: 'hp', delta: Number.parseInt(bare[2].replace(/\s+/g, ''), 10), cur: null, max: null }
  // 写法三：生命 24/32
  const set = /^(生命|hp|HP|血量|生命值)\s*(\d+)\s*\/\s*(\d+)$/i.exec(text)
  if (set) return { field: 'hp', delta: null, cur: Number.parseInt(set[2], 10), max: Number.parseInt(set[3], 10) }
  return null
}

/** 解析物品行：「生锈的钥匙 x1」「火把×2，绳子」。 */
function parseItemLine(body) {
  return String(body || '')
    .split(/[,，、]/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const match = /^(.*?)\s*[x×*]\s*(\d+)\s*$/i.exec(chunk)
      if (match) return { name: match[1].trim(), qty: Number.parseInt(match[2], 10) }
      return { name: chunk, qty: 1 }
    })
    .filter((item) => item.name)
}

/** 解析坐标：「移动到 (5,3)」「阿拉贡 移动到 (5,3)」「亮雾 (5,3) 3」。 */
function parseMove(body) {
  const text = String(body || '').trim()
  let match = /^(.*?)(?:移动到|移动至|走到|前往|move\s*to)\s*[（(]\s*(-?\d+)\s*[,，]\s*(-?\d+)\s*[)）]\s*$/i.exec(text)
  if (match) {
    return {
      action: 'move',
      who: match[1].trim() || null,
      x: Number.parseInt(match[2], 10),
      y: Number.parseInt(match[3], 10),
    }
  }
  match = /^(.*?)(?:亮雾|揭雾|揭开迷雾|reveal)\s*[（(]?\s*(-?\d+)\s*[,，]\s*(-?\d+)\s*[)）]?\s*(?:半径)?\s*(\d+)?\s*$/i.exec(text)
  if (match) {
    return {
      action: 'reveal',
      who: match[1].trim() || null,
      x: Number.parseInt(match[2], 10),
      y: Number.parseInt(match[3], 10),
      radius: match[4] ? Number.parseInt(match[4], 10) : null,
    }
  }
  return null
}

/** 解析「a | b | c」选项。 */
function parseChoices(body) {
  return String(body || '')
    .split(/[|｜/]/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
}

/** 判断某段是否被某个成对标签包住，返回内容与匹配区间的列表。 */
function collectBlock(text, tag) {
  const results = []
  const open = '<' + tag
  let cursor = 0
  for (;;) {
    const start = text.indexOf(open, cursor)
    if (start < 0) break
    const headEnd = text.indexOf('>', start)
    if (headEnd < 0) break
    const closeTag = '</' + tag + '>'
    const end = text.indexOf(closeTag, headEnd)
    if (end < 0) break
    const header = text.slice(start + 1, headEnd)
    const inner = text.slice(headEnd + 1, end)
    results.push({ start, end: end + closeTag.length, header, inner })
    cursor = end + closeTag.length
  }
  return results
}

/** 把块内文本按行切开并去掉序号前缀。 */
function blockLines(inner) {
  return String(inner || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.、)）]\s*/, '').trim())
    .filter(Boolean)
}

/**
 * 解析模型回复里的全部 GM 标记。
 * @param {string} text 模型回复原文
 * @returns {{
 *   checks: Array<Object>,       判定请求（方括号 [判定] 或 <dice>/<battlecheck>）
 *   stateChanges: Array<Object>, 状态/数值变更（[状态] 与 UpdateVariable 的 JSONPatch）
 *   items: Array<Object>,        获得/失去物品
 *   moves: Array<Object>,        地图移动与揭雾
 *   choices: string[],           给玩家的选项按钮
 *   scenes: Array<Object>,       场景切换/插图请求
 *   events: Array<Object>,       事件总线（[[event:]] 与 [事件]）
 *   portraits: Array<Object>,    立绘指令
 *   patches: Array<Object>,      UpdateVariable 里的 RFC6902 补丁
 *   turnEnd: boolean,            是否要求结束当前行动（[[turn:end]]）
 *   mapBackground: string|null,  地图背景切换（[[map:bg:path]]）
 *   cleanText: string,           去掉全部标记后的正文
 * }}
 * @throws {Error} 入参不是字符串时抛中文错误
 */
export function parseGmMarkers(text) {
  if (typeof text !== 'string') throw new Error('parseGmMarkers 需要一个字符串，收到 ' + typeof text)
  const checks = []
  const stateChanges = []
  const items = []
  const moves = []
  const choices = []
  const scenes = []
  const events = []
  const portraits = []
  const patches = []
  let turnEnd = false
  let mapBackground = null

  let working = text

  // ── 1. TrpgRecode 的块标记 ────────────────────────────────────────────────
  for (const tag of ['dice', 'battlecheck', 'char_info', 'UpdateVariable', 'portrait', 'illustration']) {
    for (const block of collectBlock(working, tag)) {
      const lines = blockLines(block.inner)
      if (tag === 'dice') {
        checks.push({
          source: 'dice-block',
          kind: 'check',
          skill: lines[0] || '',
          target: lines[1] || '',
          context: lines[2] || '',
          detail: lines[3] || '',
          result: lines[4] || '',
          description: lines.slice(5).join(' '),
          raw: block.inner.trim(),
        })
      } else if (tag === 'battlecheck') {
        checks.push({
          source: 'battlecheck-block',
          kind: 'battle',
          actor: lines[0] || '',
          target: lines[1] || '',
          action: lines[2] || '',
          checkType: lines[3] || '',
          detail: lines[4] || '',
          result: lines[5] || '',
          description: lines.slice(6).join(' '),
          raw: block.inner.trim(),
        })
      } else if (tag === 'char_info') {
        scenes.push({ source: 'char_info', kind: 'character-info', yaml: block.inner.trim() })
      } else if (tag === 'UpdateVariable') {
        const analysisMatch = /<Analysis>([\s\S]*?)<\/Analysis>/i.exec(block.inner)
        const patchMatch = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/i.exec(block.inner)
        let parsedPatch = []
        if (patchMatch) {
          try {
            const value = JSON.parse(patchMatch[1].trim())
            if (Array.isArray(value)) parsedPatch = value
            else if (value && typeof value === 'object') parsedPatch = [value]
          } catch {
            // 模型偶尔会写坏 JSON：不抛错，把原文留给人看
            stateChanges.push({ source: 'UpdateVariable', kind: 'malformed-patch', raw: patchMatch[1].trim() })
          }
        }
        for (const patch of parsedPatch) {
          if (!patch || typeof patch !== 'object') continue
          patches.push(patch)
          stateChanges.push({
            source: 'UpdateVariable',
            kind: 'patch',
            op: String(patch.op || ''),
            path: String(patch.path || ''),
            value: patch.value === undefined ? null : patch.value,
            analysis: analysisMatch ? analysisMatch[1].trim() : '',
          })
        }
      } else if (tag === 'portrait') {
        const header = block.header.replace(/^portrait/i, '').trim()
        const nameMatch = /name\s*=\s*"([^"]*)"/i.exec(header) || /name\s*=\s*'([^']*)'/i.exec(header)
        const clear = /clear/i.test(header) || /clear/i.test(block.inner.trim())
        portraits.push({ name: nameMatch ? nameMatch[1] : '', text: clear ? '' : block.inner.trim(), clear })
      } else if (tag === 'illustration') {
        const header = block.header.replace(/^illustration/i, '').trim()
        const srcMatch = /src\s*=\s*"([^"]*)"/i.exec(header) || /src\s*=\s*'([^']*)'/i.exec(header)
        const captionMatch = /caption\s*=\s*"([^"]*)"/i.exec(header) || /caption\s*=\s*'([^']*)'/i.exec(header)
        const clear = /clear/i.test(header) || /clear/i.test(block.inner.trim())
        scenes.push({
          source: 'illustration',
          kind: 'illustration',
          src: srcMatch ? srcMatch[1] : '',
          caption: captionMatch ? captionMatch[1] : '',
          text: clear ? '' : block.inner.trim(),
          clear,
        })
      }
    }
    // 不论解析成功与否，块标记都不该出现在正文里
    for (const block of collectBlock(working, tag).reverse()) {
      working = working.slice(0, block.start) + working.slice(block.end)
    }
  }

  // ── 2. [[...]] 双括号标记 ─────────────────────────────────────────────────
  working = working.replace(/\[\[([^\]]+)\]\]/g, (whole, inner) => {
    const body = String(inner).trim()
    if (/^turn\s*:\s*end$/i.test(body)) {
      turnEnd = true
      return ''
    }
    if (/^map\s*:\s*bg\s*:/i.test(body)) {
      mapBackground = body.replace(/^map\s*:\s*bg\s*:/i, '').trim()
      return ''
    }
    if (/^event\s*:/i.test(body)) {
      const parts = body.replace(/^event\s*:\s*/i, '').split('|')
      events.push({
        source: 'event-tag',
        type: (parts[0] || '').trim(),
        from: (parts[1] || '').trim(),
        target: (parts[2] || '').trim(),
        detail: parts.slice(3).join('|').trim(),
      })
      return ''
    }
    return whole
  })

  // ── 3. 方括号行标记（逐行） ───────────────────────────────────────────────
  const keptLines = []
  for (const line of working.split(/\r?\n/)) {
    const parsed = readBracketLine(line)
    if (!parsed) {
      keptLines.push(line)
      continue
    }
    const { tag, body } = parsed
    if (tag === '判定') {
      const info = splitDc(body)
      checks.push({ source: 'bracket', kind: 'check', text: info.text, dc: info.dc, targetValue: info.targetValue })
    } else if (tag === '状态') {
      const hp = parseHpChange(body)
      if (hp) stateChanges.push({ source: 'bracket', kind: 'hp', ...hp })
      else stateChanges.push({ source: 'bracket', kind: 'status', text: body })
    } else if (tag === '获得') {
      for (const item of parseItemLine(body)) items.push({ source: 'bracket', op: 'add', ...item })
    } else if (tag === '失去') {
      for (const item of parseItemLine(body)) items.push({ source: 'bracket', op: 'remove', ...item })
    } else if (tag === '地图') {
      const move = parseMove(body)
      if (move) moves.push({ source: 'bracket', ...move })
      else moves.push({ source: 'bracket', action: 'other', text: body })
    } else if (tag === '选项') {
      for (const choice of parseChoices(body)) choices.push(choice)
    } else if (tag === '事件') {
      const parts = body.split('|')
      events.push({
        source: 'bracket',
        type: (parts[0] || '').trim(),
        from: (parts[1] || '').trim(),
        target: (parts[2] || '').trim(),
        detail: parts.slice(3).join('|').trim(),
      })
    } else if (tag === '场景') {
      scenes.push({ source: 'bracket', kind: 'scene', text: body })
    }
    // 标记行整行从正文里去掉
  }

  const cleanText = keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    checks,
    stateChanges,
    items,
    moves,
    choices,
    scenes,
    events,
    portraits,
    patches,
    turnEnd,
    mapBackground,
    cleanText,
  }
}

/**
 * 把一次判定结果排成用户熟悉的 <dice> 六行块。
 * 行序固定：发动技能 / 目标 / 情境 / 检定细节 / 判定结果 / 结果描述。
 * @param {Object} result abilityCheck() 或 opposedCheck() 的返回
 * @param {{ target?: string, context?: string, description?: string }} [options]
 * @returns {string} 可直接贴进回复的块文本
 */
export function formatCheckBlock(result, options = {}) {
  if (!result || typeof result !== 'object') throw new Error('formatCheckBlock 需要一个判定结果')
  const skill = result.label || result.skill || result.attribute || '检定'
  const target = options.target || (result.dc !== undefined ? 'DC ' + result.dc : '')
  const context = options.context || ''
  const detail = result.breakdown || ''
  const verdict = result.degree || (result.success ? '成功' : '失败')
  const description = options.description || result.narration || ''
  return [
    '<dice>',
    skill,
    target,
    context,
    detail,
    verdict,
    description,
    '</dice>',
  ].join('\n')
}

/**
 * 把一次战斗结算排成 <battlecheck> 七行块。
 * 行序固定：发动者 / 目标 / 行动 / 检定类型 / 检定细节 / 判定结果 / 战果描述。
 * @param {{
 *   actor: string, target: string, action: string, checkType: string,
 *   detail: string, result: string, description: string,
 * }} input
 * @returns {string} 可直接贴进回复的块文本
 * @throws {Error} 缺少发动者或目标时抛中文错误
 */
export function formatBattleBlock(input = {}) {
  if (!input.actor) throw new Error('formatBattleBlock 需要发动者（actor）')
  if (!input.target) throw new Error('formatBattleBlock 需要目标（target）')
  return [
    '<battlecheck>',
    String(input.actor),
    String(input.target),
    String(input.action || ''),
    String(input.checkType || ''),
    String(input.detail || ''),
    String(input.result || ''),
    String(input.description || ''),
    '</battlecheck>',
  ].join('\n')
}

/**
 * 注入给模型的 GM 规则。这一段是跑团体验的地基，每次请求都会读到。
 * 取材自 TrpgRecode 的 gm-standard，按「模型真的会照做」的粒度重写：
 * 只写行为准则，不写平台实现。
 */
export const GM_SYSTEM_PROMPT = [
  '你是这场桌面角色扮演的 GM：规则的中立执行者、世界的沉默维护者。',
  '你负责判定、扮演 NPC、推进世界；玩家负责决定自己的角色做什么。你不自称 GM，也不在叙事里点评自己。',
  '',
  '## 什么时候掷骰',
  '只在结果不确定、且失败会有代价时才判定。走路、说话、拿桌上的杯子不判。',
  '玩家描述的行动如果必然成功或必然失败，就直接叙述结果，不要为了"有仪式感"硬掷。',
  '需要判定时，调用 trpg_check 拿结果，不要自己编数字。难度参考：简单 10、中等 15、困难 20、极难 25、几乎不可能 30。',
  '',
  '## 怎么描述判定结果',
  '把骰子结果翻译成**发生了什么**，不要念数字。',
  '不要写"你掷出了 17，对抗 DC 15，成功了"。要写"锁芯在你第三次试探时终于让开，发出一声轻响"。',
  '成功与失败都要写出具体的**代价与收获**。失败不是"什么都没发生"，是"发生了什么坏事"或"时间/资源被消耗掉了"。',
  '大成功和大失败只由裸骰决定，加值再高也不能把普通成功升成大成功。不要因为同情玩家而放水。',
  '',
  '## 状态必须走工具',
  '任何 HP、资源、物品、状态（中毒/眩晕/流血）的变化，用 trpg_update_sheet 或 trpg_log 落地，',
  '绝不在正文里自己编一个"你现在剩 24 点生命"——你没有权威数字。',
  '需要在正文里体现数值时，等工具返回真实值后再写。',
  '',
  '## 战斗',
  '严格按先攻顺序行动（trpg_start_encounter / trpg_next_turn）。不是当前行动者的动作不能插入。',
  '轮到敌人就替敌人行动，不要停下来等玩家批准。',
  '敌人不是沙包：会集火、会利用弱点、会撤退、会求援。0 生命就按规则倒下，不安排奇迹救援。',
  '',
  '## 地图与场景',
  '需要走位或战斗才用地图（trpg_show_map）；纯叙事用场景（trpg_update_scene）就够了，不要重复叠加。',
  '只描述角色当前视野内看得到的东西。没探索的地方不讲，不剧透、不给安全网。',
  '',
  '## 叙事原则',
  '感官优先：先给声音、气味、温度、光线这类能让人身临其境的细节，再给信息。',
  '留出选择：每次推进到需要决断的地方就停，给出 2~4 个具体可行的方向，不要替玩家选。',
  '不抢玩家行动权：不写"你决定推开门"，写"门在你面前，门缝里透出冷风"。',
  '世界不围着玩家转：NPC 有自己的动机，事情会在玩家不在场时也发生变化。',
  '拒绝主角光环：可以欺骗、伏击、囚禁、伤害玩家的角色，也可以在玩家犯错时真的让他付出代价。',
  '',
  '## 输出格式',
  '正文就是叙事，用中文，不要写 HTML/CSS/markdown 表格——界面由系统渲染。',
  '需要给玩家明确选项时，用一行：[选项] 推门进去 | 绕到后巷 | 原地观察',
  '需要落地数值变更时优先调用工具；工具不可用时才用标记：[状态] 生命 -8',
  '',
  '## 舞台：你想给玩家看什么，就设计什么',
  '中间那块区域叫舞台。它不是固定界面，是一块空白画布：**形状由你按当前情境决定**。',
  '战斗可能是一张格子图 + 血量条 + 先攻顺序；探索可能是一张场景图 + 地点说明；',
  '社交可能是一张人物关系表；解谜可能是线索墙；也可能什么都不需要。',
  '没有模板，没有必填项。不要为了用功能而硬造面板。',
  '',
  '### 什么时候更新',
  '舞台内容有变化才更新，没变化就不要动它。',
  '数值变了用 stage_patch 改那一块；情境整个换了用 stage_publish mode=replace 重来；',
  '结束战斗/离开场景用 stage_clear。',
  '**永远不要每轮重发一遍完整界面**——玩家已经看得到的东西不需要再说一遍。',
  '一次 stage_patch 只写真正变化的部分，一两个操作就够，不要为了更新而把所有块重写。',
  '',
  '### 不要用文字复述界面',
  '叙事只写玩家**感知到**的东西，不写界面状态。',
  '不要写「地图上显示你在(5,3)」，写「你踩到第三块松动的地砖，脚下传来空腔的回响」。',
  '不要写「HP 剩余 24」，写「肋骨下面火烧一样，每次呼吸都要停半拍」。',
  '',
  '### 对话里的图',
  '有时一张图比一千字管用（地形示意、关系图、时间线、谜题线索）。',
  '这种时候用 render_canvas / render_ui / render_text 直接在回复里生成一张，它是**一次性**的叙述辅助。',
  '一次性图不要每轮重生成；只有信息真的变了才值得新的一张。',
  '',  '## 带团节奏',
  '一次只推进一个节拍，然后停下等玩家。不要一口气把整幕演完。',
  '开场前先和玩家确认：角色为什么来、怎么登场、从哪儿开始。确认完再正式开场。',
].join('\n')
