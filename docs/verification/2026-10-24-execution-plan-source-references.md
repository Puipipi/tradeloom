# 执行计划来源参考验证

本记录涵盖隔离分支 `codex/native-workflow-bridge` 的合成输入验证。未使用真实工作簿、Host、ERP 或外部服务。

## 验证结果

- TDD RED：初始商业候选来源 API 用例因 schema 尚不接受 `supporting_source_inputs` 返回 `422 invalid_execution_plan`；续审 Node RED 暴露投影缺失、picker游标串用及 evidence 重试 key 变化；本次 legacy receipt RED 中，相同旧 materials/operations body 与 key 在升级版 canonical plan 下返回 409。相应隔离 runner 记录位于 `<WORKSPACE_ROOT>\testing\private\intake-product-confirmation-runner\runs\2026-10-23T225442-923Z-13736`、`...\2026-10-23T231415-971Z-48048`。
- 最终 Django gate：本次兼容修复后 root 独立复跑 49 tests、21.372s、exit 0；run ID `2026-10-23T231716-882Z-40204`。作者此前同样 49 tests、exit 0 的运行是 `2026-10-23T231613-005Z-34620`，新建隔离测试库 `tradeloom_test_exec_compat_final_20261024_11317670`。新增的 legacy receipt 单项用例另以 GREEN exit 0 运行，run ID `2026-10-23T231450-689Z-60008`。更早 root 独立阶段 gate 为 48 tests、exit 0，run ID `2026-10-23T230854-357Z-41556`。

  ```powershell
  $workspace = '<WORKSPACE_ROOT>'
  $runner = Join-Path $workspace 'testing/private/intake-product-confirmation-runner/run-django-tests.mjs'
  $db = 'tradeloom_test_exec_source_' + [guid]::NewGuid().ToString('N').Substring(0,12)
  node $runner test --test-db $db workbench.tests.test_execution_plan workbench.tests.test_intake_evidence workbench.tests.test_intake_api
  ```

  隔离 runner 证据位于 `<WORKSPACE_ROOT>\testing\private\intake-product-confirmation-runner\runs\2026-10-23T231613-005Z-34620`；运行器配置的专用 PostgreSQL 测试端口为 55435。每次重跑都会生成全新的数据库名。
- 延续审计的 RED：业务工具读取器最初因缺少 `supporting_sources` 投影而失败；交错打开两个 picker 后第二个从 offset 40 而非 20 继续；同一来源格证据请求重试生成了不同幂等键。Node 首次结果 exit 1，62 tests，56 pass、3 fail、3 skip。
- root 最终 Node gate：DOM 与 business-tools 合计 64/64 pass、0 fail、0 skip，exit 0（设置完整 pinned runtime8、DOM 与 ToolRuntime 依赖环境）。之后仅移除历史来源行中面向实现者的 cell ID 文字；复跑同一 Node gate确认无回归。

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
  node --test packages/tradeloom-shell/tests/execution-plans-dom.test.js packages/tradeloom-shell/tests/business-tools.test.js
  ```
- `git diff --check` exit 0。

## 覆盖点

- commercial_source 与 labor_analysis 的 source_record 合法绑定；跨候选、跨字段与被篡改来源 SHA provenance 均拒绝。
- `empty`、显式 `0`、带错误缓存的公式分别保持 typed state；原值/公式/cache 由不可变 SourceCellSnapshot ref 回溯。
- 后续追加来源证据不重算旧计划；同 key 重放成功、有效异体请求冲突。升级前已保存 receipt 的旧 material/operation body 与相同 key 可稳定重放原计划，canonical fingerprint 维持旧键形；同 key 的真实异体请求仍返回 409。空 source inputs 在 canonical plan 中省略，非空才进入冻结对象。
- DOM 覆盖候选分页加载到第 21 条、多个 picker 交错分页、某候选类型读取失败后重试、候选响应晚于保存时控件仍禁用、人工选择第 2 个来源格后草稿/历史精确显示该格、单独移除关联、证据 POST 失败重试复用同幂等键以及成功记录复用、计划请求关联、历史来源行与真实下载 route、迟到证据响应不能跨需求挂接。business-tools 用例覆盖安全投影保留 typed `0`、`formula_error`/`null`、有界 refs 与截断标记，并丢弃路径、原始大值及公式。

## 未验收边界

仅在专用隔离 PostgreSQL、合成 XLSX 和本地 pinned Node/jsdom 环境验证；没有进行真实 Host/GUI 操作、真实业务数据导入、ERP 写入、部署或 HTTP E2E。来源关联只表示人工参考，不确认订单、商品、价格口径、劳动基础或实际报工。
