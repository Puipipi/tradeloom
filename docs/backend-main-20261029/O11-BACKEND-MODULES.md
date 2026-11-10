# O11 独立 Node 后端模块

这次把既有 O11 候选的两个独立模块纳入正常 `@tradeloom/dsh-business-shell` 包，不新增 Python API、Host 路由或 UI 接线。原始合同来源是 recovery 下的 [O11-CONTRACT.md](../../recovery-20261029/o11-diagnostics-todos-candidate-20261030/O11-CONTRACT.md)；本文记录包交付和模块接口，不能替代该合同或 O11 的整体验收。

## 包导出与接口

```js
import { createDiagnosticsStore } from '@tradeloom/dsh-business-shell/diagnostics-store'
import { createDiagnosticsHandler, DIAGNOSTICS_ROUTE } from '@tradeloom/dsh-business-shell/diagnostics-http'

const handler = createDiagnosticsHandler(ctx, {
  storeOptions: { env: process.env },
})
// Host 在自己的受信生命周期中显式注册 DIAGNOSTICS_ROUTE + handler.handle，清理时 await handler.dispose()
```

`createDiagnosticsStore({ env })` 要求 `TRADELOOM_DSH_APP_HOME` 与 `DSH_HOME` 是同一个、带 owned marker 的绝对路径；它只把诊断数据放在该 home 下独立的 `tradeloom-diagnostics/state.json`，不读写 `tradeloom-state/state.json` 中的角色/profile 数据。Store 提供 `read()` 和串行化的 `transact(mutator, { beforeCommit })`，支持进程重开后的持久读取；不提供跨进程 writer 锁。

`createDiagnosticsHandler(ctx, dependencies?)` 导出固定 `DIAGNOSTICS_ROUTE='/tradeloom/diagnostics'`、`handle(req,res)` 与 `dispose()`。默认使用当前 `business-tools.js` 中的 `trustedBusinessAuthority` 和 `requestBusinessJson`；health 请求固定为本地 `GET /api/health`，只接受合法 200/503 JSON。`dependencies` 仅是测试/受信组合 seam，不是外部客户端可选参数。HTTP 动作为：GET 只读 snapshot/todos；POST `{"action":"recheck"}` 重查固定健康端点；POST `{"action":"toTodo","checkId":"…","sourceKey":"workbench.local:database"}` 只从最新可信 degraded snapshot 建立或幂等更新 todo。不存在 resolved/reopen、任意 URL、命令执行或后台调度行为。

模块不自行挂载进 Host。未来 Host 必须显式创建 handler、把固定 route 接到自有业务路由生命周期，并在释放时调用 `dispose()`；还需使用真实 Host 提供的 paired business authority。本文测试验证包内模块及其当前源码依赖，不证明生产 Host 已挂载。

## 与本树现有依赖的兼容

候选 `diagnostics-store.js` 原先导入 `state.js` 私有 `assertNoLinks`，但当前正常 `state.js` 只导出 `resolveOwnedHome`。为避免改动当前 state 行为，本树的新模块内保留相同边界检查语义（拒绝 home 外路径和 reparse point），并继续调用当前导出的 `resolveOwnedHome`。`diagnostics-http.js` 保持候选字节不变，直接使用当前 `business-tools.js` 导出。除这处 helper 适配，handler/store 测试由候选迁移并改为导入正常包的模块；移除了依赖候选 Host 的 host.apply 测试。

## 验证边界

在 `packages/tradeloom-shell` 下运行 `C:/Program Files/nodejs/node.exe --test tests/diagnostics.test.js`：12/12 通过，0 skip。测试使用 marker-owned 临时 home 和合成健康响应，覆盖文件持久化/重开、snapshot 与 todo 分段损坏、bridge/authority 拒绝状态、superseded/abort/Host identity 失效、幂等 todo 和当前 package self-import/files 声明。它不是 Django/PG/真实 HTTP 请求或生产 Host 验收。

测试最初按正常包自引用两个目标子路径，预期失败 `ERR_PACKAGE_PATH_NOT_EXPORTED`；随后加入 exports/files 与模块后通过。复制候选模块时发现 `assertNoLinks` 不在当前 state.js exports 中，故 store 含上述本地等义 helper；候选 store 原始 SHA 与正常模块不同。候选原始 `diagnostics-http.js` 与正常包文件 SHA 相同。具体源 SHA、命令、输出和备份差异见 [验证记录](../../recovery-20261029/o11-backend-modules-20261031/VALIDATION.md)。旧 O11 Host、Django/PG、GUI 和前端证据仍各自按原记录的边界解释；本次不据此宣称 O11 完成。
