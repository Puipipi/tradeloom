# 原生插件：接缝盘点与路线

> 2026-10-25。回答两个问题：原生界面的接缝给够了没有；有人想专门给原生界面写插件，能不能做到。
> 依据：`docs/design/plugin-seams.md`（下称「接缝规格」）、当时已有的插件接缝与 `ui.json` 代码、官方 slot 目录（从 DSH 客户端提取，方法见接缝规格附录 A）、15 个热门插件抽样（结论汇总在接缝规格 §1.3），以及本机 DSH 0.2.1-rc.2 安装包（只读）。rfw、genui、QuickJS 的现状在 2026-10-25 查过，来源见附录。
> 本文只做评估和设计，没有改代码。

## 当前接缝修订（2026-11-11）

本文的表格、样本和工作量仍是 2026-10-25 的历史评估。§5 / §7.1 将浮层岛拿掉的决定已被本次网页接缝实现取代：`shell.overlay` 按包显式启用，按包 + cell 放行，只在 `HomeShell.chat` 内的 `ChatScreen` 聊天内容区显示，以 `ClipRect` 裁在原生顶栏和输入框之间，不覆盖原生 chrome、抽屉、右详情或模态；未决审批 / 未答问题时停止，键盘出现时视口随原生布局收缩。它不是跨 App 悬浮窗；本机偏好按主机保存，`ui.json` 的 `plugins.seats` 显式值优先。`sidebar.footer.action`、`settings.plugins.tab`、`plugins.detail.section` 从插件详情提供单包、单 cell 整页入口。

浮层矩形命中不是像素透明；快速运动的命中区可能滞后。本文首岛约 200 MB 等性能值仅来自 Android 15 x86_64 debug 模拟器估测，真机未验证；旧普查比例也不是免改兼容承诺。音频仍需现有用户手势，本轮不新增原生 `pets` / `bubbles` / `actions` 协议。详见 [网页面板](../plugins/web-panels.md)。

## 0. 结论

| 问题 | 结论 |
|---|---|
| 接缝够不够 | **不够。** 已接线的位置都是「整页」类：设置、插件详情、对话详情页的插件页签、全部功能、Cordis 交互区，靠网页岛或 schema 表单撑着。聊天页本体（顶栏、输入框、消息、工具卡、回合尾）和抽屉，第三方一个位置都没有。插件最常用的偏偏是这些地方：按抽样加权，约 4 成用法落在已接线位置，3 成落在已设计但还没接线的聊天页面板和浮层，另外 3 成没有任何安排，其中消息级的用法按设计永远进不了网页岛（§1） |
| 能不能专门给原生界面写插件 | **能，做法和 Raycast 一样，但不能运行任意 Flutter 代码。** Flutter 是 AOT 编译的，App 不能在运行时加载 Dart，所以任何路线都绕不开「App 自带一套组件目录」。可行的模型是：插件逻辑跑在 DSH 引擎里（Node），插件把「组件树 + 数据」发给 App，App 用原生组件画出来，用户的操作回传给插件。面板、按钮、状态条、工具卡、图表、列表、表单、宠物皮肤都能做；自定义绘制、自定义动画、换肤、替换官方界面都做不到（§2） |
| 推荐路线 | **c：服务端驱动的原生组件，格式用自定义 JSON（现有 `dsh-ui` 目录的超集），不用 rfw，也不嵌 JS 引擎。** 另加一条几乎零成本的通道：DSH 工具本来就有 `presentationMeta`（随对话记录持久化、模型看不到），插件工具在里面放一份 `dsh-ui` 视图，App 就画成原生工具卡。这条通道不经桥接，中转主机也能用（§2.4、§3） |
| 第一期最小可用 | **第 0 期（3–4 人日）**：工具卡走 `presentationMeta`，外加作者文档「已经原生显示的扩展点」。**第一期（15–19 人日）**：桥接插件提供 `dshGo` 服务和插件清单，开通四个插槽：输入框胶囊、消息操作、输入框上方状态条、原生面板。配两个示例插件：用量、快捷指令（§5） |
| 工作量 | 第 0 期加第一期约 3.5–4.5 人周；第二期（工具卡交互、输入控件、回合尾注、通知、宠物包、网页版同步渲染）再加 16–22 人日 |
| 最大风险 | **生态冷启动**：dsh-go 的用户量撑不起第三方作者专门适配。对策有四条：工具卡零成本；同一份声明在 DSH 网页版也能渲染（第二期）；用技能教用户自己的 agent 写插件；我们自己给两三个热门插件提适配 PR（§7） |

一句话：现在的接缝只够「把网页插件整页搬进来」，不够「原生插件」。要补的不是更多网页岛，而是一套很小的原生插件协议。

## 1. 盘点

### 1.1 原生界面的位置（按区域）

「能放什么」是今天第三方实际能放进来的东西。ui.json 一栏：写作时 App 已经能解析，但还没接到各界面，所以全部不生效。

