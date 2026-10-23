# 织贸助手

华为 ICT 大赛 · 第十一届 · 创新赛 · 赛题 2 参赛项目

**新克隆前请先看：** 仓库包含 TradeLoom 产品源码，但不包含 pinned DSH runtime、PostgreSQL 实例、Python 运行环境、provider API 配置或既有演示数据。源码开发需先按[运行时准备说明](docs/upgrade-harness.md)取得受支持的外部 runtime，并准备 Python 与 PostgreSQL；安装依赖或初始化服务不是 clone 的自动步骤。

### 本轮本地源码候选

`codex/native-workflow-bridge` 分支当前源码检查点为 `c8b3cb5`。本地候选尚未合入或发布，且该分支当前未列在 `origin`；队友从共享 `main` 拉取不到这些候选功能。实现契约和源码验证范围见[商品资料应用契约](docs/plans/2026-10-24-intake-product-application-contract.md)、[原生工作流桥验证](docs/verification/2026-10-24-native-workflow-bridge.md)、[执行计划来源参考验证](docs/verification/2026-10-24-execution-plan-source-references.md)。记录中的合成验证不证明真实 Host、真实模型、GUI 或真实四文件导入已验收。

当前开发优先级是本地 source-mode。较早的本机启动记录涉及既有 candidate7/8 与已发布 UI bundle；不能据此说本轮 launcher/shell/UI 候选已经在运行中的应用里生效。普通 launcher 默认 runtime 仍为 `0.2.1-rc.2-tradeloom-desktop-2`；候选开发可显式指定已准备并带匹配 build receipt 的受管 runtime，示例见[快速开始](docs/quick-start.md)。source-mode 的既有模型/工作流边界及手机、安装版状态见下方说明与验证记录。

快速入口：[快速开始](docs/quick-start.md) · [Agent 开发与接入](docs/agent-development.md) · [验收矩阵](docs/acceptance-matrix.md) · [工作报告](docs/work-report.md) · [2026-10-23 本地工作台验收](docs/verification/2026-10-23-workbench-local-activation.md)

## 通用源码开发

启动前置条件：Windows、Node.js、专用 Python 环境（依赖见 `requirements-workbench.txt`）、PostgreSQL 17，以及按当前 patch lock/receipt 准备的 pinned DSH runtime。DSH 要求 Node `^22.19.0 || >=24.0.0` 和 pnpm `11.28.5`；本机隔离 Django 全量回归使用 Python 3.14.5，但 source launcher 不强制具体 Python 版本。runtime 位于仓库外；普通 PowerShell 包装脚本默认寻找 sibling `workspace/runtime/tradeloom-harness/releases/0.2.1-rc.2-tradeloom-desktop-2`。本机已验证的 candidate7 快捷方式不随仓库提供，也不能据此改写该默认候选。首次克隆、固定 runtime 准备和启动细节见[快速开始](docs/quick-start.md)及[运行时升级说明](docs/upgrade-harness.md)。

准备好默认 runtime、专用 Python 与 PostgreSQL 后，在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-postgres.ps1 -Port 55432
powershell -ExecutionPolicy Bypass -File .\scripts\launch-tradeloom.ps1 -Mode desktop -DataRoot '<新建的绝对数据目录>'
```

停止由该 launcher 管理的本地实例：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-tradeloom.ps1 -DataRoot '<同一绝对数据目录>'
```

`DataRoot` 首次必须是空目录，启动器会创建所有权标记；后续启动必须继续使用同一目录。启动脚本会从当前活动物理网卡中选择 LAN 地址，多网卡时要求选择。Django 绑定 loopback `3090`，桌面 Host 使用所选私网地址的 `3088`，PostgreSQL 绑定 loopback `55432`。这些命令只管理本 launcher 实例。普通窗口 X 是隐藏窗口；要彻底退出桌面应用，请使用应用菜单。不要用本项目脚本关闭其他 DSH 实例。

