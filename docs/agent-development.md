# Agent 开发与接入

本文说明如何在现有工作台中增加一个 Agent 角色。它描述当前代码边界，不预设企业规则；现有角色逻辑是可替换的本地演示规则。字段约束、审核选项、业务判断与交付内容应先通过实际访谈确认。长期 Phase 0–7 目标保留。

## 当前角色契约

工作流角色位于 `workbench/agents/`，不是旧 capability API 的另一种写法。现有工作流角色包括 `center`、`product_profile`、`delivery_quality`、`market_customer` 和 `quotation`；后两个是不可用占位。真实执行角色遵循以下形状：

```python
class SomeRole:
    role_id = "example_role"
    available = True
    allowed_tools = frozenset()

    def input_schema(self) -> dict[str, Any]: ...
    def output_schema(self) -> dict[str, Any]: ...
    def execute(
        self,
        context: WorkflowContext,
        input_refs: dict[str, Any] | None,
    ) -> dict[str, Any]: ...
```

`ProductAgent` 当前返回 `candidate` 或 `needs_human`；`DeliveryQualityAgent` 返回 `ready_for_generation`、`needs_human` 或 `blocked`。这是现存演示契约，不是已确认的企业决策规则。角色只返回结构化结果与来源引用；编排器负责持久化状态、依赖、幂等和事件。它们不应自行把业务任务标为完成。

两个业务角色的 `input_schema()` 会在 `MockAgentRuntime.run_subtask()` 调用 `execute()` 前，按角色注册表中的声明实际校验；`output_schema()` 则在返回后、编排器保存 canonical result 前校验。两者共用 `workbench/agents/schema_validation.py` 的 Draft 2020-12 JSON 校验和标准 JSON 检查。输入 shape 错误返回带角色标识的安全 `InputContractError`，不包含验证器文本或输入值；可选扩展字段继续兼容。跨批、过期修订和完整批次范围仍由原有角色与 `WorkflowContext.validate_refs()` 检查。中心新计划的 input/output schema 来自同一角色注册表；已保存计划按原 JSON 回放。占位角色仍在输入 schema 校验前保留 `RoleUnavailable`。

当前两个业务角色要求 workflow/batch 标识及数组 ID 项是非空白字符串；数组允许为空，产品角色可选的 `product_revision_ids` 允许省略、null 或数组。交付角色保留原有七项 required 输入，`all_revision_ids` 可省略、null 或数组，其他额外字段保持兼容。这些 schema 只约束输入形状，不替代现有来源、身份或批次校验。

`workbench/agents/context.py` 底部的 `_TOOL_DEFINITIONS` 是九个确定性工具的实际可执行注册表，包含每个 `ToolDefinition`（描述、Draft 2020-12 JSON Schema 输入/输出和 handler）。`workbench/agents/tool_contracts.py` 集中定义这些描述/schema，并提供创建 `ToolDefinition` 的工厂。`RoleToolbox.call()` 先按可执行注册表判定未知工具，再按实际 `TOOL_ALLOWLIST` 判定权限，之后校验 kwargs、执行一次 handler 并验证其返回值；schema 失败使用安全的 `ToolInputContractError`（400）或 `ToolOutputContractError`（500），不会把验证器异常或数据写入错误消息。输入拒绝未声明字段；输出按实际 DTO 字段和类型描述，允许兼容扩展字段，修订 `snapshot` 保持自由 JSON object，既有字符串不增加业务值限制。`describe_tools()` 只返回本角色获准工具的 JSON 副本，省略 handler、context 与业务数据，可供未来模型接入读取元数据；它不启用远程服务，也不改变 `TOOL_ALLOWLIST` 的授权来源。

工具 Schema 复用当前环境已有的 `jsonschema.Draft202012Validator`，与角色结果校验使用同一依赖和版本；接口形状采用 MCP 工具定义中的 `name`、`description`、`inputSchema`、`outputSchema` 概念，但本地 `describe_tools()` 不实现 MCP 服务或协议。工具输入/输出契约只验证数据形状，不替代现有来源引用校验或角色权限检查。

最小接口形状示意如下。它只是未注册的文档 stub：没有业务判断、没有外部调用、没有工具权限，也不能直接加入当前固定计划。

```python
class ExampleRole:
    role_id = "example_role"
    available = False
    allowed_tools = frozenset()

    def input_schema(self) -> dict[str, Any]:
        return {"type": "object", "required": ["workflow_task_id"]}

    def output_schema(self) -> dict[str, Any]:
        return {"type": "object", "required": ["status", "source_refs"]}

    def execute(
        self,
        context: WorkflowContext,
        input_refs: dict[str, Any] | None,
    ) -> dict[str, Any]:
        raise NotImplementedError("stub 尚未接入")
```

## 注册、权限与数据来源

### DSH 原生 MCP / Skill 可见能力

Shell 顶部“查看 MCP 与 Skill 能力”调用固定的 `GET /tradeloom/agent-capabilities?role=...`。服务端只读取应用已有的该 role 会话绑定，并核对原生 live Agent 和 preset；它不会恢复会话，也不接受客户端传入 session ID。未绑定或依赖服务不可用时显示“未知/暂不可用”，不把空列表解释成无限权限。

能力窗口显示该 live Agent 当前可见的工具名称，以及以该 Agent scope/cwd 查询的 Skill 名称、简述、来源类别和调用策略。Skill summary 的路径、正文、资源目录及其他运行时元数据不会投影到页面。列表可能受长度上限截断，响应会明确标记。MCP 预设模块被声明只说明当前 preset 的组成；`mcp__...` 工具名只说明它当前对该 Agent 可见，两者都不证明服务器已连接、健康或调用成功。能力窗口也提供“已保存配置”页签，可按助手角色编辑受支持的默认项；保存后的配置用于新会话，当前运行会话保持原能力。窗口不列出所有全局插件，也不是完整 ACL 或独立 Skill 编辑器。

安装 MCP/Skill 插件是宿主级操作；它本身不会自动把能力授权给每个 Agent。“当前能力”页展示 DSH 提供的 scoped snapshot/工具 schema 与 preset 声明；“已保存配置”页签另行读取和编辑所选助手角色的受支持默认配置。实际可用能力仍由原生 preset、Agent scope 和宿主配置决定。添加角色仍应更新 `packages/tradeloom-shell/roles.js` 与对应原生 preset；不要为显示能力复制 session ID、preset 内部配置或第二套授权表。

