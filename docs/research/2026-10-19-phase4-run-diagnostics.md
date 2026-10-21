# Phase 4 Task 18 运行诊断切片

| 字段 | 记录 |
|---|---|
| 当前批次 | Phase 4 Task 18：运行记录与设置页面诊断增量；代码与 14 项 before/after/live SHA 审查通过，本机受控上线验收完成。 |
| 目标 | `/runs` 安全展示 AgentRun 失败摘要、当前意图规则与 Prompt 版本/文件 SHA、数据库与当前 Web runtime 本地健康检查；`/api/health` 增加依赖细节并保留既有字段语义。 |
| 来源与版本 | 复用 `load_intent_config()` 对当前 `rules.json` 和 `prompt.md` 真实字节的校验与 SHA-256；运行时取自 Web `WorkflowOrchestrator().runtime` 当前默认选择的 `MockAgentRuntime`。当前配置不冒充历史运行快照。 |
| 固定范围 | 数据库只执行 `SELECT 1`；Runtime 只调用本地 `health_check()`；外部模型 Provider 标记 `not_checked`，AgentArts 标记 `not_configured`。未知失败只显示固定摘要/安全 code，不显示自由文本、结果、事件 payload、凭据或 URL。 |
| 已完成 | `/runs` 显示最近 AgentRun/EventLog、安全错误文案、当前规则与 Prompt 版本及 hash、依赖状态；API 健康响应保留 `status`、`execution_mode`、`agentarts`，新增本地依赖诊断。数据库或意图配置失败时为 `degraded`/503；Runtime mock 的 `partial` 能力状态明确展示。 |
| 测试结果 | TDD RED 的真实行为证据：旧 `/runs` 未显示失败摘要/当前 hash，旧 `/api/health` 缺少 dependencies。最初 settings guard 发现默认 `NAME=tradeloom`、`PORT=5432` 后在运行测试前停止；随后明确配置并核验隔离库，未在错误配置下触库。最终目标组合 35/35、workbench 全量 289/289 通过。首次全量 286 项中 4 项失败来自旧 recovery 子进程硬编码 `tradeloom_test_generation_recovery`；父测试现传活动 TEST.NAME，worker 在业务动作前核验独立 `EXPECTED_TEST_DATABASE` 与 `tradeloom_test_*` 前缀，修正后全量通过。Django check、迁移 no-drift、compileall、diff check 均 exit 0。 |
| 运行方式 | 测试使用项目外 Python、隔离库 `tradeloom_test_run_diagnostics` 和项目外媒体/产物根目录。formal 使用显式 `tradeloom_dev`/`tradeloom`/`127.0.0.1:55432` 与原 media/artifact 路径，口令只从项目外 pwfile 注入环境。核实并仅停止旧工作台 listener 12300/launcher 36412，以同一 Python、相同设置和 `--noreload` 启动新 listener 20916/launcher 45200；PostgreSQL PID 30328 未停止或重启。 |
| 限制与下一步 | 无 runtime selector/config loader；基于 Web 编排器实际默认 Mock 诊断，不添加 selector。未调用云运行时 API；本机 HTTP 验收不代表 browser/CUA。按 Phase 4 其他未完成目标推进，平台账号与 AgentArts 另行实测；正式服务保持运行。 |

本地官方文档能力补充见 [平台能力研究 §7](2026-10-18-platform-capabilities.md)。本切片未调用云运行时 API，未进行 browser/CUA、正式业务数据写入或迁移；正式本机 8000 服务已受控重启并完成只读验收。

## 正式只读验收

五个主页面、旧 Workflow 页面/详情 API/交付物 API、health 和 stylesheet 共 11 个 GET 均为 200；真实 CSRF 只读 preview 为 200/ready/local_mock/simulated_rules/not_configured。Health 为 `ok`，DB 与 intent_config 为 `ok`，Runtime 本地检查为 `ok`、能力为 `partial`、模式为 `local_mock/simulated_rules`；外部 Provider `not_checked`，AgentArts `not_configured`。当前规则版本 `task-intent-rules-v1` SHA-256 `0d31e42d9e539dc2cb0eb55a4bdcf1d70b64d27fefc55987a9b5a9d198c21352`；Prompt 版本 `task-intent-prompt-v1` SHA-256 `8d622fb7b377093118f990211ed8177c74ac018076320a429ea10a23e8be012e`。

前后 15 表/306 行、12 个 workbench 业务表、3 序列、5 migrations、90 uploads 和 artifacts 文件清单一致；旧 Workflow `07082f323dfa4746a6f83e0df870ae7d` 仍为 `waiting_human`/5 pending/0 交付版本，两个 QA ID 前后均不存在；formal comparison 13 项全部通过。未做浏览器/CUA验收。完整快照、HTTP probe、进程归属、日志和 comparison 保存在项目外 `workspace/testing/phase4-run-diagnostics/formal/`。