本机专用入口和 provider 配置属于各自机器的既有设置，不随仓库 clone 提供。模型仍通过应用原生 provider 设置路径配置；不要求登录 DeepSeek 官方账号。候选启动时 launcher 为 Django 与 Host 建立同次临时桥接配对；不要手工复制密钥或把密钥放进 `.env`、命令、文档或日志。手机与电脑连接同一 Wi-Fi 后，可使用 Host 的局域网地址和 `3088` 端口；Django `3090` 与 PostgreSQL `55432` 仍绑定 loopback。真实 GUI、手机、模型及 ERP 尚未由本轮候选验收；报价的单位、币种和利润口径待业务确认。

ERPNext 当前默认未配置。后端状态接口与只读查询在管理员显式配置服务端连接前不会访问外部 ERP；普通桌面用户无需安装 Linux、WSL、Docker 或 ERPNext。真实 ERPNext 部署与实体手机验收尚未完成。

### 历史技术资料与验收记录

下方技术资料保留各批次当时的状态与验收结论；遇到旧的“尚未完成”记录时，以本文顶部当前入口说明及[验收矩阵](docs/acceptance-matrix.md)的最新状态为准。

当前业务层使用 Django/PostgreSQL；下方保留历史接口与各批验收说明。主要文档：[原始总目标验收矩阵](docs/acceptance-matrix.md) · [工作报告](docs/work-report.md) · [快速开始](docs/quick-start.md) · [Agent 开发与接入](docs/agent-development.md) · [运行时准备与升级](docs/upgrade-harness.md) · [桌面启动契约](docs/desktop-bootstrap.md) · [Phase 7 工作流验收](docs/research/2026-10-19-phase7-workflow-http-e2e.md) · [业务规格](docs/specs/2026-10-18-multi-agent-workbench-spec.md) · [AgentArts 核查清单](docs/agentarts-integration-checklist.md) · [平台能力研究](docs/research/2026-10-18-platform-capabilities.md)。忽略的 `.superpowers` 执行账本不作为仓库文档链接；历史详细证据以有链接的工作报告和验收记录为准。

---

## 业务模块与历史接口说明

Django 模板、JSON API 与 PostgreSQL 仍是当前业务层；以下页面、接口描述旧独立工作台入口及历史验收，不代表当前 DSH 桌面业务页面或 provider 已验收。任务、产品、文件引用及 Agent 运行记录持久化在 PostgreSQL；演示任务可查看丝带/蝴蝶结产品卡、补齐缺项、人工确认，再导出 UTF-8 CSV。产品图片只按“文件名去扩展名后与货号完全相等”匹配，`image_filename` 是只读派生字段，不进行视觉识别，也不推断材质或价格。

该历史工作台曾登记“产品资料整理”“询报价”“目录备样”三项能力，只有产品资料整理有本地演示执行器。询报价和目录备样明确未接入，当前没有 AgentArts 凭证、工作流导出或联调结果。

历史 Agent 能力页可选择任务运行产品资料检查。每次 dispatch 都会把 `run_id`、任务、能力、状态、开始/结束时间、结果或错误写入 PostgreSQL；刷新页面后仍可查看运行历史。未接入能力返回 409 并记录为非成功状态，不展示 token 或费用。

旧接口 `POST /api/tasks/{task}/agents/{capability}` 保持无请求体兼容：不带 `Idempotency-Key` 的每次调用都会创建新运行；调用方也可带 key 获得相同回执语义。新版能力页使用 `POST /api/tasks/{task}/agents/{capability}/runs`，必须提供 `Idempotency-Key`，请求不含其他业务参数。key 以任务和能力限定作用域；重复 key 返回原运行结果，不再次执行。`202` 与 `status: running` 表示原运行仍处理中，不代表完成；可再次提交相同 key 读取状态，客户端不会自动轮询。

能力页在提交前按任务和能力分别将待确认 key 保存到当前标签页的 `sessionStorage`。网络结果未知时，重试沿用原 key；收到成功结果或带终态标记的失败后才清除该 key。刷新同一标签页可恢复回执；`sessionStorage` 按标签页隔离，关闭标签页后不承诺保留。若新版页面连接到尚无 `/runs` 路由的旧后端，请求会得到 404 且保留回执；更新后仍可使用同 key 安全重放。

