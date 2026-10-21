# TradeLoom 工作台骨架：批准范围

> 实现栈更新（2026-10-19）：本文件保留最初 FastAPI/SQLite/Vue 范围的决策记录；正式工作台已迁移为 Django + Django templates + PostgreSQL。当前启动与接口以 [README](../../README.md) 和 [architecture](../architecture.md) 为准。

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-10-18 |
| 状态 | 已批准实施 |
| 基线提交 | `8799523b562325133492114c6cc403043e9dfda9` |
| 实施分支 | `feature/workbench-shell` |
| 关系 | 对 v0.1/v0.2 设计的落地补充，不覆盖既有方案与研究文档 |

## 目标

建立一个可在本机运行的 TradeLoom 中文工作台骨架。用户能够创建演示任务或上传 CSV 商品表与图片，查看按明确文件名规则匹配的产品资料，编辑并确认资料，再导出真实 UTF-8 CSV。后端使用 SQLite 持久化任务、产品、文件引用和待确认项，前端真实调用后端。

同时建立可扩展的多 Agent 接口。产品资料能力提供本地演示执行器；询报价与目录备样只登记能力描述并明确标记未接入。界面、文档和接口不得把未接入能力描述成已运行。

## 范围

- 前端：Vue 3、TypeScript、Vite。
- 后端：Python、FastAPI、SQLite。
- 本机默认地址：后端 `http://localhost:8000`，前端 `http://localhost:5173`。
- 任务状态：`created`、`awaiting_confirmation`、`confirmed`、`failed`。
- 产品必填字段：货号、名称、品类、材质、尺寸、颜色、图片文件名。
- 图片匹配：仅按图片文件名去掉扩展名后与货号完全相等；匹配不到时列出缺项。
- `image_filename` 由当前任务上传图片和当前货号派生，是只读字段；修改货号时重新做精确匹配，找不到图片就清空关联并阻止确认。
- 导出：只有任务状态为 `confirmed` 时允许；输出带固定表头的 UTF-8 CSV。
- 持久化：SQLite 保存任务、产品、确认状态、待确认项和上传文件引用；重启后仍可查询。

## 非目标

- 不实现 ERP、账户权限、复杂任务队列或微服务。
- 不实现真实报价、视觉识别、材质或价格推断、PDF 印刷生成和付费模型调用。
- 不实现 AgentArts 联调、复杂 Agent 框架或新的 provider 模式。
- 不写入真实企业资料、凭证或密钥。
- 不在本轮划分三名成员的工作职责。

## 系统结构

```text
frontend (Vue 3 + TS + Vite)
    │  fetch /api and /uploads
    ▼
backend (FastAPI)
    ├── workbench service：任务、产品、CSV、确认状态
    ├── agent registry：能力描述与执行器分派
    ├── local product executor：确定性的资料归一与缺项检查
    └── SQLite + data/runtime uploads
```

前端不直接访问数据库。后端不保存完整聊天历史；Agent 请求只携带任务标识、输入引用和结构化 payload。任务详情加载使用路由校验和请求序号丢弃过期响应，避免在途请求把界面覆盖回已离开的任务页。

## Agent 契约

- `AgentCapability`：`id`、`name`、`description`、`implemented`。
- `AgentRequest`：`task_id`、`capability_id`、`input_refs`、`payload`。
- `AgentResult`：`status`、`output`、`pending_items`、`artifact_refs`。
- `AgentExecutor(Protocol)`：接收 `AgentRequest`，返回 `AgentResult`。
- `AgentRegistry`：注册能力，统一分派；未实现能力抛出可映射为 HTTP 409 的明确错误。

已登记能力：

| 能力 | 本轮状态 | 行为 |
| --- | --- | --- |
| `product_profile` | 本地演示实现 | 归一产品字段，按文件名/货号匹配图片，生成缺项 |
| `quotation` | 未接入 | 返回清晰错误，不生成报价 |
| `catalog_package` | 未接入 | 返回清晰错误，不生成目录或 PDF |

AgentArts 适配位置位于执行器边界：未来可新增一个实现 `AgentExecutor` 的适配器并由 registry 注册。当前没有平台凭证和联调结果，因此界面固定显示“演示模式”。

## 协作关系图

Agent 能力页提供一个原生 Vue/CSS/SVG 的轻量协作关系图，节点为产品资料、询报价、目录备样和共享任务资料。点击节点显示输入、输出、实现状态与接入边界；当前能力与规划能力使用不同线型/标签区分。

该图只说明接口规划，不表示已经有多个 Agent 在互聊。页面可选择一个真实任务并调用现有 `product_profile` dispatch，显示结构化执行结果和待确认项；未接入能力不执行、不伪造结果。

每次实际 dispatch 都写入 SQLite `agent_runs`，记录 `run_id`、任务、能力、状态、开始/结束时间、结果或错误。Agent 能力页展示所选任务的真实运行历史；所选任务 ID 通过 `#agents/<task_id>` 保存在 URL 中，刷新后校验并恢复同一任务。未实现能力返回 409 时记录 `unavailable`，不得写成成功。

## API 边界

- `GET /api/health`
- `GET /api/agents`
- `GET /api/tasks`
- `POST /api/tasks/demo`
- `POST /api/tasks`（multipart：标题、CSV、可选图片）
- `GET /api/tasks/{task_id}`
- `PATCH /api/products/{product_id}`
- `POST /api/tasks/{task_id}/confirm`
- `POST /api/tasks/{task_id}/agents/{capability_id}`
- `GET /api/tasks/{task_id}/export.csv`
- `GET /uploads/{stored_name}`

错误响应使用 FastAPI 的结构化 `detail` 字段。确认前导出返回 409；存在缺失必填项时确认返回 409；调用未接入能力返回 409。

## 验收

- 后端测试覆盖：演示任务创建、重启后持久化、确认前禁止导出、缺项禁止确认、编辑确认后的 CSV、未接入 Agent 错误。
- 前端通过 `npm run build`（包含 `vue-tsc`）。
- 真实浏览器 smoke：加载演示任务、编辑缺项、确认、下载并核对 CSV、刷新后仍为已确认状态。
- 浏览器 smoke 点击协作图节点，验证节点详情、未接入标记和产品资料真实 dispatch 结果。
- 后端验证运行记录跨 app 实例持久化；浏览器验证一条真实运行历史在刷新后可见。
- HTTP 验证健康检查、任务查询与导出。
- Git 工作区没有未检查的空白错误，运行数据、依赖和日志不提交。