| 区域 | 原生位置 | 今天能放什么 | 状态 | 对应官方 slot |
|---|---|---|---|---|
| 聊天页 · 顶栏 | 按钮区 | ui.json `header.actions`（用户自己写，自定义 ≤ 3 个） | 未接线 | `conversation.session.header.actions` / `utilities`：面板岛，未接线 |
| 聊天页 · 空状态 | 建议卡 | ui.json `emptyState.suggestions` | 未接线 | `conversation.hero.options`：无安排 |
| 输入框 · 上方 | 胶囊行 | ui.json `composer.quickActions` | 未接线 | `conversation.input.dock` / `composer.dock`：面板岛，未接线 |
| 输入框 · 工具行 | 左、右按钮 | 都不行 | — | `conversation.input.left` / `right` / `overlay`：面板岛，未接线 |
| 输入框 · `/` 菜单 | 命令列表 | 插件在引擎里注册的命令 ✅ 原生 | 已有 | `conversation.chat.commandview`（命令结果自定义渲染）：无 |
| 消息 · 助手正文 | 正文渲染 | `dsh-ui` 围栏 ✅ 原生（模型输出；插件可以用技能教模型输出） | 已有 | `conversation.chat.node`：替换点 |
| 消息 · 操作 | 长按菜单 / 操作行 | 都不行 | — | `conversation.chat.assistant-actions`：消息级，无 |
| 消息 · 回合尾 | 尾注 | 都不行 | — | `conversation.chat.turnTail`：消息级，无 |
| 工具调用卡 | 工具行 | 通用行：动词 + 首个字符串参数 + 原始 JSON（`tool_view.dart`），不能定制 | 已有 | `tool.call.toolview`（按工具名定制卡片）：消息级，无 |
| Cordis 卡 | 交互区 | 整页岛 | ☑️ 已接线 | `tool.view.cordis` |
| 抽屉 | 分组、排序、筛选 | ui.json `drawer` | 未接线 | `sidebar.*`：替换点，不做 |
| 抽屉 · 对话行 | 菜单、前导标记、悬停 | 都不行 | — | `sidebar.workspaces.session.menu.item` 等 4 个：无 |
| 抽屉 · 底部 | 按钮 | 都不行 | — | `sidebar.footer.action`：无 |
| 对话详情页 | 「插件」页签 | 整页岛（每个页签一个） | ☑️ 已接线 | `sidebar.right.pane.tab` (+`.title`) |
| 全部功能 | 插件面板入口 | 整页岛 / 网页版链接 | ☑️ 已接线 | `main` + `sidebar.panellist` |
| 设置 | 插件分组 | schema 原生表单 / 整页岛 | ☑️ 已接线 | `settings.section`、`settings.general.item` |
| 插件详情页 | 插件设置 | schema 原生表单 / 整页岛 | ☑️ 已接线 | `plugins.bundle.config` / `row.config` |
| 插件详情页 | 操作、徽章、分节 | 都不行 | — | `plugins.detail.actions` / `badge` / `section`：无 |
| 引擎设置 | 各命名空间 | `settings/describe` schema ✅ 原生表单 | 已有 | — |
| 文件 / 产物 | 文件操作、预览器 | 都不行 | — | `deliverables.file.actions`、`sidebar.right.tab.document*` 等 8 个：无 |
| 全屏浮层 | — | 都不行 | 浮层岛（P2）未接线 | `shell.overlay` |
| 宠物 | 聊天页 / 悬浮窗 | 只有内置两只；ui.json `pet` 只能选内置 | — | `shell.overlay`（宠物插件走这里） |
| 通知 | 横幅、系统通知 | 都不行 | — | 官方没有对应 slot |
| 外观 | 主题、疏密、隐藏项 | ui.json `theme` / `density` / `hide` | 未接线 | 换肤类替换点，不做 |

结论：24 个原生位置里，第三方今天真正能用的只有 5 个整页类座位（全靠网页岛或 schema 表单）。另有 4 个「引擎贡献、原生自动显示」的扩展点：命令、引擎设置 schema、工具通用行、`dsh-ui` 围栏。

### 1.2 和官方 slot 清单对账（0.2.1-rc.2，100 个）

| 类别 | 个数 | 原生现状 |
|---|---|---|
| 替换点（`shadows-shipped-ui`） | 48 | 不做（接缝规格 §2 原则）。其中 `main`、`plugins.bundle.config` 按 key 追加，已接线 |
| 追加点 | 52 | 见下 |
| ├ 已接线 | 7 + 2 | `settings.section`、`settings.general.item`、`plugins.row.config`、`sidebar.panellist`、`sidebar.right.pane.tab`(+`.title`)、`tool.view.cordis`，加上 `main`、`plugins.bundle.config` |
| ├ 设计了、没接线 | 8 | 聊天页面板岛 7 个（输入框 5 个 + 顶栏 2 个），浮层岛 `shell.overlay` |
| ├ 消息级 | 2（另有 4 个替换点也属消息级） | 按设计只给「在网页版查看」，实际也没接 |
| └ 没有任何安排 | 35 | 抽屉对话行 4 个、文件 / 文档预览 8 个、插件页 6 个、设置 5 个、其余 12 个 |

按抽样加权（15 个热门插件，共 54 个「插件 × slot」用法，接缝规格 §1.3）：

| 落点 | 用法数 | 占比 | 典型 |
|---|---|---|---|
| 已接线 | 22 | 41 % | 设置分区 9、插件配置 3、右栏页签 3 |
| 设计了、没接线 | 16 | 30 % | 输入框坞 5、浮层 3、顶栏 4 |
| 没有位置 | 16 | 30 % | 回合尾 3、消息操作 3、工具卡 2、抽屉底部 2 |

已接线的那 41 % 里，大多数呈现成网页岛：第一个岛约 200 MB，打开要 0.8–3.4 s（模拟器实测），同屏最多 1–3 个，观感是「换了颜色的网页」。

### 1.3 原生缺的、重要的

