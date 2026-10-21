# 统一工作台与 ERPNext 接入设计

> 状态：已审阅，首批实现中；本文件定义长期目标与本地首批边界，不代表后续 ERPNext 接入已实现。

## 目标与原则

织贸助手继续以现有 DSH 原生会话、provider、工具执行和 Django/PostgreSQL 业务系统为基础，形成一个可在本机使用的统一工作台。场景和面板配置决定工作区布局；同一个原生会话及其模型选择能在工作台中使用，不另造聊天协议或第二套 provider 状态。Django 负责工作流、人工审核、商品资料整理版本及交付记录；ERPNext 负责其官方 Item、客户、供应商、库存与业务单据等 ERP 记录。跨系统只保存来源系统与记录引用，不把两边的数据权威混为一体。

实现顺序从可本地运行、可热更新的插件与配置开始。安装器、发布或上传不是此阶段的前置条件。已有演示数据继续明确标注演示/模拟；LLM 提案仍须由用户在现有 Django 确认界面显式预览、确认。用户可选后续接入的外部服务，不作为当前 UI 骨架的前置条件。

## 七项目标

1. **统一桌面导航。** 在 DSH 原生窗口内保留左侧六个通用 Agent 和现有五个业务入口；顶层模型入口读取当前原生会话实际模型目录，按 provider/model 分组展示可访问图标（无图标时用名称首字，不伪造标识），并保留原生设置入口；下层用紧凑图标导航业务页和场景，hover/focus 时展开可读标签。原有 five-route 地址 `/home`、`/products`、`/agent-center`、`/artifacts`、`/runs` 不改变，常规点击切换相应配置场景并聚焦业务面板，保持正式工作台与原生聊天可见。Agent 点击切换到对应既有 role session 并绑定工作台聊天，不改角色/会话数据。模型身份由原生 session/provider 选择决定，Agent 身份由既有 preset/session 映射决定，两者不可混为一项。
2. **配置驱动场景与可停靠面板。** 场景 JSON 声明场景、角色、panel allowlist 与默认面板顺序；桌面面板区使用 Dockview React core 支持分割、标签分组、拖动停靠与调整大小，不再以固定 4×4 网格约束用户。用户布局由 Dockview `toJSON()/fromJSON()` 按场景独立保存；现有 v1 `col`/`row`/`w`/`h` 与 `visible` 状态只作为迁移输入和可恢复快照，不直接覆盖或丢弃。可确定映射的旧布局转换为新布局；遇到重叠或无法安全映射的布局时，以配置顺序生成确定性默认停靠布局，并保留原 v1 快照供恢复。窄屏根据工作区容器 `ResizeObserver` 切换为单面板选择视图，不改写桌面停靠树；宽屏恢复原桌面布局。面板刷新、关闭、恢复及每场景独立布局继续受注册表和产品状态校验约束。
3. **同场景原生聊天。** 复用 DSH 原生 `conversation.content` 工厂与 composer、消息列表、模型选择器，不复制聊天 UI。产品场景以显式 `SessionProvider` 绑定 `/tradeloom/session` 返回的 role session，并通过 `sessions.retain` 管理引用生命周期；切换场景只挂载所选场景的一个原生聊天面板，释放 UI 引用但不删除原生会话或历史。左侧角色入口选中对应 preset/既有 role session，并绑定该 session 的网格聊天；场景导航通过 `layout.selectPanel('scene-workbench')` 返回/进入正式网格，不通过选择 conversation 主面板把网格替换为全屏聊天。
4. **布局和会话持久性。** 经 schema 校验的 Dockview 序列化布局、已关闭面板元数据及场景选择写入产品独立 apphome 状态；既有 v1 网格快照在迁移时保留，不把 layout state 写入 Django 业务表。角色到原生 session 的持久映射继续由现有 state store 和 `/tradeloom/session` 提供。Dockview 面板采用常驻 renderer，切换布局、标签、窄屏视图或场景不得重新创建 session、释放每角色保留引用、丢失 composer 草稿、业务表单状态或 iframe 页面状态；插件/工作台销毁时仍按既有生命周期释放引用。不覆盖原有 provider、凭据、workspace 或 conversation 内容。
5. **真实模型入口。** 顶部模型选择读取当前场景实际 session 的 `ctx.modelDirectories.directoryFor(sessionId)`，以该目录的 `load()`、订阅快照和 `select(selection)` 显示并选择真实 provider/model。复用原生 settings 中的 API/provider 配置表单和原生会话选择持久化；不以静态名称或图标冒充已配置模型，不新建第二份 provider 列表。不能解析当前 session 或目录失败时应展示明确不可用状态并保留原生 settings 入口。
6. **保留业务执行边界。** Django/PostgreSQL 是 TradeLoom 内商品资料修订、任务/子任务、workflow、人工审核、交付物/版本与事件状态的业务权威；ERPNext 是其官方 ERP DocType 记录（如 Item、Customer、Supplier、库存与单据）的权威来源。同步前后都保留来源系统和源记录 ID，不把 ERPNext 数据复制后称为 Django 权威，也不绕过两侧各自权限。现有 proposal handoff、五个业务路由、六个通用 preset、真实工具权限、幂等和人工审核门禁须保持兼容。模型提出结构化意图不等于事实确认或业务执行；业务执行仍由现有 `local_mock`/`simulated_rules` 或明确接通的运行时标注，用户显式确认后才继续。
7. **独立 ERPNext 入口。** 工作台显示一个独立 ERPNext 服务入口/状态面板；服务未部署或未配置时明确显示“未连接”，不显示虚构公司数据或成功状态。后续连接只面向官方 ERPNext 服务 API，单独配置其 base URL/鉴权并按官方 DocType/字段核对；不把 ERPNext 表映射成新的 Django 事实源，不接管现有 PostgreSQL。ERPNext 服务可与工作台并行部署。

