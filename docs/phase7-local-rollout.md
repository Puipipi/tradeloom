# 本地工作台可恢复更新记录

日期：2026-10-19
范围：仅记录本机 `tradeloom_dev` 的备份、恢复演练、migration 0003、8000 受控重启及只读/无效请求验收。该本地更新子批次已由主控通过 UI 与结果审查；不代表 Phase 7 或长期总目标完成。

## 变更结果

本机 PostgreSQL 17 数据库 `tradeloom_dev` 已只应用 `workbench.0003_workflow_create_idempotency`。正式库此前仅应用 `0001` 和 `0002`；本次没有修改产品代码。8000 当前使用该项目源码，通过项目外 Python 以 `127.0.0.1:8000 --noreload` 运行，listener PID 为 39804。

正式数据仍为 1 个 `waiting_human` WorkflowTask、2 个 SubTask（Product `waiting_human`、Delivery `queued`）、2 个 completed WorkflowStep、5 个 pending HumanReview、0 Artifact。主控 CUA 实际查看五个板块与旧 Workflow：详情显示 5 条待填/未核验审核；Product 为 `waiting_human`、Delivery 为 `queued`；运行方式为本地 mock，AgentArts 未配置。没有提交审核或执行角色。

## 备份与恢复边界

PostgreSQL custom dump 位于本地仓库外：`<USER_HOME>\Desktop\ICT\workspace\backups\local-rollout-20261019\tradeloom_dev_20261019T004421090Z.dump`。大小 71,235 字节，SHA-256：`D51CB59719DAFE98B49AB0E33292732BB60EAA99FCD35B9923D9B23883296E48`。`pg_restore --list` exit 0，目录含 111 项。

恢复演练实际创建并恢复到 `tradeloom_restore_local_rollout_20261019`；该库保留且未改动。数据库旧行摘要、schema、约束、序列和迁移表已与 formal 对比。90 个 `data/runtime/uploads` 文件只复制到新的外部备份目录，并逐文件 SHA-256 校验；没有做整套应用回滚。artifact root 原本不存在，未创建。

迁移前后所有旧表行摘要、WorkflowTask 的旧列、PK/FK 均一致。`workbench_workflowtask` 只新增 `creation_idempotency_key`、`creation_request_fingerprint`、`creation_receipt` 三个 nullable 字段；现存行三个新值全为 NULL；幂等键唯一索引存在。`django_migrations` 新增唯一的 0003 行，旧业务行没有增删。`django_migrations_id_seq` 从 4 增到 5，其他序列状态不变。

## 启动和验证

停止前重新确认旧 Python launcher/autoreloader/listener 的完整进程链仅属于本项目；随后清理该链，未停止通用 PowerShell、PostgreSQL 或其他服务。启动使用隐藏的 `Start-Process`、同一已验证目录与原本地配置，`--noreload` 禁止 watcher 复活。venv Python redirector PID 42836 启动实际 listener PID 39804。旧进程内存中的代码代次无法确认，所以精确旧内存代码回滚未证明。

迁移执行命令：

```powershell
& $python manage.py migrate workbench 0003_workflow_create_idempotency --plan
& $python manage.py migrate workbench 0003_workflow_create_idempotency --noinput
```

plan 仅含 `workbench.0003_workflow_create_idempotency`，两条命令 exit 0。迁移前通过同 shell Django settings guard 核验 DB/TEST/HOST/PORT/USER/MEDIA_ROOT/ARTIFACT_ROOT；具体操作见[本机启动与迁移说明](04-环境搭建.md)。

以下只读 GET 均返回 200：`/api/health`、`/home`、`/products`、`/agent-center`、`/artifacts`、`/runs`、旧 Workflow 页面与详情 API。详情 API 返回 `waiting_human`，审核状态统计为 5 pending。另以真实 GET 获取的 CSRF token 在内存中发送空 `batch_id`、空 `user_goal` 且带 `idempotency_key` 的无效 POST，返回 422 `batch_id` 校验；请求前后数据库摘要一致，没有创建业务记录。cookie/token 未保存。

此前 `workbench` 全量 264/264、迁移检查等结果属于上批相同代码历史验收；本次没有修改代码，也没有重跑全量测试。此次实际验证包括 PostgreSQL dump/list、恢复到新库、仅迁移 0003、旧行/序列/媒体 hash 对比、页面/API GET、主控 CUA 与无效 POST。没有调用付费服务。

## 风险与下一步

