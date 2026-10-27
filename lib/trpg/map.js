/**
 * 格子地图：数据结构 + 操作 + 随机地牢生成。
 *
 * 这个数据结构是**冻结契约**（tavern-ui 按它渲染 SVG 格子图），改字段要通知 lead 与 UI：
 *   { width, height, tileSize, name,
 *     cells:    [{ x, y, type, label, fog, decor }]   类型: floor|wall|door|water|grass|stone|void
 *     tokens:   [{ id, x, y, name, color, icon, kind }]   kind: pc|npc|enemy|object
 *     features: [{ x, y, type, data }]             门/陷阱/宝箱/楼梯/笔记
 *     fog:      { enabled, revealed: [[x,y]] }
 *     grid:     { visible, color } }
 *
 * 坐标原点在左上，x 向右、y 向下，单位是格。
 * cells 是**稠密**的：width*height 个格子全部有值，前端不用处理空洞。
 *
 * icon / decor 都是**素材 key**（例如 'glyph_strength'、'tile_moss'），不是路径。
 * 前端拿 key 到 /dsh-sillytavern-api/assets/:group/:file 取图，后端不复制图片（不带 /api，那个前缀被 RPC 桥占用）。
 *
 * 随机地牢是房间+走廊的真实生成：先用房间布点（互不重叠、带间隙），
 * 再用 L 形走廊把相邻房间连起来，最后回填墙。生成结果保证全连通。
 */
import { nowIso, clamp } from '../util.js'
import { createRng } from './dice.js'
import { cellIcon, featureIcon, kindIcon } from './icons.js'

/** 允许的地形类型。 */
export const CELL_TYPES = ['floor', 'wall', 'door', 'water', 'grass', 'stone', 'void']

/** 地形类型的中文名，给日志与工具返回用。 */
export const CELL_TYPE_LABELS = {
  floor: '地面',
  wall: '墙',
  door: '门',
  water: '水',
  grass: '草地',
  stone: '石地',
  void: '虚空',
}

/** 特征类型的中文名。 */
export const FEATURE_LABELS = {
  door: '门',
  trap: '陷阱',
  chest: '宝箱',
  stairs: '楼梯',
  note: '标记',
  torch: '火把',
  altar: '祭坛',
}

/** 默认格子像素尺寸。 */
const DEFAULT_TILE_SIZE = 48
/** 地图尺寸上限，防止模型建 10000x10000 的地图把前端拖垮。 */
const MAX_DIMENSION = 200

/** 取整数并夹在合法范围。 */
function dimension(value, fallback) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return clamp(n, 1, MAX_DIMENSION)
}

/** 深拷贝地图（JSON 安全子集）。 */
function cloneMap(map) {
  return JSON.parse(JSON.stringify(map))
}

/**
 * 建一张空地图（默认全墙）。
 * @param {number} width 宽（格）
 * @param {number} height 高（格）
 * @param {{ name?: string, tileSize?: number, fill?: string, fogEnabled?: boolean, gridVisible?: boolean }} [options]
 *   fill：初始地形，缺省 'wall'（室内地牢常用）；野外可给 'grass'
 * @returns {Object} 地图对象
 * @throws {Error} 宽高不是数字时抛中文错误
 */
export function createMap(width, height, options = {}) {
  if (!Number.isFinite(Number(width)) || !Number.isFinite(Number(height))) {
    throw new Error('createMap 需要数字宽高，收到 ' + width + ' x ' + height)
  }
  const w = dimension(width, 20)
  const h = dimension(height, 15)
  const fill = CELL_TYPES.includes(options.fill) ? options.fill : 'wall'
  const cells = []
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) cells.push({ x, y, type: fill, label: '', fog: options.fogEnabled === true, decor: '' })
  }
  const map = {
    id: 'map-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name: String(options.name || '未命名地图'),
    width: w,
    height: h,
    tileSize: clamp(Math.trunc(Number(options.tileSize) || DEFAULT_TILE_SIZE), 8, 256),
    cells,
    tokens: [],
    features: [],
    fog: { enabled: options.fogEnabled === true, revealed: [] },
    grid: { visible: options.gridVisible !== false, color: '#0002' },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  if (map.fog.enabled) for (const cell of map.cells) cell.fog = true
  return map
}