`workbench/agents/registry.py` 中有两套分开的注册入口：旧 capability 用 `AgentRegistry.register(capability, executor)`，请求为 `AgentRequest` 并返回 `AgentResult`；工作流角色用 `WorkflowRoleRegistry.register(role)`，由 `build_workflow_role_registry()` 集中构建，运行时按 `SubTask.agent_role` 查找。新角色如果获准进入工作流，应在注册表增加实例，并编写独立契约测试。

当前实际执行权限边界是 `workbench/agents/context.py` 的 `TOOL_ALLOWLIST`：`RoleToolbox` 按 `role_id` 从该表取得允许集合，并据此拒绝未授权工具。角色类的 `allowed_tools` 是声明，目前与该表保持同步，但 `RoleToolbox` 不读取它；只改角色声明不会授予或撤销权限。可执行工具必须在 `_TOOL_DEFINITIONS` 注册。新增工具时要同步更新 `tool_contracts.py` 中的输入/输出 schema 与描述、`context.py` 中的 handler 绑定、实际 `TOOL_ALLOWLIST` 和相关角色的 `allowed_tools` 声明，并覆盖允许/拒绝路径测试。不要让角色直接访问任意 ORM、网络或文件系统，也不要为了单个角色扩成通用工具总线。

## Native DSH 业务工具

`packages/tradeloom-shell/business-tools.js` 通过原生 `ToolRuntime.register` 接入固定 Django API。preset 的 Cordis 行显式传入 `config.preset`：中心注册五个工具，商品只注册 `tradeloom_read_products`，交付只注册 `tradeloom_read_workflow_task` 和 `tradeloom_read_deliverables`；缺少或未知 preset 时不注册工具。执行时仍按 Agent preset 二次检查权限。商品缺失字段/版本、工作流状态/人工 review、交付版本与质量检查均来自现有 DTO。预览只返回固定字段、`requires_human_confirmation` 和 Agent 中心入口，不返回签名确认 token；工具不创建正式工作流，也不提交或应用人工审核。

注册按 Agent preset 的 scoped context 隔离。Pinned ToolRuntime 的源码和 scoped registry 测试确认同名工具可分别注册在不同 Agent scope，scope 内重复仍拒绝；scoped context 继承服务依赖 API，`webServer` 是宿主服务。因此三种 preset 都可在自身 scope 注册对应工具而不发生全局重复冲突。当前本地 fixture 验证 preset→工具集合；这不等于真实 DSH composer/E2E 验收。

HTTP 只连本机 `127.0.0.1:3090`，Host/Origin 来自当前 DSH Host 的受信 LAN IPv4 `:3088` 配置；POST 仍使用原 CSRF cookie 与 `X-CSRFToken`。另外，三个 native workflow POST 专用启动器生成的临时 `TRADELOOM_NATIVE_BRIDGE_KEY`，经 `X-TradeLoom-Native-Bridge` header 做恒定时间比较；只在受控 Host 与 Django 进程环境中共享，不放进模型参数、DTO、CLI 参数、日志或 manifest。缺失/无效密钥返回固定 403。普通业务路由与 CSRF 请求不附带该 header。该 key 证明的是同一次受控启动的进程配对，不提供同用户进程之间或恶意 Host 插件的隔离保证。它不是 native DSH/provider 凭据，也不转发 `Authorization`。`local_mock` dispatch 先读取工作流 API 的 server-side `dispatch_target`，只在 subtask 与当前候选一致时发送服务端生成的幂等键；该 DTO 不含 `resume_authority`，因此人工 apply 后也由同一服务端逻辑选择正确恢复键。HTTP fixture 验证不等于真实 DSH/Django/model 端到端验收。

工作流创建显式保存 `execution_mode`：`local_mock` 是兼容默认的本地规则演示；`native_dsh` 需在创建预览/确认时明确选择并绑定确认指纹。执行模式只选择已保存步骤由哪条路径执行，当前目标解析和工作计划仍来自固定规则，不是模型规划。`native_dsh` 不得调用旧 `dispatch`/`retry` 的 `MockAgentRuntime` 路径；失败、中断或响应未知时保留 `unknown`，不自动回退 `local_mock`、重试或再次派生专家。

原生中心工具按以下顺序协作：

1. 中心调用 `tradeloom_begin_native_workflow_assignment`，服务端持久化并返回 assignment、step、状态和冻结的 `advice_context`。该上下文只列服务端确定性检查得到的可建议字段或 `needs_human` 检查代码及精确来源 ID，不含产品原值、文件路径或内部指纹。只有返回允许新派生的状态时，中心才使用 DSH 原生 `subagent` 能力创建所选专家。
2. `subagent` 返回的 `subagentId` 后，中心调用 `tradeloom_bind_native_workflow_expert`。宿主侧从 live Agent context 读取 child ID、preset、parent 和 delegation depth；只有绑定成功后，中心才用 DSH `send_message` 将任务引用、冻结 `advice_context` 与提交要求原样传递给专家。重放或 `unknown` 状态不能触发自动再次派生。
3. 已绑定的商品/交付专家按各自读取权限检查来源，仅针对 `advice_context` 列出的目标调用 `tradeloom_submit_native_workflow_advice` 提交有界 typed advice，来源 ID 必须与上下文一致。Django 校验 assignment、来源及当前版本，由服务端确定性角色检查生成 canonical 结果；专家建议保持未确认，不能直接写产品事实、ERP 或声明交付已通过。未经程序验证的新事实进入既有人审流程。

这三个工具对应 `POST /api/workflow-tasks/{workflow_id}/subtasks/{subtask_id}/native-assignment`、`POST /api/workflow-tasks/{workflow_id}/native-assignments/{assignment_id}/bind` 和 `POST /api/workflow-tasks/{workflow_id}/native-assignments/{assignment_id}/submit`。完整来源引用不会截断；超过契约上限的 advice context 返回 `advice_context_too_large`（HTTP 413），并且不会保存 assignment。工具回执表示 assignment 已保存、child 已绑定或 typed advice 已接受，不代表 DSH child lifecycle 已结束。当前 Host 接缝无法证实实际 provider/model，相关字段记录为 `unknown`，不能以模型选择器中的配置代替执行证据。现有 pinned ToolRuntime/schema、合成 Host context 与 PostgreSQL 测试不等于真实 DSH Host、真实模型或 GUI 端到端验收；本轮没有付费模型调用。