### 工作流创建请求与幂等回执

`POST /api/workflow-tasks` 可继续使用旧请求体 `{batch_id, user_goal, task_type?}`；显式加入 `idempotency_key` 时，必须是非空白字符串且长度不超过 200。服务器将全局唯一 key 绑定到原始 `batch_id`、`user_goal`、`task_type` 指纹：同 key、同请求返回首次创建时冻结的完整公开 DTO 与 201；同 key 绑定不同批次/目标/类型返回 409 `idempotency_conflict`；无 key 的旧客户端保持旧创建路径。输入校验或计划失败会回滚，不占用 key。创建回执只代表计划已保存，不表示角色已执行或任务完成。

Agent Center 为提交生成稳定 key，并在同标签页 `sessionStorage` 保存未确认的请求。响应未知或失败可用原 payload/key 重试；刷新同一标签页可恢复草稿。用户编辑后提交不同 payload 时才使用新 key；编辑后还原原文仍复用未确认请求的 key。收到有效 `workflow.id` 才清除草稿并跳转。存储不可用时页面保留本页重试，并提示刷新后先检查任务列表；浏览器存储被禁用时不承诺 reload 恢复。`sessionStorage` 按标签页隔离，关闭标签页后不承诺保留。

当前代码包含该接口和 additive migration `0003_workflow_create_idempotency`。历史本机数据库迁移、页面响应与数据前后核对记录见[本地实例更新报告](docs/phase7-local-rollout.md)；原始日志保留在项目外，不随 clone 提供。跨机器环境仍须显式设置数据库变量、验证 Django settings 身份、备份已有数据并核对 migration plan 后再迁移；不要直接复用本机数据库配置。

### Phase 1 页面与产品库入口

- 新工作台首页：<http://127.0.0.1:8000/home>
- 产品资料库：<http://127.0.0.1:8000/products>
- Agent 中心：<http://127.0.0.1:8000/agent-center>
- 交付物：<http://127.0.0.1:8000/artifacts>
- 运行记录：<http://127.0.0.1:8000/runs>
- 旧入口保留：`/` 任务列表、`/tasks/new` 新建任务、`/tasks/<id>` 任务详情、`/agents` 旧 Agent 能力页。

产品库只读 API：

```text
GET /api/product-library?q=&status=&batch_id=
GET /api/products/{id}/revisions
```

`q` 搜索 SKU/名称；`status` 使用原始 `draft/needs_review/confirmed`，页面展示中文；`batch_id` 精确筛选批次。版本列表按版本倒序，当前版本为最大 version；不存在的产品返回 404，无版本产品返回真实空列表/`unbuilt`，未知状态筛选返回 400。产品页支持 `q/state/batch` GET 筛选、清空和展开真实版本历史。

`data/samples/phase1/` 提供 10 条明确标注 `[演示]` 的产品 CSV、9 个 SVG 与图片 manifest；这些数据只用于本地演示，不自动 seed。旧 `data/samples/products.csv` 的 2 条样例与七字段 CSV 行为保持不变。

当前规划与工作流角色使用明确标注的本地模拟规则；角色规则仍待业务访谈确认。Phase 2 Task 8–10 编排基线已完成并通过审查。`task14-15-files` 的真实文件生成、落盘 QA、5 类产物版本、交付审核、受控预览/下载与显式完成门禁已通过自动化验证及隔离 CUA。交付物中心可查看 HTML/Markdown 目录预览及每个已登记样品清单 CSV 版本的只读表格预览；CSV 预览沿用已登记路径、归属和 SHA 校验，不改变版本、审核或事件记录。Task13b-facts 已完成基础字段 apply；Task13b-image-selection 与 Task13b-missing-image 分别覆盖歧义候选选择和规范无图信号的人工补图，均完成显式整周期 apply、固定两角色恢复及真实文件生成/审核/完成。后者 QA 核对旧 Revision、Review 来源/回执和原图文件保持不变，下载、产物版本、磁盘文件与质量报告 SHA 对齐；TaskFile 保存来源元数据，本产品模型没有通用图片字节版本记录。其他图片/来源冲突、Task12 六类检测及 Phase 3 其余闭环仍未完成。Phase 4 交付生成中断接管与有界重试、Task 18 运行诊断子批次均已完成各自记录的实现验证；AgentArts 仍未配置/接入。