| 缺口 | 为什么重要 | 网页岛能不能补 |
|---|---|---|
| **工具卡**（`tool.call.toolview`） | 带工具的插件，在 App 里只显示原始 JSON。可视化、生图、浏览器截图一类插件的价值全在卡片上。roadmap 早就列了 `tool.renderers` | 不能：消息级，每条消息一个平台视图会拖垮滚动 |
| **消息操作**（`assistant-actions`） | 朗读、翻译、改写、复制成某种格式。抽样 3 个插件在用 | 不能：消息级 |
| **输入框按钮 / 胶囊**（`input.left/right/dock`） | 快捷指令、表情包、模板。抽样里用得最多的聊天页位置 | 能，但要先打开「插件」面板，一个面板就是一个完整客户端 |
| **状态条 / 回合尾注**（`composer.dock`、`turnTail`） | 用量、余额、上下文压力，「一眼看到」型信息 | 状态条能（面板岛）；尾注不能 |
| **原生面板**（`dsh-go.panel`，适配器只有骨架） | 让愿意适配的插件摆脱网页岛：省内存、秒开、观感统一 | — |
| 次要：顶栏按钮、对话行菜单、通知、宠物包、插件详情页分节 | 各有一两个插件在用 | 顶栏能（面板岛）；其余不能 |

## 2. 能不能「专门给原生界面写插件」

### 2.1 硬约束与先例

- **Flutter AOT**：release 包没有 Dart 解释器，不能加载外来 Dart 或 Flutter 组件。Android 上再从主机下载 `.so` / `.dex` 执行，是安全上的红线，也不是插件作者该写的东西。
- 所以任何非 WebView 的路线，都拆成同样三层，只是第三层放的位置不同：

| 层 | 谁写 | 说明 |
|---|---|---|
| ① 组件目录 | App（我们） | 绕不开。卡片、列表、图表、按钮……观感由它决定 |
| ② 视图描述 | 插件 | 用 JSON / rfw / A2UI 编码的组件树和数据。这一层只是「格式」之争 |
| ③ 逻辑 | 插件 | 跑在哪：DSH 引擎（Node，路线 c）、App 里的 JS 引擎（路线 d），或者只用声明式的局部状态和公式 |

- **先例**：
  - Raycast：扩展用 TypeScript / React 写，跑在 Node 进程里，由自定义 reconciler 转成渲染树，再由宿主画成 AppKit 原生界面，全程没有 HTML。组件目录很小（List / Grid / Detail / Form / ActionPanel），但撑起了上千个扩展。
  - VS Code：`contributes` 静态声明菜单和按钮，`activate` 里跑逻辑。
  - Slack Block Kit、Adaptive Cards：JSON 卡片，按钮回调服务端。
  - 路线 c 就是这个模型，并且 DSH 插件本来就跑在 Node 里。

### 2.2 能做到什么程度（能力阶梯）

| 级 | 内容 | 例子 | 推荐路线下 |
|---|---|---|---|
| L0 | 引擎贡献，原生自动显示 | 斜杠命令、引擎设置表单、技能、模型输出的 `dsh-ui` 卡 | ✅ 现在就有 |
| L1 | 静态按钮和文字，点了由宿主处理 | 输入框胶囊「翻译剪贴板」、消息菜单「朗读」、状态条「本对话 ¥0.42」 | 第一期 |
| L2 | 原生面板：组件树 + 推送数据 + 事件回传 | 用量面板（指标 + 图表 + 明细表）、工具卡 | 第 0 期（工具卡）、第一期（面板） |
| L3 | 不回宿主的本地交互：输入控件、局部状态、公式重算 | 房贷计算器滑块、筛选开关 | 第二期 |
| L4 | 自定义绘制、自定义动画、手势游戏、换肤、替换官方界面 | Live2D 宠物、Wallpaper Engine、claude-style 主题 | ❌ 只能走网页岛，或者不做 |

抽样 15 个插件，按包描述估（未逐个实测）：约 8 个能在第一、二期做到全部或主要功能原生（用量、表情包、可视化工具卡、余额挂件、上下文面板、宠物皮肤……）；约 4 个部分原生（朗读要「播放」效果、改写要消息编辑能力）；约 3 个永远不会原生（换肤、侧栏替换、Wallpaper Engine）。

### 2.3 路线对比

| | a. 网页岛 | b. ui.json 扩展 | c. 服务端驱动原生组件（推荐） | d. 内嵌 JS 引擎（QuickJS） |
|---|---|---|---|---|
| 插件作者写什么 | 不用写：现有网页插件直接用 | 写不了：ui.json 归用户和用户的 AI，插件不能贡献 | 宿主半侧加几十行：`package.json` 静态声明 + 可选 `ctx.dshGo` 处理事件、推数据；工具卡只加一个 `presentationMeta` | 一个在 App 里运行的 JS 包，调我们定义的桥 API |
| 能做出什么 | 整页、面板、浮层；不能进消息级 | 固定按钮、固定文本、主题和隐藏项；没有数据、没有逻辑 | L0–L3；工具卡、消息操作、状态条、面板、宠物皮肤 | 同 c，外加离线、零延迟的本地逻辑 |
| 性能上限 | 第一个岛约 200 MB（渲染进程约 145 + App 侧约 60），之后每个 5–30 MB；就绪 0.8–3.4 s；同屏 1–3 个 | 零开销 | 普通 widget；列表里无额外开销；面板首开取决于主机往返（本机约几十 ms） | 引擎每个 ABI 约 1–2 MB（估）；每个插件一个上下文，几 MB 到几十 MB |
| 观感 | 网页，靠覆盖约 27 个配色 token 和字号缩放拉近，不是原生滚动和转场 | 原生 | 原生，并且被目录约束成同一套设计 | 原生（画的仍是 c 的目录） |
| 安全 | 守卫 + 窄桥；网页里的插件代码和网页版同权 | 无代码 | App 不执行任何外来代码：攻击面只有 JSON 解析和动作白名单 | 主机下发的代码跑进 App 进程：信任边界变大，要做沙箱、超时、内存上限、桥 API 审计 |
| 版本兼容 | 依赖官方 DOM 和 slot 结构；DSH 升级弄坏配方时退成「在网页版打开」 | `version` 整数 | 协议 `v` + App 能力声明；不认识的组件画成占位行 | JS API 版本 + 引擎版本，两头都要管 |
| 主机覆盖 | 本机（守卫生效后）、SSH；中转主机没有 | 本机、SSH；中转看能不能读文件 | 工具卡：全部主机（随对话记录走）。其余：本机、装了桥接的 SSH 主机 | 同 c（代码也要经桥接下发） |
| 我们的投入 | 已投入；剩聊天页面板岛 2–3、浮层岛 3–5、真机内存复测 1 | 各界面接入 4–6（已排） | 第 0 期 3–4、第一期 15–19、第二期 16–22 | c 的全部，再加 10–15 |
| 最大风险 | 内存，以及观感永远差一截 | 不解决插件问题 | 生态冷启动；目录不够用 | 第三方 QuickJS 绑定的维护（见附录）；安全面；调试难 |

