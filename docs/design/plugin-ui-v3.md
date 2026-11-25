# 插件界面 v3：兼容网页插件，给原生插件更多位置和组件

> 2026-10-28。基于 main `2e37d13`（DSH Go，内置 DSH 0.2.1-rc.4）。在 [plugin-seams.md](plugin-seams.md)（接缝规格：「原生适配器优先，网页岛兜底」）和 [native-plugins.md](native-plugins.md) / [-protocol.md](native-plugins-protocol.md) / [-views.md](native-plugins-views.md)（原生协议 NA v1.3、视图 v2）上扩展，不另起炉灶。审美规则沿用 [polish-guide.md](polish-guide.md)、[page-design.md](page-design.md) 和作者侧的 [design-rules.md](../plugins/design-rules.md)。
>
> 调研数据没有入库（复现方法见附录 A）。下载的包逐个放进新建的空目录，只在内存里读 tarball 做文本匹配，不解压、不执行。
>
> 标记：**〔源码〕** 读过代码或包内文档；**〔统计〕** 来自本次静态扫描；**〔推断〕** 设计推断，要 PoC 验证。

## 当前接缝修订（2026-11-11）

本节取代下文「浮层岛撤掉 / 不做」的路线结论；其余普查数字与 P1 / P2 表保留为 2026-10-28 历史快照，不重算成兼容率。现在补 `shell.overlay`：在插件详情逐包显式启用，本机偏好按主机保存，`ui.json` 的 `plugins.seats` 显式值优先；桥接按包 + cell 只放行被启用条目。浮层只挂 `HomeShell.chat` 内的 `ChatScreen` 聊天内容区，以 `ClipRect` 裁在原生顶栏与输入框之间，不覆盖原生 chrome、抽屉、右详情或模态；未决审批 / 未答问题时停止，键盘出现时视口随原生布局收缩，不能跨 App。另给 `sidebar.footer.action`、`settings.plugins.tab`、`plugins.detail.section` 从插件详情打开的单包、单 cell 整页入口。

触摸穿透依据矩形，不是像素 alpha；快速运动时采样 / 桥接有滞后。首岛约 200 MB 仅是 Android 15 x86_64 debug 模拟器估测，真机未验。19% 只代表历史静态用量，不承诺所有浮层插件免改可用。不自动开启音频免手势播放，本轮也不新增原生 `pets` / `bubbles` / `actions` 协议。作者与使用边界见 [网页面板](../plugins/web-panels.md)。

## 0. 结论

**网页插件在 App 里，今天只有三分之一能完整看到，近四成一处都看不到；最大的缺口是聊天页，而不是缺组件。** 原生 App 对网页插件只接了 9 个 slot，全是「整页」类（设置、插件配置、全部功能面板、对话详情页签、Cordis）。扫了 dshfind 索引里全部 4116 个带浏览器半侧的包，3424 个注册了 slot：按插件算，34 % 全部可见、27 % 部分可见、39 % 一处都没有〔统计〕。原生协议这边，作者已经有 4 个插槽、40 种组件和声音、字幕、文件能力，owner 举例的列表、网格、标签页、步骤、进度、可折叠分组都**已经有了**；真正缺的是位置（聊天页、对话级操作、＋ 面板、回合尾注）和少数组件（空态、媒体网格、环形进度、趋势线）。

| 问题 | 结论 |
|---|---|
| 网页插件实际在用什么 | 87 个 slot 被用到。前五：设置分区 39 %、全屏浮层 19 %、侧栏底部 12 %、插件配置 9 %、输入框上方 8 %。聊天页那 7 个 slot 合计 31 % 的插件在用，却一个都没接线（§2） |
| 一处正在发生的故障 | 月下载 4.4 万的 `@changfenhuang/dsh-genui` 也用 ```` ```dsh-ui ```` 围栏，但 JSON 格式不同（根节点没有 `type`）。装了它的主机，App 把每一块都画成「原始 JSON + 让它重发」（`dsh_ui_model.dart:491`、`dsh_ui_block.dart:111`）。一个方言适配器就能修（§3.2） |
| 兼容怎么做 | 不加新形态，复用已有的整页岛和面板岛：对话视图（7 %）进对话详情「插件」页签；聊天页 7 个 slot 进一个「插件」弹层，和原生 `chat.panel` 面板放在一起；画不了的位置在插件详情里如实列出并给「在网页版打开」，不再静默丢弃（§3） |
| 给作者什么 | P1 不改协议：`chat.panel` 落地、4 个新组件、`accent: "app"` 跟随用户配色、图标名从 72 个扩到约 140 个。P2 改桥接：＋ 面板工具、对话操作、回合尾注、弹层面板、插件页面板、工具卡交互，以及附图、打开自己的网页面板、打开对话三个效果（§4） |
| 覆盖能到多少 | 按插件，全部可见 34 % → P1 57 % → P2 67 %，一处都没有 39 % → 20 % → 12 %；按 slot，9 → 17 → 21 个（共 57 个可追加的），按「插件 × slot」用法算 41 % → 64 % → 73 %（§1.3、§6） |
| 审美怎么守 | 插件只给意图（结构、语义色调、档位），几何、署名边界、动效归 App。每个新位置先写几何等式再画，每个新组件深浅色、320 / 390 宽、1× / 2× 字号都出 golden（§5） |
| 要 owner 定 | 两件：聊天页「插件」入口放哪；网页面板岛是否进 P1（§8） |

## 1. 现状盘点

### 1.1 三条路

| 路 | 插件写什么 | App 怎么画 | 位置 | 主机 |
|---|---|---|---|---|
| 网页 slot（接缝） | 网页半侧的 React 组件 | 座位规划：原生适配器 → 网页岛 → 「在网页版打开」→ 隐藏（`seat_planner.dart:136`） | 9 个 slot（§1.2 A 类） | 本机（路由守卫后）、SSH；中转没有网页 |
| 原生协议 `dshGo`（NA v1.3） | `package.json` 清单 + `ctx.dshGo` | 原生组件：视图 v1 16 种 + v2 24 种 | 胶囊、消息菜单、状态条、面板（对话详情页签、全部功能）；声音、字幕、文件能力 | 本机（桥接）；SSH 等桥接能装 |
| 不写 App 代码就原生 | 命令、技能、Config schema、工具、`dsh-ui` 围栏、`presentationMeta` | 原生 | 斜杠菜单、设置表单、工具行、工具卡 | 全部 |

协议里已经声明、App 还没画的：面板 `placement: "chat.panel"`。App 解析清单时只留 `session.tab` 和 `features`（`native_model.dart:457`）〔源码〕。

### 1.2 slot 覆盖（rc.4，103 个）

| 类 | 个数 | slot | App 现在 | 用到它的插件〔统计〕 |
|---|---|---|---|---|
| **A 已接线** | 9 | `settings.section`、`settings.general.item`、`plugins.bundle.config`、`plugins.row.config`、`main` + `sidebar.panellist`、`sidebar.right.pane.tab` + `.title`、`tool.view.cordis` | 有 Config schema 画原生表单，否则整页岛，岛开不了给「在网页版打开」 | 设置类 53 %、面板 / 页签类 13 % |
| **B 设计了没接线** | 8 | `conversation.input.dock` / `left` / `right` / `overlay`、`conversation.composer.dock`、`conversation.session.header.actions` / `utilities`、`shell.overlay` | 不显示。面板岛 S5 没做；浮层岛 2026-10-25 已撤 | 聊天页 7 个合计 31 %；浮层 19 % |
| **C 消息级** | 7 | `conversation.chat.assistant-actions`、`turnTail`、`chat.node`、`chat.commandview`、`user.text.node`、`tool.call.toolview`、`tool.call.images` | 不显示。每条消息一个平台视图会拖垮滚动，按设计不做岛 | 12 % |
| **D 替换点** | 42 | `replaceRisk: shadows-shipped-ui` 的 48 个，减去已接线的 `main`、`plugins.bundle.config`（按 key 追加）和归入 C 的 4 个消息级 | 不做（原生界面不让换） | 5 %（多是换肤、换侧栏） |
| **E 没有安排的追加点** | 37 | `conversation.view`、`sidebar.footer.action`、`settings.plugins.tab`、`plugins.detail.*`、抽屉对话行 4 个、文件预览 8 个、rc.4 新增 3 个…… | 不显示 | `conversation.view` 7 %、`sidebar.footer.action` 12 %、设置类长尾 8 % |

逐个 slot 的用量和 P1 / P2 之后的去向见附录 B。

**rc.4 比 rc.2 多了 3 个 slot**〔源码〕：都是 list · root、`replaceRisk: none`，都是网页版里一个「更多」菜单的行。官方占用者 `dsh-client-ui-entry-customization` 往里放「浏览更多插件」和「创建你的插件」（后者用 Creator 预设开新对话，把请求放进草稿，**绝不发送**）。

| slot | 网页版位置 | 原生对应 |
|---|---|---|
| `conversation.session.header.views.actions` | 会话 View 标签后的「更多会话视图」 | 对话详情「插件」页签（§3.3） |
| `sidebar.panellist.actions` | 左侧栏导航下的「更多」 | 全部功能 › 插件 |
| `sidebar.right.tab.guide.actions` | 右侧栏起始页的「更多工具」 | 对话详情「插件」页签 |

扫描里还没有第三方包注册它们。App 侧：目录登记为 `SeatPolicy.other`（不设座位），插件详情的「网页版界面」照常列出（§3.5）；「创建你的插件」的原生版本放 P2（§6.2）。`slotCatalogRelease` 和 `app/assets/islands/recipes.json` 的 `release` 一起改成 `0.2.1-rc.4`，`slot_catalog_test.dart` 的 101 / 100 改成 104 / 103。

### 1.3 按插件算

一个插件用了几个 slot，按「全部能在 App 里看到（原生或岛）/ 一部分 / 一个都没有」分〔统计〕。

| 阶段 | 全部可见 | 部分可见 | 一处都没有 | 按下载加权（全 / 部分 / 无） |
|---|---|---|---|---|
| 现在 | 1166（34 %） | 933（27 %） | 1325（39 %） | 25 % / 61 % / 14 % |
| P1 之后 | 1950（57 %） | 801（23 %） | 673（20 %） | 64 % / 30 % / 6 % |
| P2 之后 | 2301（67 %） | 723（21 %） | 400（12 %） | 69 % / 28 % / 3 % |

- 「全部可见」里有 903 个只用设置类 slot，这部分现在就是好的：它们的设置分区里 54 % 的包带宿主 Config schema，能直接画原生表单。
- 「可见」的前提是岛开得出来：本机引擎要守卫生效，聊天页面板岛还要桥接的占用表（只有本机）；SSH 主机只有整页岛，中转主机一个岛都没有。
- 下载加权只作参考：3424 个包里 222 个 scoped 包的下载量没取到（npm API 限流，按 0 计），一个 `billion-context`（月 220 万，用了 `conversation.view`）就能把一列拉动十几个点。
- P1 之后还剩的「一处都没有」，主要是只用浮层（`shell.overlay`）、侧栏底部或消息级 slot 的插件。前两类在 P2 接一部分，消息级只能靠作者原生化（§3.6）。

### 1.4 原生协议已经给作者的

| 维度 | 已有 | 缺 |
|---|---|---|
| 位置 | `composer.actions`（胶囊）、`message.actions`（消息菜单）、`composer.strip`（状态条）、`panels`（对话详情页签、全部功能）、`tool.card`（`presentationMeta`）；能力 `audio` `voice` `micro` `overlay` `files` | `chat.panel` 没画；对话级操作、＋ 面板、回合尾注、插件详情页、通知、小部件 |
| 组件 | v1：stack row text metric chart compare steps callout options confirm list keyValue progress table actions image；v2：表单与 11 种输入、tabs collapsible accordion carousel grid timeline badge tag avatar codeBlock divider spacer | 空态、媒体网格（带全屏查看）、环形进度、趋势线；分组列表、行菜单、本地搜索、受限 Markdown、相对时间 |
| 样式 | v2：6 档字号、4 档字重、spans、10 个命名色 + `#RRGGBB`（逐背景校正到 ≥ 4.5:1）、4 种容器、S/M/L 间距、比例列 | 跟随用户配色（`accent` 只能写死颜色）；图标只有 72 个名字 |
| 效果 | insert command open link toast copy refresh patch、延后效果、pickFile / pickImage | 附图进输入框、打开自己的网页面板、打开某个对话 |

