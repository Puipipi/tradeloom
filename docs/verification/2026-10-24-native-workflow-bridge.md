# Native DSH 工作流桥：源码检查点

此检查点记录隔离分支上的源码实现与合成测试。它不是实际 DSH Host、真实模型、GUI 或业务资料的端到端验收，也没有调用付费模型。

## 当前契约

- 执行模式需显式保存并确认：`local_mock` 保持兼容的本地规则演示，`native_dsh` 走原生专家桥。native 失败、中断或结果未知时不回退 Mock、不自动重试或再次派生。
- 流程复用现有 `WorkflowStep` attempt、幂等键、依赖、来源校验、人审、恢复和交付门禁；不增加调度器或数据库表。中心按 begin → 原生 `subagent` 返回 `subagentId` → bind → `send_message` 专家 的顺序操作。身份只来自 Host/ToolRuntime context，不接受模型参数自报。
- 商品/交付专家提交有界 typed advice。服务端重新运行确定性角色校验；模型建议保持未确认，不能自行写 Product、intake 或 ERP，也不能声称交付通过。provider/model 无法从当前 Host 接缝证实时记为 `unknown`。
- begin 冻结有限的 advice context，不暴露产品原值、文件路径或内部指纹。来源引用不截断；超出商品 100 项、每项 30 个文件 ID，或交付 100 项、1000 个来源产品 ID 的边界时返回 HTTP 413 `advice_context_too_large`，且不保存 assignment。
- 三个 native POST 需要每次受控启动生成的临时 bridge key，由 Host 与 Django 进程环境共享并通过专用 header 校验。密钥不进入 URL、CLI 参数、模型 DTO、日志、manifest 或持久配置；缺失或错误时 fail closed。该机制只配对受控启动的两个进程，不承诺隔离同用户恶意进程或恶意 Host 插件。

## 验证记录

- 作者完整非 opt-in Django gate：54 个模块、545 tests、系统检查 0 问题，结果 OK，runner exit 0。排除的仅是 `test_execution_plan_http_e2e` 与 `test_phase7_workflow_http_e2e`；它们需显式启动隔离 HTTP 服务，本轮没有启用。私有记录位于 `<WORKSPACE_ROOT>\testing\private\intake-product-confirmation-runner\runs\2026-10-23T222926-247Z-17064`。
- 主控补充 Django gate：`test_native_workflow_bridge`、`test_workflow_pages`、`test_review_application`、`test_workflow_dispatch`、`test_workflow_recovery_api` 共 5 模块、66 tests，OK，exit 0。私有记录位于 `<WORKSPACE_ROOT>\testing\private\intake-product-confirmation-runner\runs\2026-10-23T223956-116Z-50524`。
- 作者 launcher + shell + Workbench JS gate：350 tests，331 pass、19 skip、0 fail，exit 0。19 个 skip 分别是：4 项缺少真实 8.3 runtime alias；4 项缺少冻结 stage6 payload；7 项需 pinned compiled DSH runtime；以及 WebServer、Cordis context、Cordis Loader、app-boot/include pinned library 各 1 项。主控另跑 launcher/bootstrap/core/installed-bootstrap 与 shell ToolRuntime 专项共 129 tests，125 pass、4 skip、0 fail；4 个 skip 同样需要冻结 stage6 payload。私有 TAP 记录位于 `<WORKSPACE_ROOT>\testing\private\native-workflow-bridge-final\node-tests.tap`。
- launcher 测试在 worktree 中显式接收 workspace/release/runtime 路径。Windows checkout 的 patch 文件换行与 pinned upstream 源不同；测试仅在临时 fixture 中把 patch 副本规范化为 LF，再执行原始 `git apply --check`、apply 和原断言，未改 patch 或放宽断言。
- 31 个文件来源引用的超限回归先 RED 后 GREEN：超限请求返回 413，assignment 不落库。最终 545 项 Django gate 与 350 项 Node gate 均在该修复后运行。

## 可重跑命令

以下命令使用已有专用 runner/runtime；请为每次 PostgreSQL 重跑生成新的 `tradeloom_test_*` 数据库名，不要把真实业务数据库作为目标。

```powershell
$workspace = '<WORKSPACE_ROOT>'
$runner = Join-Path $workspace 'testing/private/intake-product-confirmation-runner/run-django-tests.mjs'
$db = 'tradeloom_test_native_bridge_verify_20261024_01' # 每次重跑改用新的唯一名称
$labels = Get-ChildItem workbench\tests -Filter 'test_*.py' |
  Where-Object { $_.BaseName -notin @('test_execution_plan_http_e2e','test_phase7_workflow_http_e2e') } |
  ForEach-Object { 'workbench.tests.' + $_.BaseName }
node $runner test --test-db $db @labels
```

作者完整 Node gate：

```powershell
$workspace = '<WORKSPACE_ROOT>'
$runtime = Join-Path $workspace 'runtime/tradeloom-harness/releases/0.2.1-rc.2-tradeloom-desktop-8'
$env:TRADELOOM_TEST_WORKSPACE_ROOT = $workspace
$env:TRADELOOM_TEST_RELEASE_ROOT = Join-Path $workspace 'runtime/tradeloom-harness/releases'
$env:TRADELOOM_DSH_TEST_RUNTIME = $runtime
$env:TRADELOOM_DOM_TEST_ROOT = $runtime
$env:TRADELOOM_DOM_MODULE = Join-Path $runtime 'node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.4.0/node_modules/jsdom/lib/api.js'
$env:TRADELOOM_REACT_LIBRARY = Join-Path $runtime 'node_modules/.pnpm/react@18.3.1/node_modules/react/index.js'
$env:TRADELOOM_REACT_SERVER_LIBRARY = Join-Path $runtime 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/server.js'
$env:TRADELOOM_DSH_TOOLS_LIBRARY = Join-Path $runtime 'packages/core/tools/lib/index.js'
node --test --test-reporter=tap apps/tradeloom-launcher/tests/*.test.mjs packages/tradeloom-shell/tests/*.test.js workbench/tests/js/*.js
```

## 未验证边界

尚未用真实 DSH Host/child、真实 provider/model 或 GUI 验证此桥；未执行真实业务导入、付费模型调用、ERP 写入或 HTTP E2E。PostgreSQL 与 Node 结果均来自隔离数据库、合成输入和 pinned 本地运行时。失败历史保留在私有 runner 证据中；本检查点仅总结最终绿色结果，不把初始 RED 或平台 skip 表述为成功端到端证据。
