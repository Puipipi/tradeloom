## Patch 23 只读诊断接线验证

### 私有候选范围

- 改动前逐字节复制 `browser-guests.ts` 到 `browser-guests-v22.ts`，SHA-256 见 `baseline.json`。该基线是冻结 patch22 后的候选源。
- 独立 patch：`integrations/dsh/patches/desktop-ai-web-readonly-diagnostics.patch`；内容仅涉及 `browser-guests.ts`、新 `ai-web-diagnostics.ts` 和专用 Electron fixture/build helper。
- 冻结 patch22 `desktop-ai-web-multisite-state.patch` 未编辑、未重跑 freeze；当前 SHA-256 为 `858DBAED145ACB6F124989597A980F641CC9592D3F007C2740D1181C96091088`。

### 最终验证

- 新诊断模块 TypeScript 严格语义 `--noEmit --strict`：exit 0，日志 `strict-typecheck-final.log`。修改的 browser-guests/ipc/helper 三文件也在严格模式通过，使用 Electron 44 实际声明；当前 fixture 缺少 workspace-only browser/shortcut package types，语义验证为这两个外部类型加了最小临时 ambient stubs，详见 `host-files-strict-typecheck.log`，stubs 未进入 patch。
- 受控 Electron 44 fixture：对 fixture/build helper 和 transpiled CJS 先做 `node --check`，确认无残留候选 Electron 后隐藏启动一次；exit 0、12 项通过。结果 `electron-diagnostics-result-v5-pid-61760.json`；实际导出的 bounded JSON 单独保存为 `electron-export-v5.json`。覆盖固定菜单导出、固定 userData 目录、canary 不泄漏、无额外 show/focus、form 外 textarea 元数据、可信 composer 按钮边界、身份属性只报存在、异站/导航/销毁安全失败、挂起 5 秒截止。此结果只证明受控页，不是实际站点 E2E。
- runtime16 原生启动/网页文档测试：148 项通过；preload 测试：24 项通过。原始日志及退出码见 `native-regression.*`、`preload-regression.*`。
- 正反向验证：`roundtrip-v2` 上 `core.autocrlf=false` 执行 `git apply --check/apply` 与 `git apply --check --reverse/--reverse`；正向四目标 SHA-256 等于候选字节，反向 browser-guests 恢复 v22 基线且新增文件删除。patch 为 LF-only。完整哈希见 `23-delivery.json` 与 `hashes-final.json`。

### 历史结果和事故说明

- 早期 12 项结果保存在 `electron-diagnostics-result-v1-weak-assertion.json`，并标注其 standalone 断言只验证 inputPresent、没有证明 chat_composer 输出。加强断言后的失败保存在 `electron-diagnostics-result-v2-standalone-regression.json`。最终 helper 从元素父容器开始查可信 composer root，并按已收录 inputs 去重后收录唯一未收录 textarea；仅从可信 root 扫描按钮。v5 结果通过。
- 首次 PowerShell fixture 生成误删路径字符串引号；已修复并记录。旧 PID 2372/14128 及其子进程经路径/命令行/创建时间核验后停止；最终 fixture 启动前确认无候选 Electron 残留，启动后进程退出。
- 旧 `acceptance.cjs:85` 上传 smoke 仍失败：controlled page 已通过 ready 检查，`manager.upload` 返回 delivered 后立即读取 `window.fileResult`。change listener 等 `File.text()` 后才赋值，fixture 未等其异步完成；现有证据不能区分事件未派发和读取竞态。未改旧测试或生产上传逻辑，也未伪造 `window.fileResult`。

### 接线边界

仅增加已拥有 BrowserWindow 的 main-side manager 方法和原有“网页”菜单固定动作，导出到应用 `userData/site-diagnostics` 的不可覆盖 JSON；错误只显示安全码。不增加 productAPI、HTTP、CDP，也未修改 main/ipc/preload/live16；没有部署或重启。

## 上传 smoke 后续（fixture-only）

旧 `acceptance.cjs:85` 的即时读取失败仍原样保存在 `acceptance-smoke-legacy-failure.json`。随后只修改私有 `acceptance.cjs`，改用真实 change/input 监听和真实 FileReader `load` 结果，最多等待 5 秒；没有改 BrowserWindow manager 上传逻辑。新的单次 controlled run 16 项通过：1 次 input、1 次 change、1 个真实 FileList 文件，FileReader resolved，文件名/36 字节/text 均与输入一致。完整记录、源码 hash、run ID reconciliation 见 `ACCEPTANCE-SMOKE-RESULT.md` 与 `acceptance-smoke-v2-*`。frozen patch23 未改动。
