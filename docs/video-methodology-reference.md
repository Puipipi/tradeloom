# 视频方法参考：分层工作台与持久上下文

> 方法总结已按时间顺序核对覆盖全片范围的截图，并通读用户提供的全部字幕。截图是覆盖全片时间范围的取样，不是逐帧或连续观看；字幕是自动转写，源代码和视频中软件行为未独立核实。

## 来源与证据边界

- 视频：[BV15mnJ6YELj](https://www.bilibili.com/video/BV15mnJ6YELj)，浏览器报告时长 740 秒（12:20）。用户提供字幕文件 `<LOCAL_TASK_BRIEF_ROOT>\7e5663e5-728c-4bc9-a6a4-170867e44018\已粘贴的文本.txt` 共 346 段，字幕从 00:00.1 到 12:01.5；片尾 12:08、12:17 的观察来自画面，不在字幕中。主控按时间顺序抽看覆盖全片范围的画面；这不是逐帧或连续音视频观看。以下按证据类型注明字幕与截图，不把视觉观察伪装成字幕引文。
- 字幕是自动转写，部分术语显然有误：例如反复把“对话”识别成“绘画”；`DPCCANNAS`、`DBC Connect`、`SKILLDMD`、`英贝面板`等不能据此确认真实产品/技术名称。下文只引用可辨认的方法，不按这些词推断依赖。
- 画面观察（非字幕证据）：00:09 开场工作台和多场景；01:07 彩色场景图；02:37 显示 47 份文档及索引先读少量的示意；03:06 四块工作区（代码资源、工作台、画布、体检）；03:34 身份/当前上下文；03:50 `AGENTS` 开场协议框；04:35 三条成本/停止规则图；05:05 “会话档案.md”与会话切换/交接说明；05:41 “场景之眼”说明 Agent 需要知道当前窗口、面板和选中对象；06:08 协作任务及回执；07:05 多级索引；07:31 共同记忆/共同宪法；08:07 场景模板和目录骨架；08:38 记忆 Markdown、SKILL 与 UI JSON 作为可迁移文件；09:06 个人资料分层案例；10:37–10:51 每周体检示意；12:08 字幕外 OCR 派单及断点续做；12:17 画面结语“规矩改成机制才是真的智能体”。截图观察证明画面呈现了这些结构，不证明其源码、权限或运行效果。

## 视频的方法与流程

1. 一个项目对应一个边界清楚的场景，项目资料与 Agent 身份有持久定位。字幕 01:31–02:05 直接提出“一个项目⇒一个场景”和项目记忆 Markdown；画面 03:34–03:50 展示身份、当前上下文和 `AGENTS` 开场协议框。截图展示的是作者方案，不能据此假设 DSH 自动按场景注入记忆。
2. 给长期资料设边界、索引和归档，而不是每轮灌入全部文件。字幕 02:01–02:21 提出作者自己的 25KB 项目文件、4KB 交接段，并说旧内容归档；画面 02:09 展示同一限制，02:37 用 47 份文档示意只先读索引/少量相关项。25KB/4KB 是作者参数，不是 TradeLoom 固定上限。
3. 把会话记录、索引与交接分开处理。画面 05:05 展示“会话档案.md”记录 session ID 与原始文件引用；原始会话文件为 `session.v4.jsonl.zstd`，只读保留，可只读导出或解压副本；切换会话时更新 ID 与当前交接。可复用原则是保留原记录、让索引定位、用有界交接续接；我们不读取或迁移用户个人 DSH 会话。
4. 把当前 UI 状态作为 Agent 可见上下文的一部分。画面 05:41 明确指出，仅有记忆和身份还不够，Agent 还需知道当前窗口、面板和选中对象，才能回答“改哪里”。画面 03:06 展示代码资源/工作台/画布/体检四块，说明上下文可能包含面板类别和对象定位；视频没有给出实际 API/协议，不能推断其可靠性实现。
5. 把协作与续做落成检查点、状态和回执，而非只写长提示词。画面 06:08 展示协作任务回执；07:31 展示多人避免覆盖所需的共同记忆/共同宪法；12:08 的画面（字幕外）展示 OCR 派单：引用前一天的收工记录和 `_pdf_ocr_run.json`，只续做剩余 120 件，限定批次/截止时间并要求回执；12:17 总结“规矩改成机制”。这支持“可恢复的任务状态 + 明确范围/截止 + 幂等回执”的设计方向，但 OCR 展示不是 TradeLoom 需求，也没有因此实现新功能。
6. 按需加载技能与层级索引，让目录短、正文延迟读取。字幕 06:36–07:13 讲从踩坑记录更新 SKILL、目录名/一句简介常驻、用到时再读正文；画面 07:05 展示技能索引→场景/窗口索引→工作区类别→具体资料的层级。字幕 08:07 讲模板化骨架，08:38 画面展示记忆 Markdown、SKILL、UI JSON 是作者认为可迁移的文件。
7. 把成本/工具规则表达成可执行门槛。字幕 04:28–05:00 说插件默认关闭，并提及主机负载>90%、单条回执不超过200字、余额报错后停止；画面 04:35 展示三规矩图。能借鉴的是明确开关、范围与失败停手；90% 和 200 字等作者参数不直接成为产品策略。

## 与当前项目的对应和取舍

- 当前主架构是官方 DSH Electron 桌面软件/聊天入口，Django + PostgreSQL 业务层继续保留；已接入 packaged bootstrap 和相对资源清单的实现见 [桌面安装启动契约](desktop-bootstrap.md)、[`bootstrap-entry.mjs`](../apps/tradeloom-launcher/bootstrap-entry.mjs)、[`installed-bootstrap.mjs`](../apps/tradeloom-launcher/installed-bootstrap.mjs) 与 [架构说明](architecture.md)。p5 安装器已成功生成并安装；首次启动和 GUI 仍需验收。
- 用户已明确的首轮产品方向是 Windows DSH 桌面主入口、顶部业务导航、左侧六个通用 Agent、中心调度/用户信息区、原生聊天和手机同网访问；当前围绕“官方外壳 + TradeLoom 业务模块 + 独立数据资源”落地，不自建替代 DSH 的整屏 Web 聊天壳。上述首轮链路是验收目标，不能据结构意图宣称已全部实现。
- 可复用的最小结构是：Agent/场景标识与其配置/记忆分离；配置和资源有版本及摘要；启动或选中时显式解析；按需读取；用户数据留在专属数据根。当前隔离数据根、资源 manifest/hash 和官方 `initProfile` 启动路径提供了部分基础，但没有实现项目记忆索引或读取策略。
- 画面要求 Agent 获得当前窗口、面板、选中对象等 UI 上下文；当前产品尚无这个上下文接口，必须明确记为待做/待产品化，不能宣称现有 Host 或 Agent 工具已提供。
- 业务事实以 Django/PostgreSQL 中的产品、工作流和审核记录为权威；Agent 通过受控 Django API/tool 写入，不把共同 Markdown 当业务数据库，也不让多个 Agent 任意覆盖同一事实文件。现有 `business-tools.js` 的 dispatch 会先读服务端 `dispatch_target` 并使用服务端 idempotency key；[agent-development.md](agent-development.md#保存计划的单子任务-dispatch) 记录保存计划、依赖门禁、dispatch 与 resume 能力。这些仅证明当前受控业务工作流实现，不等于通用暂停/续做/OCR 功能。
- 不复制视频中的九场景、跨场景自治、自我进化技能、自动插件/MCP、自动清理或“赛博自己”愿景，也不创建虚构业务提示词/团队分工。用户已取消 AgentArts；真实 provider 调用和凭据不纳入当前闭环。字幕 08:49–10:35 描述作者导入个人文件、社交媒体和聊天记录；这与本项目边界相反，不读取或迁移个人 DSH、个人 home、会话或账号资料。

## 当前阶段采用的方法

- 维持“官方桌面运行时 / 产品业务层 / 用户数据”三层边界，新增能力先通过现有 DSH 合同接入。
- DSH 负责会话、工具和运行能力，业务继续由独立 TradeLoom bundle 与 Django/PostgreSQL 扩展。六个通用 Agent 先解决可识别、可进入原生聊天、状态/资源互不混淆。
- 可把场景映射为工作空间、角色映射为 Agent；每个角色定义只写职责、输入输出、工具边界和交接格式，具体业务事实等访谈确认，不编造岗位提示词。
- 若后续需要跨会话记忆，先用短索引、按需读取、归档和显式交接；25KB/4KB只是视频作者参数，不成为我们的固定阈值。
- 沿用现有的工具权限、委派次数、步数/深度/令牌等预算与失败停手规则；视频中的主机负载阈值可作为后续评估项，目前不声称已有该调度机制。不新增主机自动化、金融操作或个人资料采集。
- 复盘先形成候选记录，经审核后再改角色或规则；不启用自动改写“宪法”或权限。用真实任务实现暂停/续接时，至少要保留稳定任务标识、已完成/待处理项、输入范围、停止条件和回执/幂等键；当前 API 的幂等 dispatch 与已保存步骤恢复是局部先例，不等于通用检查点系统。模型/API 在本轮未调用。

## 当前最小闭环状态与续接

- 当前目标闭环（不含新增业务）：启动独立 Windows 桌面包 → 看见官方 DSH 窗口与顶部业务导航 → 左侧能选择六个通用 Agent → 中央调度/用户信息与原生聊天可用 → 手机可在同一 LAN 通过授权连接该实例。
- 已完成（版本边界）：p5/p7/p8 的构建、资源与安装记录保留为各自版本历史；p8 首启曾显示 welcome/account.state Web RPC failure，不代表本地 source-mode 当前仍失败。2026-10-20 本地 source-mode Electron 已实际打开并操作，最终窗口标题“织贸助手”；记录含五业务入口、两场景、六 Agent、授权链接浏览器跳转。隔离 Django/PostgreSQL 的任务与文件仍标记 `local_mock/simulated_rules`，且该演示站已停止。该本地运行不更新 p8 安装版。p6 `runtime:smoke` 临时安装 pnpm 插件时 `package.json` 原子 rename 收到 EPERM；p7 未复现，根因未确认。详见[工作报告八字段状态](work-report.md)及项目外 GUI evidence JSON。
- 当前源码与运行证据：startup/branding 11-patch 在 candidate 7 官方 9 项 gate 及 host/client TypeScript 检查已通过；场景定向测试 28 pass、3 skip；shell/launcher 测试 124 pass、4 skip、exit 0。`pnpm run build:artifacts` 曾以 `DSH_CLIENT_TITLE=织贸助手` 本地成功，未 stage/package/upload。first-party Windows computer-use 实际操作了 source-mode 工作台：五个业务路由、两场景切换、面板刷新/展开/返回、六个 Agent 与各自会话恢复均有记录；最终快照连续 9.2 分钟 health 200、PostgreSQL ready、无新 crash，并有已核对的本地开发快捷方式。截图和完整范围摘要见 `<LOCAL_EVIDENCE_ROOT>\desktop-package-contract\local-workbench-gui-acceptance-20261020.json`。场景里的对话仍通过按钮进入原生全屏会话，顶部场景标签可返回；没有并排嵌入指定角色会话的 DSH API。
- 未完成：当前安装 p8 未被这轮源码验证更新；需另行打包/安装才能证明安装版含有当前场景与标题修正。API 设置只观察到第三方目录、自定义 API 表单和缺项反馈，未保存 Key 或调用模型；真实 provider/资料工具/模型委派及结构化提案 handoff 流程未验。授权链接在同 profile 浏览器成功打开工作台，实体手机和窄视口未测；关窗退出行为也未验。场景工作台不是并排原生聊天；不实现视频中的记忆分层、自动演化或 OCR 续跑功能。Agent 保持通用，不编造企业事实或分工。
- 续接建议先读：本文件；[桌面安装启动契约](desktop-bootstrap.md)；[工作报告最新状态](work-report.md)；[`client.js`](../packages/tradeloom-shell/client.js)、[`client.scenes.js`](../packages/tradeloom-shell/client.scenes.js)、[`scenes.json`](../packages/tradeloom-shell/scenes.json)、[`host.js`](../packages/tradeloom-shell/host.js)、[`business-tools.js`](../packages/tradeloom-shell/business-tools.js)；安装启动边界见 [`bootstrap-entry.mjs`](../apps/tradeloom-launcher/bootstrap-entry.mjs) 与 [`installed-bootstrap.mjs`](../apps/tradeloom-launcher/installed-bootstrap.mjs)。


视频中的方法是参考材料，不是 TradeLoom 必须逐项实现的产品规格。

## 全片时间分段核对表

表中“字幕”仅概括自动转写主张；“画面”来自按时间顺序覆盖全片范围的截图观察。截图不代表连续播放/逐帧审查，产品实现也未据此得到验证。

| 时间段 | 字幕主张 | 画面观察 | 对当前项目的参考 |
|---|---|---|---|
| 00:00–02:00 | 00:30 聊天记忆边界；01:31 项目对应场景；01:37 项目记忆 MD；01:55 文件膨胀 | 00:09 工作台/多场景；01:07 彩色场景图 | 场景和项目上下文需显式映射，避免把通用会话当项目记忆 |
| 02:00–04:00 | 02:01 25KB/4KB 作者限制；02:27 索引；03:18 身份卡；03:38 身份认领 | 02:09 限额/归档；02:37 47 文档索引示意；03:06 四块工作区；03:34 身份与上下文；03:50 `AGENTS` 协议框 | 只借鉴摘要、索引、归档和启动协议；数字不是产品阈值 |
| 04:00–06:00 | 04:01 多面板；04:28 开关与预算规矩；05:40 场景界面绑定 | 04:00 文件/预览组合；04:35 三规矩图；05:05 会话档案；05:41 窗口/面板/选中对象接口 | UI 上下文接口尚未实现；个人会话档案不迁入本产品 |
| 06:00–08:00 | 06:01 场景协作；06:36 踩坑沉淀技能；07:05 技能索引；07:31 共同记忆 | 06:08 任务回执；07:05 多级索引；07:31 共同记忆/共同宪法 | 用受控状态和 API 共享业务事实，避免多个 Agent 直接改同一文件 |
| 08:00–10:00 | 08:01 场景模板化；08:09 插件/MCP；08:49 自我复盘；09:06 私人助手愿景 | 08:07 目录骨架；08:38 记忆/SKILL/UI JSON 文件；09:06 个人资料分层案例 | 仅参考模板、可迁移配置和资料分层；不采集个人数据、不开放自治权限 |
| 10:00–12:20 | 10:04 模型个性/规则；10:35 后体检；11:07 子助手；11:37 后个人化结语；字幕止于约12:02 | 10:37–10:51 每周体检示意；11:07 子助手；12:08 OCR 检查点/剩余120件/批次截止与回执；12:17 规矩变机制 | 有边界的检查点/回执值得评估；不据画面声称已有通用暂停续做或 OCR 流程 |

## 开源工作台参考核对（2026-10-20）

- 来源：[mashanglinyu/luanyujia-workbench](https://github.com/mashanglinyu/luanyujia-workbench)，只读副本位于 `<LOCAL_EVIDENCE_ROOT>\desktop-package-contract\reference-luanyujia-workbench-20261020`，HEAD `49f232cccf711fd412b46971beec8e88f1bb4358`，许可证 MIT。该仓库共 20 份 Markdown、1 个 JavaScript、2 个 JSON 和 5 张 PNG；README 与 `新手必读.md` 明确这是方法与纯壳模板，不是安装后即用的软件。
- 实际可复用代码只有 `模板/面板-HelloWorld.js` 的小型 renderer 例子，接收 `body/meta/head` 并返回可选清理函数；两个场景 JSON、定位卡和项目信息 Markdown 都是带占位值的模板。三字段会话绑定、每板独立 partition、网页 DOM 注入/跟随和记忆分层是文档描述，不是仓库提供的会话运行时或可直接移植的库。MCP 章节也标记为仍需逐站调试。
- 与本项目的会话接口核对基于固定上游只读参考 `workspace/research/references/deepseek-harness`：`packages/client/ui-workspace/src/client/navigation.ts` 的 `uiWorkspace.openSession(target)` 替换单一 `mainView` reference；`packages/client/ui-layout/src/client/service.ts` 通过 `selectPanel(null)` 返回全局 Conversation。`packages/client/ui-layout/src/client/index.ts` 将 `main` 定义为 root scope 的 keyed slot。`packages/client/ui-conversation/src/client/contract/slots.ts` 和 `packages/client/ui-conversation/src/client/apply.ts` 提供原生 `conversation.content` Factory，含 `variant: 'embedded'`，但 `renderFactorySlot()` 按调用位置继承 scope，且不接受 Session identity。因而现有业务 shell 可以安全地从场景按钮调用 `openSession(roleSessionId)`，但这会离开场景网格；从 root 级场景面板渲染原生聊天工厂时，不能同时绑定到一个独立指定的 role Session。
- 最小采用边界：保留 DSH 的六个 Agent、角色工作区和原生会话作为身份/隔离依据；场景配置只表达用户可选的场景 ID、可见业务面板布局和它关联的既有 Agent/Session，不复制参考仓库对网页内部 storage 的直接写入、DOM 点击或多 WebView 登录态技巧。场景布局可由当前 DSH 的 `main` slot 做本地 scene grid，业务 Django 页面仍在其格内；要让其中一格嵌入另一个指定 Session 的原生对话，需先由 DSH 提供明确的 session-bound embedded Conversation host/reference API，再消费现有 `conversation.content` Factory。不能用伪聊天组件或 DOM 注入补这个缺口。
- 桌面面板网格不等于手机布局。作者仓库未提供移动端适配实现；TradeLoom 继续通过现有授权 LAN 页面独立满足同 Wi-Fi 访问，实体手机验收仍单独记录。产品侧本地开发可先在隔离 source-mode 中修改 shell bundle 并同步到本地运行副本；Django 模板/静态脚本走现有本地页面加载路径。此参考不授权构建、上传或发布。
