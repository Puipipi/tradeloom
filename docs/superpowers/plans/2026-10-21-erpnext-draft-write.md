# ERPNext Quotation 草稿受控写入实施计划

## Goal

为现有“企业管理”场景和中心 Agent 提供有限的 ERPNext `Quotation` 草稿创建、修改与读回能力。每次写入都只能生成或修改 `docstatus=0` 的报价单；正式提交、取消、删除和任何库存变更不属于本计划，之后若要增加必须有独立的明确确认设计。

本阶段不要求在保存草稿后再走一遍人工审批。现有 `HumanReview`、workflow intent receipt 和模型输出都不构成 ERP 写入授权或幂等凭证。

## Architecture

- Django 是本地写入边界，继续使用已配置的服务端 ERPNext client；浏览器只通过现有同源 `/business-api` 代理访问固定 Django API，不连接 ERPNext、不提供任意 URL/DocType/RPC。
- 人工界面在当前本地桌面信任域中通过同源请求保存草稿：代理继续执行 DSH `connection.requestRejection`，转发仅限 CSRF cookie 和请求头；Django 标准 CSRF middleware 继续保护非安全方法。界面不发送 `role` 或 `actor` 字段，服务器不得把其当权限凭据。当前系统没有端到端的多用户身份认证，本接口不声称隔离不同本机/局域网操作者。
- Agent 写工具仅能在 DSH `exec.agent.session.header.agentPreset` 的可信执行上下文中检查中心 preset；工具的浏览器参数不能选择或声明角色。产品/交付等现有只读角色权限保持不变。
- 先在 PostgreSQL 持久预留操作与幂等键，再调用固定的 ERPNext Quotation endpoint。远程结果不确定时保留 `outcome_unknown`，只允许后续读回和人工调和；不得自动重放可能已成功的创建请求，不承诺跨数据库/ERP 的 exactly-once。
- 创建和修改均只能写允许字段并由服务端固定 `docstatus=0`。修改必须使用原子 `modified` 条件；普通 GET 后再无条件 PUT 不符合要求。官方 Frappe v16.52.0 源码已确认其条件更新路径，具体部署镜像与并发响应仍待运行验证。

## Tech Stack

- Django / PostgreSQL：窄操作记录、事务内幂等预留、受控 API 和审计事件。
- 现有 `workbench/erpnext/client.py`、`service.py`、`api.py`：扩展固定 Quotation 操作；不引入通用 CRUD/REST 代理。
- `packages/tradeloom-shell/business-tools.js`：为 DSH 只增加固定写工具；复用已有可信 preset 检查、同源 authority 和 CSRF bootstrap。
- `packages/tradeloom-shell/client.scenes.js`：复用既有 ERPNext 面板、主题和 Dockview 生命周期，增加草稿表单及读回；不创建第二套 ERP 状态或凭据存储。
- ERPNext 参考契约：仓库外固定版本 v16.51.1 的 `Quotation` 与 `Quotation Item` DocType JSON。真实服务请求和 GUI 验证需另行获准后执行。

## Existing Contract Evidence

- `packages/tradeloom-shell/proxy.js:24-46, 89-92`：业务代理只保留 `csrftoken` cookie 和随请求转发的 CSRF header，并在转发前调用 `ctx.connection.requestRejection(req)`；`/business-api` 代理仍是固定 Django 同源入口。
- `config/settings.py:31-35`：Django 启用标准 `CsrfViewMiddleware`。`workbench/views.py:142-158, 312-314` 的页面由 `ensure_csrf_cookie` 设置 CSRF cookie；`workbench/templates/workbench/base.html:7` 提供 CSRF token meta。`packages/tradeloom-shell/business-tools.js:139-181` 已有 GET bootstrap 后附 cookie 与 `X-CSRFToken` 的服务端范式。
- 身份边界：`packages/tradeloom-shell/business-tools.js:147-150` 的 ERP 权限检查使用可信执行对象中的 `exec.agent.session.header.agentPreset`。这只适用于 DSH 工具调用；`ctx.connection.requestRejection` 与 CSRF 不代表已认证自然人，浏览器端不得把 `role`/`actor` 请求字段当授权。
- `workbench/urls.py:21-23` 已将现有只读 ERP API 固定挂在 `/api/erpnext/status`、`records`、`record`；本计划新增的草稿路由仅限 Quotation，不改变这些 GET 语义。
- `workbench/models.py:108-139, 247-278, 370-397`：WorkflowTask 现有创建幂等键绑定 workflow 创建，WorkflowStep 的幂等键绑定 task/step，EventLog 是事件记录；这些结构没有证明远端 ERP 创建/更新的请求指纹、instance、remote name、expected modified 与 `outcome_unknown` 状态可完整表达，因此计划增加窄操作记录，不复用 intent receipt 冒充 ERP 操作收据。
- 本地参考树 `references/erpnext-20261021/erpnext/selling/doctype/quotation/quotation.json`、`quotation_item/quotation_item.json`：`quotation_to` 是必填 Dynamic Link 的目标 DocType，`party_name` 是对应 Customer 引用；Quotation 必填 `company`、`transaction_date`、`currency`、`items`，行项目包含必填 `qty`、`uom`，并有 `item_code`、`rate`。`docstatus` 是系统状态字段，服务端必须固定/校验为草稿值 0。