`WorkflowContext.from_workflow()` 从 ORM 读取当前 `WorkflowTask`、关联批次的 `Product`、`TaskFile`，以及这些产品的当前 `ProductRevision`。角色通过 context 和 `RoleToolbox` 只读这些已限定来源；输入使用 `SubTask.input_refs`，结果的 `source_refs` 应指出实际记录 ID，避免复制或编造企业事实。跨批产品引用和过期修订由现有引用校验拒绝。

角色返回 `needs_human` 时，当前编排接缝可把角色已有的可解析待确认信号写成通用 `HumanReview` candidate，并把工作流暂停。候选只保留 issue identity、item reference、通用核对问题和经校验的来源引用；不预填审批选项/答案，也不改 Product/Revision。通用提交 API 只形成 `submitted` 回执；来源过期时拒绝提交，已提交回执按原时间和内容幂等回读。它不批准、不应用业务事实、不恢复工作流；具体 answer 字段、审批规则、事实修订和显式恢复仍是后续范围，等待访谈确认。

Task 13c1 的 Agent 中心表单复用现有 `POST /api/workflow-tasks`，只创建已保存计划和排队子任务；详情路由复用 `get_prepared_workflow()` / `serialize_prepared_workflow()` 展示已有记录。普通 pending 审核可提交 `{review_key, answer:{note}, reviewer}` 并得到 submitted 回执；`reviewer` 仍是未认证标签。Task13b-facts 为当前完整周期中的受支持事实增加独立 typed answer 与显式原子 apply：支持 `sku/name/category/material/size/color/english_name` 字面值及精确当前 Revision 确认；旧 Review answer/source 不改写，新 Revision 与 apply receipt 保留来源。Task13b-image-selection 歧义图片选择及 Task13b-missing-image 规范无图人工补图子批次已另行验收，具体 schema、上传凭据、冻结候选预览与来源校验见下文；其他图片/来源冲突仍阻断并待后续处理。apply 后复用原两条 SubTask，追加最新固定计划并要求用户逐步显式执行。Task13c2 在符合保存状态时允许用户明确运行一个本地模拟子任务；已验收的 `task16-17-recovery` 子批次增加了有上限的显式安全 retry 和 outcome-unknown interrupt 接管表单。应用不会自动调用 handlers、生成或批准交付，也不会自动完成工作流；旧进程和外部副作用仍可能发生。Task 16/17 整体与 Phase 4、Task13整体、完整 Task13c、Task12六类检测和Phase3仍未完成；通用重复 SKU 子批次已单独验收，其他冲突裁决与更多企业审核规则仍待访谈。

角色返回 `needs_human` 时，当前编排接缝可把角色已有的可解析待确认信号写成通用 `HumanReview` candidate，并把工作流暂停。候选只保留 issue identity、item reference、通用核对问题和经校验的来源引用；不预填审批选项/答案，也不改 Product/Revision。通用提交 API 只形成 `submitted` 回执；来源过期时拒绝提交，已提交回执按原时间和内容幂等回读。它不批准、不应用业务事实、不恢复工作流；具体 answer 字段、审批规则、事实修订和显式恢复仍是后续范围，等待访谈确认。

### Task13b-missing-image：人工补图回执

正常产品角色在无图时同时产生 `missing_field: 图片` 与 `no_image_candidate`；审核保存的完整来源证明仍指向原角色结果和 Revision。`POST /api/workflow-tasks/{workflow_id}/reviews/{review_id}/image` 接受单张 multipart 文件及 `review_key`、`idempotency_key`、`reviewer`；使用现有 5 MiB 上限和真实图片格式校验。成功只创建带 workflow/batch/review/product/revision/origin/file/hash 绑定的上传 WorkflowStep、TaskFile 与事件，不修改旧 Review/source、Product 或 Revision，不自动提交或调用 Agent。相同幂等键和指纹回放相同 receipt；同键不同文件名/字节/操作人冲突。数据库提交失败后保留的 owned 文件可供同字节重试复用，文件系统与数据库没有跨资源原子事务或后台 GC。

操作者随后明确提交精确答案 `{"type":"provide_image","upload_step_id":"..."}`，服务端重新校验原始来源、凭据归属和图片字节；提交仅形成审核回执。图片预览只读取该工作流已验证的补图凭据，且以媒体目录 containment、哈希和真实格式校验保护历史预览。显式 apply 才按整周期 Revision CAS 创建新 Revision，将人工补图来源写入新事实并恢复既有 Product→Delivery 子任务。后续 matcher 只消费已 approved、同批同产品且来源有效的人工补图；失效证据阻断，不回退 SKU 匹配。换图须用新幂等键；上传不代表用户确认。该子批次不定义其他图片冲突、企业规则或身份认证。

调用链与职责边界：

1. `MockAgentRuntime.run_subtask(subtask_id)` 根据当前保存的 SubTask 构造 `WorkflowContext`，按 `agent_role` 取角色并调用 `execute()`；该 runtime 层不自行持久化执行成功状态。
2. `WorkflowOrchestrator.plan_task()` 持久化中心计划、业务 SubTask 与依赖；`dispatch_subtask()` 管依赖检查、步骤 claim、幂等、结果/错误/EventLog；`resume_task()` 从已保存步骤继续。
3. 因此，角色实现只负责当前输入范围内的结构化处理；计划选择、状态转换和事件由 orchestrator 管。Agent 不互相自由聊天。

## 批内重复 SKU 检测与人工解决（Task 12–13 子批次）

产品角色按同一批次的全体当前产品快照分组；仅对比时去除 SKU 首尾空白，比较区分大小写。空 SKU 继续由既有 missing-field 信号处理。每个重复组中的每个产品各有一条 `duplicate_sku` HumanReview，服务端冻结原组 SKU、全部成员 Product ID 与各自 Revision ID；来源校验会重算并精确验证，客户端不能提交或改写组成员。

唯一 typed answer 为 `{type: "resolve_duplicate_sku", value: "..."}`。新答案去除首尾空白后保存为应用值，必须非空且不超过 120 字符；若要保留原货号，操作者需要重新输入。HumanReview 回执仍保存原始回答，包括空白字符。首个可用答案可提交，后续答案若与同周期已确定值或未参与审核产品的 SKU 冲突，则在提交前返回 409、保留 pending 和表单输入，允许纠正。普通说明和未知 JSON 仍按原 receipt-only 合同处理。

