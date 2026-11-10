# O08 本地 workflow definition revision CAS

本切片只为现有 `createWorkflowStore(dir)` 增加本地文件级整数 revision/CAS。它不是 Django definitions API、HTTP 服务、执行计划历史或 O08 整体完成证明。

## API 与兼容视图

```js
import { createWorkflowStore } from '@tradeloom/dsh-business-shell/workflow-engine'

const store = createWorkflowStore(definitionsDirectory)
const current = await store.getVersioned('sales-flow')
// current.revision 可用于下一次写入；document 为标准 workflow 文档，不含更新时间元数据。
const saved = await store.saveVersioned(nextWorkflowDocument, current.revision)
```

`getVersioned(id)` 返回稳定 DTO：

```json
{
  "document": { "version": 1, "id": "sales-flow", "title": "销售流程", "description": "", "source": "manual", "confirmed": true, "nodes": [{ "id": "input", "kind": "input", "title": "输入", "instruction": "", "position": { "x": 40, "y": 40 } }, { "id": "output", "kind": "output", "title": "输出", "instruction": "", "position": { "x": 280, "y": 40 } }], "edges": [{ "from": "input", "to": "output" }] },
  "revision": 3,
  "updatedAt": "2026-10-31T00:00:00.000Z",
  "definitionRevision": "sha256:<64位十六进制摘要>"
}
```

没有文件时为 `{ "document": null, "revision": 0, "updatedAt": null, "definitionRevision": null }`。历史 raw workflow JSON 作为 revision 0 读取；第一次 `saveVersioned(input, 0)` 会迁入版本 envelope。`saveVersioned(input, expectedRevision)` 先用现有 `validateWorkflow` 校验标准文档，并在首次异步等待前结构化复制规范化结果；随后在 per-file 队列内比较 revision。调用者在等待期间修改原输入不会改变这次写入或返回 DTO。成功写入后整数 revision 加一。对 `confirmed: false` 的 draft，`definitionRevision` 为 `null`；confirmed 定义通过现有 `createConfirmedWorkflowDefinition` 计算内容 digest。重复保存相同 confirmed 内容仍递增整数 revision，但 digest 保持稳定，二者语义不同。

旧 API 保持原调用形状：

- `get(id)` 返回标准 workflow 字段加 `updatedAt`，不存在或已删除返回 `null`。
- `list()` 返回原 `{ id, title, source, confirmed, nodes, updatedAt }` 元数据行，损坏文件跳过，tombstone 不显示。
- `save(input)` 无 CAS，但沿用 schema 校验并递增同一整数 revision；因此旧调用不会让先前 versioned CAS 静默通过。返回仍是标准 workflow 文档加 `updatedAt`。
- `remove(id)` 保持成功返回语义。删除现存文档会写 tombstone 并递增 revision；缺失/已删除的重复 remove 不再递增。后续旧 `save` 也读取 tombstone revision 并递增。

成功 `saveVersioned` 返回 `{ document, revision, updatedAt, definitionRevision }`，不返回内部 envelope。版本 envelope 存在同一个 `<dir>/<id>.json` 文件中，形状为 `{ formatVersion: 1, revision, deleted, document, updatedAt, definitionRevision }`。`document` 是 validated standard document；删除时为 `null`，并且 `definitionRevision` 也为 `null`。confirmed digest 与既有 O08 verifier 使用同一算法；digest 是内容身份，不是签名。

## 错误与并发范围

- `invalid_workflow`：标准 workflow schema 不合法；不写文件。
- `invalid_revision`：`expectedRevision` 不是非负安全整数。
- `workflow_revision_conflict`：磁盘当前 revision 与期望值不同；没有自动重试。
- `workflow_revision_exhausted`：安全整数 revision 无法再递增。
- `workflow_store_invalid_record`：已有 JSON 无法解析、legacy workflow schema 不合法、envelope 格式不支持或 digest 对不上。
- `workflow_store_read_failed`：非缺失文件的读取 I/O 失败。
- `workflow_store_write_failed`：临时文件写入或原子 rename 失败；原目标文件保持原字节。

legacy 与 versioned 写入、remove 均按规范化绝对文件路径使用同一个进程内队列，多个 store wrapper 在本进程中共享 CAS 顺序。临时文件先写入并 `fsync`，再原子 rename。它不提供跨进程或外部文件写入锁；不会自动重试业务冲突。该 store 仍是本地 JSON consumer seam，尚未接 Django definitions endpoint、前端/UI、Host 或多进程 writer。