**结论**：
- a 留作现有网页插件的兼容层。
- b 留作用户自定义，并作为 c 的「用户覆盖」（`plugins.seats`、胶囊排序和隐藏）。
- c 是原生插件的主路线。
- d 不做。

### 2.4 四个真实插件在各路线下

| 插件（原型） | a. 网页岛 | b. ui.json | c. 原生协议 | d. QuickJS |
|---|---|---|---|---|
| **用量面板**（dsh-cost-meter、dsh-whale-widget） | 面板岛能显示，约 200 MB，要先点开面板；回合尾注放不进来 | ❌ 没有数据 | ✅ 状态条「本对话 ¥0.42 · 今日 ¥3.1」+ 面板（指标、柱状图、明细表）；回合尾注在第二期 | 同 c |
| **自定义工具卡**（dsh-visualize、生图、截图） | ❌ 消息级 | ❌ | ✅ `presentationMeta` 里放视图，全主机可用，重放历史也在；HTML 可视化在第二、三期做成「点开全屏沙箱」 | 同 c |
| **快捷指令 / 消息操作**（dsh-omi-voice 朗读、翻译、改写） | 面板岛里能点，但不在消息旁边 | 只有用户手写的固定文本和命令 | ✅ 胶囊和消息菜单项，由宿主处理，返回「放进输入框 / 提示 / 打开面板」；朗读要第二期的 `play` 效果 | 同 c；本地处理略快 |
| **宠物**（dsh-pet、鲸娘、linxin 宠物） | 浮层岛：常驻一个完整客户端，命中区滞后约 100 ms | 只能选内置宠物 | ✅ 宠物包（纯数据：`pack.json` + 序列帧），由 App 的 `PetMood` 驱动；按 `pets.md` 规则不做碎碎念和养成 | 能自定义行为，但耗电，也违背 `pets.md` 的「状态指示器」定位 |

### 2.5 c 的视图格式：自定义 JSON、rfw，还是 A2UI

| | 自定义 JSON（`dsh-ui` 超集，推荐） | rfw 2.0.0 | A2UI / genui 0.10.4 |
|---|---|---|---|
| 维护方与状态 | 我们自己；渲染器已有约 5.3k 行（`app/lib/ui/chat/dsh_ui/`），带 4 种自绘图表 | flutter.dev，3 天前发布 2.0.0（要求 Flutter 3.44 / Dart 3.12，我们是 3.47 / 3.13，满足）。近一年主要是 SDK 升级和零星补组件，兼容性官方写的是「尽力而为」 | labs.flutter.dev，0.x 版本，面向「LLM 生成界面」，协议还在变 |
| 作者用什么写 | JS 对象 / TS 类型，Node 作者最熟，LLM 写起来也最稳 | `.rfwtxt`，一种类 Dart 的 DSL；生产环境官方建议发二进制；Node 侧没有校验工具，要我们把 Dart 解析器编成 JS 另发 | JSON 消息流：扁平组件表 + 数据模型 |
| 数据绑定 / 局部状态 | 要自己做：第一期只做路径引用，第二期实现与 DS Bot 兼容的公式（dsh-ui 二期本来就要做） | 现成：`data.x`、`args`、`state`、`...for`、`switch`、事件 | 现成：数据模型 + 路径绑定 |
| 观感约束 | 只开放高层组件，颜色只能用语义色调，天然统一 | 默认开放 core widgets（Container、Padding、颜色…），作者能拼出任意样式。要统一就只能暴露我们自己的组件库，这样它就只剩「另一种语法」 | 目录由 App 定，可约束 |
| 能不能在网页版和 TUI 复用 | ✅ 桥接的浏览器半侧写一个 React 渲染器即可，同一份声明网页版也显示（第二期）；dsh-TUI 可画成文本块 | ❌ 只有 Flutter 能画 | 有 Web 渲染器，但又多一套协议 |
| 和已有资产 | 与模型输出的 `dsh-ui` 卡、准备提给上游 `@dsh-std/ui` 的 Panel 块是同一套 | 平行的第二套 | 平行的第二套 |

选自定义 JSON。从 A2UI 借两点：视图和数据分开推送；用增量的 `updateDataModel` 代替整树重发。从 rfw 借两点：绑定写法，以及「事件只是名字加参数，逻辑在宿主」。rfw 唯一明显的优势是现成的绑定和状态，那部分只值 3–5 人日，不值得换掉生态复用。

### 2.6 为什么不做 d（QuickJS）

