# 执行计划来源参考实现计划

**目标：** 允许人工从既有 commercial_source / labor_analysis 导入候选中选择来源格，创建并关联未核实 source_record，并将有界来源投影冻结在新增执行计划版本中供历史回溯。

**架构：** 复用分页候选 API、候选字段 provenance 和现有 append-only EvidenceRecord API。执行计划新增 optional `supporting_source_inputs`，服务端校验 candidate、字段、snapshot、hash、坐标与 source_record 精确绑定后，把 typed cell/state 与原始值、公式、缓存值的引用冻结到计划 JSON；历史读取只返回冻结内容。

**技术栈：** Django / PostgreSQL JSONField，现有 Workbench vanilla JS，指定 Node.js + runtime8 依赖与 pinned jsdom 测试运行时。

**接口契约：** 每个物料/工序可带 `supporting_source_inputs: [{candidate_id, field_key, evidence_ids}]`；数组为空时可省略以兼容旧请求。只接受 `commercial_source`、`labor_analysis` 候选及属于该候选字段的 `source_record` EvidenceRecord；拒绝不存在、跨候选/字段、非 source_record、snapshot/source hash/provenance/坐标不匹配的引用。冻结项包含 candidate id/type、mapping revision、source SHA-256、snapshot id、field key、evidence id/status、sheet index/coordinate、typed value/state，以及指向不可变 SourceCellSnapshot 的原值/公式/cache refs；不复制整个 workbook、不冻结文件路径、不重算历史、不推断商业角色、价格性质或计件/工时口径。缺值、显式 0、公式错误分别保持原状态。任何有界值发生截断时必须写明 truncation marker；身份 refs 不截断。

## 实施切片

1. 在 `workbench/tests/test_execution_plan.py` 增加 API RED：合法 commercial 与 labor 来源冻结、错误绑定拒绝、null/0/公式错误保留、后续新来源不改历史，以及幂等重放/冲突和旧请求兼容。
2. 在 `workbench/execution_plans/schemas.py`、`service.py`、`api.py` 实现 bounded 请求校验、严格绑定与 plan JSON 冻结；复用单元测试覆盖服务拒绝和历史投影。
3. 在 `packages/tradeloom-shell/tests/execution-plans-dom.test.js` 增加真实 jsdom RED，覆盖按需加载、candidate/field/cell 选择、证据创建后请求关联、历史回溯，以及切换时 stale response 和失败重试。
4. 在 `workbench/static/workbench/execution-plans.js`、`artifacts.html` 与样式实现折叠选择器；新建 `supporting_source_inputs` payload，仅保存成功创建的 source_record id，保存失败时保留未关联证据并沿用同 body 幂等键。
5. 使用指定私有 runner 与全新 `tradeloom_test_<freshuniq>` 执行明确 Django 模块；用 pinned Node runtime 运行 DOM 测试，最后 `git diff --check`。

## 边界

- 仅合成来源；不改 migration、native bridge、launcher、DSH 底座或已发布 checkout。
- 不修改/解释未知商业或劳动语义；reference 不构成订单、产品、采购价或实绩确认。
- 不调用真实 Host/ERP、远端服务、付费模型，不运行两个 opt-in HTTP E2E 模块，不触碰业务数据库。
- 收尾报告说明隔离 PostgreSQL/合成 Node 证据与未验证的真实 Host/UI 行为边界。
