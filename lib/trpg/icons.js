/**
 * 素材图标 key 映射。
 *
 * 只输出 **key 字符串**，不读文件、不复制图片。前端拿 key 到
 * /dsh-sillytavern-api/assets/:group/:file 取图（该路由由 tavern-tools 提供）。
 * 路径不带 /api：DSH 的 RPC 桥接管了 /api/* 前缀，外部 URL 一律 401。
 *
 * 素材来源（用户自己的 Godot 项目，可直接复用）：
 *   D:\\Game\\tianjie-fall\\assets\\ui\\icon_library_v1\\glyph_*.png   —— 64×64 像素图标
 *   D:\\Game\\tianjie-fall\\assets\\ui\\shared_argent_v1\\assets\\icons\\meter_*.png —— HP/护盾条
 *
 * 这里的 key 就是**去掉 .png 的文件名**，例如 'glyph_strength'。
 * 图标库实际只有 46 个 glyph，任何映射都必须落在真实存在的 key 上——
 * 编一个不存在的 key，前端就会拿到 404 空白格。
 */

/** 六维/属性键 → glyph key。键统一小写。 */
export const ATTRIBUTE_ICONS = {
  // D&D 5e 六维
  str: 'glyph_strength',
  dex: 'glyph_agility',
  con: 'glyph_constitution',
  int: 'glyph_intelligence',
  wis: 'glyph_spirit',
  cha: 'glyph_luck',
  // COC 7e 补充属性
  siz: 'glyph_vigor',
  app: 'glyph_flow',
  pow: 'glyph_ward',
  edu: 'glyph_arcana',
  luck: 'glyph_luck',
  // 中文别名：角色卡里可能直接写中文属性名
  力量: 'glyph_strength',
  敏捷: 'glyph_agility',
  体质: 'glyph_constitution',
  智力: 'glyph_intelligence',
  感知: 'glyph_spirit',
  魅力: 'glyph_luck',
  体型: 'glyph_vigor',
  外貌: 'glyph_flow',
  意志: 'glyph_ward',
  教育: 'glyph_arcana',
  幸运: 'glyph_luck',
}

/** 属性键的中文名，展示用。 */
export const ATTRIBUTE_NAMES = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力',
  siz: '体型',
  app: '外貌',
  pow: '意志',
  edu: '教育',
  luck: '幸运',
}

/** 元素/伤害类型 → glyph key。 */
export const ELEMENT_ICONS = {
  fire: 'glyph_fire',
  火: 'glyph_fire',
  火焰: 'glyph_fire',
  water: 'glyph_water',
  水: 'glyph_water',
  冰: 'glyph_water',
  ice: 'glyph_water',
  wind: 'glyph_wind',
  风: 'glyph_wind',
  雷: 'glyph_wind',
  lightning: 'glyph_wind',
  earth: 'glyph_earth',
  土: 'glyph_earth',
  地: 'glyph_earth',
  light: 'glyph_light',
  光: 'glyph_light',
  神圣: 'glyph_light',
  dark: 'glyph_dark',
  暗: 'glyph_dark',
  暗影: 'glyph_dark',
  精神: 'glyph_dark',
  毒: 'glyph_potion',
  poison: 'glyph_potion',
}

/**
 * 状态名（中英文都认）→ glyph key。
 * 挑选标准：图标库只有 46 个 glyph，「中毒/流血」这类没有专属图标，
 * 用语义最近的通用 glyph（药水/恢复/守护/敌意）而不是硬造不存在的名字。
 */
export const STATUS_ICONS = {
  中毒: 'glyph_potion',
  poison: 'glyph_potion',
  poisoned: 'glyph_potion',
  流血: 'glyph_potion',
  出血: 'glyph_potion',
  bleed: 'glyph_potion',
  bleeding: 'glyph_potion',
  眩晕: 'glyph_absolute',
  stun: 'glyph_absolute',
  stunned: 'glyph_absolute',
  麻痹: 'glyph_absolute',
  paralyzed: 'glyph_absolute',
  倒地: 'glyph_garrison',
  prone: 'glyph_garrison',
  束缚: 'glyph_garrison',
  restrained: 'glyph_garrison',
  恐惧: 'glyph_enmity',
  fear: 'glyph_enmity',
  feared: 'glyph_enmity',
  魅惑: 'glyph_flow',
  charm: 'glyph_flow',
  charmed: 'glyph_flow',
  睡眠: 'glyph_recovery',
  sleep: 'glyph_recovery',
  asleep: 'glyph_recovery',
  隐形: 'glyph_flow',
  invisible: 'glyph_flow',
  目盲: 'glyph_dark',
  blinded: 'glyph_dark',
  耳聋: 'glyph_absolute',
  deafened: 'glyph_absolute',
  力竭: 'glyph_stamina',
  exhaustion: 'glyph_stamina',
  护盾: 'glyph_ward',
  shield: 'glyph_ward',
  加速: 'glyph_haste',
  haste: 'glyph_haste',
  恢复: 'glyph_recovery',
  regen: 'glyph_recovery',
}

/**
 * 物品名关键词 → glyph key。
 * 按顺序匹配，先命中的先赢；都不命中用 DEFAULT_ITEM_ICON。
 */
