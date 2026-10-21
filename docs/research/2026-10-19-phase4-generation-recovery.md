# Phase 4：交付生成中断接管与有界重试切片

日期：2026-10-19

## 验收范围

此切片为持久交付生成流程增加明确的未知结果接管、幂等回执核对与有限错误重试。实现不宣称接管会终止原工作进程。当前 Django 事务、WorkflowStep/EventLog 与 UUID 独立文件目录提供持久恢复边界；未引入 LangGraph、Celery 或新的锁服务。

接管仅接受该 Workflow 最新且确切为 `running` 的生成 Step，要求调用方提供预期 Step ID、明确的 `outcome_unknown` 决定、幂等 key、操作人标签与说明。workflow 行锁串行化接管和 finalize；历史同 action/key 先按完整原始 payload 重放或以 409 拒绝冲突，再检查当前接管资格。Step 原有 `idempotency_key` 保留为生成请求 key，接管回执存于独立 `output_refs` 命名空间。成功接管将旧 Step 标记为 failed/outcome_unknown，写入不可变回执和事件，并按既有状态转换把 workflow 移至 `generate_deliverables_failed`。不把 HumanReview 已提交视为批准。

## 自动化与中断窗口

本切片按 TDD 先实际执行行为 RED：隔离 PostgreSQL 中，latest generation Step 为 running 时，接管 API POST 预期 200，实测旧源码返回 404。随后自动化记录显示恢复目标 27/27、workbench 全量 282/282、两个 Node 测试脚本、JS syntax、Django check、迁移无漂移及 diff 检查均通过，命令 exit 0。主控本批没有重跑自动化；自动化结果沿用这次源码版本的已存证据。

专用测试 helper 在独立真实子进程中 monkeypatch 执行路径并调用 `os._exit(86)`，受测试库 `tradeloom_test_generation_recovery` 身份 guard 约束，使用自有临时 media/artifact 目录。分别覆盖：

1. generation claim 已提交、后续工作尚未进行；
2. staging 仅写出部分文件；
3. 文件已 publish、数据库 ArtifactVersion 注册前；
4. ArtifactVersion 注册事务已提交、成功响应返回前。

前 3 类中断仍保留 running，必须明确接管后使用新 key 启动独立 attempt/UUID 目录；旧部分文件和已 publish 文件保持原样，不登记为版本，也不开放下载。第 4 类成功响应未知时，原 generation key 重放原有 5 个版本，不重复生成。另以真实 PostgreSQL 并发连接验证 takeover 与 finalize 串行竞争。late worker 的 finalize 与失败记录器均须通过 status/key/latest fence；旧 attempt 不能登记版本、改变新 workflow 状态或修改新回执。staging 与 PostgreSQL 不能跨资源原子提交，测试不宣称解决此限制。

失败与未知结果按最近一次完成生成分成连续错误轮次，初次加两次重试；相邻失败尝试耗尽后拒绝新 key，不新增拒绝事件。人工驳回一个成功交付后开启合法新轮次，不消耗前一轮错误额度。已保存回执在未来新轮次后仍可用历史 key 重放，不新增副作用。

## UI 恢复路径

当前 running 最新 attempt 才显示显式接管表单，文案明确标记未知并封存；提交失败时将原 URL、expected Step、key 与全部原始字段 payload 保存到 workflow-scoped sessionStorage。工作流详情始终渲染固定 pending-form 入口。即使服务器已接管成功、原 running form 在 reload 后不再渲染，用户仍能查看原请求的 target/operator/note 并向历史 endpoint 提交相同 payload/key 核对已保存回执；收到成功 ACK 后清理该请求。新 attempt 不覆盖旧 pending 请求。remaining 为 0 时明确显示额度耗尽及人工处理，不建议被 API 拒绝的新 key 重试。

公开页面/DTO 只表达状态、来源、结果和下一步，不公开私有推理。`operator_label` 仅为本地审计标签，不提供身份认证。

## Formal 本机只读上线验收

先核对端口 owner 与命令行：原 8000 listener PID 33964 是 `<LOCAL_PYTHON_ENV>\Scripts\python.exe manage.py runserver 127.0.0.1:8000 --noreload` 的子进程，launcher PID 35200；PG PID 30328 使用 PostgreSQL 17 原 data dir 并监听 127.0.0.1:55432。基线 SQL/Django settings guard 确认正式库 `tradeloom_dev`、角色 `tradeloom`。仅停止上述实际 owned Django 进程树，再以同目录、同项目外 Python、`--noreload` 和相同正式 DB 配置启动当前源码；新 listener PID 12300，launcher PID 36412。未碰 PG listener。

正式前后对比结果：15 张 PostgreSQL 表的行数与规范行 hash 相同，其中 12 个 workbench 业务模型表、`workbench_subtask_depends_on` 关联表均逐行一致；3 个序列状态与 5 条 migration 记录一致。Django 文件快照核对 uploads 90 个文件的相对路径、大小和 SHA-256，artifact root 内容清单亦一致（当前 0 文件）。旧 Workflow `07082f323dfa4746a6f83e0df870ae7d` 两侧均为 `waiting_human`、5 个 pending review、2 个 Step、0 个 ArtifactVersion；QA-owned batch `1241bf4f2c6649b285859d0acdacbe85` 和 workflow `4efe53c97b69417d9539eb152b7f44f4` 在正式库均不存在。DB、media、artifacts 与 HTTP 比较脚本结果全部通过。

重启后的 HTTP GET `/`、`/home`、`/products`、`/agent-center`、`/artifacts`、`/runs`、旧 Workflow 详情、health、Workflow API、deliverables API 与新静态 JS 共 11 项均返回 200。详情页包含固定 `generation-takeover-pending-form`，不包含 running 专用 `generation-takeover-form`，符合旧 workflow 当前状态；JS 已包含 pending 回执恢复分支。带真实 CSRF cookie/header 的 `/api/workflow-intent/preview` 只读 POST 返回 200/ready，模式为 `local_mock`，执行来源 `simulated_rules`，provider `not_configured`。未创建 workflow 或提交业务变更。本批没有浏览器 UI/CUA 验收，也未启动 QA。

正式验收证据位于 `<LOCAL_EVIDENCE_ROOT>\phase4-generation-recovery\`，包含数据库/文件前后快照、全量比较、HTTP 探针、进程日志及源文件快照。可复核 `formal-restart-comparison.json` 中每个通过项，并检查 launcher/listener PID 与日志。

## 未覆盖与限制

- 显式接管只封存当前 attempt 并标记结果未知，不停止可能仍运行的旧进程，也不以超时推断进程死亡。
- staging/final 孤儿文件保留；不做自动 adopt、下载或 GC。文件系统与 PostgreSQL 仍非跨资源原子事务。
- `operator_label` 是标签而非身份认证。
- 项目历史 `PermissionError` 的根因未知，本切片没有声称修复。
- AgentArts 与真实平台账号能力未接入或验证。
- 未执行本批 CUA/浏览器验收；HTTP 只读结果不应描述成真实 UI 验收。
- 本切片只说明生成中断恢复边界，不完成 Task 14–15、Task 16–17 或 Phase 4 整体。

进度记录见[既有工作台 progress.md](../../.superpowers/sdd/2026-10-18-multi-agent-workbench/progress.md)。