## Spec

### 允许的输入

只接受固定对象 `Quotation`，未知键一律拒绝。基于本地 v16.51.1 DocType 定义，初始候选字段为：

- 报价头：`company`、`quotation_to`（服务器固定为 `Customer`）、`party_name`（Customer 引用）、`transaction_date`、可选 `valid_till`、`currency`。
- 明细行：`item_code`、`qty`、`rate`、`uom`。`Quotation Item` 要求 `qty` 与 `uom`；实现前逐字段核对 DocType 和服务端实际校验，不从 UI 任意透传其他字段。
- 服务端固定 `docstatus=0`。不得接受 `docstatus`、提交/取消动作、税/折扣、任意脚本、任意 DocType 或资源 URL。日期、数量、价格与引用只做格式/类型/边界校验；不补充未经访谈的企业交易规则。

### 操作与失败语义

- 固定 API：`POST /api/erpnext/quotation-drafts` 创建；`PUT /api/erpnext/quotation-drafts/<target_operation_id>` 基于一条已成功的草稿操作修改；`GET /api/erpnext/quotation-drafts/<operation_id>` 读取该操作的固定收据，并单独返回一次新的只读远端状态。API 不接受客户端指定远端 URL、任意 DocType 或任意远端 name 作为写目标；操作记录负责绑定远端 name 与 ERP instance。
- 每次 create/update 都是独立幂等操作。POST 由服务器生成 `operation_id`，调用方只提供非空 `idempotency_key` 和规范化报价内容。PUT 指向已成功的 `target_operation_id`，必须使用新的幂等键；服务器为本次 update 生成新 operation row，并以 `target_operation` 外键绑定目标。两类响应都返回本次服务器生成的 operation ID。不得复用或覆盖旧操作的幂等键、请求内容、payload SHA 或成功收据。
- 持久唯一键按 ERP instance 与 `idempotency_key` 约束。fingerprint 覆盖 action、instance、target operation、expected `modified`、规范化 payload 和 workflow（如有）。相同 key/fingerprint 返回原操作且不重发副作用；相同 key 但 fingerprint 不同返回 409。历史 `reserved` 仅作为兼容状态；新操作从 `outcome_unknown` 开始，操作身份和成功收据不可被后续操作改写。
- 创建先提交 `outcome_unknown` 记录再发网络请求。只有首次插入该操作的原始调用（`created=true`）取得一次写入资格，重放只读/调和。明确成功后，在该操作收据中冻结远端 name、回读字段、合法 `modified` 和 `result_ref`。GET 将不可变历史操作收据与最新远端只读读回分别呈现；新的远端状态不得回写旧成功收据。
- 进程中断、超时、不可解析响应、远端已写但本地读回失败等无法确认结果的情况标为 `outcome_unknown`，保留已知远端标识；任何不确定/未完成操作均不得自动重发 create/update。已知远端 name 只允许只读 reconciliation；没有 name 也不得推断远端未写入。由操作者处理不确定结局。
- 新 operation 在唯一创建请求提交时即持久化为 `outcome_unknown`；仅创建该行的原始调用（`created=true`）获得一次远端写入资格。相同幂等键的并发请求只读/调和，不获得第二次写入资格。旧 `reserved` 行兼容为未知结局，首次重放/读取时升级为 `outcome_unknown`，不推断失败、不重发。
- 对 outcome unknown 的 update，只有当请求白名单内容与远端当前记录一致且 `modified` 已不同于该操作的 expected 值时，才可据只读回读确认成功。若请求内容可能在写入前就已与记录相同，且版本仍等于 expected 值，无法证明超时请求已应用，必须继续保留 unknown。
- 修改要求调用 ERPNext 支持的原子条件更新：目标必须仍为 `docstatus=0` 且 `modified` 等于请求的 expected value；冲突不覆盖远端数据。当前实现固定带 `docstatus=0` 和 `modified=expected_modified` 的 Quotation PUT；Frappe `TimestampMismatchError` 被安全映射为稳定冲突码。
- 返回只包含操作 ID、固定 DocType、受限记录字段、`docstatus`、`modified`、`external_ref`、幂等状态及稳定错误码。不得返回凭据、Authorization/header、原始响应 body 或堆栈。事件记录 operation、可信来源类别、payload SHA、结果/不确定状态；不伪造自然人身份。
- 202 且 `status=outcome_unknown` 表示尚未确认成功，调用方不得自动重试写入；即使兼容 envelope 中的 `ok` 为 true，也只有 `status=succeeded` 才能显示或宣称写入成功。未来工具/UI需按 `status` 判断。

