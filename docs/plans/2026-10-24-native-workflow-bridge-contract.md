# Native DSH 工作流桥：实现契约

本计划只把宿主已观察到的原生中心/直接专家结果接入现有持久工作流；它不证明子代理已结束，也不把自然语言当作事实凭据。`local_mock` 仍是显式演示路径，`native_dsh` 必须由用户选择并绑定确认指纹；原生调用失败、超时或中断时记录 `unknown`，不自动回退、不自动重试。

## 契约

- 复用 `WorkflowStep` 的 attempt、idempotency key、输入/输出 refs 与现有 fencing；不增加调度器或数据库表。Mock 与原生结果共用 claim、依赖、校验、人审、恢复与交付门禁。
- 只有根 center 上下文可开始 assignment。assignment 固定 workflow/task/batch、step/attempt、中心 session/agent/preset、预期专家 preset 和输入 refs。只有 assignment 成功保存后，center 才能调用既有原生 `subagent` 能力。
- 中心在原生 subagent activation 返回 child ID 后，先调用 center-only bind 工具。bind 从 `ctx.agents.get(childId)`重新读取 Host 当前 child ID、preset、parent 和 delegation depth，校验其为该 assignment center 的直接子代理且 preset 与角色匹配，再原子绑定唯一 child；相同绑定重放稳定，其他 child 冲突。child 可在 bind 前启动，但中心只能在 bind 成功后向其发送提交指令。
- 专家通过 typed submit 工具提交 `assignment_id`、`step_id` 和 schema 化 result。身份、父 session、preset、delegation depth 仅从真实 ToolRuntime 上下文读取，绝不接受模型参数自报；服务端要求提交者已与assignment绑定。业务提交成功表示 typed result 已被工作流接受，不表示 DSH child lifecycle settled。provider/model 当前不可观测时均记 `unknown`。
- begin 在确定性角色校验后冻结 `native-advice-context.v1`：商品角色只投影产品 ID、可建议的缺项字段与 `product_id/revision_id/task_file_ids`；交付角色只投影确定性检查中 `needs_human` 的 code、可选产品 ID及 workflow/batch/product IDs。投影随 assignment 保存并经 begin 回执交给中心，再由中心原样转交已绑定专家；不包含产品原值、文件名/路径、候选详情或内部指纹。完整来源引用不可截断：商品建议最多 100 项、每项来源文件 ID 最多 30 个，交付建议最多 100 项、来源产品 ID 最多 1000 个；超限返回 `advice_context_too_large`（HTTP 413）且不保存 assignment。工具只接受与该上下文完全一致的 typed advice，提交时服务端仍重新计算并校验当前来源。
- 三个 native POST 接口额外要求启动器每次启动生成的临时 `TRADELOOM_NATIVE_BRIDGE_KEY`，经 `X-TradeLoom-Native-Bridge` header 验证；仅 Host 与 Django 子进程通过进程环境共享，不进入 URL、CLI 参数、模型 DTO、日志、manifest 或持久配置。缺失/错误密钥 fail closed；普通业务 GET/POST 与 CSRF 流程不变。它只区分本次受控启动的两个进程，不是对同一用户权限、恶意本地进程或 Host 插件的密码学隔离承诺。
- CLI 启动先生成一次并分别传给 Django 与 Desktop；受管 Desktop bootstrap 复用其继承密钥，缺失时拒绝启动。独立 staged bootstrap 自行生成一次并传给两侧。installed bootstrap 同样生成一次，但 PostgreSQL 控制器和 init/check/create helper 使用不含此密钥的基础环境；仅 Host 与 Django 获得它。
- 专家提交是有界建议/观察，不是 canonical 业务结果。服务端按既有 `RoleToolbox` 重算 canonical 校验结果，再复用 `_record_result`。Product 建议仅映射到已有 review 字段并生成待人工回答卡，不预填为已确认；不支持的建议安全拒绝。Delivery 的模型意见只作旁注，`ready` 与 `generation_intent` 必须由服务端确定性检查生成，且 `artifacts_generated=false`、`artifact_quality=not_evaluated`。模型永远不能据此写 Product、intake 或 ERP。
- 每次提交都校验角色 schema、workflow/task/batch、source refs 归属和当前 revision fencing；模型声称 `ready` 不能绕过确定性校验。未经程序证实的新事实进入既有人审。通过 `_record_result`、`HumanReview`、fact application 与 `resume_authority` 继续流程。原生交付仍受原 readiness 和人工门禁约束。
- 同 assignment、同规范化结果重放返回冻结回执；不同结果、不同 child 或过期 attempt 冲突。取消/中断只记录未知状态，不声称子代理已停止。原生/模拟 marker 与 DTO 必须诚实区分。

## 实施与验证步骤

1. 为模式选择/确认指纹、持久 claim 与 typed submit 补真实 PostgreSQL RED；先跑 workflow dispatch/recovery 基线。
2. 抽取最小共享 claim/completion seam，使既有 Mock 路径继续使用同一 CAS 与人审规则；实现 native assignment/submit、冻结回执和明确 unknown 状态。
3. 增加 Host context/ToolRuntime schema 与 ACL 回归，覆盖错误父级、preset、sender、深度、重放、旧 attempt、跨 batch/source/revision 和失败不 fallback。
4. 覆盖 typed proposal → 既有人审/事实应用 → 授权 delivery；使用合成 refs，不请求付费模型、不写真实业务库。
5. 使用专用 PostgreSQL 55435 guarded runner 和 pinned ToolRuntime 离线验证。真实桌面 Host、真实模型执行和 GUI 流程不在本轮验收范围。