/**
 * 取一个格子的下标；越界返回 -1。
 * @param {Object} map 地图
 * @param {number} x 列
 * @param {number} y 行
 * @returns {number} cells 数组下标，越界 -1
 */
export function cellIndex(map, x, y) {
  const cx = Math.trunc(Number(x))
  const cy = Math.trunc(Number(y))
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return -1
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return -1
  return cy * map.width + cx
}

/**
 * 读一个格子（返回副本）。
 * @param {Object} map 地图
 * @param {number} x 列
 * @param {number} y 行
 * @returns {Object|null} 格子副本；越界返回 null
 */
export function getCell(map, x, y) {
  const index = cellIndex(map, x, y)
  return index < 0 ? null : { ...map.cells[index] }
}

/**
 * 设置一个格子。只改给出的字段。
 * @param {Object} map 地图（不会被就地修改）
 * @param {number} x 列
 * @param {number} y 行
 * @param {{ type?: string, label?: string, fog?: boolean, decor?: string }} patch 格子变更
 * @returns {Object} 新地图
 * @throws {Error} 坐标越界或地形类型非法时抛中文错误
 */
export function setCell(map, x, y, patch = {}) {
  const next = cloneMap(map)
  const index = cellIndex(next, x, y)
  if (index < 0) throw new Error('坐标 (' + x + ',' + y + ') 超出地图范围 ' + next.width + 'x' + next.height)
  if (patch.type !== undefined && !CELL_TYPES.includes(patch.type)) {
    throw new Error('未知地形类型 "' + patch.type + '"，可用：' + CELL_TYPES.join(' / '))
  }
  const cell = next.cells[index]
  if (patch.type !== undefined) cell.type = patch.type
  if (patch.label !== undefined) cell.label = String(patch.label)
  if (patch.fog !== undefined) cell.fog = Boolean(patch.fog)
  if (patch.decor !== undefined) cell.decor = String(patch.decor)
  next.updatedAt = nowIso()
  return next
}

/**
 * 批量刷地形，一次改一大片（画房间、挖走廊、铺河流）。
 * 越界坐标会被跳过而不是中断整批——刷一大片时不该因为一个越界点全废。
 * @param {Object} map 地图（不会被就地修改）
 * @param {{ x: number, y: number, type?: string, label?: string, fog?: boolean, decor?: string } | Array<Object>} cells 单个或数组
 * @returns {{ map: Object, touched: number }} 新地图与真正改到的格子数
 * @throws {Error} 地形类型非法或一个格子都没落在地图上时抛中文错误
 */
export function paintCells(map, cells) {
  const list = Array.isArray(cells) ? cells : [cells]
  const next = cloneMap(map)
  let touched = 0
  for (const raw of list) {
    if (!raw || raw.x === undefined || raw.y === undefined) continue
    const index = cellIndex(next, raw.x, raw.y)
    if (index < 0) continue
    if (raw.type !== undefined && !CELL_TYPES.includes(raw.type)) {
      throw new Error('未知地形类型 "' + raw.type + '"，可用：' + CELL_TYPES.join(' / '))
    }
    const cell = next.cells[index]
    if (raw.type !== undefined) cell.type = raw.type
    if (raw.label !== undefined) cell.label = String(raw.label)
    if (raw.fog !== undefined) cell.fog = Boolean(raw.fog)
    if (raw.decor !== undefined) cell.decor = String(raw.decor)
    touched += 1
  }
  if (!touched) throw new Error('paintCells 没有任何坐标落在地图范围内')
  next.updatedAt = nowIso()
  return { map: next, touched }
}

/**
 * 铺一个矩形区域的地形（画房间最常用）。
 * @param {Object} map 地图（不会被就地修改）
 * @param {{ x: number, y: number, width: number, height: number }} rect 矩形（x,y 是左上角）
 * @param {string} type 地形类型
 * @param {{ label?: string, decor?: string }} [options]
 * @returns {{ map: Object, touched: number }}
 * @throws {Error} 地形类型非法时抛中文错误
 */
export function fillRect(map, rect, type, options = {}) {
  if (!CELL_TYPES.includes(type)) throw new Error('未知地形类型 "' + type + '"，可用：' + CELL_TYPES.join(' / '))
  const x0 = Math.trunc(Number(rect && rect.x) || 0)
  const y0 = Math.trunc(Number(rect && rect.y) || 0)
  const w = Math.max(1, Math.trunc(Number(rect && rect.width) || 1))
  const h = Math.max(1, Math.trunc(Number(rect && rect.height) || 1))
  const list = []
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const entry = { x, y, type }
      if (options.label !== undefined) entry.label = options.label
      if (options.decor !== undefined) entry.decor = options.decor
      list.push(entry)
    }
  }
  return paintCells(map, list)
}