## 2. 网页插件实际在用什么

### 2.1 样本

| 项 | 值 |
|---|---|
| 来源 | dshfind 市场索引 `https://api.dshfind.com/market/dsh-index.json`（DSH 自己的插件市场用的同一份，2026-10-28 取），5781 个包 |
| 取到清单 | 5642 个（139 个取不到，多是已下架），读 npmmirror 上索引所列版本的 `package.json` |
| 带浏览器半侧 | 4116 个（`dsh.client` 或 `exports["./client"]`），全部下载扫描；92 个跳过（tarball 超过 40 MB 或解不开） |
| 注册了 slot | 3424 个（去掉 `@deepseek-ai/` 官方包）。判据：`inject("<key>")`、`register("<key>")` 或 `name: "<key>"`，只认 rc.4 目录里的 103 个 key |
| 下载量 | npm 上月下载（2026-09-28 至 10-27）。scoped 包没有批量接口、会被限流，逐个慢取，3424 个里取到 3202 个 |
| 局限 | 纯文本匹配：动态拼出来的 slot 名会漏；`name:` 只认带点的 key（`main` 这类单词 key 只认 `inject(`）；市场里有批量发布的同作者包，按包数统计会放大它们 |

和 plugin-seams 附录 A 的 15 个抽样相比，设置分区从 60 % 降到 39 %，`conversation.view`（7 %）和 `sidebar.footer.action`（12 %）是抽样里几乎没出现、全量里很重的两个。

### 2.2 slot 频率（前 25，全表见附录 B）

| slot | 类 | 包数 | 占比 | 现在 | P1 / P2 |
|---|---|---|---|---|---|
| `settings.section` | A | 1350 | 39 % | 原生表单 / 整页岛 | — |
| `shell.overlay` | B | 664 | 19 % | 无 | P2 岛内浮层；宠物走 P3 宠物包 |
| `sidebar.footer.action` | E | 401 | 12 % | 无 | P2 整页岛（需配方 PoC） |
| `plugins.bundle.config` | A | 309 | 9 % | 原生表单 / 整页岛 | — |
| `conversation.input.dock` | B | 276 | 8 % | 无 | P1 聊天页「插件」弹层 |
| `conversation.view` | E | 238 | 7 % | 无 | P1 对话详情「插件」页签 |
| `sidebar.right.pane.tab` | A | 225 | 7 % | 整页岛 | — |
| `sidebar.panellist` / `main` | A | 219 / 219 | 6 % | 全部功能整页岛 | — |
| `tool.call.toolview` | C | 196 | 6 % | 无 | 作者 `tool.card`；P2 通用工具卡增强 |
| `conversation.composer.dock` | B | 195 | 6 % | 无 | P1 弹层 |
| `conversation.input.right` / `left` | B | 191 / 187 | 6 % / 5 % | 无 | P1 弹层；原生对应 P2 `composer.tools` |
| `conversation.session.header.actions` / `utilities` | B | 189 / 170 | 6 % / 5 % | 无 | P1 弹层；原生对应 P2 `session.actions` |
| `settings.general.item` | A | 151 | 4 % | 整页岛（遮官方条目） | — |
| `settings.plugins.tab` | E | 146 | 4 % | 无 | P2 整页岛 |
| `plugins.row.config` | A | 137 | 4 % | 原生表单 / 整页岛 | — |
| `conversation.chat.node` | C | 113 | 3 % | 无 | 不做岛；`dsh-ui` 方言覆盖其中最热的一个（§3.2） |
| `conversation.chat.turnTail` | C | 85 | 2 % | 无 | 作者 P2 `turn.note` |
| `conversation.chat.assistant-actions` | C | 75 | 2 % | 无 | 作者 `message.actions` |
| `plugins.item` | E | 72 | 2 % | 无 | 不做（官方插件卡片位） |
| `conversation.input.overlay` | B | 64 | 2 % | 无 | P1 弹层 |
| `sidebar.workspaces.session.menu.item` | E | 61 | 2 % | 无 | 作者 P2 `session.actions` |

一个插件平均用 1.9 个 slot，51 % 只用 1 个。按「插件 × slot」的 6609 次用法算：A 类 41 %、B 类 29 %、E 类 18 %、C 类 8 %、D 类 4 %。

### 2.3 组件形态与客户端服务

**组件**：3424 个包里 1110 个用了官方 `ui-primitives`，按包数：`Button` 469、`Switch` 277、`Modal` 264、`Input` 258、`Menu` 253、`Tooltip` 242、`StateDot` 178、`Tag` 144、`MarkdownText` 133、`Toast` 107、`SettingsForm` 78、`SegmentedControl` 65、`CodeBlock` 44、`DiffBlock` 24。读出来的形态是：**设置表单 + 工具条按钮 + 弹窗 + 状态点和标签**。另有 25 % 带 Markdown 库、12 % 用 canvas、11 % 播音频、8 % 用 iframe、8 % 播视频、2 % 自带图表库。

**客户端服务和标准 props**：`sessions` 15 %、`connection` 13 %、`slots` 13 %、`settings` 9 %、`locale` 8 %、`uiWorkspace` 3 %、`jobs` 2 %、`theme` 2 %；`useSessions` 12 %、`inputActions` 8 %（往输入框插字、附件）、`useSession` 7 %、`useProjection` 7 %、`useInput` 5 %。另有 173 个包用客户端服务 `configForms` 读写宿主 Config 条目，它们的设置页本质上是宿主配置表单。

**改官方 DOM**：63 % 调 `querySelector`，25 % 用 `MutationObserver`，249 个包用 `data-slot="…"` 选择器去改官方节点（最多的是侧栏底部、`composer.dock`、侧栏本身）。在岛里这些改动落在被隐藏的官方节点上，无害但失效，这一点和接缝规格 §1.3 的结论一致。

**宿主侧**：62 % 自带 HTTP 路由（岛必须在 G1 守卫之后才开，`plugin-seams.md` §9），48 % 有 schemastery Config，34 % 定义工具，6 % 用 `presentationMeta`。**还没有一个包用 `dshGo`**：原生协议的作者生态是零，兼容层要先扛住。

