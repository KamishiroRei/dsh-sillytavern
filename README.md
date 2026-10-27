# dsh-sillytavern

把 SillyTavern 酒馆引擎搬进 DeepSeek Harness，并在其上做 ST 做不到的事：跑团三栏布局、格子地图、角色卡数值面板。

## 它是什么

DSH 的一个插件。装上之后：

- **角色卡**：导入 ST 的 PNG / JSON 卡（V1 / V2 / V3 全兼容），头像自动抽出，可直接在对话里扮演
- **世界书**：ST 原生的扫描引擎——常量条目、关键词、二级关键词四种组合逻辑、递归、包含组加权、概率、令牌预算、@depth 分槽、sticky/cooldown/delay
- **预设与宏**：73 个 ST 宏（含 \`{{if}}\` / \`{{random}}\` / \`{{getvar}}\` 嵌套展开）、正则脚本、作者注释
- **变量**：ST 的 \`setvar\` / \`getvar\` / MVU 变量表
- **跑团**：骰子、判定、战斗、角色卡数值、格子地图、场景、日志、GM 协议
- **三栏布局**：左角色/队伍、中地图/场景/角色卡/日志、右对话

## 装法

\`\`\`sh
# 1. 注册到 profile
#    在 $DSH_HOME/profiles/web/package.json 的 dependencies 加：
#    "dsh-sillytavern": "link:D:/DSH-plugins/packages/dsh-sillytavern"
#    并把它加进 dsh.profile.bundles 数组

# 2. 链接包（Windows 用 junction，不需要管理员）
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-sillytavern" "D:\DSH-plugins\packages\dsh-sillytavern"

# 3. 在 profile 的 cordis.patch.yml 里配数据源（见下）
# 4. 重启 dsh web
\`\`\`

## 配置

在 \`$DSH_HOME/profiles/web/cordis.patch.yml\`：

\`\`\`yaml
- id: dsh-sillytavern
  name: dsh-sillytavern
  config:
    sillyTavernRoot: 'D:\Silly\SillyTavern-1.16.0'   # ST 安装目录，只读导入
    assetRoot: 'D:\Game\tianjie-fall\assets'          # 图标/血条/面板素材
\`\`\`

| 字段 | 默认 | 说明 |
|---|---|---|
| \`dataRoot\` | \`~/.dsh/dsh-sillytavern\` | 插件自己的数据目录 |
| \`sillyTavernRoot\` | \`''\` | ST 安装目录；配置后首次启动自动导入 |
| \`autoBind\` | \`true\` | 新会话自动绑定上次的角色卡 |
| \`maxWorldInfoDepth\` | \`4\` | 世界书递归扫描深度 |
| \`worldInfoBudget\` | \`2048\` | 单轮世界书令牌预算 |
| \`authorNoteDepth\` | \`4\` | 作者注释深度 |
| \`trpgLayout\` | \`true\` | 启用三栏跑团布局 |
| \`trpgCenterPanel\` | \`map\` | 中间舞台默认面板（map/scene/sheet/log） |
| \`injectSystemPrompt\` | \`true\` | 是否把角色/世界书装配进系统提示词 |
| \`promptSectionOrder\` | \`6500\` | 提示词分节排序位 |
| \`maxHistoryMessages\` | \`60\` | 装配时保留的历史消息条数 |
| \`defaultDiceSystem\` | \`dnd5e\` | 判定体系（dnd5e/coc7e/generic） |
| \`assetRoot\` | \`D:\Game\tianjie-fall\assets\` | UI 素材根目录 |

## 数据目录

\`\`\`
~/.dsh/dsh-sillytavern/
  characters/     角色卡（ST V2 JSON，带完整 extensions）
  avatars/        头像原图
  worlds/         世界书（ST 原生 { entries: {...} } 格式）
  chats/          会话
  presets/        ST OpenAI Settings 预设
  regex/          正则脚本
  quick-replies/  快速回复
  personas/       用户人格
  trpg/           跑团存档（按会话分目录）
  state.json      插件状态
\`\`\`

## 模型可见的工具

**酒馆**：\`st_list_characters\` \`st_get_character\` \`st_create_character\` \`st_edit_character\`
\`st_import_character\` \`st_export_character\` \`st_bind_character\`
\`st_list_worldbooks\` \`st_get_worldbook\` \`st_create_worldbook\` \`st_import_worldbook\`
\`st_add_worldbook_entry\` \`st_toggle_worldbook\` \`st_scan_worldbook\`
\`st_list_presets\` \`st_get_preset\` \`st_set_preset\` \`st_set_author_note\` \`st_set_scene\` \`st_apply_regex\`
\`st_get_chat_state\` \`st_swipe\` \`st_regenerate\` \`st_set_persona\` \`st_export_chat\`
\`st_get_variables\` \`st_set_variable\` \`st_list_variables\`
\`st_import_sillytavern\` \`st_list_st_sources\`

**跑团**：\`trpg_roll\` \`trpg_check\` \`trpg_opposed_check\` \`trpg_damage\`
\`trpg_start_encounter\` \`trpg_next_turn\` \`trpg_status\` \`trpg_end_encounter\`
\`trpg_update_sheet\` \`trpg_get_sheets\` \`trpg_remove_sheet\`
\`trpg_show_map\` \`trpg_update_scene\` \`trpg_log\`
\`trpg_parse_markers\` \`trpg_state\` \`trpg_reset\`

## HTTP 接口

独立前缀 \`/dsh-sillytavern-api\`（**不是 /api**——那个前缀被 DSH 的 RPC 桥占着，会 401）。

\`\`\`
GET  /ping              服务与配置自检
GET  /characters        角色列表        GET /characters/:id
GET  /avatars/:file     头像图片
GET  /worldbooks        POST /worldbooks/scan
GET  /state             POST /state（布局状态）
GET  /chat/:sessionId
GET  /trpg/:sessionId   跑团状态（渲染就绪，HP 百分比/图标 key 都算好）
POST /import
GET  /assets/:group/:file   静态素材
\`\`\`

## 设计要点

**没有构建步骤。** \`lib/\` 全是可直接被 Node ESM 加载的 .js，客户端是手写的 ModuleLoader bundle。
改完重启 \`dsh web\` 即生效，不需要 tsc/tsdown/esbuild。

**零外部依赖。** 插件装在 profile 树之外，解析不到 \`@deepseek-ai/*\` 裸包名，所以：
工具定义用自带的 \`lib/toolkit.js\`、配置用自带的 Standard Schema 实现、PNG 编解码自己写、
HTTP 路由拿 \`ctx.webServer\`、提示词分节拿 \`ctx.systemPrompt\`。

**延迟服务绑定。** \`webServer\` 和 \`systemPrompt\` 是 Web profile 才有的服务。
顶层 \`inject\` 只声明 \`tools\`（headless 也要能用），这两个走 \`ctx.inject()\` 等服务 ACTIVE 再注册——
直接同步 \`ctx.get()\` 会拿到 \`undefined\` 而静默失败。

**提示词注入是双路兜底。** \`prompt/inject.js\` 注册 \`systemPrompt\` 分节（主路径），
同时跟踪 \`agent/created\` / \`agent/pre-step\` 维护 agent→session 映射，
让分节的函数式 \`text\` 能按当前绑定的角色现算。

## 自检

\`\`\`sh
node scripts/verify.mjs            # 主自检：入口/Config/逐模块/47 工具真实调用/路由/分节/落盘/客户端
node scripts/verify-client.mjs     # 客户端 bundle 契约
node scripts/verify-e2e.mjs        # 真起 dsh web 验 HTTP
node scripts/verify-st-import.mjs  # 真实 ST 数据导入验收
\`\`\`

## SillyTavern 保真度

这一版按 ST 的真实源码逐项对齐，不再只做「能跑」：

| 能力 | ST 语义 | 本插件 |
|---|---|---|
| 世界书扫描 | 常量/关键词/二级组合/递归/包含组/概率/预算 | 一致，另实现 `min_activations` 与 `max_recursion_steps` |
| 世界书定时 | sticky / cooldown / delay 落 chat_metadata | 一致，`timedWorldInfo` 结构相同 |
| 开场白 | first_mes + alternate_greetings 合成 swipes | 一致，含 `swipe_info`；绑定角色时自动写入会话 |
| 聊天格式 | `.jsonl`，首行 `chat_metadata`，消息用 `mes/is_user/extra` | 一致，可直读 ST 文件 |
| swipe | 只移动 `swipe_id`，不改 `swipes` | 一致 |
| 聊天管理 | 一个角色多个存档 | `st_list_chats` / `st_new_chat` / `st_rename_chat` / `st_delete_chat` |
| 聊天导入 | — | 从 ST 的 `chats/<角色>/*.jsonl` 直接导入 |

`chat_metadata` 字段：`integrity` `chat_id_hash` `note_prompt` `note_interval` `note_position` `note_depth` `note_role` `timedWorldInfo` `variables`。

## 已知限制

- **@depth 不是真的插进对话**。DSH 的对话历史由宿主管，插件插不进去。
  @depth 内容（世界书 atDepth 条目 / 角色卡 depth_prompt / 作者注释）集中在
  \`sillytavern:depth\` 分节排到系统提示词最末，语义上"贴得近"但不精确；
  真实深度报在 \`diagnostics.injected\` 里。
- **宏只在系统提示词里展开**，聊天历史保持原文（展开后回写会污染持久化存档）。
- **令牌是粗估**（CJK 1.5 字/token、其余 4 字/token），没接真分词器。误差 ±20%。
- **跑团只实现通用规则体系**（d20 / d100 / 骰池），不硬编码具体规则书的法术位、专长、职业特性——
  那些属于规则书数据。
- **PNG 导出需要底图**：没有头像图的卡降级导出 JSON。
- **首次启动会自动导入 ST 数据**（当 `sillyTavernRoot` 已配置且数据目录为空）。
  之后想强制重新导入要显式传 `overwrite: true`，否则同名的卡与世界书会被跳过。