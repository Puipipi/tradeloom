# O08：Canvas 工作流定义 Node client

本模块为既有 Django `/api/canvas-workflow-definitions` 提供 Node 持久化 adapter，供 Host composition 传给 `createWorkflowNativeService({ definitionStore })`。它复用 `requestBusinessJson`、`trustedBusinessAuthority` 和现有 `workflow-postgres.js` 的 `pairedBusinessAuthority`，没有单独 HTTP/认证栈。

```js
import { createPostgresWorkflowDefinitionStore } from '@tradeloom/dsh-business-shell/workflow-definition-postgres'
import { createWorkflowNativeService } from './workflow-native-service.js'

const definitionStore = createPostgresWorkflowDefinitionStore({
  webServer: ctx.webServer,
  // 只由可信 Host pairing 提供；不能来自工具参数或模型输出。
  pairedHost: { host: '127.0.0.1', port: pairedPort },
  nativeBridgeKey: hostOwnedBridgeKey,
  port: djangoPort,
})
const service = createWorkflowNativeService({ ctx, readState, definitionStore, runStore, taskAuthority })
```

`pairedHost` 可省略，此时使用现有 `trustedBusinessAuthority`。`nativeBridgeKey` 可由 Host factory 显式提供，或沿用既有 `TRADELOOM_NATIVE_BRIDGE_KEY` 环境变量。密钥不进入 adapter 方法参数、Django body 或模型工具输入。请求不附带浏览器 cookie/CSRF token；Django endpoint 使用 native bridge gate 并且是 `csrf_exempt`。请求固定发往 `127.0.0.1`，只调用 `/api/canvas-workflow-definitions`。没有 local-store fallback，也不改变 run-store。

## API

- `getVersioned(id, { signal? })` 返回 `{ document, revision, definitionRevision, updatedAt }`。无记录返回 `document: null, revision: 0, definitionRevision: null, updatedAt: null`；tombstone 保留其 revision，document/digest 为 null。
- `saveVersioned(document, expectedRevision, { signal? })` 在第一次 await 前深复制并用现有 JS schema 规范化。confirmed 文档用 `createConfirmedWorkflowDefinition` 核验 digest；draft 的 digest 为 null。期望 revision 为 0 时只能接受 HTTP 201/revision 1；其他保存只接受 HTTP 200/exact expected+1。没有自动重读、重试或覆盖冲突。
- `removeVersioned(id, expectedRevision, { signal? })` 接受已逻辑删除的幂等回执（revision 不变），或首次删除后的 expected+1 revision。
- `listPage({ offset = 0, limit = 50, signal? })` 返回 `{ definitions, total, offset, limit, nextOffset }`；limit 为 1–100。它只读取一页，不隐式遍历；offset 大于 total 的空页合法。API 的 count/slice 是两个 read-committed 查询，client 不假设跨页 total 冻结。
- `get(id, { signal? })` 兼容 native service 的旧 seam，返回标准 workflow document 加 `updatedAt`，缺失或 tombstone 返回 null。

所有成功 DTO 都核对精确字段、workflow ID、revision、删除形态、时间戳、规范化 document 和 canonical digest。列表核对每行身份、活跃状态、重复 ID、分页字段与服务端 `nextOffset` 公式，并保留数据库返回顺序；不在 client 中重新排序或推断数据库排序规则。response 上限按请求页大小增长（每行预留 3 MiB 加页元数据），所以可容纳 API 接受的多行页；不会因为沿用单文档 2 MiB 限制而把合法列表静默截断。

本地稳定错误码：`invalid_workflow_id`、`invalid_revision`、`invalid_workflow`、`invalid_page`、`native_bridge_unavailable`、`trusted_business_authority_unavailable`、`definition_store_cancelled`、`definition_store_timeout`、`definition_store_unavailable`、`invalid_definition_store_response`。API 稳定错误仅按 allowlist 与 HTTP 状态映射，包括 `native_bridge_required`(403)、`invalid_request`(400/422)、`invalid_workflow`(400)、`invalid_workflow_id`/`invalid_query`(400)、`request_too_large`(413)、`definition_not_found`(404)、`revision_conflict`(409)、`workflow_validation_unavailable`/`definition_store_invalid_record`/`storage_unavailable`(503)。未知 code/status 或非 JSON 响应折叠为固定 unavailable/invalid-response 错误；不会把响应 body、URL、cookie 或 bridge key放到错误消息里。

## 验证与边界

`packages/tradeloom-shell/tests/workflow-definition-postgres.test.js` 使用真实 `requestBusinessJson` 和合成 request transport，覆盖 Host authority/bridge headers、无 cookie、CRUD/tombstone、CAS、draft/confirmed digest、精确 DTO 与错误处理、取消、调用方输入快照、以及超过 1 MiB 的多行响应。`workflow-native-service.test.js` 增加一项 adapter 消费测试：prepare 读到 definition revision 后，服务端定义被编辑，submit 因 revision 变化拒绝且不 dispatch。

本轮 Node transport 是测试注入的合成 HTTP transport；它不证明 Node 到 Django 的真实 socket/HTTP、真实 Cordis Host pairing、Host bootstrap 已注入 adapter 或生产 package 已部署。Django endpoint 和真实 PostgreSQL 的单独证据见 [API 验收](O08-WORKFLOW-DEFINITION-API.md) 与 [回执](../../recovery-20261029/o08-definition-api-20261031/testing/o08_definition_api_pg_receipt.attempt3.json)。当前真实 Node client→Django wire 仍未验证；既往 Django runserver 启动动作被拒绝，本轮不换入口重试。