**声明式 UI 方言**：至少四个包在对话里画生成式界面。`@changfenhuang/dsh-genui`（月 4.4 万，按下载排第 22）用 ```` ```dsh-ui ```` 围栏和自己的约 50 种组件；`dsh-genui`（另一位作者，月 2 万）、`@valuz/dsh-valuz-genui`（A2UI）、`dsh-plugin-genui`（React 小应用）都不用这个围栏名。只有第一个和 App 撞名（§3.2）。

### 2.4 高收益点

| 排名 | 点 | 一次投入覆盖多少 | 风险 | 期 |
|---|---|---|---|---|
| 1 | 聊天页 7 个 slot 合成一个面板岛，和原生 `chat.panel` 放进同一个弹层 | 1049 个包（31 %）；其中 554 个之后全部可见 | 中：WebView 内存，走已有预算 | P1 |
| 2 | `dsh-ui` 方言（genui） | 1 个包，但它画的是每一条回复；修的是现有故障 | 低：只多一个解析分支 | P1 |
| 3 | `conversation.view` 进对话详情「插件」页签 | 238 个包（7 %），复用整页岛 | 低中：新配方 | P1 |
| 4 | 画不了的位置如实列出 + 「在网页版打开」 | 所有带浏览器半侧的包至少有一个入口 | 低 | P1 |
| 5 | 浮层：插件自己页面弹出的对话框在岛里可见 | 664 个用浮层的包里，272 个同时有整页 slot | 中：要 PoC | P2 |
| 6 | 侧栏底部、设置类长尾进整页岛 | 401 + 286 个 | 中：配方要打开侧栏 | P2 |
| 7 | 消息级（工具卡、消息节点、消息操作、回合尾） | 421 个；岛做不了，只能作者原生化。工具卡那 196 个里 111 个已经在写 `presentationMeta`，加一个键就有原生卡 | — | 文档 + SDK（P1），`turn.note` 等（P2） |

## 3. 兼容方案

### 3.1 原则

沿用接缝规格 §2：原生适配器优先，网页岛兜底；没有第三方占用者时界面零变化；原生界面自己的部件不让换；App 不执行插件代码。新增一条：

- **不再静默丢弃**。一个网页插件在某处画不出来，插件详情里就写明「它在网页版的哪里」，并给出「在网页版打开」（§3.5）。用户装了插件却找不到它，比看到一个网页岛更糟。

原计划只保留整页、面板两种；2026-11-11 修订加入受限的 App 内浮层，替代撤掉浮层岛的决定，边界见本文开头「当前接缝修订」。

### 3.2 `dsh-ui` 方言：genui（P1）

**现象**〔源码〕：genui 的围栏是 `{"title"?, "gap"?, "items": [...]}`，根节点没有 `type`；组件叫 `stat`、`card`、`col`、`keyvalue`、`hero`、`image-group`……App 的解析器在根节点报「缺少 type」（`dsh_ui_model.dart:491`），整块降级成 `DshUiFallback`：一行小字、整段原始 JSON、一个「让它重发」（`dsh_ui_block.dart:111`）。用户点了「让它重发」，模型会被要求改格式，而 genui 自己的校验器说这块是对的。

**做法**：

1. 识别：围栏语言是 `dsh-ui`，并且根是没有 `type`、带 `items` 数组的对象，或任一节点的 `type` 只属于 genui 词汇表 → 方言 `genui`。App 自己的格式根节点必有 `type`，两者不会混淆。
2. 映射成插件视图 v2 的节点树，用插件视图渲染器的**只读档**画（和工具卡一样不能 invoke），不带插件署名（这是模型输出，和原生 `dsh-ui` 卡同级）。卡片本身就是 v2 的不透明内容底色（圆角 20、内边距 16，`dsh_ui_dialect_card.dart`），不再套玻璃卡：套了会在深色下露出第二层底。
3. 画不了的节点原位一行「在网页版查看」（浅底、次要色，不是错误样式）；整块里一个都画不了才降级，降级时**不出现「让它重发」**。
4. 上限按面板档（32 KiB、120 节点、8 层）：genui 自己的预算比模型卡大，按模型卡档会大面积截断。
5. 复制、分享、导出照旧用 `title` 一行摘要（`dshUiPlainText`）。

| genui | 原生 | 备注 |
|---|---|---|
| 根 `{title, items}`、`row` / `col` / `grid`（`cols`）| `stack`（`title`）/ `row` / `grid`（≤ 4 列）| `col.width` 换成 `row` 的整数权重；全是数字的 `grid` 画成一行指标（不给每个数字套框） |
| `text`（`size` `tone` `align` `mono`）| `text` + v2 `style` | `display`/`h1` → title、`h2` → subtitle、`h3`/`body` → body、`muted`/`caption` → caption；`**` 和行内代码保留，`==高亮==` → span 背景，链接只留文字 |
| `card`（`title` `tone` `items`）| `stack` + `style.card: surface`（有 `tone` 用 `tinted`）| `accent` 颜色照收，过对比度校正 |
| `hero`、`stat`（`label` `value` `delta` `spark`）| `metric`（`delta` 进 `caption`，正负定色调，`spark` → 新 `trend`）| `trend` 见 §4.2 |
| `badge`、`avatar`、`divider`、`spacer`、`tabs`、`accordion`、`carousel`、`timeline`、`steps`（`current`）| 同名或对应 v2 组件 | `steps` 按 `current` 推出 done / current / todo |
| `progress`（`variant: ring`）| `progress`（新 `shape: ring`）| |
| `list`（`title`/`desc`）、`keyvalue`（`pairs`）、`table`（`columns` `rows`）| `list`、`keyValue`、`table` | 表格列类型 `bar`/`ring`/`spark` 先按文字显示，P2 再做列类型 |
| `callout`（`tone` `title` `content`）| 色调浅底的 `stack`：标题用色调色、正文用阅读色 | v2 的 `callout` 只是彩色文字，长句读起来太重 |
| `chart`（`kind` bars/line/donut，`data[]`、`series[].data[]`）| `chart` | `{label, value}` 数组拆成 `categories` + `values`；`horizontal` → `hbar` |
| `code` / `diff` / `json` | `codeBlock`（`diff` 用 diff 着色，`json` 格式化）| |
| `mermaid` | 「示意图 · 在网页版查看」 | 插件视图里嵌不进 App 的 Mermaid 预览；源码对读者没用 |
| `image` / `image-group` | `image` / 新 `gallery` | 只收 `data:`。genui 常用的主机相对地址（`/mmx-files/…`）P2 经已鉴权的主机通道取 |
| `button` `input` `select` `checkbox` `radio` `switch` `slider` `textarea` `submit` `quiz` | 连续的一段合成一个「可交互内容 · 在网页版查看」 | 只读的输入框看起来能点、点了没反应，比一行说明更糟。P2 按 genui 的 `[genui-action]` 消息格式回传（先核实格式） |
| `copy` / `link` | 带复制键的代码块 / 只有文字 | |
| `echart` `plot` `svg` `diagram` `scene3d` `audio` `video` `file-tree` `blocks` `arrow` `icon` `breadcrumb` | 「在网页版查看」占位；`breadcrumb` 画成一行文字 | |

实现落在新文件 `app/lib/ui/chat/dsh_ui/dsh_ui_dialect_genui.dart`（纯函数 `genuiToPluginView(Object? json) → (Object? view, List<DshUiIssue> issues)`），`parseDshUi` 只多一个分支。夹具用自己按 genui `SKILL.md` 规格写的样例，不拷对方代码。

长期：向 genui 作者提议在根上加 `"dialect": "genui"`，App 优先认这个标记。

### 3.3 对话视图 `conversation.view`（P1）

rc.4 里，插件可以给对话注册一个「View」（和 Chat、Trajectory 并列的另一种看法），会话头部的 View 标签行显示它们，放不下的进「更多会话视图」〔源码，`dsh-client-ui-conversation` 0.2.1-rc.4 README〕。238 个包在用：记忆、上下文看板、轨迹迷宫、画布、Office 编辑器……这些插件的主界面就是这个 View。

| 项 | 规定 |
|---|---|
| 原生位置 | 对话详情「插件」页签（`session_plugins_tab.dart`），和 `sidebar.right.pane.tab` 的页签并列，一项直接打开，多项先列出 |
| 名字 | 注册时的 `label`（占用表里有） |
| 形态 | 整页岛。新配方 `"conversation.view": { "forms": ["page"], "open": "session-view", "stretch": "child", "pad": [16, 12], "session": true, "ready": "view" }`；`island.js` 新增 `then.view`：打开对话 → 在 View 标签行（或「更多会话视图」菜单）里按名字点中 `cell` 对应的 View → 等槽位里的内容换成它 → 拉满。槽位一直在（默认画 Chat），所以只有 View 真的换过来才算找到，否则按「没找到」上报。**名字只用来挑要点的那一个，身份靠 id 确认**（CR-7881a22）：名字必须整个相等（`Gallery Extra` 不是 `Gallery`），标签行或菜单里有两个同名就不点；点选后网页版会把所选 View 的 id 记进 `dsh.conversation.<id>` 的 `view`（rc.4 源码核实：`setView` 改会话状态，整份 `{draft, view, viewRequest}` 在同一次更新里同步写入 localStorage），只有记下的 id 等于 `cell`、槽位内容换过、标签行里选中的（如果有）正是同名那一枚，才算打开，`ready` 回报的 `cell` 就是读回的 id。已经选中的同名标签，记下的 id 不是 `cell` 也不算。任何一条不满足都按「没找到」上报，退回「在网页版打开」，并把用户原来的 View 写回 |
| 条件 | 要占用表（桥接，Tier B）：名字从占用表来；路由守卫、岛预算照旧。策略 `p1ViewPage`：要占用表但不遮官方条目（网页版一次只画一个 View，没有可遮的） |
| 时限 | 12 秒（`IslandTiming.viewReady`），期间是岛的加载骨架；过了退回「在网页版打开」（其他整页岛是 15 秒）。依据：实测一般 0.8–3.4 s，最慢 11.3 s，就是第一次打开某个对话、要先重载进去的时候；5 秒会让这第一次大多退回网页版 |
| 不做 | 不改用户的 View 偏好：网页版点选会把 View 记进 `dsh.conversation.<id>`，岛在显示后和离开时把原来的值写回；只写回岛自己点出来的那个 id，之后别处（同一存储上的另一个网页版）选的别的 View 不覆盖 |
| 风险 | View 标签的 DOM 没有逐条 id，配方要按名字找，靠网页版记下的 id 确认。同名的 View 一律退回网页版，不猜。若哪个版本不再把选择记进 `dsh.conversation.<id>`，所有 View 岛都会退回网页版：最坏是不生效，不会出错页，也不会把别的 View 当成它 |

### 3.4 聊天页「插件」弹层（P1）

一个弹层同时装两样：作者写的原生面板（`placement: "chat.panel"`，协议早就有）和网页插件的聊天页部件（7 个 B 类 slot 的面板岛，即接缝规格的 S5）。原生在前，网页在后。

**入口**〔推荐，owner 定，§8〕：输入框上方胶囊行的最后一枚胶囊「插件」，拼图图标。几何和普通胶囊相同（高 34、左右内边距 14、图标 16、间距 8，`CapsuleMetrics`），不占胶囊总数 8 个的名额；只在这个对话有原生 `chat.panel` 面板或有第三方占用者时出现；生成回复时和整行一起让位。

**弹层**（page-design E 骨架）：

```
╭────────────────────────────────────────────╮
│                    ───                     │  拖把手，居中
│  插件                                      │  标题行：左 20
│  ╭──────────────────────────────────────╮  │
│  │ ◇ 用量                         ⟳     │  │  原生面板：PluginFrame（署名行 + 内容）
│  │ （插件视图）                         │  │
│  ╰──────────────────────────────────────╯  │
│  网页插件 · dsh-cost-meter、dsh-meme       │  一行来源，次要色
│  ╭──────────────────────────────────────╮  │
│  │ （面板岛：7 个 slot 竖排，官方条目已遮）│  │  岛高随内容，超出内部滚动
│  ╰──────────────────────────────────────╯  │
╰────────────────────────────────────────────╯
```

| 项 | 规定 |
|---|---|
| 尺寸 | 圆角 28；内容左右 20（两侧相等）；起始半高，可拉到全高；宽屏最宽 640 居中 |
| 顺序 | 原生面板按插件名排序；网页一节固定在最后，一个岛装下所有网页插件 |
| 岛 | 打开弹层才建，关掉后 30 秒回收（`IslandBudgetRules.hiddenGrace`）；预算不够、守卫没生效、8 秒（`IslandTiming.sheetReady`；实测一般 0.8–3.4 s，最慢 11.3 s，弹层只是看一眼，不等更久）没 `ready` → 换成一行「在网页版打开」 |
| 一个岛怎么装 7 个 slot | App 侧的键 `dsh-go.chat`（不是 DSH 的 slot），配方 `"slots": [7 个]`、`"stretch": "common"`、`"ready": "sheet"`。桥接一次遮掉 7 个 slot 的官方条目（`#dsh-go-island=a,b,…`）；`island.js` 取有内容的那几个 slot 的最近公共盒子当框，框里只留通往它们的路径，其余移出布局，于是条目按页面顺序竖排（先头部的，后输入框的） |
| 什么时候建岛 | 7 个 slot 的每个第三方条目单独规划都是岛（本机引擎 + 守卫、Tier B）、没有一项被 `ui.json` 改成 `web` 或隐藏，且预算放得下这一个岛；否则整块是一行「在网页版打开」（岛里不能只藏某个插件的条目） |
| 署名 | 原生面板照旧每张卡带插件名；岛里条目没有逐条标记，所以在岛上方列出来源包名 |
| 用户控制 | ui.json `plugins.seats` 照旧能隐藏某插件或改成 `web` |
| 空 | 两样都没有时入口不出现，没有空弹层 |

