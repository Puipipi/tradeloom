# ExecutionPlanRevision 后端核验

日期：2026-10-22。范围：本地 Django/PostgreSQL 后端、migration、合成 API 测试。状态仅覆盖下表列出的源码和测试，不代表 UI、shell tools、模型推理、安装包或发布验收。

## 结果

- 在已归属的 PostgreSQL 17 集群 `127.0.0.1:55435` 与专用隔离 runner 上执行；最终测试使用唯一数据库 `tradeloom_test_execplan_all_20261022_02`。没有运行迁移到基库、重启数据库或触碰 55432。
- 最终 Django system check：`node ...\run-django-tests.mjs check`，run `2026-10-22T091517-650Z-44552`，exit 0，`System check identified no issues (0 silenced)`。
- 补充审查验收后的定向命令使用全新数据库 `tradeloom_test_execplan_review_final_20261022_01`，run `2026-10-22T092440-805Z-22476`，exit 0，11 tests。新增 route draft/revision 错配、字段冒充证据拒绝、v1 原请求跨最新版回放、公开来源穿透检查，以及在仅内存 SQLite override 下的 `makemigrations --check --dry-run`（无迁移文件生成）。
- 既有 requirement/intake 全回归（与后续最后一组仅新增测试、未改生产代码）run `2026-10-22T091429-040Z-6808`，exit 0，61 tests，`OK`。receipt 与输出位于 runner `runs/2026-10-22T091429-040Z-6808/`。
- 最终 Django system check：`node ...\run-django-tests.mjs check`，run `2026-10-22T091517-650Z-44552`，exit 0，`System check identified no issues (0 silenced)`。

## RED 和修正记录

- 首次 runner 前置失败 `PG_NOT_RUNNING`，exit 2；当时未产生 runID/result，也未启动集群或创建测试库。这不是功能 RED。
- `2026-10-22T085925-555Z-15212` 是夹具 AttributeError（合成 XLSX helper 未暴露），不是功能 RED；修正为独立夹具。
- `2026-10-22T090123-835Z-46104` 是真实功能 RED：新增计划 POST 返回 404，符合未实现接口的预期。
- `2026-10-22T090537-750Z-41304` 的首次实现测试因合成 XLSX 字节相同而正确重放 200、夹具却只接受 201，4/6 通过；只改合成 fixture 以保证不同测试来源字节不同，没有改生产去重行为。后续 `2026-10-22T090634-642Z-40624` 为 6/6 通过，之后扩充测试并在最终批次重新覆盖。
- 第二轮审计 RED `2026-10-22T091250-850Z-43760`：10 tests 中 3 项按预期失败，分别证明缺历史 lineage 过滤、重复引用同字段证据被错误拒绝、未知 ValueError 哨兵进入公开错误码。4301 位 offset 用例也加入测试；因历史过滤先失败，随后在 GREEN 中确认安全拒绝。

## Bingus 映射增量

这些 M 编号和 43 个 leaf checks 属于项目既有归纳。映射理由、完整源、N01–N06 不采用项沿用[方法审计](2026-10-21-bingus-methodology-audit.md)；这里只记录本动作可复核的增量，不把整项方法判为通过。