当前基础样式链接使用固定发布参数 `?v=imgsel2` 使浏览器在 CSS 更新后重新取件；修改 `workbench/static/workbench/styles.css` 时需同步更新该参数。本地工作台不依赖 ManifestStorage，正式部署的静态文件存储策略另行评估。

工作流审核候选由 `GET /api/workflow-tasks/{id}` 只读返回。`POST /api/workflow-tasks/{workflow_id}/reviews/{review_id}/submit` 接受 `review_key`、非空 JSON `answer` 对象和 `reviewer` 标签，校验候选保存的来源后生成 `submitted` 回执；提交本身不会批准、应用业务事实或恢复工作流。Task13b-facts 对完整当前周期提供单独显式 apply。歧义图片审核只接受精确 typed answer `{"type":"select_image_candidate","task_file_id":"..."}`；规范无图审核另提供 `POST /api/workflow-tasks/{workflow_id}/reviews/{review_id}/image` multipart 上传，字段为 `image/review_key/idempotency_key/reviewer`，每次上传只保存有来源证明的 WorkflowStep、TaskFile 和事件，不改 Product/Review，也不自动提交。操作者再以 `{"type":"provide_image","upload_step_id":"..."}` 提交独立回执；之后仍须明确 apply 完整审核周期。只读预览为 `GET /api/workflow-tasks/{workflow_id}/task-files/{task_file_id}/preview`，仅接受当前工作流已验证的候选或补图凭据。Apply 重新校验整批 Revision/TaskFile CAS，创建新 Revision 并恢复既有 Product→Delivery 两个 SubTask；人工选图/补图标记由后续 matcher 验证复用，证据失效时阻断而不回退到 SKU 匹配。其他图片/来源冲突、普通 note 和未知信号仍阻断 apply。`reviewer` 仍是未认证标签，企业规则和更多审核决策待访谈确认。

Agent 中心提供“创建业务计划”入口；成功后跳转 `/workflow-tasks/{id}`。详情页展示保存的计划、步骤 attempt 历史、子任务、来源引用、审核与事件。pending 人审可提交 `{answer:{note:...}}` 说明形成 submitted 回执；已提交项只读显示填写人和实际提交时间。对当前受支持的产品事实，页面另提供人写字面字段或确认当前 Revision 的 typed 表单；提交只保存回执，用户需显式应用整个人审周期后再逐步执行既有两角色。步骤 attempt 按总执行序号递增，SubTask 错误重试额度单独计算；UI 会显示剩余重试额度。生成、交付审核和工作流完成仍是分开的显式操作。running 步骤可显式标记中断并接管；这只记录 outcome unknown，不能证明旧进程停止或副作用未发生。Task12–13 重复 SKU 子批次只处理批内去首尾空白后的大小写敏感货号冲突，要求人工明确输入新货号或重新输入原货号；不自动编号、不合并产品，也不裁决图片。完整 Task13c、Task13、Task12 六类检测及 Phase3 仍未完成。

### Windows PowerShell 启动

本节命令启动仓库中的 Django 工作台网页服务，不会打开 DSH 原生桌面窗口。DSH 桌面端与本仓库 CLI 的运行时选择、数据目录要求及当前本地入口状态见[本地启动与协作说明](docs/verification/2026-10-23-local-start-entry.md)。

运行要求：

- Python 专用环境及 `requirements-workbench.txt` 中依赖。已记录的隔离回归环境为 Python 3.14.5；source launcher 本身只检查专用解释器文件是否存在，没有声明更宽的最低版本支持范围。安装资源中的 Python 3.12.14 属于另一套 packaged-runtime 合同。
- PostgreSQL 17 用户态实例；数据库二进制和 Python 环境放在项目外。

