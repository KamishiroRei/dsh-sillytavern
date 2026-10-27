/**
 * 跑团工具（模型可见）。
 *
 * 设计原则（TrpgRecode GM 协议）：
 *   - 骰子和判定交给系统，故事交给 AI：模型调用工具拿真实结果，不自己编数字。
 *   - 变量精确管理：HP/资源/物品/状态由工具落地，不靠模型记忆。
 *   - AI 只写标记：结构化数据都进存档，模型只管叙事。
 *
 * 工具名一律 trpg_ 前缀（CONTRACTS.md 的硬约定）。
 * 另外导出 getTrpgState() 给 routes.js 用，前端三栏从那里取数据。
 */
/**
 * 地图变更视图。
 * full 为 true 时返回整图（客户端首次渲染用）；否则只返回这次变了什么。
 * 地图是「维护一份状态」而不是「每轮重新描述」，所以默认走增量。
 * @param {Object|null} prev 改动前的地图
 * @param {Object} next 改动后的地图
 * @param {boolean} [full] 是否返回全量
 * @returns {Object} 全量 mapView 或增量 diff
 */
function mapDelta(prev, next, full) {
  if (full === true) return mapView(next)
  return diffMaps(prev, next)
}
import { defineTool } from '../toolkit.js'
import { sessionIdOf } from '../session.js'
import { readDoc, writeDoc, sessionDir, touchMeta, sessionIdFor } from '../trpg/persist.js'
import { rollDice, rollDamage } from '../trpg/dice.js'
import { abilityCheck, opposedCheck, normalizeSystem } from '../trpg/check.js'
import {
  addSheet,
  listSheets,
  findSheet,
  updateSheet,
  saveSheet,
  removeSheet,
  applyDamage as applySheetDamage,
  describeSheet,
  sheetPanelView,
} from '../trpg/sheet.js'
import {
  createEncounter,
  encounterFromSheets,
  nextTurn,
  applyDamage as applyEncounterDamage,
  addCombatStatus,
  endEncounter,
  encounterView,
} from '../trpg/encounter.js'
import {
  createMap,
  generateDungeon,
  setCell,
  paintCells,
  fillRect,
  addToken,
  moveToken,
  removeToken,
  revealFog,
  addFeature,
  mapView,
  diffMaps,
  isEmptyDelta,
  checkConnectivity,
  renderAscii,
} from '../trpg/map.js'
import { createScene, updateScene, sceneView, describeScene } from '../trpg/scene.js'
import { appendLog, readLog } from '../trpg/log.js'
import { parseGmMarkers, GM_SYSTEM_PROMPT } from '../trpg/protocol.js'
import { METER_ASSETS, PANEL_ASSETS } from '../trpg/icons.js'

/** 从 exec 里取会话 id：优先 DSH 会话，没有则用 default 存档。 */
function sid(exec) {
  return sessionIdFor(sessionIdOf(exec))
}

/** 读地图存档。 */
function loadMap(state, sessionId) {
  return readDoc(state, sessionId, 'map', null)
}

/** 读场景存档。 */
function loadScene(state, sessionId) {
  return readDoc(state, sessionId, 'scene', null)
}

/** 读遭遇战存档。 */
function loadEncounter(state, sessionId) {
  return readDoc(state, sessionId, 'encounter', null)
}

/** 统一的失败返回：不抛异常，把原因交给模型，避免打断整轮。 */
function failure(message, extra) {
  return { ok: false, error: message, ...(extra || {}) }
}

/**
 * 组装某一局跑团的完整状态，给 HTTP 路由与前端三栏用。
 *
 * 返回的一切都是**渲染就绪**的：HP 百分比、图标 key、格子坐标、格子装饰图标
 * 都已经算好，前端拿到直接画，不再做二次计算。
 *
 * @param {Object} state 插件共享状态
 * @param {string} [sessionId] DSH 会话 id；空值走 default 存档
 * @returns {{
 *   sessionKey: string,
 *   scene: Object|null, map: Object|null, encounter: Object|null,
 *   sheets: Array<Object>, log: Array<Object>,
 *   protocol: { systemPrompt: string },
 *   assets: { meters: Object, panels: Object, spriteBase: string },
 *   summary: string,
 *   updatedAt: string,
 * }}
 *   没有数据的字段为 null / 空数组，不会抛错。
 */
