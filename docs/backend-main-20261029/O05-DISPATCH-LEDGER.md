# O05 派单台账：后端切片

本候选在独立 `codex/feature-additions` worktree 中实现；未合并到共享前端、未部署，也未标记 O05 整项完成。

## 合同

- `POST /api/dispatches` 创建 `notification` 或 `action`。请求含 `actor`、`recipient`、`idempotency_key`、`source`、`requirement`。成功首次创建为 `202`、状态 `queued`；相同发送 session/key 和相同请求重放为 `200` 并返回同一 ID；相同 key 的不同请求为 `409 idempotency_conflict`。同 session 的 agent/preset 若与原记录不同，返回 `403 dispatch_sender_conflict`。
- `POST /api/dispatches/inbox` 用执行身份读取 `inbox` 或 `outbox`，支持 `offset`、`has_more`、`next_offset`。收件箱只列待处理的 `queued`/`claimed` 记录；发件箱列该 session 的记录。
- `POST /api/dispatches/{id}/claim` 由收件方 session/agent/preset 接单。通知被接收后进入 `acknowledged`；action 进入 `claimed`。同一收件 session 已有被接收的 action 时返回 `busy`，新任务保持 `queued`。每个收件 session 的 claimed action 另有数据库唯一约束，避免并发重复认领。
- `POST /api/dispatches/{id}/receipt` 仅接受收件方对已 `claimed` action 提交 `completed` 或 `failed` 与非空结果。完全相同的回执重放返回原记录；不同回执返回 `409 receipt_conflict`。通知不能用 action 回执关闭。

错误码包括 `native_bridge_forbidden`、`invalid_request`、`invalid_actor`、`dispatch_sender_conflict`、`idempotency_conflict`、`dispatch_not_found`、`dispatch_recipient_forbidden`、`dispatch_closed`、`dispatch_not_claimed`、`receipt_conflict` 和 `dispatch_store_conflict`。

## 最小调用与 DTO 示例

以下标识、时间和内容均为合成示例。业务工具参数不包含 `actor`、收件 session 或 preset；Node 从当前执行上下文及 live agent registry 补入这些字段。Host 按既有 CSRF bootstrap、可信 origin 与私有 bridge header 调用固定 Django 路由；示例不包含任何 bridge key。

创建工具调用：

```json
{
  "idempotency_key": "wf-123-product-review-1",
  "kind": "action",
  "recipient_agent_id": "agent-product-demo",
  "source": "workflow:wf-demo-123",
  "requirement": "请核对产品资料并提交结果。"
}
```

首次 Django `POST /api/dispatches` 响应为 HTTP `202`，业务数据如下；该创建只排队：

```json
{
  "dispatch": {
    "id": "0123456789abcdef0123456789abcdef",
    "kind": "action",
    "status": "queued",
    "sender": {"agent_id": "agent-center-demo", "session_id": "session-center-demo", "agent_preset": "tradeloom-center"},
    "recipient": {"agent_id": "agent-product-demo", "session_id": "session-product-demo", "agent_preset": "tradeloom-product"},
    "source": "workflow:wf-demo-123",
    "requirement": "请核对产品资料并提交结果。",
    "delivery_result": {"state": "queued"},
    "receipt": null,
    "created_at": "2026-10-30T10:00:00+00:00",
    "updated_at": "2026-10-30T10:00:00+00:00",
    "claimed_at": null,
    "closed_at": null
  },
  "replayed": false
}
```

四个工具的成功输出遵循既有 `TOOL_OUTPUT` 包装：`ok=true`、`data` 是上述工具数据的 JSON 字符串、`requires_human_confirmation=false`、`business_ui_url=""`、`error_code=""`。create 重放时 `data` 中的 `replayed=true`，并返回同一 `dispatch.id`。