## 长期目标分批

首批实现本地工作台框架（目标 1–3）和 ERPNext 未连接入口；不把下列后续工作塞入首批 UI 任务，也不将它们写成已经落地。工作台场景至少包含主业务、辅助资料/任务、参考资料、原生聊天四格；五个既有业务路由作为已登记业务面板在场景网格内切换，不丢失原生会话。

| 后续批次 | 目标与验收边界 |
| --- | --- |
 | ERPNext 服务与七类 DocType | 部署独立官方 ERPNext；共用一个受限 adapter 对 `Item`、`Customer`、`Supplier`、`Warehouse`、`Bin`、`Sales Order`、`Purchase Order` 做真实读取，并保留来源引用 `{system: 'erpnext', instance_id, doctype, name, modified}`。七类是技术适配对象，不构成企业规则；字段映射须基于官方源码逐字段核实，不在此规格臆写。 |
 | 受控写入与人工门禁 | 由 Django workflow 管理草稿、回读差异、来源/版本审计和人工确认；后续写入对象为单独 `Quotation` 适配。普通读取 adapter 不暴露 `submit`/`cancel`；草稿更新前检查官方状态 `docstatus=0`，调用前需要显式人工确认，写入后从 ERPNext 回读并记录事件，不把请求成功当作持久化成功。Django 保存 ERP 引用与协作记录，不复制 ERP 主数据作为本地权威。 |
| 工具与权限 | 每个 Agent 只拿到职责所需、按 DocType/操作限定的工具；服务端校验引用、权限与人工审批状态。模型不能直接写库、绕过 Django 门禁或扩展任意 API URL。 |
| 统一协作契约 | 为中心、各通用 Agent、Django workflow 和 ERP adapter 共用结构化协作 DTO，包含目标/来源引用/状态/待澄清/结果引用；明确版本及兼容策略，不通过自由文本传递权威业务事实。 |
| Agent、模型与工具注册 | 复用现有 DSH preset、原生 provider/model directory 和 tool registry；以可审阅清单描述 Agent、模型和允许工具，保证会话角色与 per-session 模型选择独立。 |
| 生图与网页桥接扩展 | 仅预留协议和受控 adapter 边界；真实图片生成需单独供应商配置和审核，不能把聊天多模态输入说成生图。网页/反代只有兼容已批准的聊天协议时才可复用 provider；不能实现成任意 URL 代理或绕过来源验证。 |
| 模块目录与新增示例 | 为 UI panel、场景和可选集成提供模块索引及最小通用示例；示例只证明注册、权限、来源引用和人工门禁，不填企业事实、角色职责或默认业务规则。 |