显式 apply 只接受完整的受支持审核周期，在任何 Product/Revision 写入前校验全批拟定 SKU 唯一，再执行既有整批 Revision/文件 CAS、事务内新增 Revision 与计划 append；原始 Review answer/source、旧 Revision 和 TaskFile 图片身份保持不变，并复用既有两条 SubTask 供操作者逐步执行。此功能不自动编号、合并商品或解决图片/来源冲突。

详情页展示冻结原 SKU 与成员 Product/Revision/name，冲突提交保留原输入及 reviewer 标签。当前工作台 CSS 发布参数为 `?v=bef27b63b2d2`；每次更新静态 CSS 时应更新固定 query 版本，正式部署 ManifestStorage 不属于本子批次。

本批验收证据：项目外测试目录中的 `finalaudit.json`、`receipts-before-apply.json`、`browser-acceptance.json`、`browser-downloads.json` 及对应实际截图。QA 只使用隔离库；正式库仅 GET 核验。原始证据不会随源码仓库上传。

## 保存计划的单子任务 dispatch

`POST /api/workflow-tasks/{workflow_id}/subtasks/{subtask_id}/dispatch` 接受唯一字段 `idempotency_key`（非空且最多 200 字符），先校验工作流存在和子任务归属，再通过薄应用服务恰好调用一次 `WorkflowOrchestrator.dispatch_subtask()`。调用不包外层事务，因此 handler 不会在 dispatch API 的额外事务锁内运行。不存在/不归属统一返回 404；非法 JSON、额外字段和错误 key 返回 422；进行中、幂等冲突、依赖/人审与状态门禁返回有稳定 code 的 409；执行失败在引擎写入失败步骤后返回不含内部异常的 500。

新执行只接受 queued 子任务与 queued/running 工作流；pending/submitted HumanReview、未完成或跨工作流依赖继续阻塞。已有同 key 步骤优先按引擎 replay 规则读取，不重跑角色、不重复 started event；已保存的 failed 步骤回读为 failed 状态，也不由普通 dispatch 创建新 attempt。详情页仅根据已保存状态、同 workflow 依赖与 unresolved review 数选择排序后第一个 ready queued 子任务；POST 仍会再次做服务端校验。固定 key 形如 `workflow:{workflow_id}:subtask:{subtask_id}`，方便浏览器刷新后重放同一逻辑调用。

dispatch 响应只包含持久化 workflow/subtask 状态、实际 WorkflowStep id/key/status/attempt/时间、canonical `result_ref` 与 `SIMULATED_MARKERS`。同一幂等键回放返回该键对应的历史 attempt 与结果引用，另附当前子任务状态。不返回 Step 内部快照或私有推理；HTTP 200 说明已返回调度记录，子任务可能仍在 waiting_human，WorkflowTask 也不会因两个角色结束而自动 completed。该入口不批准、不应用事实、不恢复、不重试、不生成文件。

## 有限重试与中断接管

`POST /api/workflow-tasks/{workflow_id}/subtasks/{subtask_id}/retry` 仅接受 `idempotency_key` 和 `expected_step_id`，显式启动一次追加 attempt；每个 SubTask 最多 3 次 attempt（首次加两次）。retry key 与其 `retry_of_step_id` 绑定，历史 key 在后续 attempt 已存在时仍返回原 Step；同 key 与不同 expected step 冲突。新 attempt 使用独立 WorkflowStep 和新幂等键，不重置子任务或覆盖旧 Step。SubTask.retry_count 是已追加重试次数。

只有最新 failed Step 持有明确 `retryable=true`、工作流为 failed/running、依赖完成、无 pending/submitted review，且 runtime 的 `supports_safe_retry is True` 时，服务端才 claim 新 attempt。通用 Exception、契约/来源/权限问题和角色 `blocked` 结果默认不可重试。重试不是后台循环；前端显示剩余次数，POST 会再次锁定并检查条件。MockAgentRuntime 当前两角色是本地只读计算，因此声明安全重试；未来 runtime 默认不支持，只有能保证重试安全的 adapter 才可显式 opt-in。

`POST /api/workflow-tasks/{workflow_id}/subtasks/{subtask_id}/interrupt` 接受 `expected_step_id`、操作者标签和备注，只能把当前最新 running Step 标为 failed/outcome_unknown；workflow 仍 running 时也会用既有状态转换记为 failed，并保存安全错误摘要和当前步骤。它不停止可能仍运行的旧进程，也不保证外部副作用没发生；不自动重试。之后的 retry 仍需安全 runtime。旧 handler 迟到成功或失败会在保存前被当前 attempt fence 拒绝。Step 内部 `result_snapshot` 保留每次执行 JSON；canonical ref 指向 `workflow_step:<id>:output_refs.result_snapshot`；GET 只返回明确白名单中的安全状态 metadata 和该次结果 ref，SubTask 仍保留现有最新 canonical result DTO。没有 schema migration 或新 runtime 依赖。真实文件 QA、业务审批和 WorkflowTask completed 仍由原门禁阻止。

## 通用审核提交回执

`POST /api/workflow-tasks/{workflow_id}/reviews/{review_id}/submit` 仅接受 `review_key`、非空标准 JSON `answer` 对象和非空 `reviewer` 字符串。`reviewer` 由本地操作者填写，是标签，不是认证身份。首个有效请求只把 HumanReview 从 `pending` 改为 `submitted`，同时保存用户提交内容、真实 `submitted_at`、请求指纹和服务端重新验证过的来源引用，并写一条短 `human_review_submitted` 事件。相同内容重放返回历史回执；不同内容不能覆盖。

来源验证使用审核记录中保存的 `source_conflict.source_refs`，客户端不能替换来源。验证 WorkflowTask、批次、所属 SubTask 与 canonical `needs_human` 结果，并复核当前 ProductRevision 与同批 TaskFile；baseline `revision_ids` 也必须仍是当前版本。锁顺序遵循 WorkflowTask → 批次 Task → 按 ID 排序的 Product → HumanReview → 修订/文件来源。`pending` 和 `submitted` 都是未解决审核，继续阻止派发、恢复和完成。GET 工作流详情列出保存的 reviews 并提供 `pending_review_count` / `unresolved_review_count`，不刷新来源、不执行角色。