- d 不省事：插件 JS 在 App 里也画不了 Flutter，最后还是输出 c 的组件树。d 等于「c + 一个 JS 运行时」，只多了两样东西：离线逻辑和零往返。
- 零往返的需求由 L3（声明式局部状态 + 公式）覆盖。本机引擎走回环地址，往返只有几十毫秒。
- 代价：
  - 主机下发的代码进入 App 进程，任何一台被攻破的远程主机都能在手机 App 里执行代码；
  - Flutter 的 QuickJS 绑定都是社区维护：`flutter_js` 在 Android 上还停在 2021 年的 QuickJS，较新的 `quickjs_engine`、`flutter_qjs_next` 各自只有一个作者；
  - 调试、内存上限、超时、生命周期全要自己做。
- 等到有插件明确需要离线逻辑时再评估。

## 3. 推荐方案：dsh-go 原生插件协议

### 3.1 结构

```
插件包（npm，DSH 插件）
 ├─ package.json "dshGo": 静态声明（清单）——胶囊、消息操作、面板、状态条、宠物包
 ├─ 宿主半侧（Node，可选）：ctx.inject(['dshGo?']) → 视图、数据推送、事件处理
 └─ 工具：output.presentationMeta(args, value) → { "dsh-go/view": View }   ← 不经桥接
                │                                         │
       dsh-go-bridge（宿主，已有）                   对话记录（tool/result.meta）
  GET /dsh-go/v1/contributions                             │
  GET /dsh-go/v1/views/<pkg>/<id>                          │
  WS  /dsh-go/v1/stream（数据补丁）                         │
  POST /dsh-go/v1/invoke（事件 → 效果）                     │
                └──────────────┬───────────────────────────┘
                     App：组件目录（dsh-ui 渲染器 + 新块）
                          动作白名单 · 署名外框 · 用户覆盖（ui.json）
```

- 只装了网页半侧的插件，照旧走网页岛。声明了 `dshGo` 面板的插件，座位规划器选 `native`：接缝规格 §4 的 `dsh-ui-panel` 适配器从骨架变成真实现。
- 没有插件时界面零变化（沿用接缝规格 §2 原则）。

### 3.2 作者面（草案）

```jsonc
// package.json
"dshGo": {
  "v": 1,
  "contributes": {
    "composer.actions": [{ "id": "translate", "label": "译成英文", "icon": "translate" }],
    "message.actions":  [{ "id": "speak", "label": "朗读", "icon": "speaker" }],
    "composer.strip":   [{ "id": "cost" }],
    "panels": [{ "id": "usage", "title": "用量", "icon": "chart", "placement": ["session.tab", "features"] }],
    "pets":   [{ "id": "mochi", "pack": "./pets/mochi/pack.json" }]
  }
}
```

```ts
// 宿主半侧：只在需要动态内容或处理点按时写
export function apply(ctx) {
  ctx.inject(['dshGo?'], (ctx) => {
    ctx.dshGo.panel('usage', {
      view: (scope, caps) => ({ type: 'stack', children: [
        { type: 'metric', label: '本对话', value: { $: 'data.session' } },
        { type: 'chart', kind: 'bar', categories: { $: 'data.days' }, series: [{ values: { $: 'data.cost' } }] } ] }),
      data: (scope, emit) => watchCost(scope.sessionId, (d) => emit(d)),   // 返回取消函数
    })
    ctx.dshGo.on('translate', async (scope) => ({ insert: await translate(scope.clipboard) }))
  })
}
```

```ts
// 工具卡：不需要桥接，任何主机可用
output: {
  schema, render,
  presentationMeta: (args, value) => ({ 'dsh-go/view': { type: 'stack', title: '东京 · 未来 3 天', children: [/* metric / chart */] } }),
}
```

`presentationMeta` 是 DSH 工具的正式字段（`dsh-tools` 类型：`output.presentationMeta`，注释写的是「可重放的展示元数据，与模型内容分开」）。它的值持久化在 `tool/result.meta` 里，App 已经收到它（`ToolChatItem.meta`，现在用来读 diff 和子代理 id）。

`scope` = `{ host, sessionId?, turnId?, messageId?, callId? }`。只有用户点按 `composer.actions` 或 `composer.tools` 时，才附带当前输入框文字和剪贴板，并且两样都要声明 `"wants": ["draft" | "clipboard"]`，安装或首次使用时提示一次。

### 3.3 插槽（surface）v1

| surface | 原生位置 | 内容 | 上限 | 期 |
|---|---|---|---|---|
| `tool.card` | 工具行展开区；折叠行的摘要取视图 `title` | `meta["dsh-go/view"]` | 8 KiB（要写进对话记录，必须小）、40 个节点 | 0 |
| `composer.actions` | 输入框上方胶囊行，和 ui.json `quickActions` 合并 | 图标 + 文字，点按触发 invoke | 每插件 2 个，总计 8 个；ui.json 的排序和隐藏优先 | 1 |
| `message.actions` | 助手消息长按菜单，按插件分组 | 同上，`scope` 带 `messageId` | 每插件 2 个 | 1 |
| `composer.strip` | 输入框上方一行（与活动条互斥，生成中让位） | 图标 + ≤ 24 字，绑定数据 | 同时只显示 1 条，多个插件轮流 | 1 |
| `panel` | 对话详情页「插件」页签、全部功能、聊天页面板 | 视图 + 数据 | 视图 32 KiB、120 个节点、8 层；数据补丁 16 KiB、≤ 4 Hz | 1 |
| `turn.note` | 回合尾一行小字 | 模板 + 按 `turnId` 批量拉的数据（每个对话一个订阅，不按行请求） | ≤ 24 字 | 2 |
| `header.actions` | 顶栏「更多」菜单（不新增顶栏图标；用户可以在 ui.json 里提到顶栏） | 同 `composer.actions` | 每插件 2 个 | 2 |
| `session.menu` | 抽屉里对话行的菜单 | 同上，`scope` 带 `sessionId` | 每插件 2 个 | 2 |
| `notify` | 应用内横幅；后台走系统通知 | 标题 + 正文 + 目标对话 | 每插件每分钟 1 条，用户可逐插件关闭 | 2 |
| `pets` | 宠物站位 / 悬浮窗 | 宠物包（`pets.md` §3 格式），素材由桥接按同源地址提供 | 包 ≤ 2 MB | 2 |