/**
 * 加一个棋子。
 * @param {Object} map 地图（不会被就地修改）
 * @param {{ x: number, y: number, name: string, color?: string, icon?: string, kind?: string, id?: string }} token 棋子
 * @returns {{ map: Object, token: Object }} 新地图与新棋子
 * @throws {Error} 缺名字 / 坐标越界 / 重名时抛中文错误
 */
export function addToken(map, token = {}) {
  const name = String(token.name || '').trim()
  if (!name) throw new Error('棋子需要名字')
  const next = cloneMap(map)
  if (cellIndex(next, token.x, token.y) < 0) {
    throw new Error('棋子坐标 (' + token.x + ',' + token.y + ') 超出地图范围 ' + next.width + 'x' + next.height)
  }
  if (next.tokens.some((entry) => entry.name === name)) {
    throw new Error('地图上已经有叫「' + name + '」的棋子，用 moveToken 移动它，或换个名字')
  }
  const kind = ['pc', 'npc', 'enemy', 'object'].includes(token.kind) ? token.kind : 'npc'
  const entry = {
    id: token.id ? String(token.id) : 'tok-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    x: Math.trunc(Number(token.x)),
    y: Math.trunc(Number(token.y)),
    name,
    color: String(token.color || '#4ecdc4'),
    icon: String(token.icon || kindIcon(kind)),
    kind,
  }
  next.tokens.push(entry)
  next.updatedAt = nowIso()
  return { map: next, token: { ...entry } }
}

/** 在地图上按 id 或名字找棋子本体（可变引用）。 */
function findTokenEntry(map, idOrName) {
  const needle = String(idOrName || '').trim().toLowerCase()
  if (!needle) return null
  const exact = map.tokens.find((entry) => entry.id.toLowerCase() === needle || entry.name.toLowerCase() === needle)
  if (exact) return exact
  const partial = map.tokens.filter((entry) => entry.name.toLowerCase().includes(needle))
  return partial.length === 1 ? partial[0] : null
}

/**
 * 移动棋子（按 id 或名字找）。
 * @param {Object} map 地图（不会被就地修改）
 * @param {string} idOrName 棋子 id 或名字
 * @param {number} x 目标列
 * @param {number} y 目标行
 * @param {{ force?: boolean }} [options] force=true 时不检查目标格是否墙/水
 * @returns {{ map: Object, token: Object, warnings: string[] }} 新地图、移动后的棋子、提醒（撞墙等）
 * @throws {Error} 找不到棋子或坐标越界时抛中文错误
 */
export function moveToken(map, idOrName, x, y, options = {}) {
  const next = cloneMap(map)
  const token = findTokenEntry(next, idOrName)
  if (!token) {
    throw new Error('地图上没有「' + idOrName + '」这个棋子。当前棋子：' + (next.tokens.map((entry) => entry.name).join('、') || '无'))
  }
  const index = cellIndex(next, x, y)
  if (index < 0) throw new Error('坐标 (' + x + ',' + y + ') 超出地图范围 ' + next.width + 'x' + next.height)
  const target = next.cells[index]
  const warnings = []
  if (!options.force) {
    if (target.type === 'wall' || target.type === 'void') {
      warnings.push('目标是' + CELL_TYPE_LABELS[target.type] + '，棋子站不上去（确实要放请传 force）')
    }
    if (target.type === 'water') warnings.push('目标是水域，除非有游泳/涉水规则，否则应消耗额外移动力')
    if (target.fog) warnings.push('目标格尚未探索，注意别把 GM 才知道的信息说漏')
  }
  token.x = Math.trunc(Number(x))
  token.y = Math.trunc(Number(y))
  next.updatedAt = nowIso()
  return { map: next, token: { ...token }, warnings }
}

/**
 * 移除棋子。
 * @param {Object} map 地图（不会被就地修改）
 * @param {string} idOrName 棋子 id 或名字
 * @returns {{ map: Object, removed: Object }} 新地图与被移除的棋子
 * @throws {Error} 找不到棋子时抛中文错误
 */
