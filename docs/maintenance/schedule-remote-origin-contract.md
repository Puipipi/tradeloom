# 定时任务的确认范围

助手工具创建、修改任务时要用户确认；用户自己在界面上操作不确认，和官方一致（owner，2026-11-05）。

## 官方调用

核对对象为官方 npm `0.2.2-rc.1`。

| 入口 | 官方源位置 | 进入服务的身份 |
| --- | --- | --- |
| 页面保存新任务 | `dsh-client-ui-schedule/lib/client.js:15836,19377` | `ctx.remote.schedule.create(request)`，没有 actor |
| 页面修改 | 同文件 `15841,19320` | `ctx.remote.schedule.edit(request)`，含 expectedUpdatedAt，没有 actor |
| 页面立即执行 | 同文件 `19328` | `ctx.remote.schedule.run({id})`，不走 create/edit |
| Remote 创建 | `dsh-schedule/lib/index.js:2216` | `this.create(request, undefined, signal)` |
| Remote 修改 | 同文件 `2387` | `this.edit(request, undefined, signal)` |
| 助手工具创建、修改 | `dsh-tool-schedule/lib/index.js:548,686` | 由 exec.agent 取得真实 agent.session.id；子代理在 runForCaller 拒绝 |

## 规则

- **有 actor（助手工具）：** 先确认完整任务，再进入串行提交，等待期间不持有写队列。拒绝、取消、超时、服务停止、没有确认界面都不保存。批准只覆盖这一次变更。
- **没有 actor（Remote）：** 不确认，直接提交。
- **两种都一样：** 提交时检查删除准入、目标、未来时间和修改版本冲突。

## 为什么没有 actor 不确认

没有 actor 不能证明是人点的，已批准的 Host 插件和拿到网页凭据的程序也能这样调用。但网页凭据明文存在 `~/.dsh/.credentials.yaml`，能发这种请求的调用方同样能经 `$events/result` 回答确认问题，所以这里确认拦不住它们，只会让官方页面报错。

确认卡防的是助手工具这条路，防不住能读凭据文件的 shell。这一点和 changelog 里「授权不能代替凭据和工具执行的系统隔离」是同一个限制。

## 验证

- `DSH_PREFIX=<prefix> node runtime/tests/schedule-remote-origin-live.mjs`：真实 `dsh web`、临时 HOME、真实 HTTP/Cookie/mux，没有模型调用。页面相同 RPC 的创建和修改都保存，没有确认问题。
- `DSH_PREFIX=<prefix> node --test runtime/tests/schedule-authorization.test.mjs`：助手路径的确认、拒绝、超时、取消，内存接缝测试。
- `DSH_PREFIX=<prefix> node runtime/tests/schedule-tool-web-live.mjs`：真实 Web 提示词经官方 mock 模型调用 `schedule_create` 并弹确认。

都没有执行浏览器点击，也没上真机。