此普通说明回执不会确认/修改 Product 或 ProductRevision，不会把 reviewer 标签解释为实名/已鉴权身份，也不会调用 Agent、批准或按业务答案恢复工作流。Task13b-facts 的 typed apply 已在显式单独操作中完成全周期 CAS、人审字段应用、新 immutable Revision、来源保留与固定两角色恢复准备。Task13b-image-selection 子批次另支持 `{"type":"select_image_candidate","task_file_id":"..."}`：仅从不可变 canonical 角色结果中的冻结候选选择一张；候选文件可通过只读 `GET /api/workflow-tasks/{workflow_id}/task-files/{task_file_id}/preview` 查看。提交仍只是回执，显式 apply 保留全批 Revision/TaskFile CAS，且只改获授权产品图片；新 Revision 的人工选择标记须与原 approved review、同批产品、snapshot 和候选 TaskFile 一致。后续 matcher 只使用已验证的所选文件，标记失效时 fail closed，不回退到 SKU 匹配。图片预览仅服务经验证的冻结候选或有效补图凭据，并校验 MEDIA_ROOT 内路径。规范无图项在没有有效 `provide_image` 回执且尚未显式 apply 完整周期前仍阻断；输入源变化及其他未知类型 note/image 继续阻断整批。TaskFile 保存来源元数据，不提供通用图片字节版本机制。Retry 计数只按显式错误 retry 增加，human resume 不消耗 retry budget。Phase 4 本地安全失败重试/中断接管是独立通用执行能力，不会把 submitted 答案自动当审批。Task13c1 与 Task13c2 页面子批次已验收，Task12–13 通用重复 SKU 子批次另行完成；完整 Task13c、Task13整体、Task12 六类检测与 Phase3 仍未完成。

当前计划被显式限制为 `product_profile → delivery_quality`，`_validate_plan()` 也校验这两个固定角色及其依赖。只把新角色注册到 registry 不会让它自动进入计划。新增业务角色时，要协同更新角色 `output_schema()`、`CenterAgent.plan()` 的计划与输入形状、orchestrator 的允许角色/依赖边界，并用真实返回结果覆盖持久化、状态推进和阻塞测试；输出状态集合应由角色 schema 声明，不再另抄一份 status 白名单。不要引入通用 DAG 或新增角色框架。业务内容待访谈后再定。

## 并行协作与独立验证

适合独立推进的边界包括：一个角色实现及其契约测试、受限工具实现及权限测试、runtime/orchestrator 接缝、页面只读摘要、文档。共享 `WorkflowContext` / `input_refs` / 输出状态、registry 或数据库迁移会影响多个模块；开始前先同步字段和兼容约束，按小批合并验证。此处只说明模块边界，不预设三名协作者的实际分工。