export function getTrpgState(state, sessionId) {
  const key = sessionIdFor(sessionId)
  const map = readDoc(state, key, 'map', null)
  const scene = readDoc(state, key, 'scene', null)
  const encounter = readDoc(state, key, 'encounter', null)
  const sheetsDoc = readDoc(state, key, 'sheets', null)
  const logDoc = readDoc(state, key, 'log', null)
  const meta = readDoc(state, key, 'meta', null)

  const sheets = sheetsDoc && Array.isArray(sheetsDoc.sheets) ? sheetsDoc.sheets : []
  const log = logDoc && Array.isArray(logDoc.entries) ? logDoc.entries : []

  const summaries = []
  if (scene) summaries.push(describeScene(scene))
  if (map) summaries.push('【地图】' + map.name + '（' + map.width + 'x' + map.height + '）棋子 ' + map.tokens.length + ' 个')
  if (encounter && encounter.active) {
    const view = encounterView(encounter)
    summaries.push('【战斗】第 ' + view.round + ' 回合，轮到 ' + (view.current || '无'))
  }
  if (sheets.length) summaries.push('【角色】' + sheets.map((sheet) => describeSheet(sheet)).join('；'))

  const panel = sheets.length ? sheets[0] : null
  return {
    sessionKey: key,
    scene: sceneView(scene),
    map: mapView(map),
    encounter: encounter ? encounterView(encounter) : null,
    sheets: sheets.map((sheet) => sheetPanelView(sheet)),
    /** 主控角色卡（第一张），三栏左侧的默认选中项。 */
    activeSheetId: panel ? panel.id : null,
    log,
    protocol: { systemPrompt: GM_SYSTEM_PROMPT },
    /**
     * 前端贴图用的素材 key；真正的图片走 assets 路由，这里只给名字。
     * spriteBase 不带 /api —— DSH 的 RPC 桥接管了 /api/* 前缀，外部请求一律 401。
     */
    assets: {
      meters: { ...METER_ASSETS },
      panels: { ...PANEL_ASSETS },
      spriteBase: '/dsh-sillytavern-api/assets',
    },
    summary: summaries.join('\n'),
    meta: meta || null,
    updatedAt: meta && meta.updatedAt ? meta.updatedAt : new Date().toISOString(),
  }
}

/**
 * 注册全部跑团工具。
 * @param {Object} ctx Cordis 上下文
 * @param {Object} state 插件共享状态
 * @returns {void}
 */
