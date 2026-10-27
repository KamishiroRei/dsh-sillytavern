# 模块契约（团队协作必须遵守）

任何跨目录调用的导出名与签名以本文件为准。**改签名先改这里，再改调用方。**

## lib/paths.js   [lead]
```js
export function dshHome(): string
export function dataLayout(root): { root, characters, avatars, worlds, chats, groups, presets, regex, quickReplies, personas, trpg, settings, bindings, state }
export function ensureLayout(root): 同上（并创建目录）
export function stUserDirs(stRoot): null | { root, characters, worlds, chats, groups, presets, quickReplies, personas, themes }
export function absPath(p, cwd?): string
```

## lib/store.js   [lead]
```js
export function readJson(file, fallback?): any
export function writeJson(file, value): void      // 原子写
export function removeFile(file): void
export function safeName(name, fallback?): string
export function listJsonFiles(dir): { name, file, mtime }[]
export function collection(dir): { dir, list(), read(id), write(id, v), remove(id), has(id) }
export function createStore(ctx, config): PluginState   // 已被 plugin.js 内联替代，保留兼容
```

## lib/util.js   [lead]
```js
export function estimateTokens(text): number
export function trimByBudget(messages, budget, getText): any[]
export function assign(target, ...sources): object
export function displayText(value): string
export function shortId(prefix?): string
export function clamp(n, lo, hi): number
export function clone(value): any
export function contains(haystack, needle): boolean
export function toList(value): string[]
export function tryRegExp(pattern, flags?): RegExp|null
export function nowIso(): string
```

## lib/st/character.js   [tavern-core]
```js
/** 解析 PNG(tavern卡) 或 JSON 文本 → 规范化角色卡。抛错表示格式不支持。 */
export function parseCharacterBuffer(buffer, filenameHint?): { card: CharacterCard, avatarPng: Buffer|null }
export function parseCharacterJson(rawText): CharacterCard
export function normalizeCharacter(input, idHint?): CharacterCard
/** 导出为 ST V2 规范的 JSON 文本（可直接被 ST 导入）。 */
export function serializeCharacter(card): string
/** 把 PNG 头像里写入 tEXt chara 块，产出可被 ST 直接导入的卡图。 */
export function buildCharacterPng(card, avatarPng?): Buffer
/** 角色卡 → 提示词块数组，顺序即 ST PromptManager 默认顺序。 */
export function characterPromptBlocks(card, options): { identifier: string, text: string }[]
```

## lib/st/worldbook.js   [tavern-core]
```js
export function normalizeWorldbook(raw): { entries: Record<string, WorldbookEntry>, name?: string }
export function loadWorldbookFromFile(file): { entries, name }
/** 核心：扫描激活。chatLines 是从旧到新的消息文本数组。 */
export function scanWorldInfo(entries, options): {
  before: string[],        // 插在角色定义之前（position 0）
  after: string[],         // 插在角色定义之后（position 1）
  atDepth: { text: string, depth: number, role: string }[],
  anTop: string[], anBottom: string[],
  activated: number[],     // uid
  tokens: number,
}
export function createWorldbookStore(state): { list(), read(name), write(name, book), remove(name) }
```

## lib/st/macros.js   [tavern-core]
```js
export function createMacroEnv(env): Object       // 归一化运行环境
export function expandMacros(text, env): string   // 展开全部 ST 宏，返回纯文本
export function listMacros(): string[]            // 已支持宏名，供文档与自检
```

## lib/st/regex.js   [tavern-core]
```js
export function normalizeRegexScripts(raw): RegexScript[]
export function applyRegex(text, scripts, placement /* 'prompt'|'display' */): string
export function createRegexStore(state): { list(), write(scripts) }
```

## lib/prompt/assembly.js   [tavern-core]
```js
/** 注册到 ctx.systemPrompt 的 section 与相关工具；由 plugin.js 调用。 */
export function registerAssembly(ctx, state): void
/** 供工具与路由复用：装配一次完整提示。 */
export function assemblePrompt(state, chat, character, options): AssembledPrompt
export function listPromptBlocks(state): { identifier: string, label: string, order: number, enabled: boolean }[]
```

## lib/tools/*.js   [tavern-tools 除 trpg.js]
每个文件导出 `registerXxx(ctx, state)`，内部 `ctx.tools.register(defineTool({...}))`。
工具名一律 `st_` 前缀。

## lib/tools/support.js   [tavern-tools]
工具、路由、导入器共用的支撑层（没有 register，只有函数）。**改这里的签名先改本文件。**
```js
export const ROUTE_PREFIX, AVATAR_ROUTE, AVATAR_MIME, DEFAULT_SESSION_ID
export async function loadEngine(name): Object   // name: character|worldbook|macros|regex|assembly|trpg
export function needExport(mod, exportName, label): any
export function resolveSessionId(state, args?, exec?): string   // 永不抛错，兜底 'default'
export function touchSession(state, sessionId): string
export function normalizeCardShape(raw, id): CharacterCard
export function characterStore(state): { dir, ids, read, has, remove, write, nextId, idFor, resolve, hasAvatar, writeAvatar, readAvatar }
export function listCharacters(state, options?): Array<summary>
export function avatarUrlOf(card): string
export function touchCharacterUsage(state, id): void
export function bindCharacterToSession(state, sessionId, characterId): { sessionId, characterId }
export function createChatStore(state): { dir, fileOf, list, read, write, ensure, append, remove }
export function stEntryDefaults(): Object
export function normalizeWorldbookEntry(input, uid?): WorldbookEntry
export function worldbookStore(state): { dir, names, read, write, remove, has, resolve, count }
export function bookEnabled(state, name): boolean
export function setBookEnabled(state, name, enabled): { name, enabled }
export function activeWorldbookNames(state, sessionId): string[]
export async function scanWorldbooksForText(state, options): ScanResult
export function regexStore(state): { file, read, write }
export function regenerateLastReply(state, sessionId, options?): RegenerateResult
export function swipeMessage(state, sessionId, options?): SwipeResult
export function stExtraOf(message): Object
export async function getTrpgStateSafe(state, sessionId): Object
export function denyNonLoopback(req, res): boolean
export function sendJson/sendError/sendOk/sendImage(...)
export function readJsonBody(req, limitBytes?): Promise<Object>
```

