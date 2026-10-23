# ExecutionPlanRevision 实施计划

状态：已按 root 本轮裁定开工。范围仅为后端、迁移、契约说明和测试；不实现页面或 shell business tools，不访问或写入 ERPNext。

## 依据与前置保护

- 契约：`workspace/research/erpnext-engine-20261021/deployment/slice3-execution-plan-contract-20261022.md`；接缝：`github-erpnext-production-seams-20261022.md`；已批准三切片：`business-next-slices-implementation-20261022.md`。
- root 已裁定 confirmed requirement revision 是准入条件；锁所属 Draft 并按每个不可变 requirement revision 单独 CAS；物料/工序 proposal 显式 unresolved，actual 固定 missing。
- 原始文件及 SHA-256 已保存到 `workspace/testing/execution-plan-20261022/before/manifest.json`，含当前工作树中此前切片留下的改动。不得覆盖/还原这些副本来回退他人工作。
- 测试仅通过 `workspace/runtime/tradeloom-harness/local-dev/django-phase2-test-runner-20261021-01/run-django-tests.mjs`，loopback PostgreSQL 55435，逐轮全新 `tradeloom_test_*` 数据库。禁止碰生产/开发 55432、重启/迁移主库、同步或清理既存测试库。

## 实施顺序

1. 先新增 `workbench/tests/test_execution_plan.py` 合约测试并运行，记录尚无 endpoint/model 时的 RED 结果。
2. 只增 `ExecutionPlanRevision` 一个 append-only 模型和 `0009_execution_plan_revision.py`。复用 hex UUID、`PROTECT` requirement revision、正 revision、draft-only 状态、需求/物料/工序 JSON typed arrays、actor/time；幂等只复用 `IntakeOperationReceipt`，不在计划模型重复保存。数据库唯一键 `(requirement_revision, revision)`。模型校验拒绝改写或删除，数据库约束兜住 revision 唯一性和有效状态。
3. 在 `workbench/execution_plans/` 加封闭 schema/service/API。POST 限 256 KiB，强制精确顶层/嵌套键、真实 JSON 类型、数组上限 refs 100/materials 200/operations 100、item refs 20；核对所有 EvidenceRecord 属于指定 exact requirement revision 且 field_key 一致。物料仅 `item_ref=null`、`resolution=unresolved`；仅保存用户明确给出的 description、decimal-string quantity、unit、ISO date proposal，不从需求数量推值。工序仅 null/unresolved 与显式 description、正整数顺序 proposal；不衍生工时、人、成本、ERP ID。actual 只在 DTO 固定返回 missing。
4. POST 在事务中先锁 route draft，校验 exact requirement revision 的 draft 归属和 confirmed 状态，再读取该 lineage 最新版并校验 expected_revision（首次为 0），追加 revision。幂等 receipt 使用 `ExecutionPlanRevision` typed resolver：同 key/请求/同 revision 返回原始结果，异 payload 冲突；response 的 original revision 与最新 revision/is_latest 分开。
5. GET 指定 revision，含绑定 requirement revision 与 lineage 最新标识；同 route GET 历史列表最多 20 条，offset/limit 严格校验。旧确认版本仍可回读，且不改绑新 requirement revision。
6. GREEN 覆盖拒绝路径、schema/bounds/provenance、confirmed 成功/回读、独立 lineage/immutable latest、幂等冲突、真实 PostgreSQL 双线程首版 CAS、append-only/约束、proposal 与需求来源分离/actual missing/未知不变 0，以及 intake 与 requirement 回归。保留每次 RED/失败记录，最终汇报 run ID、命令、退出码、diff 与哈希。

## 可验证边界

本阶段不写 UI、`packages/tradeloom-shell/business-tools.js`、ERP adapter、生产单据、库存、到料或报工记录。计划只表示本地 draft 输入，不表示产能、齐套、交期可行性或已核实事实。测试结果只证明 Django/PostgreSQL backend 行为，不证明原生 UI 或模型推理。