export function removeToken(map, idOrName) {
  const next = cloneMap(map)
  const token = findTokenEntry(next, idOrName)
  if (!token) throw new Error('地图上没有「' + idOrName + '」这个棋子')
  next.tokens = next.tokens.filter((entry) => entry.id !== token.id)
  next.updatedAt = nowIso()
  return { map: next, removed: { ...token } }
}

/**
 * 揭开战争迷雾。
 * @param {Object} map 地图（不会被就地修改）
 * @param {number} cx 中心列
 * @param {number} cy 中心行
 * @param {number} [radius] 半径（切比雪夫距离，默认 3）
 * @param {{ revealAll?: boolean }} [options] revealAll=true 时揭开全图
 * @returns {{ map: Object, revealed: Array<[number, number]> }} 新地图与本轮新揭开的格子
 */
export function revealFog(map, cx, cy, radius = 3, options = {}) {
  const next = cloneMap(map)
  const revealed = []
  if (options.revealAll) {
    for (const cell of next.cells) {
      if (!cell.fog) continue
      cell.fog = false
      revealed.push([cell.x, cell.y])
    }
  } else {
    const r = clamp(Math.trunc(Number(radius) || 3), 0, Math.max(next.width, next.height))
    const centerX = Math.trunc(Number(cx) || 0)
    const centerY = Math.trunc(Number(cy) || 0)
    for (let y = centerY - r; y <= centerY + r; y += 1) {
      for (let x = centerX - r; x <= centerX + r; x += 1) {
        if (Math.max(Math.abs(x - centerX), Math.abs(y - centerY)) > r) continue
        const index = cellIndex(next, x, y)
        if (index < 0) continue
        const cell = next.cells[index]
        if (!cell.fog) continue
        cell.fog = false
        revealed.push([x, y])
      }
    }
  }
  const seen = new Set(next.fog.revealed.map((pair) => pair[0] + ',' + pair[1]))
  for (const pair of revealed) {
    const key = pair[0] + ',' + pair[1]
    if (seen.has(key)) continue
    seen.add(key)
    next.fog.revealed.push(pair)
  }
  next.updatedAt = nowIso()
  return { map: next, revealed }
}

/**
 * 加一个地图特征（门/陷阱/宝箱/楼梯）。
 * @param {Object} map 地图（不会被就地修改）
 * @param {{ x: number, y: number, type: string, data?: Object }} feature 特征
 * @returns {{ map: Object, feature: Object }} 新地图与写入的特征
 * @throws {Error} 坐标越界或缺类型时抛中文错误
 */
export function addFeature(map, feature = {}) {
  const next = cloneMap(map)
  if (cellIndex(next, feature.x, feature.y) < 0) {
    throw new Error('特征坐标 (' + feature.x + ',' + feature.y + ') 超出地图范围')
  }
  const type = String(feature.type || '').trim()
  if (!type) throw new Error('特征需要类型（door/trap/chest/stairs/note 等）')
  const entry = {
    x: Math.trunc(Number(feature.x)),
    y: Math.trunc(Number(feature.y)),
    type,
    data: feature.data && typeof feature.data === 'object' ? { ...feature.data } : {},
  }
  next.features = next.features.filter((item) => !(item.x === entry.x && item.y === entry.y && item.type === entry.type))
  next.features.push(entry)
  next.updatedAt = nowIso()
  return { map: next, feature: entry }
}

/**
 * 移除某个格子上的全部特征。
 * @param {Object} map 地图（不会被就地修改）
 * @param {number} x 列
 * @param {number} y 行
 * @returns {{ map: Object, removed: number }}
 */
export function removeFeaturesAt(map, x, y) {
  const next = cloneMap(map)
  const before = next.features.length
  next.features = next.features.filter((item) => !(item.x === x && item.y === y))
  next.updatedAt = nowIso()
  return { map: next, removed: before - next.features.length }
}

/**
 * 把地图压成前端的可渲染视图。
 * @param {Object} map 地图
 * @param {{ includeFog?: boolean }} [options] includeFog=false 时把未探索格的真实地形换成 void（防剧透给玩家端）
 * @returns {Object} 前端视图 { id, name, width, height, tileSize, cells, tokens, features, fog, grid }
 */