### 3.5 插件详情「网页版界面」（P1）

插件详情页（`plugin_detail_sheet.dart`）新增一节，列出这个插件在网页版里、App 画不了的位置：

| 行 | 内容 |
|---|---|
| 图标 | `AppIcons.webApp` |
| 标题 | 位置的白话名：「输入框上方」「回合尾」「消息操作」「全屏浮层」「侧栏底部」「对话菜单」……约 25 个常用 slot 有名字，其余统称「网页版其他位置」 |
| 尾部 | 「网页版」+ 箭头；点开用已有的 `seatWebTarget` 打开网页版（落到对话或对应分区） |
| 数据 | 有占用表（本机）时逐个列；没有（远程）时只有一行「网页版界面」 |
| 不出现 | 已经能原生或成岛的位置不列；中转主机（没有网页版）整节不出现 |

### 3.6 网页组件的意图 → 原生

能自动接的就是 §3.2–3.4。剩下的靠作者：给网页插件作者一张对照表（新作者文档 `docs/plugins/from-web.md`），告诉他们加几行 `dshGo` 就有原生版本。这张表也是 P2 新插槽的来源。

| 网页插件在做的事 | slot · 常见组件 | 原生对应 | 作者要写的 |
|---|---|---|---|
| 插件设置页 | `settings.section` · SettingsForm / Switch / Input | 原生设置表单（已有） | Config 的字段标成可在线修改（volatile），不写 App 代码 |
| 输入框旁的按钮、开关 | `input.left` / `right` · Button / Menu / Tooltip | 胶囊（已有）；＋ 面板工具（P2 `composer.tools`） | 清单两行；需要处理就 `on(id)` |
| 输入框上方的状态条 | `input.dock` / `composer.dock` · StateDot / Tag | 状态条 `composer.strip`（已有） | `strip(id)` 推 `{text, icon, tone}` |
| 会话头部的按钮 | `session.header.actions` / `utilities` | 对话操作（P2 `session.actions`） | 清单 + `on(id)` |
| 另一种看对话的方式 | `conversation.view` | 对话详情页签面板 `placement: "session.tab"`（已有） | `panel(id)` |
| 侧栏面板、右栏页签 | `main` + `panellist`、`sidebar.right.pane.tab` | 面板 `features` / `session.tab`（已有） | `panel(id)` |
| 工具结果卡 | `tool.call.toolview` | 工具卡（已有） | `presentationMeta` 里加 `"dsh-go/view"` |
| 消息旁的按钮 | `assistant-actions` | 消息菜单（已有） | 清单 + `on(id)` |
| 回合尾的数字 | `turnTail` | 回合尾注（P2 `turn.note`） | `turnNote(id)` |
| 弹窗、提示 | `shell.overlay` · Modal / Toast | 弹层面板（P2 `presentation: "sheet"`）、`toast` 效果 | — |
| 侧栏底部的小部件 | `sidebar.footer.action` | 状态条，或全部功能里的面板 | — |
| 系统通知 | Notification API | 应用内通知（P2 `notify`） | — |
| 输入框里插字、附图 | `inputActions` | `insert`（已有）、`attach`（P2） | — |

SDK 配套一个检查：`dsh-go-plugin-check --from-web <插件目录>` 读出它的网页 slot，逐条给出上表的建议（P2）。

### 3.7 网页岛本身的体验

| 改进 | 期 | 内容 |
|---|---|---|
| rc.4 配方复核 | P1 | rc.4 改了会话头部（View 标签行、「更多」）。`recipes.json` 的配方在 rc.4 运行时上逐个跑一遍（模拟器），`island_logic_test.dart` 补 rc.4 的用例 |
| 给网页作者的环境标记 | P1（只写文档） | 岛里 `<html>` 已有 `data-dsh-go-island` 和 `data-dsh-go-island-form`（page / panel），以及 `--dsh-go-island-top` 等 CSS 变量；写进 `web-panels.md`，配一节「让网页插件在 DSH Go 里好看」：用 `--dsw-*` token、不写死宽度、360 宽下自测 |
| 岛内浮层 | P2 | 插件自己页面弹出的对话框、提示挂在 `shell.overlay` 里，在岛里被一并隐藏。做法同现有 body 弹层（`island.js` `markLayers`）：岛内点按后 3 秒内出现在 `[data-slot="shell.overlay"]` 下的新节点放出来；本机由桥接遮掉官方占用者 |
| 只读环境信息 | P2 | `window.__dshGoIsland.info()` → `{app, form, theme, textScale}`，只读，不加任何能力 |
| 预热 | 不做 | 一个岛约 200 MB，提前建不划算；首开骨架 1–3 秒维持现状 |

### 3.8 能力探测与降级链

| 方向 | 怎么知道对方能做什么 | 做不到时 |
|---|---|---|
| App → 网页插件的一个占用者 | 座位规划器按顺序试：原生适配器（schema 表单、Cordis、同位置的 `dshGo` 原生面板）→ 岛（这个 slot 支持的形态、守卫、占用表、内存预算、5 秒就绪门）→ 「在网页版打开」 | 都不行就隐藏，并在插件详情「网页版界面」里列出（§3.5） |
| App → `dshGo` 插件 | 请求带 `caps`：`surfaces`、`components`、`features`、App 版本 | 插件自己用 `adaptView` / `hasComponent` 降级；不认识的组件画占位，不认识的 surface 忽略 |
| 网页插件 → 自己是不是在 App 的岛里 | `html[data-dsh-go-island]`、`data-dsh-go-island-form`（P1 写进文档），P2 加只读 `info()` | 不在岛里就照常是网页版 |
| 同一个包两边都有 | 原生优先：对话详情页签和全部功能已经是这样（`seat_planner.dart` 里 `nativePanelId` 那段）；聊天页弹层 P1 先两样都显示，P2 由桥接在岛模式下把已原生化的包的网页条目一并遮掉 | ui.json `plugins.seats` 可以反过来指定 `web` |

## 4. 给作者的新能力

协议主版本仍是 `v: 1`，只加可选项（NA 文档「v1 内只允许加可选字段」）；视图仍是 v2，只加组件和属性。老 App、老桥接遇到新东西按现有规则忽略或画占位。

### 4.1 位置

| 位置 | 原生在哪 | 内容 | 每插件 | 对应网页 slot | 期 |
|---|---|---|---|---|---|
| `panels[].placement: "chat.panel"` | 聊天页「插件」弹层（§3.4） | 面板视图 + 数据 | 计入面板 4 个 | `input.dock`、`composer.dock` | **P1**（协议已有，只差 App） |
| `composer.tools` | ＋ 面板里的「插件」一节（等 settings-ia S6 改完 ＋ 面板） | 图标 + 名字 → 静态效果，或打开本插件面板（弹层） | 2 | `input.left` / `right` | P2 |
| `session.actions` | 对话详情页头部右上的「⋯」（只在有插件操作时出现） | 菜单项，按插件分组；`scope` 带 `sessionId` | 2 | `session.header.actions` / `utilities`、`sidebar.workspaces.session.menu.item` | P2 |
| `turn.note` | 回合脚注末尾一段（`turn_footnote.dart`） | ≤ 16 字 + 可选色调 | 1 | `turnTail` | P2 |
| `panels[].presentation: "sheet"` | 打开面板时用弹层而不是推页 | 同面板 | — | `shell.overlay` 里的对话框 | P2 |
| `panels[].placement: "plugin"` | 插件详情页里，「设置」下面 | 同面板 | 计入面板 4 个 | `plugins.detail.section`、`settings.plugins.tab` | P2 |
| `tool.card` 交互 | 工具卡里的按钮、选项、确认生效 | 同面板的点按 | — | `tool.call.toolview` | P2 |
| `notify` | 应用内横幅（App 在前台时） | 标题 + 正文 + 目标 | 每分钟 1 条 | Notification API、`shell.overlay` 提示 | P2 |
| `widgets` | 桌面小部件（Android） | 复用状态条数据 `{text, icon, tone}` | 1 | — | P3 |
| 后台系统通知 | 系统通知栏 | 同 `notify` | 同上 | — | P3 |
| `pets` | 宠物站位 | 宠物包（`pets.md`） | 1 | `shell.overlay` 里的宠物 | P3 |