实际记录流程仍待业务验证：现有访谈分析不足以证明持续报工/到料载体、填报与审核责任人、以及更正方式；当前业务基线和访谈问题表也把这些列为待验证。因此计划 proposal 即使由操作者明确输入仍标为未核实，actual 保持 `missing`，不得呈现为 `0` 或“未开始”。任何 actual 记录设计必须等上述流程得到确认后另案处理。

## 阶段2：现有计划 UI、来源 DTO 与 DSH 只读工具

状态：root 于 2026-10-22 批准阶段2；保持阶段1报告及 `review-final` 冻结不变。本阶段先在 `workspace/testing/execution-plan-ui-tools-20261022/before/manifest.json` 保存触及文件快照和 SHA-256。

### 实施顺序

1. 只移除执行计划测试中 SQLite `DATABASES` override；迁移 autodetector check 改在 runner 管理的 PostgreSQL 55435 测试上下文中执行，不改通用 runner、不生成迁移。原SQLite记录保留为历史。
2. 为精确 plan revision 的创建/回放与 GET DTO 添加绑定 confirmed requirement revision 的 `requirements.service.revision_payload`，限制为该版本既有字段与来源引用；不取 Draft 最新版本，不暴露源文件路径/原始文件名，不加模型或 migration。测试覆盖需求更新后旧 plan 仍回读其原版本来源。
3. 在 artifacts 页面添加计划工作区和独立 `execution-plans.js`，该脚本先加载并监听 intake 的窄 `CustomEvent`，再加载 intake 脚本。intake 仅在候选切换/清空、精确 viewed revision 渲染、dirty/save 状态变化时发事件。按 requirement ID 分代隔离异步响应；未确认、需求dirty/保存中时不能保存；历史按精确 lineage 只读分页，当前 lineage 可追加。proposal 只接受明确人工输入；材料与工序保持 unresolved、空值为 null、actual 永远 missing。关联需求依据与物料/工序提议字段分开呈现，以 textContent 安全显示出处。补 DOM 测试覆盖禁用/允许、dirty、空与0、历史、迟到响应、409保留、幂等网络重试和 XSS-safe 出处。
4. 扩展 `packages/tradeloom-shell/business-tools.js` 增加 `tradeloom_read_execution_plan`：限定 center/delivery，闭合 JSON Schema、32位小写 hex ID；role deny 先于 HTTP；仅 GET；经专属 allowlist 投影返回 plan proposal、固定 actual missing 及绑定 requirement 来源，不传递原始请求体、存储路径或不相关键。依赖既有 `capabilities.js` 动态发现，不另建注册表；测试覆盖 schema、role/HTTP计数、投影和 capability 可见性。
5. 使用现有外部 jsdom 30.1.3 和项目固定 candidate8 Node runtime 执行有关测试；Django 通过现有runner、新唯一 testDB/55435执行必要模块。先记录真实 RED，再实现并跑相关模块。留存每次失败/成功的原始输出、run ID、退出码和 hash。

### 边界

不得进行主库迁移、同步、服务重启、安装包构建、Git提交/上传或任何 ERP/真实资料写入。DOM、ToolRuntime adapter、API 测试仅证明各自合同，不表示原生 UI、真实模型、手机或发布验收。业务实际到料/报工/审核流程仍待验证；actual 继续为 missing。
# 阶段3：真实 loopback HTTP 与注册后 ToolRuntime handler 闭环

## 范围