### 信任与权限边界

- 浏览器草稿 API 位于现有 DSH same-origin/request-rejection 与 Django CSRF 边界内，运行于已接受的单用户本地桌面信任域。CSRF 用于阻止跨站请求，不能当作登录或身份认证。body/header 中的 `role`、`actor` 一律不得授权。
- Agent 工具在服务端可信 DSH session preset 中确认 center 后才允许调用；缺失 session、未知 preset 或非 center preset fail closed。工具仍调用固定 Django API 并只回传白名单结果。
- 本阶段不新增完整账户/RBAC、用户登录或“保存后人工审批”流程。审计如实记录 `local_workbench` 或可信 DSH preset 来源；无可信个人身份时明确身份不可用。

## Files

- `workbench/models.py` 与 `workbench/migrations/0004_erpnext_draft_operation.py`：窄 `ErpNextDraftOperation` 持久记录，含服务器生成的 operation ID、instance/key/action fingerprint、不可变规范化请求摘要、状态、workflow 可选关联、`target_operation` 外键、remote ref、payload hash、expected modified、安全结果引用和时间戳。每次更新新增 operation row，不覆盖目标操作。
- `workbench/migrations/`：新增操作表和必要唯一约束；不改现有 WorkflowTask/Step/HumanReview 语义。
- `workbench/erpnext/drafts.py`：字段白名单、canonical payload、操作预留/回放、受限 create/update/readback 与 unknown-outcome reconcile 服务。
- `workbench/erpnext/client.py`：仅固定 Quotation create/update/get 方法；条件更新依据官方 Frappe v16.52.0 源码审阅，尚待实际部署镜像和并发验证。
- `workbench/erpnext/api.py`、`workbench/urls.py`：三个固定操作路由、CSRF 保护、错误/结果 DTO；不改现有只读路由契约。
- `packages/tradeloom-shell/business-tools.js`：center-only 的固定 Quotation 草稿工具；保留既有 ERP read tools 的三角色权限。
- `packages/tradeloom-shell/client.scenes.js`：ERPNext 场景中的有限草稿表单、操作状态、读回和 unknown-outcome 提示。
- `workbench/tests/test_erpnext_drafts.py`、`workbench/tests/test_erpnext_draft_api.py`、shell 对应测试：幂等/并发/状态/安全 DTO/权限/CSRF/读回/失败结局。
- `docs/agent-development.md`：说明草稿保存与提交/取消的边界、操作状态与不确定结局处理。

## Steps

### 1. 固定远端写契约与授权入口

