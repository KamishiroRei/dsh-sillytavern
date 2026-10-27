/**
 * 共享类型与模块契约（只有 JSDoc，无运行时代码）。
 *
 * 团队分工按此文件的导出签名对齐；改签名必须先改这里。
 */

/**
 * @typedef {Object} PluginState 所有子系统共享的运行时状态
 * @property {import('@deepseek-ai/cordis').Context} ctx
 * @property {Object} config          lib/plugin.js 校验后的配置
 * @property {Object} layout          lib/paths.js ensureLayout() 的目录表
 * @property {Map<string, any>} cache 解析缓存
 * @property {Object} data            落盘的 state.json 内容
 * @property {() => void} save        立即落盘
 */

/**
 * @typedef {Object} CharacterCard SillyTavern V2 角色卡（规范化后）
 * @property {string} name
 * @property {string} description
 * @property {string} personality
 * @property {string} scenario
 * @property {string} first_mes
 * @property {string} mes_example
 * @property {string} creator_notes
 * @property {string} system_prompt
 * @property {string} post_history_instructions
 * @property {string[]} alternate_greetings
 * @property {string[]} tags
 * @property {string} creator
 * @property {string} character_version
 * @property {Object} extensions      原样保留，含 depth_prompt、talkativeness 等
 * @property {Object|null} character_book 内嵌世界书
 * @property {string} avatar          头像文件名（相对 layout.avatars），可为空
 * @property {string} id              插件侧稳定 id
 */

/**
 * @typedef {Object} WorldbookEntry SillyTavern 世界书条目
 * @property {number} uid
 * @property {string[]} key
 * @property {string[]} keysecondary
 * @property {string} comment
 * @property {string} content
 * @property {boolean} constant
 * @property {boolean} selective
 * @property {boolean} selectiveLogic 0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL
 * @property {boolean} disable
 * @property {number} order  插入排序
 * @property {number} position  0=before char 1=after char 2=AN top 3=AN bottom 4=@depth
 * @property {number} depth
 * @property {number} probability
 * @property {boolean} useProbability
 * @property {string} group
 * @property {number} groupWeight
 * @property {boolean} caseSensitive
 * @property {boolean} matchWholeWords
 * @property {boolean} useGroupScoring
 * @property {string} scanDepth  null=继承全局
 * @property {string} role  system/user/assistant
 * @property {boolean} excludeRecursion
 * @property {boolean} preventRecursion
 * @property {string} automationId
 */

/**
 * @typedef {Object} ChatMessage
 * @property {string} id
 * @property {'user'|'assistant'|'system'} role
 * @property {string} name       说话的角色名（可为空）
 * @property {string} content
 * @property {number} time
 * @property {boolean} hidden    对模型隐藏（swipe 掉的、系统提示）
 * @property {string[]} swipes
 * @property {number} swipeIndex
 * @property {Object} [extra]    工具/跑团附加数据
 */

/**
 * @typedef {Object} ChatSession
 * @property {string} id
 * @property {string} characterId
 * @property {string} title
 * @property {string} persona       用户角色名
 * @property {ChatMessage[]} messages
 * @property {Object} variables     本地变量表（ST 的 setvar / MVU）
 * @property {Object} metadata      世界书激活记录、场景等
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} AssembledPrompt 一次请求装配结果
 * @property {string} systemPrompt
 * @property {ChatMessage[]} history
 * @property {Object} diagnostics    各块令牌数、激活的世界书 id、宏展开统计
 */

export {}