- 新建 `workbench/tests/test_execution_plan_http_e2e.py`，使用 `LiveServerTestCase` 的随机 loopback 端口和显式唯一 PG testDB；沿用 Phase7 的外部目录守卫、cookie jar、multipart 与 CSRF 请求模式。
- 只通过 urllib 对 Django 写入：synthetic XLSX → preview → mapping → candidate → new_demand → narrative 来源 → 补未决字段 → 公开 confirm → plan POST/GET → 更新需求新 revision 并确认旧 plan 仍绑定旧需求版本与 A1 来源。
- 在已提交 HTTP 步骤后运行外置 Node probe。probe 从项目源码导入 business tools、用固定 candidate8 ToolRuntime.prototype.register adapter 注册已存在只读 tool，并通过真实随机 LiveServer 端口调用中心与交付角色；商品角色和非法 ID 必须在 HTTP 前拒绝。所有请求保留 synthetic private Host/Origin。
- 只修改受管隔离 runner/config 的受控依赖注入：新 E2E 必须显式传固定 candidate8 `node.exe` 与 `packages/core/tools/lib/index.js`，按其根目录/文件类型/hash校验后注入子进程 env。旧 runner 命令保持兼容，依赖缺失显式失败而不 skip。
- 运行产物、测试文件素材、marker、media 与 artifact 均在 `workspace/testing/execution-plan-http-20261022/` 外部唯一 run 子目录；允许 Django 服务线程运行期间由 Node 子进程并发请求，不持有 ORM atomic。

## 验收

- CSRF 无 token 的 HTTP POST 返回 403 且业务行计数不变；合成材料 proposal 与工序 proposal 经 GET/Tool DTO 精确回读，actual 始终 missing，不从产品数量推算原料量。
- Django 测试确认更新需求后旧计划 lineage 与原 source_record sheet/coordinate 保持绑定；Node 实际 HTTP 请求目标 host/port/method/path 可检查；center/delivery 成功，product 零请求拒绝。
- 先运行新隔离标签；通过后只运行新增 E2E、execution-plan 和 production-requirement 模块。记录实际命令、exit、runID、数据库、各依赖 hash、完整 focused diff 与 frozen sources。
- 证据只覆盖本地合成 HTTP + ToolRuntime 注册 handler，不声称 provider、模型、原生 UI、手机或发布验收。

### 实际结果与限制

- 路径守卫独立四例断言通过：拒绝仓库根、仓库内 child、仓库祖先，允许同级 `workspace/testing`；candidate8 Node 对 runner 与 probe 的 `--check` 通过。
- 首次 E2E 运行 `2026-10-22T102110-246Z-57152` exit 1：全部 HTTP 流程到旧 plan GET 已通过，probe 夹具错误地要求 product preset 注册受限工具。保留原始输出；按既有角色契约改为 center 注册后用 product actor 检查零请求，不改产品权限。
- E2E GREEN：`2026-10-22T102303-848Z-59396` exit 0，1 test。随后隔离回归 `2026-10-22T102335-159Z-61472` exit 0，27 tests / 20.103s，包含 E2E、execution_plan 与 production_requirement。两次均使用 PG 55435 和各自新唯一 testDB。Node 实际 HTTP 请求从随机 LiveServer 端口发出，携带 `Host: 192.168.56.1:3088` 与 `Origin: http://192.168.56.1:3088`；DTO/工具核对 source evidence ID、preview snapshot ID、sheet 1/A1、旧 requirement revision、proposal `quantity="0"` 与 actual `missing`。
- 固定 candidate8 Node v24.21.0 SHA-256 `BA4E6D110E8C1592A1ECD390F6B05F3DA124B13871A5BE62B341A07A853C6C32`；ToolRuntime `packages/core/tools/lib/index.js` SHA-256 `1E53932E7C4213EA24A7D87F06960B7A7702CB21F8A5741C97242B4A470A442A`。
- runner 标签检测涵盖 E2E 模块祖先、完整模块及 class/method 后代；无数据库四例断言通过，只有命中 E2E 的命令才要求固定 runtime flags，其他单测仍沿用旧调用方式。
- 详细命令、result/stdout/stderr 路径和 SHA、before 源哈希及完整本阶段 focused diff 见 `<LOCAL_USER_ROOT>\Desktop\ICT\workspace\testing\execution-plan-http-20261022\review-final\`。本阶段没有运行主库迁移、同步、服务重启或部署。