两次历史生成失败仍记录为 `PermissionError`，原因未确认，本次没有修复。数据库恢复在新库已实测；媒体仅复制和哈希校验；旧进程精确代码回滚未证明。外部 dump 含业务数据，仅保存在用户本机仓库外目录，不提交、不上传。

下一步处理 Phase 4 自然语言/独立 prompt 规则；平台账号验证和企业规则访谈仍未完成。Phase 4、Phase 7 和长期总目标均未整体完成。

## 外部证据位置

- 阶段 A/B 报告、迁移计划/日志、只读数据库快照/比较、HTTP 与无效请求结果、进程 PID/命令及日志：`<LOCAL_EVIDENCE_ROOT>\phase7-local-rollout\`
- dump、90 个 uploads 备份与 hash manifest、当前源码 snapshot 与 manifest：`<USER_HOME>\Desktop\ICT\workspace\backups\local-rollout-20261019\`
- 主控实际 CUA 证据：同一 `workspace/testing/phase7-local-rollout/` 下的 `agent-center-after.png`、`legacy-workflow-after.png`、`browser-acceptance.json`。

## 2026-10-19 Task 20/21 正式实例加载验证

Task 21 离线 adapter 与 Task 20 英文名提示最终源码已有 workbench 303/303（35.504 秒）证据，见项目外 `workspace/testing/phase5-english-hints/final-full-workbench-test.log`；本批没有重跑测试，也没有修改产品代码、测试、配置或业务数据。此前正式实例未加载这代源码，本批只对本项目 8000 做受控重启。

重启前通过完整进程路径和命令行核实 listener PID 44680、launcher PID 45256 均为项目外 Python 启动的 `manage.py runserver 127.0.0.1:8000 --noreload`；仅停止这两个进程。首次启动尝试没有继承本轮显式正式配置，30 秒内未监听 8000；确认这次启动的进程仍是同一项目命令链后，只停止该链并重新显式设置环境。随后用固定 Python `<LOCAL_PYTHON_ENV>\Scripts\python.exe`、正式 DB/媒体配置及隐藏 `Start-Process` 启动成功，launcher PID 为 18952，listener PID 为 12248。PostgreSQL 17 PID 30328、启动路径与端口 55432 前后保持不变；成功启动后的日志为空，后续 HTTP GET 均成功。

重启前后重新以 Django settings guard 确认连接 `tradeloom_dev` / role `tradeloom` / `127.0.0.1:55432`，正式媒体目录为 `data/runtime/uploads`、artifact 目录为 `data/runtime/artifacts`。15 张表共 306 行逐表行数和全行 SHA-256 一致；3 个序列、5 条迁移、90 个媒体文件逐文件 SHA-256、artifact 根目录状态，以及旧 workflow `07082f323dfa4746a6f83e0df870ae7d`、五条 pending review、2 个 SubTask、2 个 WorkflowStep 和 0 个 ArtifactVersion 均未变化。另存完整 WorkflowTask 与五条 HumanReview 行及逐行 SHA-256。

重启后 `/home`、`/products`、`/agent-center`、`/artifacts`、`/runs`、旧 workflow 页面/API 和 `/api/health` 的只读 GET 全部返回 200。health 保留 `execution_mode=local_demo`、`agentarts=not_configured`，并返回 `agentarts_status.status=not_configured`、`agentarts_status.evidence=documented_not_connected`。当前 Revision 的 DEMO-001 与 DEMO-002 均没有非空英文名；页面实际显示两条英文名提示，SKU 已按 HTML 规则转义，链接分别指向与当前 Revision 匹配的 pending review。没有可作为验证对象的实际非 ASCII HTML 转义 SKU；浏览器点击/布局和业务英文质量未验收。

本批证据均在项目外 `<LOCAL_EVIDENCE_ROOT>\phase7-local-rollout\phase7b-luna-live-rollout\`：`formal-before.json` / `formal-after.json`、`comparison.json`、`focus-rows.json`、`processes-before.json` / `processes-after-restart.json`、`source-hashes-before.json` / `source-hashes-after.json`、`http-before.json` / `http-after.json` 与启动日志。当前公开源码 checkpoint 和相对路径/SHA manifest 位于同目录 `source_snapshot/`，用于保留本机已运行的当前版本；它不证明所有历史阶段均已留存或验收。只发出只读 GET；未发业务 POST、未调用 AgentArts/外部 API、未执行数据库初始化或 migration。本批不是浏览器验收，不代表 Phase 7、Phase 6 账号实测或真实 AgentArts 接入完成。
