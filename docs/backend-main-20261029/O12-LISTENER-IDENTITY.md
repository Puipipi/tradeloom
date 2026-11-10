# O12 监听器身份只读模块

本模块把可信 Host 注入的实际监听端口映射到当前监听进程身份，并只查询该可执行文件在 Windows `ActiveStore` 中的精确程序规则。它不启动或停止产品进程，不改防火墙，不提权，不持久化结果，也不接受请求方指定 PID、程序路径或端口。

## 接口

```js
import { createListenerIdentityHandler } from '@tradeloom/dsh-business-shell/listener-identity'

const listenerIdentity = createListenerIdentityHandler(ctx, { port: trustedBoundPort })
// Host 将 listenerIdentity.handle 挂到其 HTTP request handler；关闭时 await listenerIdentity.dispose()
```

`port` 必须是 Host 从本次绑定结果得到的 1–65535 整数。当前 backend worktree 没有 Host root 模块，所以尚未提供真实的 Host producer 或挂载点；示例只说明消费合同。客户端只可对固定 `GET /tradeloom/diagnostics/listener-identity` 发请求；带 query/hash 的地址会被拒绝。handler 不读取 GET body，body 不参与端口或目标选择；PID、EXE 与端口只来自可信 factory 参数。handler 复用 connection paired request rejection，原样保留其 4xx/5xx 状态；Host identity 更换后请求 fail-closed。`dispose()` 会取消并等待本 handler 正在处理的请求；默认 Windows collector 只终止自己启动的 PowerShell helper，并等待该子进程 `close`。

## 成功响应

身份可唯一确认时：

```json
{
  "ok": true,
  "listener": {
    "status": "observed",
    "port": 3088,
    "addresses": ["127.0.0.1"],
    "candidatePids": [4210],
    "pid": 4210,
    "executablePath": "C:\\Program Files\\TradeLoom\\app.exe",
    "createdAt": "2026-10-31T01:02:03.0000000Z",
    "sha256": "<64位小写SHA-256>",
    "fileVersion": "1.2.3.0",
    "productVersion": "1.2.3",
    "errorCode": null
  },
  "firewall": {
    "status": "observed",
    "rules": [],
    "errorCode": null
  }
}
```

以上值仅为 DTO 形状示例。`listener.status` 可以是 `observed`、`not_listening`、`ambiguous` 或 `unknown`。非 `observed` 时 PID/EXE/时间/hash/version 均为 null；`ambiguous` 会给出观测到的候选 PID，不选择其中一个。`firewall.status` 为 `observed`、`unknown` 或 `not_checked`；只有精确 Program 查询成功且无匹配规则时，`observed` 才返回 `rules: []`。规则投影只包括 `name/enabled/direction/action/profile/policyStoreSourceType/policyStoreSource`。

一条 `observed` 只表示同一次前后复核中，监听端点、PID、进程创建时间、可执行路径和文件 hash 一致。`firewall.observed` 只表示 ActiveStore 对该精确 Program 的规则读取成功；字段不是端口过滤器，也不能证明流量一定允许，更不能证明全局不存在其它规则或策略。

## 错误与未知状态

- 配对拒绝：使用 `ctx.connection.requestRejection(req)` 给出的原 HTTP 状态，错误 DTO 为 `{ "ok": false, "error": { "code": "forbidden" } }`。
- 固定路由带 query/hash、错误路径：400 `invalid_request`；非 GET：405，`Allow: GET`。
- Host/context 替换或 handler 已关闭：503 `host_unavailable`。
- PowerShell/helper 缺失、无效输出或执行故障：503 `listener_identity_unavailable`；helper 超时：504 `listener_identity_timeout`。
- 已确认没有 listener：200，`listener.status = "not_listening"`，防火墙为 `not_checked`。
- 多个 owner：200，`listener.status = "ambiguous"`，防火墙为 `not_checked`。
- TCP 查询、进程查询/身份、文件 hash 或前后复核不确定时：200 `listener.status = "unknown"` 并给固定错误码；防火墙权限或查询失败则 `firewall.status = "unknown"`、规则保持空数组并给 `firewall_query_failed`。未知绝不等于健康或“没有规则”。

除明确列出的安全字段外，handler 不回传原始异常、命令行、环境变量或整机规则列表。PowerShell 使用 Windows 系统目录中的绝对 `powershell.exe`，固定脚本路径、`-NoProfile -NonInteractive -File`、shell=false、隐藏窗口和仅 `{port}` JSON stdin；没有 ExecutionPolicy 绕过。

## Windows 采集路径依据

collector 先用 `Get-NetTCPConnection -State Listen -LocalPort <可信端口>` 获取监听地址/owner PID；无匹配使用已验证的固定 CIM `FullyQualifiedErrorId` 与 `ObjectNotFound` 类别，其他异常保留为查询未知。随后用 `Get-CimInstance Win32_Process` 精确查 PID 的 `ExecutablePath` 与 `CreationDate`，用 `Get-FileHash -LiteralPath <EXE> -Algorithm SHA256` 和 `FileVersionInfo` 查文件身份。防火墙只用 `Get-NetFirewallApplicationFilter -Program <EXE> -PolicyStore ActiveStore`，再按完整路径精确比较，并从对应 filter 取 `Get-NetFirewallRule` 元数据。本机只读无匹配探针确认 `CmdletizationQuery_NotFound_AppPath,Get-NetFirewallApplicationFilter` 与 `ObjectNotFound` 表示没有该精确 Program 的应用过滤器；仅此固定 typed 结果映射为 `observed` + `[]`，权限/模块/其他查询异常仍为 `unknown`。采集末尾重新查 listener/process 并复核创建时间、路径、端点和文件 hash；发生变化就返回 `identity_changed`，不把迟到结果当稳定身份。

微软接口文档：[`Get-NetTCPConnection`](https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-nettcpconnection?view=windowsserver2025-ps)、[`Win32_Process`](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)、[`Get-NetFirewallApplicationFilter`](https://learn.microsoft.com/en-us/powershell/module/netsecurity/get-netfirewallapplicationfilter?view=windowsserver2025-ps)、[`Get-NetFirewallRule`](https://learn.microsoft.com/en-us/powershell/module/netsecurity/get-netfirewallrule?view=windowsserver2025-ps)、[`Get-FileHash`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/get-filehash?view=windowsserver2025-ps)。

## 验证边界

本轮测试用真实 Windows PowerShell 和仅绑定 `127.0.0.1:0` 的测试进程验证 handler 返回 PID、路径、创建时间和 SHA-256，并在关闭同一个测试 listener 后验证 `not_listening`。本机本次 firewall 精确查询返回 `observed` 和两条规则；测试不公开规则名称。其他失败/歧义场景由 collector DTO fixture 覆盖。测试未启动产品 Host、launcher、GUI、Django、LAN listener，也未改规则。它不覆盖 O12 要求的产品旧/新 launcher 版本升级、重开行为、权限提示消失、LAN/移动端或完整启动验收。

验证原始 stdout/stderr/exit 及源备份位于 [O12 recovery evidence](../../recovery-20261029/o12-listener-identity-20261031/)；最终定向测试为 5/5、零跳过，Node 语法检查与 PowerShell AST 检查均退出 0。