export function registerTrpgTools(ctx, state) {
  // ── trpg_roll ─────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_roll',
    description: '掷骰子。支持 2d6、1d20、d100、纯数字、多段（2d6+1d4+3）、优势劣势（2d20kh1/2d20kl1）、'
      + '弃低/弃高（4d6dl1）、爆炸（1d6!）、重复（3#1d20）。'
      + '需要随机结果时用它，不要自己编数字。掷完的结果会记进跑团日志。',
    parameters: {
      expr: { type: 'string', description: '骰子表达式，例如 2d6+3、1d20、4d6dl1、3#1d20（与 expression 等价，给一个即可）' },
      expression: { type: 'string', description: '骰子表达式（expr 的别名）' },
      reason: { type: 'string', description: '这次掷骰是干什么的（会写进日志），例如「盗贼开锁」' },
      actor: { type: 'string', description: '谁在掷（角色名），会写进日志' },
      seed: { type: 'number', description: '复现用的随机种子；一般不用给' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      const expression = String(args.expression || args.expr || '').trim()
      if (!expression) return failure('trpg_roll 需要骰子表达式，例如 2d6+3')
      try {
        const result = rollDice(expression, args.seed === undefined ? {} : { seed: args.seed })
        appendLog(state, sessionId, {
          kind: 'roll',
          title: args.reason ? String(args.reason) : '掷骰 ' + expression,
          detail: result.detail,
          total: result.total,
          actor: args.actor ? String(args.actor) : '',
        })
        return {
          ok: true,
          expr: result.expr,
          total: result.total,
          rolls: result.rolls,
          faces: result.faces,
          detail: result.detail,
          repeat: result.repeat,
          repeats: result.repeats,
        }
      } catch (error) {
        return failure('掷骰失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_check ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_check',
    description: '判定/检定。system 决定规则体系：dnd5e（d20+加值 vs DC）、coc7e（d100 vs 技能值）、generic（百分比）。'
      + '只在结果不确定且有代价时才调用；必然成功或必然失败的行动直接叙述，不要掷。'
      + '返回里的 narration 是给你的语气参考，不要照抄，自己写成叙事。',
    parameters: {
      system: { type: 'string', enum: ['dnd5e', 'coc7e', 'generic'], description: '规则体系，缺省按插件配置' },
      attribute: { type: 'string', description: '属性名，例如 力量 / 敏捷 / 感知（只用于展示）' },
      skill: { type: 'string', description: '技能名，例如 察觉 / 潜行 / 说服（只用于展示）' },
      bonus: { type: 'number', description: '总加值（属性修正+熟练+装备），由你按角色卡算好传进来' },
      dc: { type: 'number', description: 'dnd5e 的难度；coc7e/generic 的目标值也可以写在这里' },
      targetValue: { type: 'number', description: 'coc7e/generic 的目标值（技能值/百分比），优先于 dc' },
      advantage: { type: 'boolean', description: '优势（2d20 取高），仅 dnd5e' },
      disadvantage: { type: 'boolean', description: '劣势（2d20 取低），仅 dnd5e' },
      actor: { type: 'string', description: '谁在做这个判定，会写进日志' },
      reason: { type: 'string', description: '判定在做什么，会写进日志' },
      seed: { type: 'number', description: '复现用的随机种子；一般不用给' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const system = normalizeSystem(args.system || state.config.defaultDiceSystem)
        const result = abilityCheck({
          system,
          attribute: args.attribute,
          skill: args.skill,
          bonus: args.bonus,
          dc: args.dc,
          targetValue: args.targetValue,
          advantage: args.advantage,
          disadvantage: args.disadvantage,
          seed: args.seed,
        })
        appendLog(state, sessionId, {
          kind: 'check',
          title: args.reason ? String(args.reason) : (result.label || '判定'),
          detail: result.breakdown + ' → ' + result.degree,
          total: result.total,
          success: result.success,
          actor: args.actor ? String(args.actor) : '',
        })
        return {
          ok: true,
          system: result.system,
          label: result.label,
          attribute: result.attribute,
          skill: result.skill,
          success: result.success,
          degree: result.degree,
          total: result.total,
          natural: result.natural,
          dc: result.dc,
          breakdown: result.breakdown,
          narration: result.narration,
          rolls: result.rolls,
        }
      } catch (error) {
        return failure('判定失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_opposed ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_opposed_check',
    description: '对抗判定：双方各掷一次比较成败与等级（例如一边 stealth vs 另一边 perception）。'
      + '甲方与乙方各自给 bonus 与 dc（或技能值）。',
    parameters: {
      system: { type: 'string', enum: ['dnd5e', 'coc7e', 'generic'], description: '规则体系' },
      a_name: { type: 'string', description: '甲方名字（展示与日志用）' },
      a_bonus: { type: 'number', description: '甲方加值' },
      a_dc: { type: 'number', description: '甲方 DC / 目标值' },
      b_name: { type: 'string', description: '乙方名字' },
      b_bonus: { type: 'number', description: '乙方加值' },
      b_dc: { type: 'number', description: '乙方 DC / 目标值' },
      reason: { type: 'string', description: '在对抗什么，会写进日志' },
      seed: { type: 'number', description: '复现用的随机种子' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const system = normalizeSystem(args.system || state.config.defaultDiceSystem)
        const result = opposedCheck(
          { system, bonus: args.a_bonus, dc: args.a_dc, seed: args.seed },
          { system, bonus: args.b_bonus, dc: args.b_dc },
        )
        const verdict = result.winner === 'a' ? '甲方胜' : result.winner === 'b' ? '乙方胜' : '平手'
        appendLog(state, sessionId, {
          kind: 'check',
          title: (args.reason ? String(args.reason) : '对抗判定') + '：' + (args.a_name || '甲方') + ' vs ' + (args.b_name || '乙方'),
          detail: verdict + ' —— ' + result.breakdown,
          total: result.winner === 'a' ? result.a.total : result.b.total,
          success: result.winner === 'a',
        })
        return {
          ok: true,
          system: result.system,
          winner: result.winner,
          verdict,
          margin: result.margin,
          breakdown: result.breakdown,
          narration: result.narration,
          a: { total: result.a.total, degree: result.a.degree, success: result.a.success, breakdown: result.a.breakdown },
          b: { total: result.b.total, degree: result.b.degree, success: result.b.success, breakdown: result.b.breakdown },
        }
      } catch (error) {
        return failure('对抗判定失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_damage ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_damage',
    description: '掷伤害骰并直接结算到目标身上（改角色卡 HP）。crit=true 时骰子翻倍（5e 暴击规则），固定加值不翻倍。'
      + '目标可以是角色卡名字，也可以是当前遭遇战里的参战单位。',
    parameters: {
      target: { type: 'string', required: true, description: '目标名字（角色卡名或遭遇战单位名）' },
      expr: { type: 'string', required: true, description: '伤害表达式，例如 2d6+3、1d8+2' },
      crit: { type: 'boolean', description: '是否暴击（骰子数量翻倍）' },
      damageType: { type: 'string', description: '伤害类型，例如 火 / 冰 / 毒 / 穿刺' },
      reason: { type: 'string', description: '这一下的来由，会写进日志' },
      seed: { type: 'number', description: '复现用的随机种子' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const damage = rollDamage(args.expr, { crit: args.crit === true, seed: args.seed })
        const notices = []

        // 优先改遭遇战里的单位，其次改角色卡
        let encounter = loadEncounter(state, sessionId)
        let touchedEncounter = false
        if (encounter && encounter.active) {
          try {
            const applied = applyEncounterDamage(encounter, args.target, damage.total)
            writeDoc(state, sessionId, 'encounter', applied.encounter)
            encounter = applied.encounter
            touchedEncounter = true
            notices.push(...applied.notices)
          } catch {
            // 目标不在遭遇战里，落到角色卡分支
          }
        }

        const sheet = findSheet(state, sessionId, args.target)
        let sheetResult = null
        if (sheet) {
          const applied = applySheetDamage(sheet, damage.total, args.damageType)
          saveSheet(state, sessionId, applied.sheet)
          sheetResult = { hp: applied.sheet.hp, changes: applied.changes, downed: applied.downed }
          notices.push(...applied.notices)
        }
        if (!touchedEncounter && !sheet) {
          return failure('找不到目标「' + args.target + '」。用 trpg_update_sheet 建角色，或 trpg_start_encounter 开战斗。',
            { damage: { total: damage.total, detail: damage.detail } })
        }

        appendLog(state, sessionId, {
          kind: 'damage',
          title: (args.reason ? String(args.reason) : '伤害') + ' → ' + args.target,
          detail: damage.detail + (args.damageType ? '（' + args.damageType + '）' : ''),
          total: damage.total,
        })
        touchMeta(state, sessionId, {})

        return {
          ok: true,
          target: args.target,
          total: damage.total,
          detail: damage.detail,
          faces: damage.faces,
          crit: damage.crit,
          sheet: sheetResult,
          encounter: touchedEncounter ? encounterView(encounter) : null,
          notices,
        }
      } catch (error) {
        return failure('伤害结算失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_start_encounter ──────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_start_encounter',
    description: '开始一场遭遇战，按先攻排序。combatants 不给就自动把本局所有角色卡（标记为敌人/友方/NPC 的）拉进来。'
      + '先攻可手动指定，不指定就自动掷 d20+敏捷修正。',
    parameters: {
      combatants: {
        type: 'array',
        items: { oneOf: [{ type: 'string' }, { type: 'object' }] },
        description: '参战单位数组，每项 { name, kind(pc|npc|enemy|ally), hp:{cur,max}, ac, initiative?, dex? }；省略则用全部角色卡',
      },
      round: { type: 'number', description: '起始回合数，默认 1' },
      system: { type: 'string', enum: ['dnd5e', 'coc7e', 'generic'], description: '规则体系' },
      seed: { type: 'number', description: '复现用的随机种子' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const system = normalizeSystem(args.system || state.config.defaultDiceSystem)
        let encounter
        if (Array.isArray(args.combatants) && args.combatants.length) {
          encounter = createEncounter({
            combatants: args.combatants,
            round: args.round,
            system,
            seed: args.seed,
          })
        } else {
          const sheets = listSheets(state, sessionId)
          if (!sheets.length) {
            return failure('本局还没有角色卡，没法开遭遇战。先用 trpg_update_sheet 建角色，或直接传 combatants。')
          }
          encounter = encounterFromSheets(sheets, { system, seed: args.seed })
        }
        writeDoc(state, sessionId, 'encounter', encounter)
        const view = encounterView(encounter)
        appendLog(state, sessionId, {
          kind: 'system',
          title: '遭遇战开始',
          detail: '第 1 回合，先攻顺序：' + view.order.map((unit) => unit.name + '(' + unit.initiative + ')').join(' → '),
        })
        return {
          ok: true,
          round: view.round,
          current: view.current,
          order: view.order,
          hint: '现在轮到 ' + (view.current || '') + ' 行动。每次行动完调用 trpg_next_turn 推进。',
        }
      } catch (error) {
        return failure('开启遭遇战失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_next_turn ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_next_turn',
    description: '推进战斗回合：把回合交给下一个还能行动的单位。全员都动过就进入下一回合（状态持续时间 -1、重置行动标记），并检查胜负。',
    parameters: {},
    async execute(_args, exec) {
      const sessionId = sid(exec)
      try {
        const encounter = loadEncounter(state, sessionId)
        if (!encounter) return failure('本局还没有遭遇战，先用 trpg_start_encounter 开一场。')
        if (!encounter.active) return failure('这场遭遇战已经结束（' + (encounter.result ? encounter.result.text : '已收尾') + '）。')
        const result = nextTurn(encounter)
        writeDoc(state, sessionId, 'encounter', result.encounter)
        const view = encounterView(result.encounter)
        if (result.finished) {
          appendLog(state, sessionId, { kind: 'system', title: '战斗结束', detail: result.finished.text })
        } else if (result.roundAdvanced) {
          appendLog(state, sessionId, { kind: 'system', title: '第 ' + view.round + ' 回合', detail: '轮到 ' + (view.current || '') })
        }
        return {
          ok: true,
          round: view.round,
          roundAdvanced: result.roundAdvanced,
          current: result.current ? { name: result.current.name, hp: result.current.hp, ac: result.current.ac, status: result.current.status } : null,
          order: view.order,
          expired: result.expired,
          finished: result.finished,
        }
      } catch (error) {
        return failure('推进回合失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_status ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_status',
    description: '给遭遇战里的某个单位加状态（中毒/眩晕/流血等），可带持续回合数。战斗每回合结束自动递减。',
    parameters: {
      target: { type: 'string', required: true, description: '目标名字' },
      status: { type: 'string', required: true, description: '状态名，例如 中毒 / 眩晕 / 流血' },
      duration: { type: 'number', description: '持续回合数；不给表示直到被移除' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const encounter = loadEncounter(state, sessionId)
        if (!encounter) return failure('本局还没有遭遇战。')
        const result = addCombatStatus(encounter, args.target, args.status, args.duration === undefined ? null : args.duration)
        writeDoc(state, sessionId, 'encounter', result.encounter)
        return { ok: true, target: result.target.name, status: result.target.status }
      } catch (error) {
        return failure('加状态失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_end_encounter ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_end_encounter',
    description: '手动结束当前遭遇战（谈判收场、敌人逃跑、剧情中断都算）。自动判定的胜负不受影响。',
    parameters: {
      reason: { type: 'string', description: '为什么结束，会写进日志' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const encounter = loadEncounter(state, sessionId)
        if (!encounter) return failure('本局还没有遭遇战。')
        const ended = endEncounter(encounter, args.reason)
        writeDoc(state, sessionId, 'encounter', ended)
        appendLog(state, sessionId, { kind: 'system', title: '战斗结束', detail: ended.result ? ended.result.text : '' })
        return { ok: true, result: ended.result }
      } catch (error) {
        return failure('结束遭遇战失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_update_sheet ─────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_update_sheet',
    description: '建角色卡或更新角色卡数值。HP 自动夹在 [0, 最大值]；状态带持续回合；物品按名字合并数量。'
      + '任何 HP/资源/物品/状态变化都必须走这个工具，不要在正文里自己编数字。'
      + 'action=create 建新卡；action=update 改已有卡。',
    parameters: {
      action: { type: 'string', enum: ['create', 'update'], description: 'create=新建，update=更新（缺省 update）' },
      name: { type: 'string', description: '角色名（create 必填；update 时用来定位角色）' },
      system: { type: 'string', description: '规则体系，例如 dnd5e / coc7e' },
      kind: { type: 'string', enum: ['pc', 'npc', 'enemy', 'ally'], description: '角色类型（决定战斗阵营）' },
      hp: { type: 'number', description: '当前生命值（update 时是直接设值）' },
      maxHp: { type: 'number', description: '生命上限' },
      hpDelta: { type: 'number', description: '生命增减量（负数扣血），比 hp 更适合结算伤害' },
      mp: { type: 'number', description: '资源/法力当前值' },
      mpDelta: { type: 'number', description: '资源增减量' },
      ac: { type: 'number', description: '护甲等级/防御值' },
      attributes: { type: 'object', description: '属性表，例如 {str:16,dex:14,con:14,int:10,wis:12,cha:10}' },
      skills: { type: 'object', description: '技能表，例如 {"察觉":5,"潜行":3}' },
      status: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] }, description: '要加的状态，["中毒"] 或 [{name:"流血",duration:3}]，两种写法都收' },
      removeStatus: { type: 'array', items: { type: 'string' }, description: '要移除的状态名' },
      items: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] }, description: '要获得的物品，["火把"] 或 [{name:"药水",qty:2}]，两种写法都收' },
      removeItem: { type: 'array', items: { type: 'string' }, description: '要消耗的物品名（每个减 1）' },
      notes: { type: 'string', description: '备注/角色设定要点' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const action = args.action === 'create' ? 'create' : 'update'
        if (action === 'create') {
          const sheet = addSheet(state, sessionId, {
            name: args.name,
            system: args.system || state.config.defaultDiceSystem,
            kind: args.kind,
            hp: { cur: args.hp === undefined ? args.maxHp : args.hp, max: args.maxHp === undefined ? (args.hp === undefined ? 10 : args.hp) : args.maxHp },
            ac: args.ac,
            attributes: args.attributes,
            skills: args.skills,
            status: args.status,
            items: args.items,
            notes: args.notes,
          })
          appendLog(state, sessionId, { kind: 'system', title: '角色创建', detail: describeSheet(sheet) })
          return { ok: true, action, sheet: sheetPanelView(sheet), summary: describeSheet(sheet) }
        }

        const target = findSheet(state, sessionId, args.name)
        if (!target) {
          const names = listSheets(state, sessionId).map((sheet) => sheet.name)
          return failure('找不到角色「' + args.name + '」' + (names.length ? '。本局已有：' + names.join('、') : '。本局还没有角色卡，请用 action=create 建一张'))
        }
        const updated = updateSheet(target, {
          hp: args.hp,
          maxHp: args.maxHp,
          hpDelta: args.hpDelta,
          mp: args.mp,
          mpDelta: args.mpDelta,
          ac: args.ac,
          attributes: args.attributes,
          skills: args.skills,
          status: args.status,
          removeStatus: args.removeStatus,
          items: args.items,
          removeItem: args.removeItem,
          notes: args.notes,
          kind: args.kind,
        })
        const saved = saveSheet(state, sessionId, updated.sheet)

        // 遭遇战里有同名单位时同步 HP，免得两处数字打架
        const encounter = loadEncounter(state, sessionId)
        if (encounter && encounter.active) {
          const unit = encounter.combatants.find((entry) => entry.name === saved.name)
          if (unit && (unit.hp.cur !== saved.hp.cur || unit.hp.max !== saved.hp.max)) {
            const synced = JSON.parse(JSON.stringify(encounter))
            const targetUnit = synced.combatants.find((entry) => entry.name === saved.name)
            targetUnit.hp = { cur: saved.hp.cur, max: saved.hp.max }
            if (saved.hp.cur <= 0) {
              targetUnit.defeated = true
              targetUnit.incapacitated = true
            }
            writeDoc(state, sessionId, 'encounter', synced)
          }
        }

        if (updated.changes.length) {
          appendLog(state, sessionId, {
            kind: 'system',
            title: saved.name + ' 状态更新',
            detail: updated.changes.map((item) => item.field + ' ' + JSON.stringify(item.before) + '→' + JSON.stringify(item.after)).join('；'),
          })
        }
        return {
          ok: true,
          action,
          sheet: sheetPanelView(saved),
          summary: describeSheet(saved),
          changes: updated.changes,
          notices: updated.notices,
        }
      } catch (error) {
        return failure('角色卡更新失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_get_sheets ───────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_get_sheets',
    description: '读本局全部角色卡的当前数值（HP/AC/状态/物品）。改数值前先读，改完再读一次核对。',
    parameters: {
      name: { type: 'string', description: '只读某一个角色；不传返回全部' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        if (args.name) {
          const sheet = findSheet(state, sessionId, args.name)
          if (!sheet) return failure('找不到角色「' + args.name + '」')
          return { ok: true, sheet: sheetPanelView(sheet), summary: describeSheet(sheet) }
        }
        const sheets = listSheets(state, sessionId)
        return {
          ok: true,
          count: sheets.length,
          sheets: sheets.map((sheet) => sheetPanelView(sheet)),
          summary: sheets.length ? sheets.map((sheet) => describeSheet(sheet)).join('\n') : '本局还没有角色卡',
        }
      } catch (error) {
        return failure('读取角色卡失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_remove_sheet ─────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_remove_sheet',
    description: '删除一张角色卡（角色离场、NPC 退场、建错了要重来）。',
    parameters: {
      name: { type: 'string', required: true, description: '角色名' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const removed = removeSheet(state, sessionId, args.name)
        if (!removed) return failure('找不到角色「' + args.name + '」')
        appendLog(state, sessionId, { kind: 'system', title: '角色移除', detail: args.name })
        return { ok: true, removed: args.name }
      } catch (error) {
        return failure('删除角色失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_show_map ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_show_map',
    description: '地图操作（一个工具带 action）。'
      + 'action=create 新建空地图；generate 生成随机地牢；paint 批量刷地形；rect 铺矩形房间；'
      + 'cell 改单个格子；token_add 加棋子；token_move 移动棋子；token_remove 移除棋子；'
      + 'reveal 揭雾；feature 加门/陷阱/宝箱；view 读取当前地图；ascii 看字符预览。'
      + '需要玩家走位或战斗才用地图；纯叙事用 trpg_update_scene。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'generate', 'paint', 'rect', 'cell', 'token_add', 'token_move', 'token_remove', 'reveal', 'feature', 'view', 'ascii'],
        description: '操作类型',
      },
      name: { type: 'string', description: '地图名（create/generate 用）' },
      width: { type: 'number', description: '宽（格），create/generate 用' },
      height: { type: 'number', description: '高（格），create/generate 用' },
      tileSize: { type: 'number', description: '每格像素，默认 48' },
      seed: { type: 'number', description: '地牢生成种子（同一个种子必得同一张图）' },
      roomCount: { type: 'number', description: '地牢房间数' },
      theme: { type: 'string', enum: ['dungeon', 'cave', 'grass'], description: '地牢主题' },
      fogEnabled: { type: 'boolean', description: '是否开启战争迷雾' },
      cells: { type: 'array', items: { type: 'object' }, description: 'paint 用的格子数组 [{x,y,type,label?,decor?}]' },
      rect: { type: 'object', description: 'rect 用的矩形 {x,y,width,height}' },
      type: { type: 'string', description: '地形类型或特征类型；地形可选 floor/wall/door/water/grass/stone/void' },
      x: { type: 'number', description: '坐标 x（格）' },
      y: { type: 'number', description: '坐标 y（格）' },
      radius: { type: 'number', description: 'reveal 的半径，默认 3' },
      full: { type: 'boolean', description: '默认只返回变化部分；传 true 才返回整张地图（客户端首次渲染用）' },
      revealAll: { type: 'boolean', description: 'reveal 时是否揭开全图' },
      token: { type: 'object', description: 'token_add 用 {x,y,name,color?,icon?,kind?}' },
      tokenName: { type: 'string', description: 'token_move/token_remove 用的棋子名字或 id' },
      data: { type: 'object', description: 'feature 的附加数据 {label?,info?,looted?...}' },
      label: { type: 'string', description: '格子/特征的文字标签' },
      decor: { type: 'string', description: '格子装饰素材 key（例如 tile_moss）' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const action = String(args.action)
        let map = loadMap(state, sessionId)
        const save = (next) => {
          writeDoc(state, sessionId, 'map', next)
          return next
        }

        if (action === 'view') {
          if (!map) return failure('本局还没有地图。用 action=generate 或 action=create 建一张。')
          return { ok: true, map: mapView(map), connectivity: checkConnectivity(map) }
        }
        if (action === 'ascii') {
          if (!map) return failure('本局还没有地图。')
          return { ok: true, ascii: renderAscii(map), connectivity: checkConnectivity(map) }
        }
        if (action === 'create') {
          const next = createMap(args.width === undefined ? 20 : args.width, args.height === undefined ? 15 : args.height, {
            name: args.name,
            tileSize: args.tileSize,
            fogEnabled: args.fogEnabled,
            fill: args.theme === 'grass' ? 'grass' : 'wall',
          })
          save(next)
          appendLog(state, sessionId, { kind: 'scene', title: '建地图', detail: next.name + ' ' + next.width + 'x' + next.height })
          return { ok: true, map: mapView(next), hint: '地图默认全是墙。用 action=rect 铺房间、action=paint 挖走廊，再用 token_add 放角色。' }
        }
        if (action === 'generate') {
          const next = generateDungeon(
            args.width === undefined ? 32 : args.width,
            args.height === undefined ? 22 : args.height,
            args.seed === undefined ? undefined : args.seed,
            {
              name: args.name,
              roomCount: args.roomCount,
              tileSize: args.tileSize,
              theme: args.theme,
              fogEnabled: args.fogEnabled,
            },
          )
          save(next)
          const connectivity = checkConnectivity(next)
          appendLog(state, sessionId, {
            kind: 'scene',
            title: '生成地牢',
            detail: next.name + ' ' + next.width + 'x' + next.height + '，' + next.rooms.length + ' 个房间',
          })
          return { ok: true, map: mapView(next), rooms: next.rooms.length, connectivity, ascii: renderAscii(next) }
        }
        if (!map) return failure('本局还没有地图，请先用 action=create 或 action=generate 建一张。')

        if (action === 'paint') {
          const result = paintCells(map, args.cells || [])
          save(result.map)
          return { ok: true, touched: result.touched, changed: mapDelta(map, result.map, args.full), map: args.full === true ? mapView(result.map) : undefined }
        }
        if (action === 'rect') {
          const result = fillRect(map, args.rect || {}, args.type || 'floor', { label: args.label, decor: args.decor })
          save(result.map)
          return { ok: true, touched: result.touched, map: mapView(result.map) }
        }
        if (action === 'cell') {
          const next = setCell(map, args.x, args.y, { type: args.type, label: args.label, decor: args.decor })
          save(next)
          return { ok: true, changed: mapDelta(map, next, args.full), map: args.full === true ? mapView(next) : undefined }
        }
        if (action === 'token_add') {
          const result = addToken(map, args.token || { x: args.x, y: args.y, name: args.tokenName, kind: args.type })
          save(result.map)
          return { ok: true, token: result.token, changed: mapDelta(map, result.map, args.full), map: args.full === true ? mapView(result.map) : undefined }
        }
        if (action === 'token_move') {
          const result = moveToken(map, args.tokenName, args.x, args.y)
          save(result.map)
          return { ok: true, token: result.token, warnings: result.warnings, changed: mapDelta(map, result.map, args.full), map: args.full === true ? mapView(result.map) : undefined }
        }
        if (action === 'token_remove') {
          const result = removeToken(map, args.tokenName)
          save(result.map)
          return { ok: true, removed: result.removed, changed: mapDelta(map, result.map, args.full), map: args.full === true ? mapView(result.map) : undefined }
        }
        if (action === 'reveal') {
          const result = revealFog(map, args.x, args.y, args.radius === undefined ? 3 : args.radius, { revealAll: args.revealAll === true })
          save(result.map)
          return { ok: true, revealed: result.revealed.length, changed: mapDelta(map, result.map, args.full), map: args.full === true ? mapView(result.map) : undefined }
        }
        if (action === 'feature') {
          const result = addFeature(map, { x: args.x, y: args.y, type: args.type, data: args.data })
          save(result.map)
          return { ok: true, feature: result.feature, changed: mapDelta(map, result.map, args.full), map: args.full === true ? mapView(result.map) : undefined }
        }
        return failure('未知 action：' + action)
      } catch (error) {
        return failure('地图操作失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_update_scene ─────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_update_scene',
    description: '切换/更新当前场景（地点、时间、天气、氛围、插图）。场景只负责叙事与氛围；'
      + '需要玩家走位或战斗时改用 trpg_show_map，不要两者重复叠加。',
    parameters: {
      name: { type: 'string', description: '场景名，例如 酒馆大厅' },
      description: { type: 'string', description: '场景描述（给玩家看到的文字）' },
      image: { type: 'string', description: '插图路径或 URL' },
      weather: { type: 'string', description: '天气，例如 小雨 / 浓雾' },
      timeOfDay: { type: 'string', description: '时段，例如 黄昏 / 深夜' },
      ambiance: { type: 'string', description: '氛围一句话（气味/声音/温度）' },
      notes: { type: 'string', description: '给 GM 自己的备注（不给玩家看）' },
      clear: { type: 'array', items: { type: 'string' }, description: '要清空的字段名，例如 ["image"]' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const existing = loadScene(state, sessionId)
        let next
        let changes = []
        if (!existing) {
          next = createScene({
            name: args.name,
            description: args.description,
            image: args.image,
            weather: args.weather,
            timeOfDay: args.timeOfDay,
            ambiance: args.ambiance,
            notes: args.notes,
          })
        } else {
          const result = updateScene(existing, args)
          next = result.scene
          changes = result.changes
        }
        writeDoc(state, sessionId, 'scene', next)
        if (changes.length || !existing) {
          appendLog(state, sessionId, { kind: 'scene', title: '场景：' + next.name, detail: describeScene(next) })
        }
        return { ok: true, scene: sceneView(next), changes, summary: describeScene(next) }
      } catch (error) {
        return failure('更新场景失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_log ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_log',
    description: '读写跑团日志。action=append 追加一条（剧情摘要/关键决策/判定记录都写这里）；'
      + 'action=list 读最近的日志；action=clear 清空。日志是这一局的"刚才发生了什么"，'
      + '推进剧情前可以读一遍回顾。',
    parameters: {
      action: { type: 'string', enum: ['append', 'list', 'clear'], description: 'append/list/clear，缺省 append' },
      kind: { type: 'string', enum: ['roll', 'check', 'damage', 'scene', 'system'], description: '日志类型' },
      title: { type: 'string', description: '标题（一句话说清发生了什么）' },
      detail: { type: 'string', description: '细节' },
      text: { type: 'string', description: '较长的文本（剧情摘要）' },
      actor: { type: 'string', description: '相关角色名' },
      limit: { type: 'number', description: 'list 时返回最近几条，默认 20' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const action = args.action || 'append'
        if (action === 'list') {
          const entries = readLog(state, sessionId, { limit: args.limit === undefined ? 20 : args.limit, kind: args.kind })
          return { ok: true, count: entries.length, entries }
        }
        if (action === 'clear') {
          writeDoc(state, sessionId, 'log', { entries: [] })
          return { ok: true, cleared: true }
        }
        if (!args.title && !args.detail && !args.text) {
          return failure('追加日志至少要给 title、detail 或 text 之一')
        }
        const entry = appendLog(state, sessionId, {
          kind: args.kind,
          title: args.title,
          detail: args.detail,
          text: args.text,
          actor: args.actor,
        })
        return { ok: true, entry }
      } catch (error) {
        return failure('日志操作失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_parse_markers ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_parse_markers',
    description: '解析一段回复里的 GM 标记（[判定]/[状态]/[获得]/[地图]/[选项]、<dice>、<battlecheck>、'
      + '<UpdateVariable>、[[turn:end]]、[[event:...]]、[[map:bg:...]]），返回结构化结果与去掉标记的正文。'
      + '自己写完一段带标记的回复后可以调它自检；一般不需要手动调用。',
    parameters: {
      text: { type: 'string', required: true, description: '要解析的文本' },
    },
    async execute(args) {
      try {
        return { ok: true, ...parseGmMarkers(args.text) }
      } catch (error) {
        return failure('解析失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_state ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_state',
    description: '读本局跑团的完整状态：当前场景、地图摘要、遭遇战、角色卡、最近日志。'
      + '每轮开场或不确定当前局势时先读它，不要凭记忆猜。',
    parameters: {
      logLimit: { type: 'number', description: '带多少条最近日志，默认 8' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      try {
        const full = getTrpgState(state, sessionId)
        const limit = args.logLimit === undefined ? 8 : Math.max(0, Math.trunc(Number(args.logLimit) || 0))
        return {
          ok: true,
          scene: full.scene,
          map: full.map
            ? {
              name: full.map.name,
              width: full.map.width,
              height: full.map.height,
              tokens: full.map.tokens,
              features: full.map.features,
              connectivity: checkConnectivity({ cells: full.map.cells, width: full.map.width, height: full.map.height }),
            }
            : null,
          encounter: full.encounter,
          sheets: full.sheets,
          log: limit > 0 ? full.log.slice(-limit) : [],
          summary: full.summary,
        }
      } catch (error) {
        return failure('读取跑团状态失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))

  // ── trpg_reset ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'trpg_reset',
    description: '清空本局的跑团存档（地图/场景/角色卡/遭遇战/日志全部重置）。开新的一局时用；'
      + '只想清日志请用 trpg_log action=clear。',
    parameters: {
      confirm: { type: 'boolean', required: true, description: '必须传 true 才会真的清空' },
    },
    async execute(args, exec) {
      const sessionId = sid(exec)
      if (args.confirm !== true) return failure('这会把本局跑团存档整个清空，确认请传 confirm=true')
      try {
        for (const doc of ['map', 'scene', 'sheets', 'encounter', 'log', 'meta']) {
          writeDoc(state, sessionId, doc, doc === 'sheets' ? { sheets: [] } : doc === 'log' ? { entries: [] } : null)
        }
        return { ok: true, reset: true, dir: sessionDir(state, sessionId) }
      } catch (error) {
        return failure('重置失败：' + (error && error.message ? error.message : String(error)))
      }
    },
  }))
}