export function mapView(map, options = {}) {
  if (!map) return null
  const hideFog = options.includeFog === false
  return {
    id: map.id,
    name: map.name,
    width: map.width,
    height: map.height,
    tileSize: map.tileSize,
    cells: map.cells.map((cell) => ({
      x: cell.x,
      y: cell.y,
      type: hideFog && cell.fog ? 'void' : cell.type,
      label: cell.label || '',
      fog: Boolean(cell.fog),
      // decor 是自定义装饰素材 key；没给就用地形默认图标，前端不用自己查表
      decor: cell.decor || '',
      icon: cell.decor || cellIcon(cell.type),
    })),
    tokens: map.tokens.map((token) => ({ ...token, icon: token.icon || kindIcon(token.kind) })),
    features: map.features.map((feature) => ({
      ...feature,
      data: { ...feature.data },
      icon: featureIcon(feature.type),
    })),
    fog: { enabled: Boolean(map.fog.enabled), revealed: map.fog.revealed.map((pair) => [pair[0], pair[1]]) },
    grid: { ...map.grid },
  }
}

/**
 * 校验地图是否连通（从第一个可走格子出发能否走到所有可走格子）。
 * @param {Object} map 地图
 * @param {{ walkable?: string[] }} [options] 可走地形，默认 floor/door/grass/stone
 * @returns {{ connected: boolean, total: number, reached: number, islands: number }}
 *   islands 是不连通的区域块数（1 表示全连通）
 */
export function checkConnectivity(map, options = {}) {
  const walkable = Array.isArray(options.walkable) && options.walkable.length
    ? options.walkable
    : ['floor', 'door', 'grass', 'stone']
  const isWalkable = (cell) => walkable.includes(cell.type)
  const passable = map.cells.filter(isWalkable)
  if (!passable.length) return { connected: true, total: 0, reached: 0, islands: 0 }

  const seen = new Set()
  let islands = 0
  let firstReach = 0
  for (const start of passable) {
    const key = start.x + ',' + start.y
    if (seen.has(key)) continue
    islands += 1
    const stack = [start]
    let reached = 0
    seen.add(key)
    while (stack.length) {
      const cell = stack.pop()
      reached += 1
      for (const [nx, ny] of [[cell.x + 1, cell.y], [cell.x - 1, cell.y], [cell.x, cell.y + 1], [cell.x, cell.y - 1]]) {
        const index = cellIndex(map, nx, ny)
        if (index < 0) continue
        const neighbor = map.cells[index]
        if (!isWalkable(neighbor)) continue
        const nkey = nx + ',' + ny
        if (seen.has(nkey)) continue
        seen.add(nkey)
        stack.push(neighbor)
      }
    }
    if (islands === 1) firstReach = reached
  }
  return { connected: islands <= 1, total: passable.length, reached: firstReach, islands }
}

// ── 随机地牢生成 ─────────────────────────────────────────────────────────────

/** 房间布点：随机撒不重叠的矩形，失败次数用完就停。 */
function scatterRooms(width, height, count, rng, minSize, maxSize) {
  const rooms = []
  const attempts = count * 40
  for (let attempt = 0; attempt < attempts && rooms.length < count; attempt += 1) {
    const w = minSize + Math.floor(rng() * (maxSize - minSize + 1))
    const h = minSize + Math.floor(rng() * (maxSize - minSize + 1))
    if (w + 2 >= width || h + 2 >= height) continue
    const x = 1 + Math.floor(rng() * Math.max(1, width - w - 1))
    const y = 1 + Math.floor(rng() * Math.max(1, height - h - 1))
    const candidate = { x, y, w, h }
    // 房间之间留 1 格间隙，避免贴墙连成一片
    const overlaps = rooms.some((room) => (
      candidate.x - 1 < room.x + room.w
      && candidate.x + candidate.w + 1 > room.x
      && candidate.y - 1 < room.y + room.h
      && candidate.y + candidate.h + 1 > room.y
    ))
    if (overlaps) continue
    rooms.push(candidate)
  }
  return rooms
}

/** 在两个房间中心之间挖 L 形走廊（先横后竖或先竖后横，随机选）。 */
function carveCorridor(grid, from, to, rng, corridorType = 'floor') {
  const horizontalFirst = rng() < 0.5
  const carve = (x, y) => {
    if (y < 0 || y >= grid.length) return
    if (x < 0 || x >= grid[y].length) return
    if (grid[y][x] === 'wall') grid[y][x] = corridorType
  }
  if (horizontalFirst) {
    for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x += 1) carve(x, from.y)
    for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y += 1) carve(to.x, y)
  } else {
    for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y += 1) carve(from.x, y)
    for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x += 1) carve(x, to.y)
  }
}