### 3.4 组件目录与绑定

- **第一期**：沿用 `dsh-ui` 一期的 10 种（stack、row、text、metric、chart、compare、steps、callout、options、confirm），再加 6 种：
  - `list`：行，含标题、副标题、尾部值、图标、行动作；
  - `keyValue`；
  - `progress`；
  - `table`：≤ 8 列、≤ 50 行；
  - `actions`：按钮组；
  - `image`：只收桥接同源地址或 ≤ 64 KiB 的 `data:`。

  前 5 种和准备提给上游 `@dsh-std/ui` 的 Panel 块一致。
- **第二期**：加输入控件 slider / number / choice / toggle 和 `form`，以及公式（与 DS Bot `formula.js` 行为兼容，来源见 THIRD_PARTY_NOTICES.md）。与 `interactive-ui.md` 的二期共用一份实现。
- **绑定**：任何值位置都可以写 `{ "$": "data.a.b" }`，从这个视图的数据模型里取值；第二期再加 `{ "=": "公式" }`。取不到值就显示「—」，不报错。
- **不开放**：任意颜色（只能用语义色调 good / warn / bad / info / muted）、字体、尺寸、绝对定位、动画参数、外部图片地址。观感由 App 决定，这是保证插件界面也像 Apple / Claude App 的唯一办法。
- **容错**：沿用 `dsh-ui` 的宽松校验：
  - 不认识的组件画成一行灰色占位，其余照画；
  - 超出上限就截断，并标注截断；
  - 根节点坏了，整块降级成一行「插件界面有误」。

### 3.5 动作与效果（白名单）

| 效果 | 含义 | 约束 |
|---|---|---|
| `insert {text}` | 放进输入框 | 不自动发送，和 ui.json `send` 一样 |
| `command {name, args?}` | 在当前对话执行斜杠命令 | 必须由用户点按触发 |
| `open {page}` | 打开 App 页面或本插件的面板 | `feature_catalog.dart` 的 id，或 `panel:<id>` |
| `link {url}` | 外部浏览器打开 | 只收 https；每次弹确认，显示域名 |
| `toast {text}` | 一行提示 | ≤ 40 字，节流 |
| `copy {text}` | 复制到剪贴板 | — |
| `refresh` / `patch {data}` | 重拉视图 / 打数据补丁 | — |
| 第二期：`attach {asset}`、`play {asset}` | 附加图片（表情包）、播放音频（朗读） | 只认桥接同源资源 |

- invoke 返回的效果只在用户点按后 3 秒内执行，宿主不能主动推效果；数据补丁不受这个限制。
- 永远不开放这些能力：批准工具调用、改权限模式、手机操控、装卸插件、切主机、读 App 设置或凭据、无点按自动触发。
- 用户在插件视图里点 `options` / `confirm`，走 invoke，不像模型卡那样发 `[dsh-ui reply]` 消息。

### 3.6 传输与主机覆盖

| 主机 | `tool.card`（meta） | 清单 / 动作 / 面板（桥接） | 网页岛 |
|---|---|---|---|
| 本机引擎 | ✅ | ✅ 桥接随运行时安装 | ✅ 守卫生效后 |
| SSH 主机 | ✅ | 装了桥接才有：用户确认后经 SSH 拷贝，或从 npm 安装（v1 不发布到 npm，见 §7.1） | ✅ |
| 中转主机 | ✅（随对话记录走，待实测） | ❌ ds-harness-remote 的白名单不放行 `/dsh-go/*` | ❌ |

- 所有 `/dsh-go/*` 路由沿用路由守卫（`routeGuard` 实测，没有凭据一律 401）。
- 流：一台主机一条 WebSocket（`registerUpgrade`，桥接已经包过），按 `{pkg, id, scope}` 多路复用。App 进后台 60 秒后断开，回到前台重连并补拉一次。
- 清单按 `bootRev` 和插件启停缓存。连上主机拉一次，插件启停时再拉一次。消息级的内容（工具卡、回合尾注）永远不按行发请求。

### 3.7 安全与审核

| 风险 | 措施 |
|---|---|
| 执行外来代码 | 不执行。App 只解析有上限的 JSON |
| 仿冒系统界面（「点确认即授权」） | 插件内容一律套署名外框：面板标题带插件名，菜单按插件分组，状态条带插件图标。没有审批卡样式的组件；效果白名单里没有任何授权类动作 |
| 未经点按的副作用 | 效果只在点按后的 3 秒窗口内执行；`insert` 不自动发送；`link` 每次确认 |
| 隐私 | 默认只发作用域 id。草稿和剪贴板要声明，并且只在点按时附带。图片只认同源地址，没有追踪像素。插件在宿主上本来就能读对话，这一点和网页插件同权，不新增暴露 |
| 资源耗尽 | 大小、节点、频率都有上限（§3.3）；超限截断；连续违规的插件在本次运行里降级成「在网页版打开」 |
| 恶意或破损的主机 | 和 `dsh-ui` 同一个解析器，模糊测试覆盖 |
| 审核 | 不设中心审核：插件是用户自己装在自己主机上的，本来就有宿主全权。插件广场给声明了 `dshGo` 的包标「手机原生」，社区精选由项目维护的 `community.json` 收录 |
| 用户控制 | 设置 › 插件 › 某插件：逐插槽开关。ui.json `plugins.seats` 可以隐藏或改呈现方式 |