export const ITEM_ICON_RULES = [
  { keys: ['金币', '钱', '银币', '铜币', '黄金', 'coin', 'gold', 'silver', 'gp', 'cp'], icon: 'glyph_coins' },
  { keys: ['药', '药剂', '药水', 'potion', 'elixir', '治疗'], icon: 'glyph_potion' },
  { keys: ['钥匙', '锁', 'key', 'lock', '撬锁', '开锁'], icon: 'glyph_lock' },
  { keys: ['卷轴', '书', '笔记', '地图', '资料', 'scroll', 'book', 'map', 'note', '数据'], icon: 'glyph_data' },
  { keys: ['剑', '刀', '斧', '锤', '矛', '枪', '匕首', 'sword', 'axe', 'blade', 'dagger', 'spear'], icon: 'glyph_might' },
  { keys: ['弓', '箭', '弩', 'bow', 'arrow', 'crossbow'], icon: 'glyph_precision' },
  { keys: ['盾', '甲', '护甲', '盔甲', 'shield', 'armor', 'mail'], icon: 'glyph_bulwark' },
  { keys: ['法杖', '魔杖', '水晶', '护符', 'staff', 'wand', 'crystal', 'amulet'], icon: 'glyph_arcana' },
  { keys: ['火把', '灯', '蜡烛', 'torch', 'lantern', 'candle'], icon: 'glyph_light' },
  { keys: ['绳', '钩', '工具', 'rope', 'hook', 'tool', 'kit'], icon: 'glyph_data' },
]

/** 物品默认图标。 */
export const DEFAULT_ITEM_ICON = 'glyph_data'

/** 角色类型（阵营）→ 棋子/角色卡图标。 */
export const KIND_ICONS = {
  pc: 'glyph_strength',
  npc: 'glyph_data',
  enemy: 'glyph_enmity',
  ally: 'glyph_ward',
  object: 'glyph_lock',
}

/** 棋子/角色卡找不到 kind 时的兜底图标。 */
export const TOKEN_ICON_FALLBACK = 'glyph_data'

/** 地形类型 → glyph key（前端画格子时的备选装饰图标，没有就用纯色块）。 */
export const CELL_ICONS = {
  floor: 'glyph_progress',
  wall: 'glyph_bulwark',
  door: 'glyph_lock',
  water: 'glyph_water',
  grass: 'glyph_earth',
  stone: 'glyph_earth',
  void: 'glyph_absolute',
}

/** 地图特征 → glyph key。 */
export const FEATURE_ICONS = {
  door: 'glyph_lock',
  trap: 'glyph_enmity',
  chest: 'glyph_coins',
  stairs: 'glyph_progress',
  note: 'glyph_data',
  torch: 'glyph_light',
  altar: 'glyph_arcana',
}

/** HP/护盾条素材（前端直接贴图，这里只给文件名）。 */
export const METER_ASSETS = {
  health: 'meter_health',
  healthWarm: 'meter_health_warm',
  shield: 'meter_shield',
  track: 'meter_track',
}

/** 面板框素材。 */
export const PANEL_ASSETS = {
  panel: 'panel',
  panelLight: 'panel_light',
  panelDark: 'panel_dark',
}

/** 把 key 归一化后查表。 */
function lookup(table, key) {
  if (!key) return null
  const raw = String(key).trim()
  if (table[raw]) return table[raw]
  const lower = raw.toLowerCase()
  if (table[lower]) return table[lower]
  return null
}

/**
 * 属性键 → 图标 key。
 * @param {string} key 属性键（str/dex/con… 或中文名）
 * @returns {string} glyph key；未知属性回退到 glyph_data
 */
export function attributeIcon(key) {
  return lookup(ATTRIBUTE_ICONS, key) || DEFAULT_ITEM_ICON
}

/**
 * 属性键 → 中文名。
 * @param {string} key 属性键
 * @returns {string} 中文名；未知时原样返回
 */
export function attributeName(key) {
  return lookup(ATTRIBUTE_NAMES, key) || String(key || '')
}

/**
 * 状态名 → 图标 key。
 * @param {string} name 状态名
 * @returns {string} glyph key；未知状态回退到 glyph_absolute
 */
export function statusIcon(name) {
  return lookup(STATUS_ICONS, name) || 'glyph_absolute'
}

/**
 * 物品名 → 图标 key（按关键词模糊匹配）。
 * @param {string} name 物品名
 * @returns {string} glyph key
 */
export function itemIcon(name) {
  const text = String(name || '').toLowerCase()
  if (!text) return DEFAULT_ITEM_ICON
  for (const rule of ITEM_ICON_RULES) {
    for (const key of rule.keys) {
      if (text.includes(String(key).toLowerCase())) return rule.icon
    }
  }
  return DEFAULT_ITEM_ICON
}

/**
 * 伤害/元素类型 → 图标 key。
 * @param {string} type 伤害类型
 * @returns {string} glyph key；未知返回 null（前端自行处理）
 */
export function elementIcon(type) {
  return lookup(ELEMENT_ICONS, type)
}

/**
 * 角色类型 → 图标 key。
 * @param {string} kind pc|npc|enemy|ally|object
 * @returns {string} glyph key
 */
export function kindIcon(kind) {
  return lookup(KIND_ICONS, kind) || KIND_ICONS.npc
}

/**
 * 地形类型 → 图标 key。
 * @param {string} type 地形类型
 * @returns {string} glyph key
 */
export function cellIcon(type) {
  return lookup(CELL_ICONS, type) || CELL_ICONS.floor
}

/**
 * 特征类型 → 图标 key。
 * @param {string} type 特征类型
 * @returns {string} glyph key
 */
export function featureIcon(type) {
  return lookup(FEATURE_ICONS, type) || 'glyph_data'
}