/** 把网格转成稠密 cells 数组。 */
function gridToCells(grid, width, height, fog = false) {
  const cells = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      cells.push({ x, y, type: grid[y][x], label: '', fog: fog === true, decor: '' })
    }
  }
  return cells
}

/**
 * 生成一个可玩的随机地牢：房间 + 走廊，保证全连通。
 *
 * 生成流程：
 *   1. 房间布点（随机尺寸、互不重叠、留 1 格间隙）
 *   2. 按房间中心横坐标排序后顺序连走廊（保证连通），再随机补 1~2 条环路
 *   3. 回填墙
 *   4. 首个房间放楼梯（入口），末个房间放宝箱，中间房间随机撒陷阱/箱子
 *
 * @param {number} width 宽（格），建议 ≥ 20
 * @param {number} height 高（格），建议 ≥ 15
 * @param {number|string} [seed] 随机种子；同一个 seed 必得同一张图
 * @param {{ name?: string, roomCount?: number, tileSize?: number, theme?: 'dungeon'|'cave'|'grass', fogEnabled?: boolean, withFeatures?: boolean }} [options]
 * @returns {Object} 地图对象（额外带 rooms 字段供调试与工具回显）
 * @throws {Error} 宽高非法或地图太小放不下房间时抛中文错误
 */