## 现有实现与可复用接口

- 产品 shell 的入口和角色映射：`packages/tradeloom-shell/client.js:93-127,199-245,269-285`、`packages/tradeloom-shell/roles.js:1-25`。现有 client 已组合单一顶栏、六角色目录和五个业务 panel；role session 由 `packages/tradeloom-shell/host.js:48-72` 按产品 apphome 状态复用。
- 场景配置与 renderer：`packages/tradeloom-shell/scenes.json`、`packages/tradeloom-shell/client.scenes.js:7-45,47-73,85-118,124-202`。现在配置只有两场景和三种 panel（业务 iframe、占位、会话卡），布局偏好主要在内存，聊天卡仍用 `uiWorkspace.openSession` 切全屏原生会话；这不是本目标的内嵌聊天交付。
- apphome 状态：`packages/tradeloom-shell/state.js:10,60-120` 有 marker 验证、序列化事务和原子文件替换，可承载有界 UI 布局偏好；不需要新增业务数据库表。
- 原生布局：pinned candidate7 `packages/client/ui-layout/src/client/service.ts:18-36,57-78` 的 `ctx.layout.selectPanel(id|null)` 能切换中心 panel 而不改当前 session；`AppFrame.tsx:27-43,281-294` 从原生 slots 渲染顶部、侧栏和主内容。
- 可复用聊天 renderer：candidate7 `packages/client/ui-conversation/src/client/contract/slots.ts:301-315,528-550` 定义 session-scoped `conversation.content` Factory 及 `variant: 'embedded'`；`packages/client/ui-conversation/src/client/apply.ts:336-349,560-572` 注册它。`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:102-117,120-168,176-201` 已演示 `sessions.retain`、`SessionProvider` 和 `renderFactorySlot('conversation.content', { variant: 'embedded', ... })` 的生命周期组合。优先照此公开契约实现，不新增上游 fork。
- 模型目录：candidate7 `packages/client/ui-model-selection/src/client/service.ts:36-89` 提供 session-bound `ctx.modelDirectories.directoryFor(sessionId)`；`directory.ts:77-105` 读取目录并经 `sessions.selectModel` 持久化选择。`ModelSelect.tsx` 是原生 composer seat 内部组件，不作为跨包私有导入；工作台顶部入口应消费公开 ModelDirectory，不复制 selection 状态。
- 上游 UI 参考：`workspace/previews/luanyujia-reference-20261020/REFERENCE-NOTES.md:1-16,27-47,69-84` 记录作者源码仓库、MIT 归属、模板范围及独立预览使用 Electron `WebContentsView` 的事实。原仓 `source/README.md:10-15,70-73,115-123` 将公开内容界定为方法与纯壳模板；`source/01-场景模式/布局与网格.md:8-27,31-45`、`source/01-场景模式/面板类型与注册.md:1-40`、`source/模板/场景-最小示例.json:1-14`、`source/模板/面板-HelloWorld.js:1-33` 是正式工作台采用布局/面板契约的依据。`source/02-会话定位与跟随/二-会话绑定三字段.md:13-20,71-124`、`四-防串台.md:8-26` 及 `六-记忆分三层.md:1-30` 是设计参考而非本仓已实现代码；不将作者未公开方法写成已实现能力。独立 preview 冻结不改；正式 UI 复用已认可视觉与契约并走 DSH 原生 API，不能把参考模型示例当真实 provider。
- ERPNext 已有官方源码只作核对依据：`workspace/runtime/tradeloom-harness/references/erpnext-20261021`（ERPNext v16.51.1，commit `5af6561f5aa48104559692fb4fd82f2580e8d338`）和 `frappe_docker-20261021`（commit `df2a3b72910634cf0e878b59eccf68a93736bf9d`）。部署准备为 `workspace/runtime/tradeloom-harness/local-dev/erpnext/SETUP.md` 与 `readiness.json`；当前 Docker/WSL 条件不满足，未运行服务。首批只做断开状态入口，不据此声称接口连通。
- 业务源材料：`docs/01-业务基线.md:95-110,196-219` 记录供应商/采购线索及待验证边界；`docs/02-客户访谈问题表.md:69-78,104-121` 是后续访谈问题。它们不为 ERPNext 的技术 DocType 映射赋予企业事实，也不解除显式审批要求。