外部 Python 环境默认位置为 `%LOCALAPPDATA%\TradeLoom\python-env`。PostgreSQL 二进制默认位于 `%LOCALAPPDATA%\Programs\PostgreSQL\17\pgsql`，实例数据位于 `%LOCALAPPDATA%\PostgreSQL\tradeloom`。

首次安装 Python 环境：

```powershell
$envRoot = Join-Path $env:LOCALAPPDATA 'TradeLoom\python-env'
python -m venv $envRoot
& "$envRoot\Scripts\python.exe" -m pip install -r requirements-workbench.txt
```

PostgreSQL 17.11 Windows x64 binaries 来自 EDB：

```text
https://get.enterprisedb.com/postgresql/postgresql-17.11-4-windows-x64-binaries.zip
SHA256: b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28
```

启动 PostgreSQL 用户态实例：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-postgres.ps1 -Port 55432
```

脚本使用 SCRAM 本地密码，只监听 `127.0.0.1`，并确保 `tradeloom_dev`、`tradeloom_lab`、`tradeloom_test`、`tradeloom_lab_test` 存在。密码保存在用户目录，不进入项目或命令输出。

启动 Django：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-workbench.ps1 -Port 8000
```

默认入口：工作台与 JSON API 为 <http://127.0.0.1:8000>；本地双 Agent 测试页为 <http://127.0.0.1:8010>。数据库变量见 `.env.example`，真实值只放本机环境或 ignored 本地文件。Django settings 不硬编码用户名或 PostgreSQL 安装路径。

### 演示步骤

1. 打开 `/tasks/new`，上传七列商品 CSV 和对应图片；演示资料中可明确留出待确认字段或同名图片候选。检查上传后的产品与来源文件。
2. 打开 Agent 中心，输入“整理产品资料并生成英文目录和样品核对清单”，检查本地有限规则的目标、依据和只读来源，再显式确认创建计划。
3. 打开工作流详情，按依赖执行产品资料角色。遇到缺字段或图片候选时，按页面的 typed 表单填写字面值/选择候选；提交只保存回执，不会批准或改写产品事实。
   当前批次最新产品版本缺少英文名时，详情页会按 SKU/位置提示人工补录并链接到对应人审项；提交后仍需显式应用整批资料，历史交付文件及其质检状态保持原版本语义。
4. 检查整轮事项后显式“应用并确认本批基础资料”，再按页面顺序恢复 Product 角色并执行 Delivery 角色。
5. 显式生成交付文件。检查 HTML/Markdown 目录与样品清单 CSV 预览、五个登记文件的来源版本和 SHA；下载文件后再显式批准交付包，最后点击“完成工作流”。

人工点击流程使用当前页面/API 契约和本地模拟角色；它不代表企业规则已经访谈确认，也不代表 AgentArts 已接入。独立 HTTP 整链验收命令见下方“测试”。

### 测试

历史全量 `workbench` 测试记录为 324/324，通过独立 PostgreSQL 测试库运行；日志与数据库身份记录为项目外证据，不随 clone 提供。该历史结果不等同当前分支的全量验收，也不是安装版、原生 DSH/provider 或浏览器提案链验收。

完整测试会包含需要独立 HTTP fixture 根目录的 Phase 7 用例。先自行创建项目外短路径，例如 `$env:USERPROFILE\tradeloom-tests\http`；测试运行会在该根目录下创建新的唯一 run-UUID 子目录。使用自有隔离 PostgreSQL 实例及该实例自己的密码文件；不要依赖旧 p3 的 55432 端口。下例中的基础库、用户名和端口需与实际隔离 PG 配置一致：