export function generateDungeon(width, height, seed, options = {}) {
  if (!Number.isFinite(Number(width)) || !Number.isFinite(Number(height))) {
    throw new Error('generateDungeon 需要数字宽高，收到 ' + width + ' x ' + height)
  }
  const w = clamp(Math.trunc(Number(width)), 8, MAX_DIMENSION)
  const h = clamp(Math.trunc(Number(height)), 8, MAX_DIMENSION)
  const rng = createRng(hashSeed(seed === undefined || seed === null ? Math.floor(Math.random() * 0xffffffff) : seed))

  const theme = ['dungeon', 'cave', 'grass'].includes(options.theme) ? options.theme : 'dungeon'
  const floorType = theme === 'grass' ? 'grass' : 'stone'
  const wallType = 'wall'

  const area = w * h
  const roomTarget = clamp(Math.round(Number(options.roomCount) || Math.max(3, Math.round(area / 120))), 2, 24)
  const minSize = 3
  const maxSize = clamp(Math.round(Math.min(w, h) / 3), 3, 8)
  let rooms = scatterRooms(w, h, roomTarget, rng, minSize, maxSize)
  // 小图可能一个房间都放不下：退化成「一整块房间」，保证任何合法尺寸都能出图
  if (rooms.length < 2) rooms = [{ x: 1, y: 1, w: w - 2, h: h - 2 }]

  const grid = []
  for (let y = 0; y < h; y += 1) grid.push(new Array(w).fill(wallType))
  for (const room of rooms) {
    for (let y = room.y; y < room.y + room.h; y += 1) {
      for (let x = room.x; x < room.x + room.w; x += 1) grid[y][x] = floorType
    }
  }

  const centers = rooms.map((room) => ({ x: room.x + Math.floor(room.w / 2), y: room.y + Math.floor(room.h / 2) }))
  const ordered = centers.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  // 走廊用 floor 与房间的 stone/grass 区分开，前端可以画不同的地表
  const corridorType = 'floor'
  for (let i = 1; i < ordered.length; i += 1) carveCorridor(grid, ordered[i - 1], ordered[i], rng, corridorType)
  const extraLoops = 1 + Math.floor(rng() * 2)
  for (let i = 0; i < extraLoops && ordered.length >= 3; i += 1) {
    const a = ordered[Math.floor(rng() * ordered.length)]
    const b = ordered[Math.floor(rng() * ordered.length)]
    if (a === b) continue
    carveCorridor(grid, a, b, rng, corridorType)
  }

  const map = {
    id: 'map-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name: String(options.name || '随机地牢'),
    width: w,
    height: h,
    tileSize: clamp(Math.trunc(Number(options.tileSize) || DEFAULT_TILE_SIZE), 8, 256),
    cells: gridToCells(grid, w, h, options.fogEnabled === true),
    tokens: [],
    features: [],
    fog: { enabled: options.fogEnabled === true, revealed: [] },
    grid: { visible: true, color: '#0002' },
    rooms: rooms.map((room, index) => ({ index, ...room })),
    seed: seed === undefined ? null : seed,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

  if (options.withFeatures !== false) {
    const firstCenter = centers[0]
    const lastCenter = centers[centers.length - 1]
    map.features.push({ x: firstCenter.x, y: firstCenter.y, type: 'stairs', data: { label: '入口', direction: 'up' } })
    if (rooms.length > 1) {
      map.features.push({ x: lastCenter.x, y: lastCenter.y, type: 'chest', data: { label: '战利品箱', looted: false } })
    }
    for (const room of rooms.slice(1, -1)) {
      const roll = rng()
      if (roll > 0.55) continue
      const x = room.x + Math.floor(rng() * room.w)
      const y = room.y + Math.floor(rng() * room.h)
      if (map.features.some((item) => item.x === x && item.y === y)) continue
      if (roll < 0.28) map.features.push({ x, y, type: 'trap', data: { label: '陷阱', armed: true, damage: '1d6' } })
      else map.features.push({ x, y, type: 'chest', data: { label: '箱子', looted: false } })
    }
  }

  if (map.fog.enabled) {
    for (const cell of map.cells) cell.fog = true
    const start = centers[0]
    for (let y = start.y - 2; y <= start.y + 2; y += 1) {
      for (let x = start.x - 2; x <= start.x + 2; x += 1) {
        const index = cellIndex(map, x, y)
        if (index < 0) continue
        map.cells[index].fog = false
        map.fog.revealed.push([x, y])
      }
    }
  }

  return map
}

/**
 * 把数字/字符串种子转成 32 位整数。
 * @param {number|string} seed 种子
 * @returns {number} 32 位无符号整数
 */
export function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.trunc(seed) >>> 0
  const text = String(seed)
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/**
 * 由数字/字符串种子建一个确定性随机源（地牢与骰子共用同一套算法）。
 * @param {number|string} seed 种子
 * @returns {() => number} 随机源
 */
export function seededRng(seed) {
  return createRng(hashSeed(seed))
}

/**
 * 地牢级 ASCII 预览（调试用；也方便模型核对生成结果）。
 * @param {Object} map 地图
 * @param {{ legend?: Record<string, string> }} [options] 自定义图例
 * @returns {string} 多行文本
 */
export function renderAscii(map, options = {}) {
  const legend = options.legend || {
    floor: '.',
    wall: '#',
    door: '+',
    water: '~',
    grass: ',',
    stone: '.',
    void: ' ',
  }
  const lines = []
  for (let y = 0; y < map.height; y += 1) {
    let line = ''
    for (let x = 0; x < map.width; x += 1) {
      const cell = map.cells[y * map.width + x]
      const token = map.tokens.find((entry) => entry.x === x && entry.y === y)
      const feature = map.features.find((entry) => entry.x === x && entry.y === y)
      if (token) line += token.kind === 'enemy' ? 'E' : token.kind === 'pc' ? '@' : 'o'
      else if (feature) line += feature.type === 'stairs' ? '<' : feature.type === 'chest' ? '$' : feature.type === 'trap' ? '^' : '*'
      else line += legend[cell.type] !== undefined ? legend[cell.type] : '?'
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * 两份地图快照之间的最小差异。
 * @param {Object} prev 改动前的地图（可为 null，表示新建）
 * @param {Object} next 改动后的地图
 * @returns {{created: boolean, cells: Array, tokens: {added: Array, moved: Array, removed: Array}, features: {added: Array, removed: Array}, fog: Array, gridChanged: boolean, size: {width:number,height:number}}}
 */
export function diffMaps(prev, next) {
  if (!next) {
    return { created: false, cells: [], tokens: { added: [], moved: [], removed: [] }, features: { added: [], removed: [] }, fog: [], gridChanged: false, size: { width: 0, height: 0 } }
  }
  if (!prev) {
    // 新建：一次给全（这是唯一必须全量的时刻），但仍然只给格子，不给冗余字段。
    return {
      created: true,
      cells: next.cells.map((cell) => ({ x: cell.x, y: cell.y, type: cell.type, icon: cell.decor || cellIcon(cell.type), fog: Boolean(cell.fog) })),
      tokens: { added: next.tokens.map((token) => ({ ...token, icon: token.icon || kindIcon(token.kind) })), moved: [], removed: [] },
      features: { added: next.features.map((feature) => ({ ...feature, icon: featureIcon(feature.type) })), removed: [] },
      fog: next.fog.revealed.map((pair) => [pair[0], pair[1]]),
      gridChanged: true,
      size: { width: next.width, height: next.height },
    }
  }

  // 格子：按坐标比对，只回变化的
  const prevCells = new Map()
  for (const cell of prev.cells) prevCells.set(cell.x + ',' + cell.y, cell)
  const cells = []
  for (const cell of next.cells) {
    const old = prevCells.get(cell.x + ',' + cell.y)
    const changed = !old || old.type !== cell.type || (old.decor || '') !== (cell.decor || '')
      || Boolean(old.fog) !== Boolean(cell.fog) || (old.label || '') !== (cell.label || '')
    if (changed) {
      cells.push({ x: cell.x, y: cell.y, type: cell.type, icon: cell.decor || cellIcon(cell.type), fog: Boolean(cell.fog), label: cell.label || '' })
    }
  }

  // token：新增 / 移动 / 移除
  const prevTokens = new Map(prev.tokens.map((token) => [token.id, token]))
  const nextTokens = new Map(next.tokens.map((token) => [token.id, token]))
  const added = []
  const moved = []
  const removed = []
  for (const token of next.tokens) {
    const old = prevTokens.get(token.id)
    if (!old) added.push({ ...token, icon: token.icon || kindIcon(token.kind) })
    else if (old.x !== token.x || old.y !== token.y) {
      moved.push({ id: token.id, name: token.name, from: { x: old.x, y: old.y }, to: { x: token.x, y: token.y } })
    }
  }
  for (const token of prev.tokens) if (!nextTokens.has(token.id)) removed.push({ id: token.id, name: token.name })

  // feature
  const prevFeatures = new Set(prev.features.map((feature) => feature.id))
  const nextFeatureIds = new Set(next.features.map((feature) => feature.id))
  const featuresAdded = next.features.filter((feature) => !prevFeatures.has(feature.id)).map((feature) => ({ ...feature, icon: featureIcon(feature.type) }))
  const featuresRemoved = prev.features.filter((feature) => !nextFeatureIds.has(feature.id)).map((feature) => ({ id: feature.id, type: feature.type }))

  // 迷雾：只回新揭开的
  const prevRevealed = new Set(prev.fog.revealed.map((pair) => pair[0] + ',' + pair[1]))
  const fog = next.fog.revealed.filter((pair) => !prevRevealed.has(pair[0] + ',' + pair[1])).map((pair) => [pair[0], pair[1]])

  return {
    created: false,
    cells,
    tokens: { added, moved, removed },
    features: { added: featuresAdded, removed: featuresRemoved },
    fog,
    gridChanged: prev.grid.visible !== next.grid.visible,
    size: { width: next.width, height: next.height },
  }
}

/**
 * 增量是否为空（没有任何可见变化）。
 * @param {Object} delta diffMaps 的结果
 * @returns {boolean}
 */
export function isEmptyDelta(delta) {
  if (!delta || delta.created) return false
  return delta.cells.length === 0
    && delta.tokens.added.length === 0 && delta.tokens.moved.length === 0 && delta.tokens.removed.length === 0
    && delta.features.added.length === 0 && delta.features.removed.length === 0
    && delta.fog.length === 0
    && !delta.gridChanged
}

/**
 * 给已有地图开启或关闭战争迷雾。
 * 开启时把所有非冒险者视野内的格子标为未探索；关闭时全部揭开。
 * @param {Object} map
 * @param {boolean} enabled
 * @param {{reveal?: Array<[number, number]>}} [options] 开启时仍然保持可见的格子（如队伍所在处）
 * @returns {Object} 新地图（不修改入参）
 */
export function coverFog(map, enabled, options = {}) {
  const next = cloneMap(map)
  next.fog.enabled = enabled === true
  const keep = new Set((options.reveal || []).map((pair) => pair[0] + ',' + pair[1]))
  for (const cell of next.cells) {
    if (!enabled) { cell.fog = false; continue }
    cell.fog = !keep.has(cell.x + ',' + cell.y)
  }
  if (!enabled) next.fog.revealed = []
  return next
}