**考虑过、不做的**：顶栏加插件按钮（顶栏是原生界面的门面，按钮数和对称都已定死，插件操作进对话详情的「⋯」）；抽屉加分节（替换点）；新对话空状态的建议卡（一屏一个重心，归用户的 ui.json）；换肤（只给用户的 ui.json）。

#### P1：`chat.panel`

```jsonc
"panels": [{ "id": "stickers", "title": { "zh": "贴纸", "en": "Stickers" }, "icon": "image",
             "placement": ["chat.panel", "features"] }]
```

`scope` 带 `sessionId`，视图函数用 `scope.sessionId` 区分；`caps.surfaces` 带上 `chat.panel` 后插件才知道 App 会画。弹层里面板卡片的规格同对话详情页签（`PluginFrame`），只是外面是弹层。

#### P2：`composer.tools`

```jsonc
"composer.tools": [
  { "id": "stickers", "label": { "zh": "贴纸", "en": "Stickers" }, "icon": "image", "panel": "stickers" },
  { "id": "today", "label": "今日日报", "icon": "calendar",
    "effect": { "type": "insert", "text": "按模板写今天的日报" } }
]
```

- `label` ≤ 8 字；`panel` 和 `effect` 二选一；都没有就点按走 invoke（同胶囊）。
- 渲染：＋ 面板「插件」一节，和附件磁贴同宽同网格（4 列，窄屏 3 列），图标 22、名字一行；插件超过 4 个时这一节横向滑动，不加高。
- 为什么：输入框左右两侧是网页插件在聊天页用得最多的位置（369 个包），而胶囊行已经被 ui.json 和插件胶囊分着用，再塞会挤；＋ 面板正是 ChatGPT、Claude 放「工具」的地方（settings-ia §4.4）。

#### P2：`session.actions`

```jsonc
"session.actions": [{ "id": "export-notion", "label": "存到 Notion", "icon": "archive" }]
```

- `label` ≤ 12 字；有 `effect` 直接执行，否则 invoke，`scope = { sessionId }`。
- 渲染：对话详情页头部右上一个 44 圆钮「⋯」（`GlassIconButton`，和返回键镜像对称），菜单按插件分组，组名是插件 `title`，同消息菜单。

#### P2：`turn.note`

```js
// 清单："turn.note": [{ "id": "cost" }]
ctx.dshGo.turnNote('cost', (scope, emit) =>
  watchTurnCosts(scope.sessionId, (costs) =>          // costs: [{ turnId, yuan }]
    emit(Object.fromEntries(costs.map((c) => [c.turnId, { text: `¥${c.yuan.toFixed(2)}`, tone: 'muted' }])))))
```

- 一个对话一个订阅，数据按 `turnId` 批量推；每回合 ≤ 2 个插件的尾注，每段 ≤ 16 字。
- 渲染：接在回合脚注后面，用「 · 」隔开，同一字号和次要色；放不下时先省插件尾注，再按现有顺序省 tokens、步数（`TurnFootnote.variants`）。
- 为什么：用量、延迟、命中率这类插件要的就是「每轮一眼看到」；回合脚注已经有这一行，零新增视觉元素。

#### P2：`tool.card` 交互

- 清单声明 `"tool.card": [{ "tool": "weather" }]`；桥接核对这个工具确实由本插件注册，在 `contributions` 里下发 `tools: { "weather": "<pkg>" }`。
- App 只按桥接的这张表认工具卡归属，**不信** `meta` 里的任何自称。
- 工具卡里的 `actions` / `options` / `confirm` 生效，invoke `surface: "tool.card"`，`scope = { sessionId, callId }`；效果白名单同面板。
- 历史卡（插件已卸载、表里没有）照旧只读。

#### P2：`notify`

```js
ctx.dshGo.notify('done', { title: '日报已生成', body: '12 条要点，点开查看', open: 'panel:report' })
```

- 清单 `"notify": [{ "id": "done" }]`。标题 ≤ 24、正文 ≤ 80 字；`open` 只能是本插件面板或 `session:<id>`。
- App 在前台时画应用内横幅（和对话完成横幅同一组件，带插件图标和名字）；每插件每分钟 1 条、每天 20 条，超出丢弃并记问题。
- 第一次弹之前问一次「允许「插件名」发通知？」（同 `wants` 的首次提示），设置 › 插件 › 某插件里可以关。

#### P2：面板的弹层呈现与插件页位置

```jsonc
{ "id": "picker", "title": "贴纸", "placement": ["chat.panel"], "presentation": "sheet" },
{ "id": "about",  "title": "状态", "placement": ["plugin"] }
```

- `presentation: "sheet"`：`open panel:<id>`、`composer.tools` 打开它时用 E 骨架弹层（起始按内容高，最高 90 %），而不是推一页。
- `placement: "plugin"`：画在插件详情页「设置」之下，`scope` 为空。给网页插件「插件详情分节」「设置里的插件页签」那约 180 个包一个原生去处。

### 4.2 组件

owner 举的例子里，**已经有的**：列表 `list`、网格 `grid`、标签页 `tabs`、步骤 `steps` / `timeline`、进度 `progress`、可折叠分组 `collapsible` / `accordion`、分页 `carousel`。真缺的是下表。全部只在视图 `v: 2` 下识别；老 App 画成占位，SDK 的 `adaptView` 给出降级。

| 组件 | 期 | 形状 | 为什么 |
|---|---|---|---|
| `emptyState` | P1 | `{ icon?, title, message?, action?: { label, action } }` | 面板没数据时现在只能写一行 `text`，和 App 自己的空状态不是一个样子 |
| `gallery` | P1 | `{ items: [{ src, alt?, caption?, action? }], columns?, aspect? }` | 贴纸、生图、相册类插件要「一组图、点开大图」；`grid` 套 `image` 点不开、没有统一的格子 |
| `progress.shape: "ring"` | P1 | 在 `progress` 上加属性 | 额度、配额类最常见的样子；genui 方言也要用 |
| `metric.trend` | P1 | 在 `metric` 上加 `trend: number[]` | 用量、余额的「数字 + 微趋势」；genui 的 `stat.spark` 映射到它 |
| `list` 增强 | P2 | `sections: [{ title, items }]`、行 `leading: { image \| avatar \| icon }`、行 `menu: [{ label, action }]`（≤ 3） | 分组列表、带缩略图的行、行内更多操作 |
| `searchField` | P2 | `{ for: "<同视图里 list/gallery/table 的 id>", placeholder? }` | 本地过滤，不 invoke；条目一多就要 |
| `markdown` | P2 | `{ text }`，≤ 4000 字 | 网页插件 25 % 带 Markdown 库。这是第一次放开文字里的可点链接，所以链接必须走和 `link` 效果同一道域名确认；图片只认 `asset:` / `data:` |
| `time` | P2 | `{ at: ISO 8601, format: "relative" \| "date" \| "datetime" }` | 「3 分钟前」由 App 按语言格式化并按分钟刷新 |
| `table.columns[].type` | P2 | `bar` `ring` `spark` `delta` | 表格里的内联进度、趋势、涨跌色 |
| `audio` / `video` | P3 | 播放器 | 跟 media-generation 的视频播放一起做（`pubspec` 现在没有视频依赖） |

#### `emptyState`

```json
{ "type": "emptyState", "icon": "image", "title": "还没有贴纸", "message": "从相册导入，或让 AI 画一张",
  "action": { "label": "导入", "action": "import" } }
```

- `title` ≤ 40、`message` ≤ 120、按钮文字 ≤ 12；`action` 至多一个。
- 渲染沿用 `EmptyView` 紧凑档：48 的圆底图标（底色和图标跟随视图 accent），标题、说明、一个插件描边按钮（高 ≥ 48，和文字一样宽、至少 120），图标到标题、说明到按钮各 14，整体水平居中，上下各 24，文字最宽 280。
- 工具卡里没有按钮（工具卡不能 invoke，P2 前）。降级：`callout`。

#### `gallery`

```json
{ "type": "gallery", "columns": 3, "aspect": 1,
  "items": [{ "src": "asset:stickers/cat.webp", "alt": "猫", "caption": "开心",
              "action": { "id": "pick", "args": { "id": "cat" } } }] }
```

- 上限：面板 24 张、工具卡 8 张；`caption` ≤ 40 字一行；`columns` 2–4（缺省按宽度：内容宽 ≥ 320 时 3，否则 2；格子窄于 72 就减列）；`aspect` 0.5–2（缺省 1）。
- `src` 规则同 `image`：`asset:` 或 ≤ 64 KiB 的 `data:`，像素上限照旧。
- 格子：`cover` 裁切、圆角 8、间距 8；同一行只要有一格带 `caption`，整行都留出说明高度（行等高）。
- 点按：带 `action` 的格子 invoke（只在面板）；不带的打开 App 全屏查看器，左右滑动看这一组，双指缩放，右上「保存到相册」「分享」是 App 的动作，插件拿不到。长按总是打开查看器。网页地址等没有来源的格子画成占位，不进查看器。
- 查看器用媒体生成的看图页（`MediaViewerPage.pictures`）：同一个黑底、同样的键位和缩放；没有底部胶囊，插件名放在「AI 生成」的位置。不另做一个查看器。
- 读屏：每格一个节点，读 `alt`（没有就读 `caption`），`caption` 不同时作为值。
- 降级：`grid` 里放 `image`。