开始新的实现前，先查仓库是否已有同职责模块、契约和测试；再检索官方文档或成熟开源实现，确认其许可证、维护状态及与当前 Django/PostgreSQL 边界的匹配度，最后只适配必要部分并保留来源说明。用户允许将开源仓库下载到本地作只读参考，例如[luanyujia-workbench](https://github.com/mashanglinyu/luanyujia-workbench)；参考代码不等于可直接接入，先核对内容和许可证。当前研究结论见[固定版本适配笔记](research/2026-10-19-open-source-workbench-reference.md)。不要因此重写现有 UI、引入 Electron，或加入未经确认的外部 AI 服务。

针对角色与工作流的测试入口：

```powershell
$python = Join-Path $env:LOCALAPPDATA 'TradeLoom\python-env\Scripts\python.exe'
& $python manage.py test workbench.tests.test_roles workbench.tests.test_runtime workbench.tests.test_orchestrator -v 1 --noinput
& $python manage.py test workbench.tests.test_workflow_dispatch workbench.tests.test_workflow_dispatch_concurrency -v 1 --noinput
```

测试需使用项目外 Python 环境和 PostgreSQL 测试库。Django TestRunner 在任何数据库 setup 前要求显式 `TRADELOOM_DB_TEST_NAME`，值须与 `DATABASES.default.TEST.NAME` 完全一致、符合 `tradeloom_test_*` 格式并不同于业务库；缺失、错拼、默认 `tradeloom_test`、正式库或不匹配配置都会在触库前拒绝。TestRunner 还强制要求 `--keepdb`；省略此参数会在 Django 父类 setup/数据库 SQL 前抛出 `ImproperlyConfigured`，防止误删已有测试库。每次测试前仍须断言实际 `TEST.NAME` 与明确测试库名精确相等。数据库连接信息通过本机环境设置；密码只从项目外本地 pwfile 注入环境，不写入仓库、不打印。新增/更新 workbench 依赖时，使用项目外 TradeLoom Python 环境安装仓库 `requirements-workbench.txt` 中声明的依赖；不要修改旧 baseline 的根 `requirements.txt`。目标命令示例：`python manage.py test --keepdb workbench.tests.test_roles -v 1 --noinput`；全量命令：`python manage.py test --keepdb workbench -v 1 --noinput`。有限重试/恢复专项目标为 `workbench.tests.test_retries workbench.tests.test_recovery workbench.tests.test_workflow_recovery_api`；并发回归可一并运行 `workbench.tests.test_workflow_dispatch workbench.tests.test_workflow_dispatch_concurrency`。本批历史证据使用 `tradeloom_test_phase3_files`，不得照抄为其他环境的库名。变量模板见仓库根目录 `.env.example`；source-mode 启动和 runtime 准备请以[快速开始](quick-start.md)及[DSH 发行准备与升级检查](upgrade-harness.md)为准。旧计划文档保留当时的任务和环境记录，不作为当前运行配置权威。

## 真实交付文件服务（Task14–15-files 工作批次）

`workbench/delivery/` 是独立的确定性文件服务，不扩展 `DeliveryQualityAgent` 的工具或副作用。它在两个业务 SubTask 完成且当前 confirmed ProductRevision、计划来源、角色输入/结果和 TaskFile 图片引用完全一致时，冻结 revision snapshot 与图片字节，生成 `catalog.html`、`catalog.md`、`sample_checklist.csv`、`sample_checklist.json`，另保存 `quality_report.json`。HTML/Markdown、CSV/JSON 使用标准库转义/序列化；英文名必须来自已确认 snapshot，其他既有字段按来源值保留，不翻译或推断。

图片从 `MEDIA_ROOT` 内 TaskFile 的真实字节读取，验证格式后以内嵌 data URI 写入 HTML/Markdown，不能依赖 `/uploads`。PNG/JPEG/GIF/WebP 使用 Pillow `verify()` 后重新打开并 `load()`，限制单边 10,000 px、总像素 40 MP；SVG 仅接受基础 XML 与主动内容拒绝检查，放在 `<img>` data URI 边界，不作为 inline markup，也不宣称提供通用 SVG sanitizer。来源缺失、跨批、路径越界、损坏图片、字节变化或不支持格式都会阻断生成。

API `POST /api/workflow-tasks/{workflow_id}/deliverables` 接受 `{ "idempotency_key": "..." }`，`GET` 同路径读取已登记版本元数据。生成使用独立 `generate_deliverables` WorkflowStep；短事务 claim 后在事务外写 staging、落盘复读并执行四文件 QA，再短事务重锁来源和 WorkflowTask，原子登记五个 ArtifactVersion。文件根由 `TRADELOOM_ARTIFACT_ROOT` 配置，默认 `BASE_DIR/data/runtime/artifacts`；仅服务端生成静态文件名和 workflow/step UUID 路径。文件系统和数据库不共享事务，登记结局未知时保留文件、维持 running claim 并阻断重试/下载，后续需人工核对；不把纯读角色 `supports_safe_retry` 用于文件副作用恢复。

`POST /api/workflow-tasks/{workflow_id}/deliverables/{generation_step_id}/review` 接受 `{decision, reviewer, note}`，decision 是 `approve` 或 `reject`。这是交付文件包的通用审核入口，仅允许在 `waiting_human/review_deliverables` 且无 pending/submitted 业务审核时执行。Reviewer 只是本地标签，不是身份认证。决策事件记录精确生成 Step、五个版本 ID 与请求指纹；同 payload 回放无新事件，不同 payload 冲突。批准不会批准产品事实，也不自动完成；`POST /api/workflow-tasks/{workflow_id}/complete` 要求真实文件 QA/hash、当前来源、两业务任务、无待审事项、五版本 approved 以及绑定精确版本的 approve EventLog，全部成立才完成。

真实下载端点为 `GET /api/workflow-tasks/{workflow_id}/artifact-versions/{version_id}/download`，预览端点将 `/download` 换为 `/preview`（仅 HTML/Markdown）。服务先约束解析路径位于 artifact root，再校验登记文件存在和 SHA-256；下载用 Django `FileResponse` 返回固定附件名，预览使用 CSP sandbox。找不到版本/文件返回 404，哈希、来源或状态冲突返回 409。
## DSH 中心的结构化任务提案（2026-10-20）

DSH 工具 `tradeloom_preview_workflow_intent` 调用 `POST /api/workflow-intent/preview`，接收 `batch_id`、字面 `user_goal`，以及可选白名单 `task_type`：`prepare_product_data` 或 `generate_deliverables`（`workbench/intent/parser.py:17`）。省略 `task_type` 时继续使用原有限规则解析；字段存在时必须是上述值之一，显式 `null` 也会拒绝。结构化输入只生成现有计划预览，不允许任意 workflow 步骤或工具。

预览工具结果中的 `business_ui_url` 使用 `version: 1` 的 fragment handoff，字段固定为 `version`、`batch_id`、原样 `user_goal` 和 `task_type`，不包含服务端 `confirmation_token`。Agent Center 校验固定形状后仅预填现有表单；用户仍需手动查看/触发预览，再显式确认创建。不得从 fragment 自动创建或确认。若有未知创建结果，客户端用原冻结 payload、token 与 idempotency key 重试以取得原回执；用户明确选择保留的旧草稿在新提案成功后仍可恢复，未选择保留的草稿按既有清理行为处理。

代码证据位于 `workbench/api.py`、`workbench/intent/parser.py`、`workbench/agents/center.py`、`workbench/templates/workbench/agent_center.html`、`workbench/static/workbench/app.js` 与 `packages/tradeloom-shell/business-tools.js`；结构化字段、legacy 兼容、fragment handoff 与草稿恢复由对应的 intent、shell 和 JS 行为测试覆盖。历史源码全量 workbench 测试记录 324/324 通过，日志位于项目外测试证据目录，不随 clone 提供。这证明当时的本地契约，不证明当前 checkout 全量通过，也不证明真实 provider/LLM 始终配置或运行；业务 workflow 的历史界面验收使用 `local_mock/simulated_rules`。

## 工作流创建 API 的可选幂等回执

`POST /api/workflow-tasks` 接受可选 `idempotency_key`。不提供 key 的请求沿用既有创建服务，兼容旧客户端；提供时，API 拒绝 null、空白、非字符串或超过 200 字符的值。唯一 key 绑定当前 API 原样接收的 `batch_id`、`user_goal`、`task_type`（正文不 trim）的 SHA-256 请求指纹。相同 key 与指纹回放最初创建时序列化的完整公开 DTO，状态码仍为 201；跨批或改变目标/类型等任何指纹变化返回 409。Key 全局唯一，不以批次为作用域。计划创建和冻结 receipt 在同一数据库事务中提交；规划异常整体回滚，不占用 key。

回放优先于重新读取当前批次，因此即使原 Workflow 后来执行或其源数据变化，POST 仍返回原始创建 receipt。该 JSON 仅含创建时公开 serializer DTO，不含私有推理/身份信息，也不存于可变 `result_refs`。`GET /api/workflow-tasks/{id}` 每次实时序列化当前状态，两种视图有意不同。不要把创建回执误读为角色运行、审核批准或工作流完成。

Agent Center 在同标签页 `sessionStorage` 保存 payload/key，以便未知响应后的重试和 reload 恢复；成功只在收到有效 workflow ID 后确认并清除。用户编辑后还原未确认 payload 时继续使用原 key，不同 payload 在提交时才生成新 key。`sessionStorage` 被禁用时，当前页面仍可用内存保持原请求并显示“刷新后先查看任务列表”的提示；该降级不承诺刷新恢复，关闭标签页后也不承诺保留。服务端幂等不依赖此浏览器存储，旧 API 客户端仍兼容。

Migration `0003_workflow_create_idempotency` 为扩展迁移：新增三个 nullable 字段和唯一约束，旧行保留 NULL，不回填。新旧代码并行时旧 reader/writer 忽略新列；代码回滚后旧版本仍可读取旧/新行并创建 legacy 行。部署新代码前必须备份并先迁移 schema。本轮只在独立 QA 数据库实际应用该迁移；formal `tradeloom_dev` 未迁移，正式服务未部署。业务 plan 异常事务回滚已覆盖；数据库 migration rollback 未实测，也不删除新增列。

## 原生 DSH provider 与账号入口边界（2026-10-20）

产品目标是允许跨厂商、多模型配置，并可保存多组独立的 base URL、API key、model 与协议选择；本产品不使用 DeepSeek 官方账号登录。保留手动 API 配置、`llm-pi-ai` 与 API-key `llm-deepseek` 入口，用户选择的模型配置应保持可用。产品 Cordis overlay 只禁用 `deepseek-account` 和 `llm-deepseek-account`，不清除用户凭据、模型选择或全局配置。

生图和网页反向代理属于后续 adapter 能力；聊天多模态输入不等同于图片生成。兼容 OpenAI chat 协议的反代可考虑复用现有 custom provider 接口。native API 表单反馈 patch 已纳入 9-patch 源码集；安装后的该项行为及真实厂商 API 请求仍待验收，不证明任意厂商已连通。本地 `local_mock/simulated_rules` 也不是实际模型执行。

### 手动添加与选择供应商模型

在 DSH 的 provider 设置中为每个供应商单独创建配置，使用各自的 provider ID、协议、base URL、model ID 和 API key；兼容 OpenAI chat 协议的反代可按其协议填写独立配置。保存后在原生 Model 设置或聊天输入框的模型选择器中选择该 provider/model；若要作为默认选择，使用原生模型选择器的保存/默认操作。不要通过 DeepSeek 官方账号入口登录。

当前源码 patch 仅改善 provider 表单的保存、缺项校验与错误反馈，相关 UI 组件测试和 TypeScript 检查通过；没有使用真实 key 或网络请求验证供应商连通。图片生成需要独立 adapter，不能用聊天多模态输入代替。

## 协作 envelope 与扩展 adapter

`GET /api/workflow-tasks/{id}` 在原有工作流响应旁增加 `collaboration` v1 投影，契约见 `contracts/collaboration-envelope-v1.schema.json`。它只包括当前任务的状态、审核状态、最多 100 条 EventLog 元数据和原有 `result_refs`；消息不包含 `payload_summary`，不复制 DSH 原生聊天。`error` 只发布固定安全摘要，未知错误文本使用通用说明。旧顶层字段保持兼容；此 DTO 不改变执行、重试或人工确认状态机。

新扩展能力应实现 `workbench/agents/adapters.py` 中对应的 `ImageGenerationAdapter` 或 `WebModelBridgeAdapter` Protocol，并由服务端显式注入 `AdapterRegistry`。默认 registry 不发现插件、不访问网络，能力状态为 `not_configured`；对象被注入也只表示 `configured_unverified`，不能据此宣称真实供应商可用。只有增加经过验证的 health 与调用契约后，才可报告 `ready`。adapter 的请求应使用应用内部类型，凭据由服务端配置注入，不能出现在 URL、DTO、日志或 repr 中；不要把 DSH provider 或聊天多模态输入当作生图/网页模型桥。

```python
class ExampleWebModelBridgeAdapter:
    def complete(self, request: dict[str, Any]) -> dict[str, Any]:
        # 在独立实现中校验输入、调用明确配置的服务并返回受限结果。
        ...

registry = AdapterRegistry(web_model_bridge=ExampleWebModelBridgeAdapter())
```

网页模型桥 Protocol 只是扩展接缝；该名称不表示现有 native DSH 聊天已接通网页浏览能力。注册示例仅说明依赖注入边界，不会自行启用网络调用或改变当前默认 `DEFAULT_ADAPTER_REGISTRY`。

## 模块接入边界

- **桌面 Agent 身份：** `packages/tradeloom-shell/roles.js` 是顶部助手选择器使用的 shell role 真相源。新增一个可独立打开的 shell Agent，至少要在该文件加入 `id`、已注册的 DSH `preset`、公开 `label` 和聊天标题 `assistantLabel`；`ROLE_IDS`、`ROLE_PRESETS`、`ROLE_LABELS` 与 `/tradeloom/scenes` 的安全元数据会从定义派生，Host 随后按 role 创建各自的 workspace/session。只在 DSH 中声明 preset 不会让它出现在菜单。不要把 provider/model 绑定成 Agent 身份；模型目录仍由 DSH 当前 session 提供。

  本仓库的原生 preset 定义位于 `packages/tradeloom-shell/cordis.patch.yml` 的 `insert` 项中。下面保留现有 overlay 的真实字段形状；添加时使用新而唯一的 entry id 和 preset id，并按该 preset 实际需要配置 plugin。不要照抄中心的委派配置，也不要在 persona 中写入未确认的企业规则：

  ```yaml
  - insert:
      - id: tradeloom-example-preset
        name: '@deepseek-ai/dsh-agent-preset'
        config:
          id: tradeloom-example
          name: 示例助手
          description: 通用助手 preset。
          order: 7
          plugins:
            - id: business-turn-limit
              name: '@tradeloom/dsh-business-shell/step-policy'
            - id: persona
              name: '@deepseek-ai/dsh-persona'
              config:
                prefix: 只依据用户提供或当前 Agent 明确可用的能力工作；不编造事实。
  ```

  对应的 shell 声明如下；`preset` 必须与原生 preset 的 `config.id` 完全相同：

  ```js
  Object.freeze({ id: 'example', preset: 'tradeloom-example', label: '示例助手', assistantLabel: '示例助手' }),
  ```

  新角色注册并部署后，可在顶部“选择助手”菜单中打开“查看 MCP 与 Skill 能力”，再在对话框的“查看助手”选择该角色，进入“已保存配置”编辑：在此配置 stdio 或 Streamable HTTP MCP、是否包含默认 Skill 目录及“本项目相对目录”字段指定的 Skill 目录，并设置工具拒绝项。凭据只填环境变量名引用，不填写明文 Key。插件仍在织贸助手所用的 DSH profile 中统一管理，不要为每个 Agent 重复安装插件。

  保存会更新该角色的新 Agent 默认配置；应用配置时可能立即校验或连接 MCP。已运行会话继续沿用原有能力。保存成功后，使用“用已保存配置新建对话”，再回到“当前能力”核对该会话实际可见的工具与 Skill。没有绑定会话时，能力显示为未知；已保存默认配置不证明 MCP 已连接或外部调用成功。若编辑器发现当前配置含有它不管理的条目，会以只读方式显示；保留该配置，不要删除或覆盖这些条目。

  加角色不会自动授予 TradeLoom 工具。`packages/tradeloom-shell/business-tools.js` 先按工具的 `TOOL_ACCESS` 集合筛选注册项，再在执行时按 live preset 检查；新 preset 默认不会继承现有工具。如果确实需要某个既有工具，只把新 preset 加入该工具对应的集合，并为允许和拒绝路径更新测试。例如下方改动会明确把现有商品只读工具授权给新 preset，未作此决定时不要添加这一行：

  ```js
  tradeloom_read_products: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.example]),
  ```

  配置面板中的工具拒绝项只会进一步限制当前 Agent，不能替代 `TOOL_ACCESS` 给新角色授权业务工具。

  顶部助手菜单的注册测试在 `packages/tradeloom-shell/tests/shell.test.js`，它逐项断言角色定义与派生映射；添加角色时同步更新契约期望。`business-tools.test.js` 覆盖工具集合及未授权拒绝。当前没有独立的 Agent 示例 dry-run 验证器。shell role 与 Python `WorkflowRoleRegistry` 是不同 ID 域；只添加顶部聊天角色不会把它加入工作流计划。需要让中心通过原生 subagent 委派时，还必须显式更新中心 preset 的 `allowedAgentPresets`；非中心 preset 不会因此获得委派权。

- **场景和业务面板：** `packages/tradeloom-shell/scenes.json` 登记 scene、各自独立保存的布局、默认业务 route 与 panel 类型。每个 scene 的 `roleId` 指定默认助手；用户切换助手只更新当前 scene 的角色映射。下面是当前配置中完整有效的“工作总览”场景对象，保留了 `icon` 与 4×4 初始几何：

  ```json
  {
    "id": "center",
    "label": "工作总览",
    "icon": "⌂",
    "roleId": "center",
    "defaultBusinessRoute": "/home",
    "panels": [
      { "id": "business-main", "type": "business-iframe", "title": "总览", "path": "/home", "col": 1, "row": 1, "w": 3, "h": 2 },
      { "id": "auxiliary", "type": "business-iframe", "title": "商品", "path": "/products", "col": 4, "row": 1, "w": 1, "h": 2 },
      { "id": "reference", "type": "business-iframe", "title": "资料", "path": "/artifacts", "col": 1, "row": 3, "w": 1, "h": 2 },
      { "id": "native-chat", "type": "native-chat", "title": "中心助手", "col": 2, "row": 3, "w": 3, "h": 2 }
    ]
  }
  ```

  这是场景条目，不是完整 `scenes.json`；新增业务 scene 时还要在根对象的 `businessRoutes` 中为受支持路由登记唯一目标。`type` 必须由 shell 已有 panel registry 支持，业务 path 必须在受限路由集合内；几何字段使用源文件的 `col`、`row`、`w`、`h`。持久布局按 scene id 隔离。新增场景不意味着能提供未实现的业务能力。
- **工具权限：** `packages/tradeloom-shell/business-tools.js` 用对象 schema 声明固定工具输入，`TOOL_ACCESS` 按现有 preset 显式授权。新工具必须同时有参数校验、固定 Django route、后端输入/来源校验和未授权角色回归；未知 preset 默认拒绝。工具名或公开角色列表不能单独作为授权依据。
- **工作流角色：** `workbench/agents/registry.py` 中的 `WorkflowRoleRegistry`、`agent_role` 与 DSH shell role 是不同 ID 域。只有 WorkflowTask 编排/执行角色使用 Python registry；不能因桌面菜单新增一个 Agent 就自动进入 workflow 计划。
- **业务数据：** Django/PostgreSQL 保存本地 workflow、审核、产品资料修订、交付版本及 ERPNext 外部引用。ERPNext 保存 ERP 主数据和单据；适配器在 `workbench/erpnext/`，走服务端注入配置和白名单只读 API。未部署时 status 为未配置，不伪造记录或调用成功。
- **协议与示例：** 跨模块公开状态使用版本化 DTO/schema；不要把原生聊天历史、凭据、原始异常或 EventLog 私有 payload 复制进协作接口。`contracts/collaboration-envelope-v1.schema.json` 是当前只读协作 envelope 示例；图像生成和网页模型桥须实现独立 adapter Protocol，聊天多模态不是这些 adapter 的替代品。样例数据必须留在 `data/samples/` 并明确标注为演示数据。

新增模块应先定位当前 source of truth、契约测试和受限注入/权限边界，再添加一个能独立验证的最小能力。不要为示例或文档引入新的角色分工、未经访谈的业务规则、第二套 provider/session 状态或通用 SDK。

### 叙述来源与候选证据（Slice1 后端契约）

`NarrativeSourceVersion` 用不透明 ID 和 SHA-256 标识不可变内容版本；相同 SHA 上传复用已有记录，`display_name` 仅供界面辨认，不依据文件名推断历史版本或关联。叙述原件保存在 DataRoot 私有目录。`EvidenceRecord` 只接受 `product_identity`、`commercial_source`、`production_instruction`、`labor_analysis` 四类候选 schema 中的字段；记录状态固定为 `unverified`。操作者叙述只保存 `summary_only` 摘要和来源行范围，不声称为已核实事实；团队假设必须引用同一候选的输入证据，系统推导必须给出 `rule_id`、`rule_version` 与输入证据 ID。当前没有自动业务规则执行器，因此这些记录仍是 `unverified`。证据以追加 revision 保存，`(candidate, field, kind, revision)` 唯一；来源单元格必须与该字段已保存的映射来源精确一致，输入证据须属于同一候选且字段有效。

只读集合接口为 `GET /api/intake/narratives?offset=&limit=` 和 `GET /api/intake/candidates/{candidate_id}/evidence?offset=&limit=`；仅接受单个 `offset`、`limit` 参数，`limit` 为 1–100、`offset` 为 0–100000，并返回 `next_offset`。候选详情保持既有 DTO，不内嵌无界证据列表。写入沿用同源/CSRF 与幂等键约束；来源及证据回执不包含文件路径或原始单元格内容。新增叙述上传的来源行和回执在同一数据库事务内完成；原有 XLSX `upload_source` 仍先写来源、再完成回执，二者并非同一事务，失败恢复仍是已知遗留限制。

以上是后端契约，不代表当前桌面已有访谈上传界面。迁移 `0007_narrative_evidence_sources` 尚未应用到主数据库；当前运行产品不能据此宣称可在界面上传或浏览这些记录。

