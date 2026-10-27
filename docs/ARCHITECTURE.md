# dsh-sillytavern 架构与分工

SillyTavern 引擎级别的 DSH 插件。目标：把 SillyTavern（下称 ST）的核心玩法搬进 DeepSeek Harness，
并在此基础上做 ST 做不到的事：三栏跑团布局、中间地图/场景、右侧对话、智能 UI。

## 事实基线（已核实，不要重新假设）

- ST 安装：`D:\Silly\SillyTavern-1.16.0`，package.json 版本写 **1.18.0**，`type: module`。
- 用户数据：`D:\Silly\SillyTavern-1.16.0\data\default-user`，含 24 张角色卡（characters/）、
  worlds/（含 D&D 5e 规则世界书、FGO、哈利波特等）、chats/、groups/、OpenAI Settings/、QuickReplies/、
  themes/、settings.json、secrets.json。
- ST 前端脚本：`public/scripts/` 721 个文件 24MB。关键：openai.js(315KB)、slash-commands.js(301KB)、
  world-info.js(266KB)、power-user.js、personas.js、tags.js、variables.js、PromptManager.js、group-chats.js。
- ST 1.18 的宏系统是新引擎：`public/scripts/macros/macro-system.js`（chevrotain 解析）+ `macros/definitions/*.js`
  （core/env/state/chat/time/variable/instruct 七组）。旧的 `macros.js` 只是兼容层。
- 提示词装配顺序（PromptManager.js）：main → worldInfoBefore → personaDescription → charDescription →
  charPersonality → scenario → enhanceDefinitions(默认关) → nsfw → worldInfoAfter → dialogueExamples →
  chatHistory → jailbreak(Post-History)。**这就是我们要复刻的顺序。**
- 默认宏文本：Main = `Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.`

## 已核实的 DSH 侧接入点

| 目的 | 接入点 | 证据 |
|---|---|---|
| 注册工具 | `ctx.tools.register(defineTool({...}))` | `docs/user/develop/basic/tool.md` |
| 系统提示词分节 | `ctx.systemPrompt.section({ name, order, text })` | `packages/core/system-prompt/src/index.ts`（SECTION_ORDERS 里 TOOLS_SDK=5000 之后、DEPLOYMENT_PERSONA_SUFFIX=10200 之前可用；外部插件可用任意有限 order） |
| HTTP 路由 | `ctx.webServer.register({ kind: 'prefix', path, handler })` | `packages/host/webserver/src/index.ts` |
| 客户端插件 | package.json 的 `dsh.client` + `exports["./client"]`，产物是 `window.__ModuleLoader__.load({ id, factory })` 的 CJS bundle | dsh-meme 实测 |
| 客户端 UI | `ctx.slots.inject(name, () => ctx.slots.register(...))`，可用 slot：`conversation.input.left`、`conversation.input.overlay`、`conversation.chat.node`、`conversation.chat.turnTail`、`tool.call.toolview`、`sidebar.right.pane.tab`、`sidebar.right.pane.tab.title`、`plugins.bundle.config`、`settings.section` | dsh-meme / motion-ui 实测 |
| 浏览器平台模块（可直接 `require()`） | `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit` | `packages/client/web/src/platform.ts` |
| 三栏布局 | `ctx.layout.selectPanel(id)` / `main` keyed slot / `sidebar.right` | `packages/client/ui-layout` |

**没有构建步骤。** `lib/` 下全是可直接被 Node ESM 加载的 .js。客户端 `lib/client.js` 是手写的
ModuleLoader bundle（参照 dsh-meme 的 client.js 结构）。不要引入 tsc/tsdown/esbuild。

## 目录与写入归属（写锁：只能改自己那格）

```
dsh-sillytavern/
  package.json  cordis.patch.yml  dsh-plugin.json     [lead]
  lib/index.js                                        [lead]  bundle 入口
  lib/plugin.js                                       [lead]  apply + Config + 组装
  lib/paths.js  lib/store.js  lib/util.js             [lead]  基础设施
  lib/st/           ST 引擎移植                        [tavern-core]
  lib/prompt/       提示词装配 + 宏 + 正则              [tavern-core]
  lib/tools/        工具定义                           [tavern-tools]
  lib/routes.js     HTTP API                          [tavern-tools]
  lib/importer.js   ST 安装目录只读导入                 [tavern-tools]
  lib/trpg/         跑团引擎（判定/战斗/NPC/地图/角色卡） [trpg-gm]
  lib/client.js     客户端 bundle                     [tavern-ui]
  lib/client/       客户端分片（仅 tavern-ui 引用）      [tavern-ui]
  docs/                                              [lead + 各自补充]
```

## 数据布局（`~/.dsh/dsh-sillytavern/`，见 lib/paths.js）

characters/ avatars/ worlds/ chats/ groups/ presets/ regex/ quick-replies/ personas/ trpg/
settings.json bindings.json state.json

角色卡存 ST 原生 V2 JSON 全字段（含 character_book、extensions），PNG 卡解析后落 JSON + 抽出头像。
世界书存 ST 原生格式 `{ entries: { "0": {...} } }`，可直接反向导出。

## 插件要提供的模型可见能力（工具）

1. 角色：list_characters / get_character / create_character / edit_character / import_character / export_character / bind_character
2. 世界书：list_worldbooks / get_worldbook / create_worldbook / import_worldbook / add_worldbook_entry / toggle_worldbook
3. 会话：get_chat_state / swipe / continue / regenerate / set_persona / set_scene
4. 提示词：list_presets / get_preset / set_preset / set_author_note / apply_regex
5. 变量：get_variables / set_variable / list_mvu
6. 跑团：roll_dice / check / start_encounter / next_turn / update_sheet / show_map / update_scene

工具名一律 `st_` 前缀，避免与其他酒馆插件冲突。**这是硬约定。**

## 客户端 UI 目标

- 默认：接管对话区，渲染角色卡气泡、头像、世界书触发的折叠标记、选项按钮。
- 跑团模式（三栏）：左 = 角色/世界书/队伍；中 = 地图/场景/角色卡/日志（可切换）；右 = 对话。
- 中间地图支持：格子地图（grid）、场景插图、角色卡数值面板、事件日志。
- 设置页：数据目录、导入 ST、布局开关、GM 规则。

## 质量基线

- 不允许"占位实现"、"TODO 后补"、"简化版"。每个功能要么完整可用，要么不做。
- 中文 UI 文案，代码注释中文，标识符英文。
- 所有状态变化走真实文件，不搞内存态自嗨。
- 改完必须能在 `dsh web` 里真的跑起来：插件加载、工具可调用、路由 200、面板可见。