#### `progress.shape: "ring"` 与 `metric.trend`

```json
{ "type": "progress", "shape": "ring", "value": 72, "label": "本月额度" }
{ "type": "metric", "label": "今日", "value": "¥3.1", "trend": [1.2, 2.0, 1.4, 3.1], "tone": "good" }
```

- 环：直径 64、线宽 6，中心是百分比（等宽数字，可用 `caption` 替换），`label` 在环下居中；放在 `row` / `grid` 里时环在各自列里水平居中。
- 趋势线：值下方一条高 24、和指标同宽的折线，线宽 1.5，色调色或 accent（对背景 ≥ 3:1，非文字对比度），最后一个点画 4 的圆点；2–30 个有限数，`null` 断开；没有坐标轴和数字。
- 老 App 忽略这两个属性，照旧画进度条和数字。

### 4.3 样式与主题 token

| 项 | 期 | 内容 |
|---|---|---|
| `accent: "app"` | P1 | 根节点写 `"accent": "app"`，强调色跟随用户在 设置 › 主题 选的配色：取配色的浅色主色（`AppAccent.seed`），深色那份和任何请求色一样由对比度搜索推出，照常过 ≥ 4.5:1 的校正。App 换配色时设 `DshUiAppAccent`，插件视图的解析缓存随之作废，界面跟着变，和功能磁贴一个逻辑（page-design §2）。不改缺省值：不写 `accent` 的老视图仍是蓝色。SDK 离线检查按 App 默认的雾蓝算 |
| 图标名扩充 | P1 | 72 个扩到 162 个（`native_icons.dart`）：编辑与分享、状态、版式、文件与媒体、Agent 与工作、时间、人与消息（含微信、QQ、Telegram、Discord，给通道类插件）、设备与主机、外观。全部取 App 已有的 `AppIcons` 角色（Phosphor Regular），图标字体不动；清单（胶囊、菜单、面板）和视图（列表行、按钮）用同一张表，SDK 的 `view.schema.json` 列同一份。**不收**锁、钥匙、盾牌、指纹、审批、权限这类安全语义的图标，免得插件拼出像授权的界面。天气、交通这类要新画字形的，等有插件要再加 |
| 表格列类型 | P2 | 见 §4.2 |
| 不开放 | — | 字体、任意字号 / 行高 / 圆角 / 宽高 / 定位、阴影、渐变、透明度、动画参数、外链图片、SVG（`native-plugins-views.md` §7.3，理由不变） |

### 4.4 交互与状态

| 项 | 规定 |
|---|---|
| 本地状态 | `gallery` 当前看到第几张、`searchField` 的过滤文字，和 `tabs` 一样只在本地，不 invoke、不持久化，关掉面板就没了 |
| 点按 | 新组件的点按都走现有 invoke 和 3 秒窗口；查看器、保存到相册是 App 的动作 |
| P2 新效果 | `attach { src }`：把一张图（`asset:` 或桥接媒体路由）放进输入框的附件托盘，**不发送**，≤ 8 MiB，只收 png / jpeg / webp / gif；`open { page: "web:<slot>/<cell>" }`：打开**本插件**在 `main`、`sidebar.right.pane.tab`、`settings.section`、`conversation.view` 里的网页面板（整页岛，App 按占用表核对归属，开不了就「在网页版打开」）；`open { page: "session:<id>" }`：打开这台主机上的某个对话，App 先核对存在 |
| 不变 | 3 秒窗口、延后效果只能 `insert` `copy` `toast` `patch`、`insert` 永不自动发送 |

`open web:` 是给网页插件作者的捷径：加一枚胶囊或一个 ＋ 工具，指向自己已有的网页面板，就有了原生入口 + 网页本体，一行原生视图都不用写。

### 4.5 权限边界

| 新能力 | 边界 | 谁执行 | 测试 |
|---|---|---|---|
| `dsh-ui` 方言 | 只读；不 invoke、不发消息（P1）；图片只收 `data:` | App | 模糊测试共用 `plugin_view_fuzz_test` 的生成器；带按钮、外链、`javascript:` 的夹具全部画成只读 |
| 聊天页面板岛 | 桥只收呈现类消息、导航限同源（接缝规格 §6.3）；守卫没生效不开岛 | App + 运行时守卫 | 沿用 `island_logic_test`；新增「守卫关时弹层只有原生面板」 |
| `chat.panel` 面板 | 与其他面板同权：只能 invoke 自己 | 桥接 + App | 协议测试：跨插件 `panel:` 被拒 |
| `gallery` | 图片来源与像素同 `image`；保存到相册只由用户在查看器里点 | App | 非法 `src`、超像素、`http:` 全部占位 |
| `accent: "app"` | 只读用户配色，结果仍过对比度校正；插件读不到具体色值 | App | 6 套预设 × 深浅色的对比度断言 |
| 图标 | 白名单，不含安全语义图标 | App + SDK | 名单测试 |
| `composer.tools` / `session.actions` | 只在用户点按后执行；`session.actions` 的 `scope` 只给 `sessionId` | 桥接 + App | 协议测试 |
| `turn.note` | 只推文字和色调；数据和视图不进对话记录 | 桥接 | 大小、频率上限 |
| `tool.card` 交互 | 工具归属以桥接的 `tools` 表为准；历史卡只读 | 桥接 + App | 伪造 `meta` 自称归属的夹具不能 invoke |
| `attach` | 只进托盘不发送；类型、大小上限；只收本插件资源或媒体路由 | 桥接 + App | — |
| `open web:` / `session:` | 只能是本插件的网页单元 / 本主机存在的对话 | App（按占用表）| 指向别的包的 `web:` 被丢弃并记问题 |
| `notify` | 首次询问、逐插件开关、频率上限；内容不含链接，点开只能去本插件面板或对话 | 桥接 + App | — |
| 小部件（P3） | 用户自己加到桌面才有；只显示状态条那三项；锁屏不显示 | App | — |

所有 `/dsh-go/*` 路由照旧经 K3 守卫，没有凭据一律 401。永远不开放的清单不变：批准工具调用、改权限、手机操控、装卸插件、切主机、读 App 设置或凭据、无点按的自动执行（`notify` 只是提示，不带任何效果）。

## 5. 审美约束

一句话：**插件声明意图，App 决定几何**。自由度给在「放什么、强调什么、用哪一档」，不给在「多宽、多圆、多大、怎么动」。

### 5.1 谁定什么

| 维度 | App 定（插件改不了） | 插件可选 | 守法 |
|---|---|---|---|
| 间距 | 4 的倍数；页面左右 16、卡片内边距 16、弹层左右 20、分组间 24（page-design §4） | 容器 `gap` / `padding` 三档 S / M / L（8 / 12 / 16） | 四边内边距公式 `min(P, max(0, (W − M) / 2))`；几何测试 |
| 圆角 | 卡片 20、弹层 28、胶囊全圆、小标签和网格格子 8 | 无 | 没有圆角属性 |
| 字号 | 6 档阶梯（28 / 24 / 20 / 16 / 13 / 14 mono），系统字号照常缩放 | 选档、字重四档 | 没有像素字号 |
| 颜色 | 中性色、语义色、署名色、深色由浅色推导 | 一个 `accent`（命名色、`#RRGGBB`、`app`）+ 语义色调 | 每个前景对实际背景校正到 ≥ 4.5:1，图形 ≥ 3:1；底色固定浅 10 % / 深 16 % |
| 层级 | 一屏一个主色实心元素，归 App | 无 | v2 的 `primary` 降成插件描边按钮 |
| 动效 | 首次出现淡入上移 8、逐项错开 ≤ 30 ms、数值交叉淡变；系统关动画即为 0 | 无 | 没有动画属性 |
| 图标 | Phosphor Regular，选中态 Fill，尺寸按位置定 | 名字（白名单） | 不认识的名字画通用图标 |
| 触控 | ≥ 48 × 48 | 无 | 组件测试量真实边界 |
| 署名 | 面板卡顶部插件名、菜单分组名、状态条图标、「插件内容」标记 | `title`、`icon` | 作者样式覆盖不了 |
| 数量 | 胶囊每插件 2、总 8；菜单项每插件 2；尾注每回合 2；每个弹层一个网页岛 | 无 | 桥接和 App 两道截断 |

### 5.2 让任何组合都整齐的机制

1. **子不管边距，父管间距**。组件自己没有外边距，间距全由所在 `stack` / `row` / `grid` 的 `gap` 决定，嵌套不叠加。
2. **同行等高、同列等宽**。`row`、`grid`、按钮组、新的 `gallery` 都按「同一行取最高、列宽等分或按权重」排；换行后最后一行留空列对齐，不拉伸。
3. **窄屏和大字号有固定的退路**：先减列，再纵排，最后截断并标注；从不横向挤出屏幕、不缩小字号。测试档：320 / 390 宽 × 1.0 / 1.3 / 2.0 字号。
4. **色彩只有一个口子**：一张视图一个 accent，其余只有语义色调。深色不让作者写，由 App 从同一个请求色推出来。
5. **外框是 App 的**：每个位置的边框、圆角、署名行、内边距是固定外框，插件内容只在框里排。所以插件内容风格再不同，也落在统一外框里，页面骨架不被打乱。
6. **位置有配额**：任何一处出现的插件条目都有上限，超出截断而不是挤。

### 5.3 新位置和新组件的几何等式（先写测试，再画）