- [ ] 从锁定的 ERPNext v16.51.1 源码核实 Quotation 创建/修改/读回 API、Customer Dynamic Link、必需子表字段和 `docstatus` 保护。
- [x] 核实 Frappe v16.52.0 中 `PUT /api/resource/<doctype>/<name>` 的事务条件更新：`frappe/api/v1.py` 的 `update_doc` 先以 `for_update=True` 读取、再应用 payload 并保存；`frappe/model/document.py` 在覆盖 modified 前保留 `_original_modified`，`check_if_latest` 对照锁定行的 modified 并在不一致时抛 `TimestampMismatchError`。更新 client 在固定 Quotation PUT payload 中提交请求的 `modified=expected_modified` 与固定 `docstatus=0`，映射 417/409 为稳定冲突码。官方版本源：[api/v1.py](https://raw.githubusercontent.com/frappe/frappe/v16.52.0/frappe/api/v1.py) 与 [document.py](https://raw.githubusercontent.com/frappe/frappe/v16.52.0/frappe/model/document.py)。本地仍需对部署镜像实际实现和并发结果做集成验证。
- [ ] 为浏览器界面沿用当前单用户本地 DSH 信任边界；不得把 CSRF、UI 选中 Agent 或请求角色字段解释为真实个人身份。
- [ ] 对 DSH Agent 工具固定检查真实 execution preset 为 center；不得让调用参数覆盖它。

### 2. 先写失败测试和操作记录模型

- [x] 使用隔离 PostgreSQL 写幂等 reserve、同键重放/异 fingerprint 冲突、create/update 独立 operation row、不可变历史收据、operation 与 workflow 关联、唯一约束和原子状态迁移测试。
- [x] 覆盖预留先于网络副作用、并发同键最多一条远端创建调用、超时/崩溃/坏响应转 `outcome_unknown` 且后续不重建；新操作持久状态在远端写入前已是 unknown，只有原始插入请求获得一次调用资格，旧 `reserved` 行重放时不重发。
- [x] 生成并审阅手写迁移；隔离测试库应用迁移，不连接业务数据库，不创建真实 ERP 记录。

### 3. 实现固定 Quotation 服务与 Django API

- [x] 固定 Quotation create/update/readback/reconcile；拒绝额外字段、任意 DocType、非草稿状态和越权写操作。update 使用预期 `modified` 条件，不采用先 GET 再无条件 PUT。
- [x] POST 请求只接收 idempotency key 与规范化内容，服务器生成并返回 operation ID；每个 PUT update 必须使用新 key、新 operation row 和目标 operation 引用。
- [x] GET 同时返回所指操作的历史收据与独立的当前远端只读快照；重读不得改写旧成功操作的结果。
- [x] 创建与修改回读后校验 name、doctype、`docstatus=0`、可供后续 update 使用的合法 `modified` 格式和白名单 DTO；保留 timeout 与写后读回不确定语义。远端 `modified` 在校验格式和有效日期/时间后按原始字符串保存。
- [x] API 使用现有 Django CSRF middleware 与 same-origin proxy；测试无 CSRF、非法角色声明、未知操作、跨 workflow 绑定和安全错误 DTO。

### 4. 暴露受限 Agent 工具与 ERPNext 场景表单

- [ ] 只注册 center preset 可调用的固定草稿工具；product/delivery 和未知 preset 保持拒绝。
- [ ] 表单仅编辑允许字段，明确显示本地操作状态、ERP name/modified/external ref；保存不触发 submit、取消或额外人工审批。
- [ ] 对 outcome unknown 显示“结果待核对”，提供只读重新读取/调和动作，不自动重放创建。

### 5. 验收与交付说明

- [x] 在隔离 PostgreSQL 完成 Django service/API 定向测试及必要并发测试；本轮未修改 shell/tool，ERP 草稿工具和表单尚待后续批次。
- [ ] 只有授权并确认远端实例可用后，使用专用测试数据验证 create/update/readback/unknown reconcile；本计划撰写时没有创建真实单据。
- [ ] 原生窗口验证 day/night、保存草稿、恢复和错误状态；不把 mock 或仅离线测试描述为 ERP 集成通过。
- [ ] 更新工程文档，列出未实现的提交/取消/库存能力及本阶段已验证边界。

## Verification Boundary

本文件由实现阶段继续维护，不代表草稿写入已完整验收。当前代码包含窄操作模型/手写迁移、固定 Quotation create/update/readback client、幂等预留/不确定结果调和服务和 Django POST/GET/PUT 路由。官方 Frappe v16.52.0 源码支持事务内 `modified` 比较；三项定向 Django 模块在隔离 PostgreSQL 新库上 42/42、exit 0，test runner 应用了该迁移。真实部署镜像 CAS 与并发行为仍待验证；未做真实 ERPNext 写入。Agent 写工具与桌面草稿界面仍未实现。CSRF 只保护同源请求；本地桌面单用户信任边界不等价于多用户身份认证。