| 映射 | 本动作证据 | 本动作结论 |
|---|---|---|
| M02 合同/回放 | API 对 confirmed gate、exact revision、latest 与 idempotency 回放/冲突的测试；v1 在 v2 后回放仍返回 v1 和当前 latest | 本切片覆盖；没有建立全产品版本化黑盒合同快照 |
| M05 字段/来源边界 | exact EvidenceRecord revision/field 校验、公开来源 snapshot/sheet/cell 回读、未知键/type/大小/数组边界、物料/工序 unresolved typed schema 的测试 | 本切片覆盖所列输入合同；未审计其它导入格式 |
| M06 分层门禁 | 独立计划测试、既有 requirement/intake 回归和 system check 分开留 run | 本批后端门禁有证据；没有跑 release build、UI 或完整 workbench.tests |
| M10 隔离 PostgreSQL | runner 固定 owned pg-data/55435；最终唯一测试库和 run receipt | 本次后端测试隔离成立；没有验证所有外部 manager/provider 组合 |
| M12 版本/范围 | 本报告绑定当前文件哈希、run IDs、命令和明确范围 | 仅本报告范围可复核；不外推其它源码或安装包 |
| M13 安全异常 | receipt completion 后 RuntimeError/ValueError 故障注入；断言 503 通用错误、无哨兵文本且 plan/receipt 一起回滚 | 只验证本 API 的异常与事务边界；日志初始化/写入和 health receipt 仍未验证 |
| M15 入口 schema | 封闭 typed JSON、非法外部 ID、错误类型、超限拒绝的 API 测试 | 只验证 execution-plan API schema；不是通用集成 manifest 验收 |

## 阶段1原始文件快照与阶段1结束时 SHA-256

修改前已将既有文件副本和哈希保存在 `workspace/testing/execution-plan-20261022/before/manifest.json`。这些是本次开始时工作树状态，含先前切片的未提交修改；不是干净基线。

| 文件 | 修改前 SHA-256 | 当前 SHA-256 |
|---|---|---|
| `workbench/models.py` | `F5A41D3056C9FAD6D44D0CABF72A9B83FB4D61384DECE0DA54C8D5F1DF3CB6C7` | `A95B6CC40D3246419112C4C5B9D16BD8D2F9D9E74FEDCDE84A9AC89D53D89ECC` |
| `workbench/urls.py` | `B0864D1345FF00610E66449B4FAD2F3687125BDF31C8DD505FDF609008E1BA99` | `201AD67C85B33BAEC40A08B53BE3550BB62F75581D5FBF13286625BBB5C28626` |
| `workbench/requirements/api.py` | `8BEECF5BF946C18D1ECE93F8759C18D79BE6399220ED261D72E2C7F97345001F` | 本轮未修改 |
| `workbench/migrations/0008_production_requirement_drafts.py` | `6AC74D6B1E1EE8CD85FE3535EB6707B5F89EE251CEECE4D960607E024FF24C20` | 本轮未修改 |

阶段1结束时新增文件 SHA-256（阶段2最终值见外部阶段2 manifest）：

| 文件 | SHA-256 |
|---|---|
| `workbench/execution_plans/api.py` | `5A886197DFF2E046159354F2E430517E2F1850B59145BB52F1E197795D149366` |
| `workbench/execution_plans/schemas.py` | `88C345411CDBFADAEF4F5F83F176DEF6CD2502516D2113A43D49AE03557C02AB` |
| `workbench/execution_plans/service.py` | `154FCAAAF68740A6092027DD4FA66454CAB135921160D06506B10575B3F1B01F` |
| `workbench/migrations/0009_execution_plan_revision.py` | `A61D1B985ECB3A58058F8860D49FEF7FB4DD3F03CC894B2A99ADD58D5BD0F207` |
| `workbench/tests/test_execution_plan.py` | `EE565B8AA75FD62892D4EA62165A0F739FF698CBFD3C4B45BBCCF4176B43B1A5` |
| `docs/superpowers/plans/2026-10-22-execution-plan.md` | `B7ED1C0429EE31D65DC3A2872C3088AB732AA903CE45D98CC58F308AF0AFCE8D` |

## 阶段2增量核验：计划 UI、精确来源 DTO 与只读工具

以下内容是阶段2的追加记录，不重算或抹除阶段1的 backend 结论与失败历史。阶段1曾用 SQLite 内存 override 执行 `makemigrations --check --dry-run`；那只证明当时 SQLite 检查通过，不能视作 PostgreSQL 证据。本阶段移除该 override，在隔离 runner 的 PostgreSQL 测试上下文执行同一 dry-run；未生成 migration 文件。