| 对象 | 等式（测试里量，不靠目测） |
|---|---|
| 「插件」胶囊 | 和现有胶囊同一组件、同一组量（`CapsuleMetrics`）：左右内边距都是 14、高 34、与相邻胶囊间距 8；`native_geometry_test` 里胶囊的等式加一枚「插件」胶囊 |
| 「插件」弹层 | 拖把手水平居中；标题行左内边距 = 内容左右边距 = 20；原生面板卡和网页岛卡左右缘对齐；节间距 24 |
| 网页版界面行 | 和插件详情页其他行同高（单行 52）、图标列对齐 |
| `emptyState` | 图标、标题、说明、按钮四者的水平中心重合；左右留白相等 |
| `gallery` | 格宽相等（误差 ≤ 0.5 px）；格间横竖间距都是 8；最外列到卡片内缘的距离左右相等；同行有说明时行高相等 |
| 环形进度 | 环心与百分比文字中心重合；`row` 里多个环的环心在同一水平线 |
| 趋势线 | 左右端点分别贴指标内容区左右缘；高 24 |
| 对话详情「⋯」（P2） | 与返回键镜像：距屏边相等（12）、同为 44 圆钮、垂直中心对齐 |
| ＋ 面板「插件」一节（P2） | 与附件磁贴同网格同宽，左右边距 16 |

### 5.4 验收

- 新组件深浅色各一张 golden（390 宽），另加 320 宽和 2.0 字号各一张；新位置（胶囊、弹层、网页版界面一节）深浅色 golden。全部生成后逐张看图。
- 几何测试放 `app/test/plugins/native/native_geometry_test.dart`（位置）和 `app/test/plugins/view/plugin_view_polish_test.dart`（组件）。
- 文案：精炼的产品腔，中英都写；l10n 只改 `app/lib/l10n/parts/*.arb`，用 `tool/l10n_merge.py` 生成。

## 6. 分阶段

### 6.1 P1：不改协议、不动运行时（App + SDK + 文档）

| # | 项 | 主要改动 | 测试 | 风险 |
|---|---|---|---|---|
| 1 | 目录到 rc.4 | `slot_catalog.dart`（3 个新 slot、`slotCatalogRelease`）、`recipes.json` `release`；配方在 rc.4 上复核 | `slot_catalog_test`（104 / 103）、`island_logic_test` 补 rc.4 用例 | 低 |
| 2 | `dsh-ui` 方言（genui） | 新 `dsh_ui_dialect_genui.dart`；`parseDshUi` 加分支；`DshUiFallback` 对方言不给「让它重发」 | 映射单测（每种 genui 组件一条夹具）、模糊测试、深浅色 golden（一份典型 genui 回复） | 低：只影响原来就画不出来的块 |
| 3 | 对话视图整页岛 | 目录给 `conversation.view` 整页策略；`recipes.json` + `island.js` 的 `session-view`；对话详情「插件」页签加这类条目 | 规划器单测；配方 PoC（真插件，如 `dsh-context`） | 低中：PoC 不过退回「在网页版打开」 |
| 4 | 聊天页「插件」弹层 | `native_model.dart` 放行 `chat.panel`；新 `chat_plugins_sheet.dart`；胶囊行末尾入口；B 类 7 个 slot 走面板岛（`IslandForm.panel` 已有） | 规划器单测；几何测试（胶囊、弹层）；深浅色 golden；岛预算测试（预算不够 → 一行「在网页版打开」）；守卫关闭时只有原生面板 | 中：岛的内存。只在本机、只在有第三方占用者时出现、走 `IslandBudget` |
| 5 | 插件详情「网页版界面」 | `plugin_detail_sheet.dart` 新一节；slot → 白话名表 | 组件测试、深浅色 golden | 低 |
| 6 | 4 个新组件 | `dsh_ui_plugin_*`（解析、渲染）；`ImageViewerPage` 改成可滑动一组 | 模型测试、交互测试、SDK 与 Dart 对照用例（`sdk_parity_test`）、几何测试、golden（深浅、320 / 390、1× / 2×） | 低中：查看器改动 |
| 7 | `accent: "app"` | v2 样式解析 | 对比度断言（6 套预设 × 深浅色）、golden | 低 |
| 8 | 图标名扩充 | `native_icons.dart`、SDK 名单 | 名单测试 | 低 |
| 9 | 文档、SDK、示例、技能 | 见 §7 | `sdk/plugin-kit` 的 `node --test`；示例插件单测；`examples/plugins/e2e` | 低 |

粗估 14–16 人日。最大的不确定是 #3 的配方和 #4 的岛内存，两者都有现成退路。

### 6.2 P2：改桥接（运行时出包）

- 位置：`composer.tools`、`session.actions`、`turn.note`、面板 `presentation: "sheet"` 和 `placement: "plugin"`、`tool.card` 交互、应用内 `notify`。
- 效果：`attach`、`open web:`、`open session:`。
- 组件：`list` 分组 / 前缀图 / 行菜单、`searchField`、`markdown`、`time`、表格列类型。
- 兼容：genui 交互回传和主机相对图片；`sidebar.footer.action`、`settings.plugins.tab`、`plugins.detail.*` 的整页岛；岛内浮层；岛的只读环境信息；SSH 主机装桥接（hosts.md 已列的第二期）。
- 作者工具：插件页「创建插件」（照 rc.4：开新对话，把请求和 `dsh-go-plugin` 技能放进草稿，不发送）；`check --from-web`。
- 测试：桥接 `runtime/tests/native-*.mjs` 加协议用例（新 surface、`tools` 归属、`attach` 上限、`notify` 频率）；`runtime/test-host.sh` 真 DSH 端到端；App 侧同 P1 的 golden 与几何口径。
- 风险：协议面变大（v1 只加可选项，老 App 忽略）；`notify` 的打扰（首次询问 + 频率上限 + 开关）；`tool.card` 交互的归属判断（只信桥接）。粗估 18–22 人日。

### 6.3 P3

桌面小部件、后台系统通知、宠物包（`pets.md`）、音视频组件（和 media-generation 的视频一起）、用户消息的消息操作、桥接浏览器半侧的 React 渲染器（同一份 `dshGo` 声明在网页版也显示，作者写一次两边用）、A2UI 方言、向上游提议（逐条 `data-slot` 标记、第三方面板的深链 id、把工具的 `presentResult` 视图经会话 API 下发）。每项开工前单独评估。

## 7. 作者文档与 SDK 同步

| 件 | P1 | P2 |
|---|---|---|
| `docs/plugins/slots.md` | `chat.panel` 落地、聊天页弹层的样子 | 新 surface 逐个一节 |
| `docs/plugins/components.md` | 4 个新组件 + 深浅色 golden 截图 | P2 组件 |
| `docs/plugins/styles.md` / `design-rules.md` | `accent: "app"`、新图标名单、§5 的「谁定什么」 | 表格列类型 |
| `docs/plugins/web-panels.md` | 对话视图、聊天页面板岛、网页版界面一节、岛里的环境标记与「在 DSH Go 里好看」 | 浮层、`info()`、`open web:` |
| `docs/plugins/from-web.md`（新） | §3.6 对照表 + 每行一个最小例子 | `check --from-web` |
| `docs/plugins/native-for-free.md` | `dsh-ui` 围栏和 genui 的关系；工具卡「已经在写 `presentationMeta` 就再加一个键」 | — |
| `docs/plugins/versions.md` | 新组件的降级、`caps.components` | 新 surface 与桥接版本 |
| `docs/plugins/en/*` | 同步英文 | 同步英文 |
| `sdk/plugin-kit/schema/view.schema.json` | `emptyState`、`gallery`、`progress.shape`、`metric.trend`、`accent: "app"`、`x-dsh-go` 里的上限 | P2 组件 |
| `schema/manifest.schema.json`、`contributions.schema.json` | `chat.panel` 已在，补说明 | 新 surface、`tools`、`notify`、`presentation` |
| `types/schema.d.ts`（`scripts/gen-types.mjs` 生成）、`lib/view.js` | 生成类型；构造函数 `emptyState()`、`gallery()` | 同 |
| `lib/caps.js` | `adaptView` 的新降级（`gallery` → `grid` + `image`、`emptyState` → `callout`） | 同 |
| `lib/view-check.js` | 新组件校验，和 Dart 共用对照用例 | 同 |
| `skill/SKILL.md`（`dsh-go-plugin` 技能） | 新组件、`chat.panel`、`accent: "app"` 的写法 | 新 surface |
| 示例插件 | 新 `examples/plugins/dsh-go-example-album`：聊天页弹层 + 全部功能里一个相册面板，用到 `gallery`、`emptyState`、环形进度、趋势线、`accent: "app"`（图片放 `assets/`，没有图时是空态） | 给 `dsh-go-example-quick` 加 `composer.tools` 和 `session.actions`；`dsh-go-example-usage` 加 `turn.note` |

## 8. 需要 owner 定的事

| # | 事 | 推荐 | 理由 |
|---|---|---|---|
| 1 | 聊天页「插件」入口放哪 | **胶囊行末尾一枚「插件」胶囊**，只在有内容时出现 | 看得见、和插件胶囊同一行、不碰输入框和顶栏；备选是 ＋ 面板，但要等 settings-ia S6 改完 ＋ 面板，而且藏得深 |
| 2 | 网页面板岛（聊天页 7 个 slot）进不进 P1 | **进** | 一次覆盖 31 % 的网页插件；基础设施（面板形态、预算、配方、守卫）都在；只在本机、有第三方占用者时出现，没有就零变化。不进的话 P1 的弹层只有原生 `chat.panel`，「全部可见」只到 38 %（同一口径重算） |

## 9. 不做

- 消息级网页岛仍不做。浮层岛不再列为永久不做，改按本文开头「当前接缝修订」实施。
- 替换点：顶栏、输入框本体、侧栏、皮肤（换肤类需求走用户的 ui.json）。
- 任意 CSS / HTML、外链图片、SVG、作者动画；App 内执行插件代码（QuickJS 维持不做）。
- 新对话空状态的插件建议卡（归用户的 ui.json）。
- 岛的预热常驻。

## 附录 A：调研方法与数据

调研时生成的数据（不进 git）：