### 3.8 版本兼容

- `dshGo.v` 是主版本号。App 拉清单时附上能力声明 `caps {protocol, components[], surfaces[]}`，桥接把它透传给 `view(scope, caps)`，插件可以据此降级。
- 不认识的组件 → 占位行；不认识的 surface → 忽略；插件声明的 `minApp` 高于当前 App → 这个插件的原生部分不显示，退回网页岛。
- 问题提示沿用 ui.json 的做法：插件详情页安静显示一行，例如「原生界面 · 2 项有误」，点开看带路径的错误。不弹窗。
- 工具卡写进对话记录，旧记录要能一直画：`dsh-go/view` 只增不删字段，渲染器对老格式永久兼容。
- 和上游的关系：把这套格式整理成 `@dsh-std/ui` 的 Panel surface 提案。官方定稿后换坐标，渲染器不动。

## 4. 最该补的 5 个插槽

| 排名 | 插槽 | 理由 | 期 | 粗估 |
|---|---|---|---|---|
| 1 | `tool.card` | 插件工具今天只显示原始 JSON；消息级，网页岛补不了；不需要桥接，全主机可用，成本最低 | 0 | 2–3 人日 |
| 2 | `panel`（原生） | 适配了的插件不再吃一个约 200 MB 的岛；对话详情页签和全部功能两个已接线的座位直接受益 | 1 | 4–5 人日（含新增 6 种块） |
| 3 | `composer.actions` | 抽样里聊天页用得最多的位置；和 ui.json 胶囊共用同一行 | 1 | 2 人日（另依赖 ui.json 胶囊行先接通） |
| 4 | `message.actions` | 朗读、翻译、改写；消息级，网页岛补不了 | 1 | 1–2 人日 |
| 5 | `composer.strip`（第二期加 `turn.note`） | 用量、余额、上下文压力这类「一眼看到」的信息 | 1 / 2 | 1 + 2 人日 |

再往后：`header.actions`（放「更多」菜单）、`session.menu`、`notify`、`pets`。这四个都在第二期。

## 5. 分期与工作量

| 期 | 内容 | 粗估 | 依赖 | 验收 |
|---|---|---|---|---|
| **0** | App 读 `meta["dsh-go/view"]`，用 `dsh_ui` 画在工具行里（宽松解析、8 KiB 上限、折叠行摘要）；作者文档第一篇「不写 App 代码也能原生显示的东西」（命令、设置 schema、工具摘要规则、技能、`dsh-ui` 围栏、工具 meta 视图）；一个示例工具 | 3–4 | 无 | 本机、SSH、中转三种主机上，同一次工具调用都显示原生卡；重进对话后历史卡还在；网页版显示官方通用卡，不报错 |
| **1** | 桥接：读清单、`ctx.dshGo` 服务、4 条路由、流、invoke 校验（3–4）。`dsh_client`：清单和流的接口（1–2）。App：贡献状态、动作分派与效果白名单、署名外框、逐插件开关（3–4）。插槽：`composer.actions`、`message.actions`、`composer.strip`，以及 `panel` 接进对话详情页签和全部功能（4–5）。新增 6 种块（2–3）。SDK、校验器、文档、2 个示例（3） | 15–19 | 第 0 期；`composer.actions` 依赖 ui.json 胶囊行先接通 | 两个示例插件在本机引擎上原生显示，点按生效；本机冷启动 300 ms 内拿到清单；没有插件时界面零变化；深浅色和字号跟随；胶囊和面板做对称测量测试 |
| **2** | `tool.card` 上的 invoke 按钮；输入控件、局部状态、公式（与 dsh-ui 二期合做，4–6）；`turn.note`（2）；`header.actions` + `session.menu`（1–2）；`notify`（1–2）；`pets` 宠物包（2–3）；桥接浏览器半侧的 React 渲染器，同一份声明在 DSH 网页版也显示（4–6）；`dsh-go-plugin` 技能（1） | 16–22 | 第一期 | 用量插件的回合尾注滚动无掉帧；同一个插件在网页版和 App 两边显示一致 |
| **3** | 向上游提 Panel surface 提案；dsh-TUI 渲染；中转主机支持（要 ds-harness-remote 放行，或等 std 落地）；`attach` / `play` 效果 | 另估 | 上游 | — |

接缝规格里没做的两项：
- 聊天页面板岛（2–3 人日）：保留，给没有原生适配的网页插件用。排在第一期之后，避免同一行胶囊有两种实现。
- 浮层岛（当时估 3–5 人日）：原建议降级为「不做」，已由 2026-11-11 的受限 App 内浮层方案取代，见开头修订；不是新增原生宠物协议。

## 6. 插件作者需要什么