```powershell
$python = Join-Path $env:LOCALAPPDATA 'TradeLoom\python-env\Scripts\python.exe'
$httpRoot = Join-Path $env:USERPROFILE 'tradeloom-tests\http'
if (-not (Test-Path -LiteralPath $httpRoot -PathType Container)) { throw "Create the dedicated test directory first: $httpRoot" }
$runId = [guid]::NewGuid().ToString('N')
$env:DJANGO_SETTINGS_MODULE = 'config.settings'
$env:TRADELOOM_DB_NAME = 'tradeloom_gui_demo'
$env:TRADELOOM_DB_USER = 'tradeloom'
$env:TRADELOOM_DB_HOST = '127.0.0.1'
$env:TRADELOOM_DB_PORT = '55435'
$env:TRADELOOM_DB_TEST_NAME = "tradeloom_test_workbench_$runId"
$env:TRADELOOM_EXPECTED_DB_NAME = $env:TRADELOOM_DB_NAME
$env:TRADELOOM_EXPECTED_DB_PORT = $env:TRADELOOM_DB_PORT
$env:TRADELOOM_PHASE7_HTTP_E2E_ROOT = $httpRoot
$env:TRADELOOM_MEDIA_ROOT = Join-Path $httpRoot 'runtime\media'
$env:TRADELOOM_ARTIFACT_ROOT = Join-Path $httpRoot 'runtime\artifacts'
$passwordFile = Read-Host -Prompt 'Path to the password file owned by this isolated PostgreSQL fixture'
if (-not (Test-Path -LiteralPath $passwordFile -PathType Leaf)) { throw 'The fixture-owned password file is required.' }
$env:TRADELOOM_DB_PASSWORD = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
& $python manage.py test workbench --noinput -v 1
```

测试守卫要求 `TRADELOOM_EXPECTED_DB_NAME`/`TRADELOOM_EXPECTED_DB_PORT` 与真实隔离连接一致，测试库名以 `tradeloom_test_` 开头，且不同于基础库与默认 `test_<base>`；Django `TEST.NAME` 也必须等于 `TRADELOOM_DB_TEST_NAME`。每次测试需指定独立 PostgreSQL 与唯一测试库，不使用业务库或本机历史测试库。历史实际命令、路径和数据库名保存在项目外证据中。

可选的旧版真实浏览器 smoke 使用外部 Python 环境 Playwright，不依赖 `frontend/node_modules`；它只覆盖 Phase 1 CSV 演示上传、编辑/确认、旧 CSV 导出和页面截图，不验证新的工作流审核/恢复/交付链：

```powershell
& $python -m pip install playwright==1.64.0
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $env:LOCALAPPDATA 'TradeLoom\playwright-browsers'
& $python -m playwright install chromium
& $python .\e2e\workbench-smoke.py
```

浏览器缓存位于项目外用户目录。脚本生成 `data/runtime/e2e-export.csv` 和 `data/runtime/workbench-preview.png`。Phase 7 Task 22 的完整浏览器验收仍未完成；下面的 LiveServer HTTP 测试通过真实 loopback HTTP 验证业务链，不称为 browser e2e。

当前完整工作流 HTTP 验收（PowerShell；使用项目外 Python、PostgreSQL 与 password file，测试库固定为本轮专用可丢弃库；每次运行会在外部 base 下新建唯一 run-UUID 目录，避免覆盖既有 CSV 或运行文件）：

```powershell
$python = Join-Path $env:LOCALAPPDATA 'TradeLoom\python-env\Scripts\python.exe'
$root = Join-Path $env:USERPROFILE 'tradeloom-tests\http'
$env:DJANGO_SETTINGS_MODULE = 'config.settings'
$env:TRADELOOM_DB_NAME = 'tradeloom_gui_demo'
$env:TRADELOOM_DB_USER = 'tradeloom'
$env:TRADELOOM_DB_HOST = '127.0.0.1'
$env:TRADELOOM_DB_PORT = '55435'
$env:TRADELOOM_DB_TEST_NAME = "tradeloom_test_workflow_http_e2e_$([guid]::NewGuid().ToString('N'))"
$env:TRADELOOM_EXPECTED_DB_NAME = $env:TRADELOOM_DB_NAME
$env:TRADELOOM_EXPECTED_DB_PORT = $env:TRADELOOM_DB_PORT
$env:TRADELOOM_PHASE7_HTTP_E2E_ROOT = $root
$env:TRADELOOM_MEDIA_ROOT = Join-Path $root 'runtime\media'
$env:TRADELOOM_ARTIFACT_ROOT = Join-Path $root 'runtime\artifacts'
$passwordFile = Read-Host -Prompt 'Path to the password file owned by this isolated PostgreSQL fixture'
if (-not (Test-Path -LiteralPath $passwordFile -PathType Leaf)) { throw 'The fixture-owned password file is required.' }
$env:TRADELOOM_DB_PASSWORD = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
& $python manage.py test workbench.tests.test_phase7_workflow_http_e2e --keepdb --noinput -v 1
```