| 文件 | 内容 |
|---|---|
| `index/dsh-index.json` | dshfind 索引原文（2026-10-28） |
| `index/manifests.jsonl` | 每个包最新版清单的摘录（`dsh`、`exports` 键、依赖、描述、tarball） |
| `index/slot-catalog-0.2.1-rc.4.json` | rc.4 的 103 个 slot，从 `@deepseek-ai/dsh-cordis-client-runner@0.2.1-rc.4` 的 `lib/client.js` 文本解析（`CLIENT_SLOT_API`，不执行），与 rc.2 对比只多 3 个 |
| `index/scan.jsonl` | 每个浏览器半侧包一行：注册的 slot、`data-slot` 选择器、primitives、标准 props、客户端服务、DOM 行为、宿主侧特征 |
| `index/downloads.json` | npm 上月下载 |
| `index/analysis.txt` | 本文的所有统计表 |
| `scripts/` | `manifests.py` → `scan.py` → `downloads.py` → `analyze.py`、`appendix.py`（P1 / P2 的 slot 集合在 `index/stages.json`），按这个顺序重跑即可；DSH 升级后先用 `slotcat.py` 重新生成目录 |

安全做法：每个 tarball 下载到自己新建的空目录，用 Python `tarfile` 在内存里逐个读成员做正则匹配（`python3 -I`），读完即删 tarball，不解压、不运行包里的任何东西。例外是为了读文档解压过的四个包（`dsh-cordis-client-runner`、`dsh-client-ui-conversation`、`dsh-client-ui-entry-customization` 的 0.2.1-rc.4，以及 `@changfenhuang/dsh-genui` 0.15.0 的 `SKILL.md`），各在自己的空目录里，只读。

## 附录 B：用到的 slot 全表（87 个，按包数）

| slot | 类 | 包数 | 现在 | 之后 |
|---|---|---|---|---|
| `settings.section` | A | 1350 | 原生表单 / 整页岛 | — |
| `shell.overlay` | B | 664 | 无 | P2 岛内浮层；P3 宠物包 |
| `sidebar.footer.action` | E | 401 | 无 | P2 整页岛（PoC） |
| `plugins.bundle.config` | A | 309 | 原生表单 / 整页岛 | — |
| `conversation.input.dock` | B | 276 | 无 | P1 聊天页「插件」弹层 |
| `conversation.view` | E | 238 | 无 | P1 对话详情页签整页岛 |
| `sidebar.right.pane.tab` | A | 225 | 整页岛 | — |
| `sidebar.panellist` | A | 219 | 全部功能入口 | — |
| `main` | A | 219 | 整页岛 | — |
| `tool.call.toolview` | C | 196 | 无 | 作者 `tool.card`；P2 交互 |
| `conversation.composer.dock` | B | 195 | 无 | P1 聊天页「插件」弹层 |
| `conversation.input.right` | B | 191 | 无 | P1 聊天页「插件」弹层 |
| `conversation.session.header.actions` | B | 189 | 无 | P1 聊天页「插件」弹层 |
| `conversation.input.left` | B | 187 | 无 | P1 聊天页「插件」弹层 |
| `conversation.session.header.utilities` | B | 170 | 无 | P1 聊天页「插件」弹层 |
| `settings.general.item` | A | 151 | 整页岛（遮官方条目） | — |
| `settings.plugins.tab` | E | 146 | 无 | P2 整页岛；作者 P2 `placement: plugin` |
| `plugins.row.config` | A | 137 | 原生表单 / 整页岛 | — |
| `conversation.chat.node` | C | 113 | 无 | 不做岛；P1 `dsh-ui` 方言 |
| `sidebar.right.pane.tab.title` | A | 106 | 页签名 | — |
| `conversation.chat.turnTail` | C | 85 | 无 | 作者 P2 `turn.note` |
| `conversation.chat.assistant-actions` | C | 75 | 无 | 作者 `message.actions` |
| `plugins.item` | E | 72 | 无 | 插件详情「网页版界面」（P1） |
| `conversation.input.overlay` | B | 64 | 无 | P1 聊天页「插件」弹层 |
| `sidebar.workspaces.session.menu.item` | E | 61 | 无 | 作者 P2 `session.actions` |
| `conversation.input.model` | D | 39 | 不做（替换点） | — |
| `conversation.chat.commandview` | C | 34 | 无 | 不做岛 |
| `sidebar.workspaces` | D | 34 | 不做（替换点） | — |
| `plugins.detail.section` | E | 34 | 无 | P2 整页岛；作者 P2 `placement: plugin` |
| `settings.models.provider-card` | E | 26 | 无 | 插件详情「网页版界面」（P1） |
| `sidebar.right.tab.document` | E | 25 | 无 | 插件详情「网页版界面」（P1） |
| `sidebar.brand.name` | D | 23 | 不做（替换点） | — |
| `sidebar.brand.mark` | D | 21 | 不做（替换点） | — |
| `conversation.hero.workspace` | D | 21 | 不做（替换点） | — |
| `conversation.composer` | E | 20 | 无 | 插件详情「网页版界面」（P1） |
| `sidebar.workspaces.directoryFlow` | D | 19 | 不做（替换点） | — |
| `conversation.hero.workspace.directoryFlow` | D | 19 | 不做（替换点） | — |
| `conversation.hero.brand.mark` | E | 18 | 无 | 插件详情「网页版界面」（P1） |
| `sidebar.workspaces.session.row.action` | E | 16 | 无 | 作者 P2 `session.actions` |
| `sidebar.session.row.leading` | E | 15 | 无 | 插件详情「网页版界面」（P1） |
| `settings.action` | E | 15 | 无 | 插件详情「网页版界面」（P1） |
| `plugins.detail.actions` | E | 14 | 无 | P2 整页岛 |
| `settings.models.footer` | E | 14 | 无 | 插件详情「网页版界面」（P1） |
| `sidebar.session.row.hover` | E | 10 | 无 | 插件详情「网页版界面」（P1） |
| `settings.onboarding` | E | 8 | 无 | 插件详情「网页版界面」（P1） |
| `conversation.input.attachments` | D | 8 | 不做（替换点） | — |
| `plugins.tab` | E | 7 | 无 | 插件详情「网页版界面」（P1） |
| `sidebar.right.tab.files.actions` | E | 7 | 无 | 插件详情「网页版界面」（P1） |
| `plugins.bundle.activation` | D | 7 | 不做（替换点） | — |
| `conversation.header.leading` | E | 7 | 无 | 插件详情「网页版界面」（P1） |
| `conversation.hero.agentPreset` | D | 6 | 不做（替换点） | — |
| `sidebar.right.tab.document.actions` | E | 6 | 无 | 插件详情「网页版界面」（P1） |
| `plugins.detail.badge` | E | 6 | 无 | 插件详情「网页版界面」（P1） |
| `tool.view.cordis` | A | 6 | 原生列表 + 整页岛 | — |
| `conversation.session.header.lineage` | D | 5 | 不做（替换点） | — |
| `sidebar.settings` | D | 5 | 不做（替换点） | — |
| `conversation.composer.bar` | D | 5 | 不做（替换点） | — |
| `sidebar.right.tab.menu.item` | E | 5 | 无 | 插件详情「网页版界面」（P1） |
| `settings.trigger` | D | 4 | 不做（替换点） | — |
| `sidebar` | D | 4 | 不做（替换点） | — |
| `settings.header` | D | 4 | 不做（替换点） | — |
| `conversation.approval.detail` | D | 4 | 不做（替换点） | — |
| `conversation.input.model.label` | D | 3 | 不做（替换点） | — |
| `deliverables.file.actions` | E | 3 | 无 | 插件详情「网页版界面」（P1） |
| `main.conversation` | D | 3 | 不做（替换点） | — |
| `workspace.toast` | D | 3 | 不做（替换点） | — |
| `conversation.input.activity` | D | 3 | 不做（替换点） | — |
| `conversation.hero.options` | E | 3 | 无 | 插件详情「网页版界面」（P1） |
| `sidebar.right.tab.guide.entry` | E | 3 | 无 | 插件详情「网页版界面」（P1） |
| `settings.close` | D | 2 | 不做（替换点） | — |
| `conversation.plan-review.actions` | E | 2 | 无 | 插件详情「网页版界面」（P1） |
| `conversation.user.text.node` | C | 2 | 无 | 不做 |
| `rightbar` | D | 2 | 不做（替换点） | — |
| `shell.leading` | D | 2 | 不做（替换点） | — |
| `conversation.session.header.corner` | D | 2 | 不做（替换点） | — |
| `root` | D | 2 | 不做（替换点） | — |
| `conversation.chat.reasoning.body` | D | 2 | 不做（替换点） | — |
| `settings.launcher` | D | 2 | 不做（替换点） | — |
| `sidebar.right.tab.document.unpreviewable` | E | 2 | 无 | 插件详情「网页版界面」（P1） |
| `shell.quota-notice` | E | 1 | 无 | 插件详情「网页版界面」（P1） |
| `conversation.input.plan` | D | 1 | 不做（替换点） | — |
| `conversation.input.permission` | D | 1 | 不做（替换点） | — |
| `plugins.add.actions` | E | 1 | 无 | 插件详情「网页版界面」（P1） |
| `rightbar.session` | D | 1 | 不做（替换点） | — |
| `shell.bottom` | D | 1 | 不做（替换点） | — |
| `conversation.session.header` | D | 1 | 不做（替换点） | — |
| `conversation.chat.flow` | D | 1 | 不做（替换点） | — |

没有任何第三方包注册的 16 个：`conversation.chat.message.images`、`conversation.chat.user.images`、`conversation.header`、`conversation.session`、`conversation.session.header.views.actions`、`conversation.trajectory.images`、`deliverables.review.file.actions`、`settings.models.sign-in`、`sidebar.chat.conversation`、`sidebar.panellist.actions`、`sidebar.right.tab.document.action`、`sidebar.right.tab.document.office.pdf`、`sidebar.right.tab.guide`、`sidebar.right.tab.guide.actions`、`sidebar.toggle.badge`、`tool.call.images`。