### 工具 ↔ HTTP 共用同一份实现
`swipeMessage` / `regenerateLastReply` / `scanWorldbooksForText` 是**唯一实现**：
`st_swipe`、`st_regenerate`、`st_scan_worldbook` 与 `POST /chat/:id/swipe`、
`POST /chat/:id/regenerate`、`POST /worldbooks/scan` 都调它们。加行为只改一处。

## lib/tools/importer.js   [tavern-tools]
`export function registerImportTools(ctx, state)` —— 除注册 `st_import_sillytavern` /
`st_list_st_sources` 外，还把 `{ importFromSillyTavern, probeSillyTavern }` 挂到
`state.importer`（`lib/bootstrap.js` 的首次启动自动导入靠这个）。

## lib/tools/trpg.js   [trpg-gm]   工具名前缀 `trpg_`
## lib/trpg/*.js       [trpg-gm]   跑团引擎，纯函数为主
```js
export function rollDice(expr): { total, rolls, detail, expr }        // 支持 2d6+3、4d6kh3、1d100
export function abilityCheck(input): CheckResult                      // 属性/技能/对抗判定
export function createEncounter(...), nextTurn(...), applyDamage(...)
export function createScene(...), updateScene(...), renderMap(...)    // 地图数据（格子/坐标）
export function createSheet(...), updateSheet(...)
export function appendLog(...) 
```

## lib/routes.js   [tavern-tools]
```js
export function registerRoutes(ctx, state): void
// 一条 prefix 路由 /dsh-sillytavern-api，内部按 pathname + method 分发
// 注意：不能挂在 /api 下 —— 那是 DSH 客户端 RPC 桥的领地，未授权请求会被 401 拦掉
```
端点（成功一律 `{ ok: true, data }`，失败 `{ ok: false, error }` + 状态码；除头像/素材外全部 JSON）：
```
GET  /ping                          （含 config 只读回显：cordis 配置，客户端改不了）
GET|POST /state                     （POST 白名单：trpgLayout centerPanel leftCollapsed
                                     splitRatio activeCharacterId theme panelWidth rightWidth；
                                     响应额外带 accepted / dropped 供前端自检）
GET  /characters · GET /characters/:id · POST /characters/bind
GET  /avatars/:file                     （二进制，Content-Type 按扩展名）
GET  /worldbooks · POST /worldbooks/toggle · POST /worldbooks/scan
GET  /presets · GET /presets/:name
GET  /chats · GET /chat/:sessionId · POST /chat/:sessionId/swipe · POST /chat/:sessionId/regenerate
GET  /trpg · GET /trpg/:sessionId · POST /trpg/log
POST /import
GET  /assets                            （分组自检）
GET  /assets/:group/:file               （二进制；group 白名单见 ASSET_GROUPS）
```
所有响应带 `Cache-Control: no-store`（素材路由是 `public, max-age=86400`），
非回环 Host 一律 403。素材路由的 file 只接受 `^[A-Za-z0-9_.-]+$`，扩展名白名单
`.png .jpg .jpeg .svg .webp .otf .ttf .woff2`。

## lib/importer.js   [tavern-tools]
```js
export function registerImportTools(ctx, state): void   // plugin.js 已调用
export function importFromSillyTavern(state, stRoot, options): ImportReport
```

## lib/client.js    [tavern-ui]
ModuleLoader bundle：`window.__ModuleLoader__.load({ id: 'dsh-sillytavern', factory: (require) => ({ apply, inject }) })`。
只允许通过 `require('react')` 等平台模块引入依赖；数据走 `/dsh-sillytavern-api/*`。

## lib/stage.js + lib/tools/stage.js   [lead]   工具名前缀 stage_

舞台是 AI 输出内容的承载面，不预设任何玩法形态。

```js
export const PANEL_KINDS = ['blocks','canvas','map','image','text','table']
export const BLOCK_KINDS = ['heading','text','list','table','meter','chips','divider','image','quote','steps']
export function getStage(state, sessionId)
export function publishStage(state, sessionId, { panels?, panel?, mode? })
export function patchStage(state, sessionId, operations)
export function clearStage(state, sessionId)
```

patch 操作：set-panel / replace-blocks / upsert-block / patch-block / remove-block / remove-panel。
面板与块必须有稳定 id，否则增量对不上。

渲染约定：客户端把 panels 按顺序铺在中栏，每种 kind 各自渲染。

## 工具名总表（唯一，禁止重名）
st_list_characters · st_get_character · st_create_character · st_edit_character · st_import_character · st_export_character · st_bind_character
st_list_worldbooks · st_get_worldbook · st_create_worldbook · st_import_worldbook · st_add_worldbook_entry · st_toggle_worldbook · st_scan_worldbook
st_list_presets · st_get_preset · st_set_preset · st_set_author_note · st_apply_regex
st_get_chat_state · st_swipe · st_regenerate · st_set_persona · st_set_scene · st_export_chat
st_get_variables · st_set_variable · st_list_variables
st_import_sillytavern · st_list_st_sources
trpg_roll · trpg_check · trpg_start_encounter · trpg_next_turn · trpg_update_sheet · trpg_show_map · trpg_update_scene · trpg_log