接收方的顺序是 `tradeloom_dispatch_list({"view":"inbox"})` → `tradeloom_dispatch_claim({"dispatch_id":"0123456789abcdef0123456789abcdef"})` → 执行动作后 `tradeloom_dispatch_receipt({"dispatch_id":"0123456789abcdef0123456789abcdef","status":"completed","result":"已核对产品资料。"})`。list 的业务数据形状为 `{"view":"inbox","items":[<完整 dispatch DTO>],"has_more":false,"next_offset":null}`；有更多记录时使用返回的整数 `next_offset` 请求下一页。action claim 的业务数据为 `{"result":"claimed","dispatch":<完整 DTO>,"replayed":false}`；忙碌时为 `result="busy"` 且 DTO 仍为 `status="queued"`。receipt 的业务数据为 `{"dispatch":<完整 DTO>,"replayed":false}`，最终 DTO 的 `status` 与 `delivery_result.state` 均为 `completed`，`receipt` 为 `{"status":"completed","result":"已核对产品资料。"}`，并带非空 `claimed_at`、`closed_at`。若 kind 为 notification，claim 的 `result` 是 `acknowledged`，最终 `receipt` 是服务端记录的 acknowledgement。

完整 DTO 字段为 `id`、`kind`、`status`、`sender`、`recipient`、`source`、`requirement`、`delivery_result`、`receipt`、`created_at`、`updated_at`、`claimed_at`、`closed_at`。sender/recipient 均含 `agent_id`、`session_id`、`agent_preset`；`receipt` 与未发生的 `claimed_at`/`closed_at` 可为空。`delivery_result.state` 会随记录写入 `queued`、`claimed`、`acknowledged`、`completed` 或 `failed`。回执由收件方/执行方提交，是其自报结果证据，不代表后台独立观察或验证 AI 已执行。

## 身份和投递边界

`tradeloom_dispatch_*` Node 工具不接受 sender/recipient session 或 preset 参数。sender 从真实 `exec.agent.id`、`exec.agent.session.id` 与 session header 生成；recipient agent ID 先经当前 Host 的 `ctx.agents.get()` 解析，再从 live agent session 取 ID 与 preset。Django 请求沿用现有可信 Host、CSRF bootstrap 和 `X-TradeLoom-Native-Bridge` gate。Django bridge key 只认证 Host 进程；不是对单次 agent execute 的独立签名。Actor metadata 来自 Node execute 闭包，后端会逐字段校验并对 sender/recipient 做精确匹配。

创建只写 `queued` 台账，不调用或调度收件 agent。收件方通过 list/claim 拉取；没有自动轮询、自动催办或计划任务。`delivery_result` 依状态记录排队、认领/确认及最终 `completed`/`failed` 阶段；`receipt` 是收件方/执行方自报的结果证据，不是后台独立验证 AI 已执行的证明。

## 验证

- Django 使用本轮唯一临时 PostgreSQL 集群和 `tradeloom_test_o05_dispatch_20261030`，执行 `manage.py test workbench.tests.test_dispatches --keepdb --verbosity 2`：8/8 通过。覆盖 bridge 拒绝、actor/schema 校验、创建/幂等、同 session 不同 agent 重放拒绝、inbox/outbox 分页、忙时保持 queued、收件人匹配、通知确认、action 回执隔离和重复冲突。
- `manage.py makemigrations workbench --check --dry-run`：exit 0，`No changes detected`。
- Node `business-dispatch-tools.test.js` 与既有 `tool-schemas.test.js`：8/8 通过。Node 测试实际调用注册后的 execute handler 并通过真实 loopback HTTP transport 到本地合成响应服务；它不是 Django/PG 联调，也不是实际 Cordis Host AgentLoop 运行。
- 临时 PostgreSQL 正常停止 exit 0，精确 data root 的最终 `pg_ctl status` exit 3。首轮整段 PowerShell 命令在临时 PG 启动后未进入 Django 测试，已保留启动记录；首次 Django 测试有 3 个测试装配错误（bridge 用例未传错误 key、两个 JSON DTO 被误当 ORM 对象），修正后同一隔离数据库 8/8 通过。它们不是产品失败，不把首轮记为通过。

详细安全输出及原文件备份见 [`recovery-20261029/o05-dispatch-ledger-20261030`](../../recovery-20261029/o05-dispatch-ledger-20261030)。本切片尚未证明真实生产 Host 注入、UI 菜单/消费者、收件 agent 自动启动或端到端模型执行；原 O05 验收要求的“可查投递/接收/回执”有后端持久 API 与 Node 工具入口，但整项产品/UI 验收仍待集成。