| 件 | 内容 |
|---|---|
| `@dsh-go/plugin-kit`（npm，TS） | 清单和视图的类型定义；组件构造函数（`metric(...)`、`chart(...)`）；`check` 命令：零依赖，与 App 同源的 JSON Schema，输出和 App 一样的带路径错误，沿用 ui.json `check.mjs` 的做法；`caps` 判断工具函数 |
| 文档（中文，另附英文） | ① 快速开始：给已有插件加一个工具卡，5 分钟；② 插槽参考（§3.3 一表）；③ 组件目录：每个组件一张浅色、深色截图 + 上限；④ 动作与效果；⑤ 主机覆盖与降级（§3.6）；⑥ 设计规则：不能自定义什么、为什么；⑦ 兼容与版本；⑧ 自查清单（署名、上限、不收集密钥） |
| 示例插件（开源，MIT） | `dsh-go-example-usage`：状态条 + 面板 + 推数据；`dsh-go-example-quick`：胶囊 + 消息操作 + invoke；`dsh-go-example-weather`：只有工具卡，第 0 期 |
| 调试 | App 插件详情页的「原生界面」一行：显示问题列表、最近一次视图大小、invoke 耗时。第二期的网页版渲染器兼作浏览器里的预览 |
| 技能 `dsh-go-plugin` | 和 `dsh-go-ui` 同样的分发方式：教用户自己的 agent 写一个本地小插件，例如「在输入框加个按钮，把剪贴板译成英文」。写在 `$DSH_HOME` 下按路径加载，用 `check` 自查。声明式格式加上有界目录，正是 LLM 写得稳的形状 |

## 7. 风险与待决

| 风险 | 可能性 | 后果 | 对策 |
|---|---|---|---|
| 生态冷启动：没人专门给 dsh-go 写适配 | 高 | 协议空转 | 工具卡零成本（一个函数）；第二期起同一份声明在网页版也显示，变成「写一次两边用」；`dsh-go-plugin` 技能让用户的 agent 当作者；我们给 dsh-cost-meter、dsh-visualize 这类热门包提适配 PR（先征得作者同意） |
| 目录不够用，作者要的视觉做不出来 | 中 | 插件仍走网页岛 | 接受。收集需求再加组件；L4 明确不做 |
| 中转主机只有工具卡 | 确定 | 中转用户看不到面板和按钮 | 文档写明；向 ds-harness-remote 提放行 `/dsh-go/*`，或等 std |
| 协议公开后要长期兼容 | 确定 | 维护负担 | v1 保持小：16 种组件、10 个插槽；先给示例插件和受邀作者用，定型后再写进公开文档 |
| 官方 `@dsh-std/ui` 将来定了不同格式 | 中 | 要迁移 | 主动提案；渲染器和格式解耦，到时只换坐标 |
| 消息级内容拖慢列表 | 低 | 掉帧 | 工具卡来自记录、尾注来自批量订阅；解析结果按内容缓存（沿用 `dsh-ui` 的 LRU） |

当时待定的（结果见 §7.1）：

1. 第一期是否压缩成「第 0 期 + `panel`」，先只验证面板？省约 5 人日，但聊天页还是没有插件位置。
2. `composer.actions` 的 `insert` 要不要允许「直接发送」（逐插件由用户开启）？默认不允许，和 ui.json 保持一致。
3. 浮层岛是否从计划里拿掉（§5 末）。
4. 桥接要不要发布到 npm，供 SSH 主机安装。

## 附录：外部现状（2026-10-25 查）

| 项 | 事实 | 来源 |
|---|---|---|
| rfw | 2.0.0，flutter.dev 认证发布者，约 10-22 发布。迁到 `material_ui`，最低 Flutter 3.44 / Dart 3.12；上一版 1.1.4 约在 9 月中。README：最适合「由预制组件组成的界面」，不适合自定义绘制、拖放、页面转场；生产环境建议发二进制格式；兼容性尽力而为；远端库不能表达闭包，事件交给宿主处理。1.0.32 删掉了 wasm 示例 | pub.dev/packages/rfw（页面、changelog、versions）；github.com/flutter/packages `packages/rfw/README.md` |
| genui | 0.10.4，labs.flutter.dev，约 9 月底发布。实现 A2UI（`createSurface` / `updateComponents` / `updateDataModel`），目录由 App 定义，后端可以是任意流式服务 | pub.dev/packages/genui |
| QuickJS 绑定 | `flutter_js` 在 Android 上用的是 2021-03-27 版 QuickJS；`quickjs_engine` 0.1.2（QuickJS-NG 分支）、`flutter_qjs_next` 1.5.1、`flutter_fjs` 0.1.5 都是社区单作者维护 | pub.dev 各包页面 |
| Raycast | 扩展用 TS / React / Node 写，自定义 reconciler 转成渲染树，由宿主画成原生界面，不经 HTML | developers.raycast.com/faq |
| DSH 工具展示元数据 | `output.presentationMeta(args, value)`：可重放的展示元数据，持久化在 `tool/result.meta`，模型看不到 | 本机 `@deepseek-ai/dsh-tools` 0.2.1-rc.2 `lib/types/schema.d.ts:191`、`index.d.ts:197-204` |
| DSH 插件会话记录 | `appendPluginRecord` 只限官方实验包，第三方不得调用，所以回合尾注不能借会话日志，只能走桥接 | `@deepseek-ai/dsh-session` README「写入实验性插件记录」 |

### 7.1 决定（2026-10-25）

| # | 结果 |
|---|---|
| 1 | 不压缩：第 0 期 + 完整第一期（四个插槽 + 原生面板）一起做 |
| 2 | `insert` 一律不自动发送，v1 不提供「直接发送」开关 |
| 3 | 当时决定浮层岛从计划里拿掉；2026-11-11 已被本文开头的受限 App 内浮层修订取代 |
| 4 | 不发布到 npm。桥接随本机运行时安装；SDK 和示例插件放在仓库 `sdk/`、`examples/plugins/` 里；SSH 主机安装桥接放到第二期 |