## 桌面停靠布局实现约束（替换固定 4×4 目标）

- 已批准使用 Dockview React core `8.6.0`（MIT；React peer 范围兼容宿主 React 18），参考：[项目与许可证](https://github.com/dockview/dockview)、[React quickstart](https://dockview.dev/docs/overview/quickstart/?framework=react)、[panel renderer](https://dockview.dev/docs/core/panels/rendering)、[布局序列化](https://dockview.dev/docs/core/state/save/)。`renderer: 'always'` 用于保留隐藏/非活动面板中的原生聊天、草稿和 iframe DOM。
- 产品只新增一个由宿主 ModuleLoader factory 注册的独立 Dockview 资产及样式；Dockview 依赖可随资产打包，React/ReactDOM 必须通过宿主 `require` 获取并保持单一实例。阶段 1 必须用 pinned candidate7 的真实 ModuleLoader 和 renderer 验证解析、Factory 挂载及 React 身份；不接受裸浏览器 ESM、自造 loader mock、第二份 React、eval/CSP 放宽或改写宿主 loader 作为证明。
- Dockview 只替换场景工作区面板布局，顶部模型目录/场景导航与左侧角色导航固定。已有 `PANEL_REGISTRY`、业务 iframe、ERP 状态、原生 `SessionProvider`/`conversation.content` Factory 与每角色 retained session pool 继续作为面板内容来源；布局事件不得重建内容实例。iframe 拖动命中区要用真实 pinned renderer/UI 验证；不可从 iframe 内容区拖动时提供面板标题栏拖动手柄，不搬运 DOM。
- 新状态采用版本化、按 sceneId 隔离的 Dockview 布局；只允许登记的 panel component 与有界参数，保存前限制结构/尺寸/总字节，失败需可见且可重试。旧 v1 几何/visible 状态先只读迁移并附带不可变快照；无法无损映射（尤其重叠面板）时使用确定性默认排列并保留完整旧快照。屏幕变窄使用工作区容器尺寸，不修改桌面序列化树；恢复宽度后回到用户的桌面排列。

## 验收条件

- 原生主窗同时保留五业务导航和六角色目录；顶部模型菜单显示当前绑定 session 的实际目录项，并通过原生选择服务持久化；切换 Agent 后显示该 session 的实际模型选择。
- Dockview 桌面场景可通过实际鼠标操作完成分割、标签归组、停靠移动和大小调整；每个场景分别保存与恢复布局。重启、切场景、调整标签、折叠面板和窄屏往返均保留原生 chat composer 草稿、session、模型选择、业务表单与 iframe 状态。新增一个仅配置声明且 renderer 已注册的场景，不改 renderer 源码即可出现。旧 v1 网格正常迁移；遇到重叠布局时确定性回退并保留完整旧快照。
- 原生聊天必须真实显示既有 session 的原生消息列表和 composer；通过一次本地 scripted mock 的工具/模型验收可验证组件绑定与会话身份，但不能据此称任何厂商 API 已连通。业务确认仍走 Django UI 并要求人工操作。
- 容器窄于适配阈值时以单面板 tab/选择器访问所有已登记 panel；恢复桌面容器尺寸时原 Dockview 树和各面板状态不变，整页无横向溢出。真实手机同 Wi‑Fi 另列设备验收，不作为框架实现前置条件。
- ERPNext 未运行时只显示未连接；没有可配置官方服务时不伪造内容、登录成功或连接状态。

## 明确不做

- 不重写 Django、PostgreSQL、模型/provider 或原生聊天 renderer；不增加第二套 session/provider 状态或以 iframe/DOM 搬运原生会话。
- 不编造企业事实、角色职责细节、SKU 规则、报价、交期、ERPNext 业务记录；保留通用 Agent 名称和当前模拟标记。`docs/01-业务基线.md:95-110,201-219` 和 `docs/02-客户访谈问题表.md:69-75,108-121` 是供应商/生产/交付标准待验证的依据，不构成已确认业务规则。
- AgentArts 按用户后续指示豁免；本设计不把平台接入当验收条件。
- 不迁移/替换独立 reference preview，不访问或修改个人 DSH home/profile/session，不在本计划中打包、安装、上传或发布。