### 旧 SQLite 数据保留与迁移

旧 `data/runtime/workbench.db` 和 `data/runtime/uploads/` 未删除，正式启动不会自动迁移或覆盖。需要时显式执行：

```powershell
& $python manage.py migrate_legacy_sqlite --path data\runtime\workbench.db
```

导入命令以只读方式打开旧库，保留 UUID hex、position、时间戳、文件引用和 Agent 运行记录。文件引用仍指向原 stored name，因此应保持 `TRADELOOM_MEDIA_ROOT=data/runtime/uploads`；若换目录，需要由操作者复制该目录。Django development server 会提供 `/uploads/`；正式部署需由 Web 服务器提供 static/media。

### 当前限制

- 只支持 CSV 商品表，不支持 XLSX。
- 不提供真实报价、视觉识别、PDF 印刷、目录成品或 AgentArts 联调。
- 没有账户、权限、复杂任务队列、微服务或通用 Agent 平台。
- PostgreSQL 是当前持久化方式；运行数据位于用户目录和 ignored 的 `data/runtime/`。
- 旧 `backend/`、`frontend/` tracked 主流程已停用；目录中残留的 `.venv`、`node_modules` 等 ignored 文件不参与启动。

## 〇、目标场景

TradeLoom 面向制造与贸易场景，目标是把分散的业务资料整理成可核对的候选，帮助使用者复核资料并准备后续业务草稿。

## 一、当前工作台框架

本地工作台支持资料整理、解析候选复核和来源关联。`production_instruction` 候选可生成生产要求草稿。草稿补齐必需信息、处理待确认项并由人确认后，才能建立执行计划草稿。执行计划保持草稿，实际到料和产量尚未记录。

访谈摘录、二次摘要与用户补充可作为来源说明保存；它们不能替代完整录音或正式业务规则。ERP Quotation 草稿由独立适配器处理，不属于生产要求到执行计划的自动链路。

## 二、待确认边界

当前仓库提供通用工作流框架，不代表特定企业的实际部署、生产连接或量化成效。具体业务规则、数据接入、外部系统操作和运行结果，需由部署方按实际配置验证。

## 三、设计原则

1. 保留候选与来源之间的关联，便于复核。
2. 区分自动解析、人工判断和外部系统操作。
3. 先交付可检查的草稿，再由使用者确认后推进后续流程。

## 四、仓库结构

```
tradeloom/
├── README.md                       # 本文件：是什么、为什么、往哪走
├── requirements.txt                # Python 依赖（Pillow / ReportLab / pikepdf / PyMuPDF）
├── manage.py                       # Django 入口
├── config/                         # Django settings/WSGI/ASGI
├── workbench/                      # PostgreSQL models、API、模板与 Agent seam
├── requirements-workbench.txt      # Django / psycopg
├── e2e/                            # 真实浏览器 smoke 脚本
├── data/
│   ├── samples/                    # 演示商品表与明确标注的演示图片
│   └── runtime/                    # 旧 SQLite、上传文件、截图与 e2e 产物（不入库）
├── scripts/
│   ├── check_env.py                # 环境自检：字体 → PDF → CMYK，9 项逐条验
│   └── fetch_fonts.ps1             # 拉 Noto Sans/Serif SC（TTF，OFL 可商用）
├── docs/
│   ├── 00-赛题与目标.md             # 赛题 2 原文、评分对齐、交付物清单
│   ├── 01-业务基线.md               # 从一次真实访谈里拆出的全链路与痛点排序
│   ├── 02-客户访谈问题表.md          # 下一轮访谈要问的问题（带优先级与「为什么问」）
│   ├── 03-数据与素材清单.md          # 要企业提供的原始素材（决定 demo 能不能真跑）
│   ├── 04-环境搭建.md               # 从零复现：装什么、怎么验、装不上的去哪拿
│   └── specs/
│       ├── 2026-10-17-tradeloom-design.md   # 设计文档 v0.1：架构、印刷校验、评测、六周排期
│       ├── 2026-10-18-v0.2-初版范围与工作台路线.md   # v0.2：初版收敛为单 Agent+两工作流+轻量工作台，五级阶梯
│       └── 2026-10-18-workbench-shell.md            # 本次批准实施的工作台骨架范围
├── assets/fonts/                   # 字体（二进制，用脚本拉，不入库）
└── docs/architecture.md            # 数据流、多 Agent 契约与 AgentArts 接入边界
```