- Django/PostgreSQL：命令 `node ...\run-django-tests.mjs test --test-db tradeloom_test_execplan_ui_final_20261022_01 workbench.tests.test_execution_plan workbench.tests.test_production_requirement`，run `2026-10-22T094426-713Z-52928`，exit 0，26 tests。DB 是新唯一库，host `127.0.0.1:55435`；stdout/stderr/result 及哈希已保存在本阶段外部证据目录。包含 exact confirmed revision DTO、创建/回放/GET、旧 plan 在需求更新后的来源固定性，以及 PostgreSQL上下文 migration autodetector dry-run。
- Node/DOM/DSH：candidate8 固定 `primary-runtime` Node 运行 `business-tools.test.js`、`capabilities.test.js`、`intake-ui.test.js`、`execution-plans-dom.test.js`；jsdom 30.1.3 与 ToolRuntime 验证库都从既有项目外运行时读取。最终复核 57/57 pass、0 skip、exit 0，run `phase2-node-audit-green-2026-10-22T0956Z-57`，stdout/result 与 SHA 在阶段2 review-final 外部证据包。覆盖需求dirty/保存状态、proposal空与显式0、正整数序列校验、精确lineage history及同上下文刷新乱序、不同需求的迟到响应、延迟POST期间冻结及成功反馈、409保留输入和显式重新读取、网络重试稳定请求键、来源文本安全显示、工具投影截断标记、主题token引用及动态能力发现。此结果不代表原生应用窗口或手机验收。
- 只读工具仅为 center/delivery 注册，通过动态 `ctx.tools.schemas(agent)` 在 capability 视图发现；严格 32hex 在执行入口验证、未知键拒绝、role gate 在 HTTP 前、固定 Django GET 和有限字段 projection。ToolRuntime 的JSON Schema子集不接受 `pattern` 关键字；故schema保持 object root + `additionalProperties:false`，ID格式仍由执行时严格校验并有角色/HTTP测试。
- DTO使用绑定 plan revision 的 `requirements.service.revision_payload`，不从 Draft.current_revision 替换历史版本；只返回需求值/来源引用有限字段，不带存储路径或文件名。UI使用独立 `execution-plans.js`，先于 intake defer 脚本安装监听；物料/工序永远显示为“人工提议·未核实”，实际到料/产量未记录。没有新增模型、迁移或外部请求。
- 保留的阶段2RED/失败：`2026-10-22T093402-455Z-50232` exit 1，首个新断言证实 exact requirement DTO 缺字段；后续修复后该模块通过。候选8 ToolRuntime 另拒绝 `pattern` schema（因运行时支持子集不包含该关键字），改为受支持闭合schema并保留严格执行时验证。最后审计定向 RED `phase2-node-audit-red-2026-10-22` exit 1，18/21通过、3个新用例失败（序列0被吞、POST未冻结表单、失败保存误发dirty=false）；同上下文history竞态和工具projection截断两项在该次RED之后加入并在GREEN通过。初次DOM断言遗漏文案、测试路径解析及断言对象引用问题属于夹具/断言错误，不作为产品RED。上述修正均未删测试或静默换运行时。
- 运行边界：没有迁移/触碰 55432、同步、服务重启、安装包构建、提交上传、ERP访问或真实资料写入。DOM、ToolRuntime adapter、API 单测不表示真实模型、原生 UI、手机或发布通过。阶段1业务事实边界与 M02/M05/M06/M10/M12/M13/M15 既有映射继续有效；此增量不把 UI/真实流程/发布标为已验证。

阶段2 touched-file 的 before/source hash、Focused diff 和原始 test result 由外部 manifest `workspace/testing/execution-plan-ui-tools-20261022/review-round2/manifest.json` 绑定；本说明自身哈希也记录在该 manifest，避免自引用。运行进度索引保存在机器私有 `workspace/runtime/tradeloom-harness/evidence/session-progress-20261022-api-intake.md`，不作为项目文档交付；首轮项目副本已归档于 `workspace/testing/execution-plan-ui-tools-20261022/private-index-archive/`。