## 五、路线图与验证记录

当前代码提供工作台基础、来源留档与标注、候选整理及生产要求草稿等框架。来源说明不等同于完整录音或正式规则；人工记录的工时是估算，不代表实际产量；报价缺少金额时也不代表金额为零。

生产要求候选可生成草稿。草稿补齐必需信息、处理待确认项并由人确认后，才能建立执行计划草稿。执行计划仍为草稿，实际到料和产量尚未记录。ERP 报价草稿是独立适配，尚未验证自动贯通的生产链路。

后续顺序为：验收桌面/手机与布局交互；用有来源的资料验证生产要求草稿、人工确认和执行计划，报工口径仍待确认；各 Agent 配置 API/UI 已实现，仍需桌面交互验收，并核验 ERP 查询与草稿边界。不预设完成日期、样本数量或效果指标。近期本地来源闭环与验证范围见[验证记录](docs/verification/2026-10-23-narrative-native-source-closure.md)。

## 六、为什么叫 TradeLoom

Loom 是织机。这家企业的日常，本质是把五根线（选品、客户、报价、生产、财务）织成一匹布——今天这五根线在老板手里打了个结，我们要做的是那台**把线并起来、张力可调、断了会报警**的织机。

TradeLoom = Trade + Loom。中文名「贸织」：贸（接单）与织（生产），正好是「工贸一体」的两半。

## 七、印刷工具链快速开始（可选，20 分钟复现环境）

```powershell
cd tradeloom
$printEnv = Join-Path $env:LOCALAPPDATA 'TradeLoom\print-env'
python -m venv $printEnv
& "$printEnv\Scripts\python.exe" -m pip install -r requirements.txt
powershell -ExecutionPolicy Bypass -File scripts\fetch_fonts.ps1

chcp 65001 > $null
$env:PYTHONIOENCODING='utf-8'
& "$printEnv\Scripts\python.exe" scripts\check_env.py   # 期望 9/9 通过
```

`check_env.py` 不是摆设：它注册中文字体 → 画 RGB 色块 → 调 Ghostscript 转 CMYK → 解析 PDF 内容流确认 `rg` 消失、`k` 出现。**这段输出就是「处理成印刷厂要的格式」的第一份证据。**

Ghostscript 需单独安装（唯一二进制依赖），装不上的、要账号才能拿的，都在 [docs/04-环境搭建.md](docs/04-环境搭建.md) 里给了网址。

## 八、English Abstract

TradeLoom is an agentic digital workforce for small export-oriented manufacturers that both trade and produce ("工贸一体"). It stitches the five fragmented workflows — product selection, customer acquisition, quotation, shop-floor execution, and cash flow — into one auditable loop. Every recommendation ships with its evidence (which orders, which customer, which cost sheet); human judgement stays in charge, while the agent does the remembering, the drafting, the reconciling, and the chasing.

## 九、参与

- 想看「要做什么」→ [docs/00-赛题与目标.md](docs/00-赛题与目标.md)
- 想运行当前工作台 → [README 的“本机已验证的 candidate7 开发入口”](#本机已验证的-candidate7-开发入口)
- 想检查可选的印刷/PDF 环境 → [docs/04-环境搭建.md](docs/04-环境搭建.md)
- 想看「为什么做这个」→ [docs/01-业务基线.md](docs/01-业务基线.md)
- 想帮着补需求 → [docs/02-客户访谈问题表.md](docs/02-客户访谈问题表.md)
