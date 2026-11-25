# 桥 HTTP 契约：错误与能力协商

桥继续使用 `/dsh-go/v1`。认证通过后，`GET /dsh-go/v1/capabilities` 返回协议主版本、桥实现版本和已实现的路由家族；`HEAD` 返回相同响应元数据而不带正文。客户端按 `v` 比较可解析的协议；`bridge` 只供诊断，不能按它推断权限或资源是否存在。

## 响应

```json
{
  "v": 1,
  "bridge": "0.4.0",
  "capabilities": [
    "inventory", "occupancy", "native-ui", "native-stream",
    "native-media", "native-files", "plugin-config", "session-deletion",
    "companion", "companion-prompt-context", "companion-recall", "companion-signals"
  ]
}
```

`bridge` 由桥的 package.json 提供，示例值不是兼容门槛。能力列表为当前实现的固定声明；新增名字可以被旧客户端忽略，已有名字不改变含义。缺少协议响应与 `capabilities: []` 不同：前者是旧桥或无法协商，后者明确没有宣告能力。

| 能力 | 已实现的路由家族 |
|---|---|
| `inventory` | GET/HEAD `/inventory` |
| `occupancy` | POST `/occupancy` |
| `native-ui` | `/contributions`、`/views/...`、`/invoke`、`/assets/...` |
| `native-stream` | WS `/stream`；仍需当前连接 hello/welcome 协商 |
| `native-media` | `/media/...`；仍需有效媒体 lease |
| `native-files` | `/files/{request}/upload`、`/complete`；仍需当前文件选择请求 |
| `plugin-config` | `/plugin-config`、`/plugin-config/{entryId}` |
| `session-deletion` | `/sessions/deletion`、`/sessions/delete` |
| `companion` | companion 状态、events、memories、context、export |
| `companion-prompt-context` | `/companion/prompt-context` |
| `companion-recall` | `/companion/recall` 及 bind/revoke/bindings |
| `companion-signals` | `/companion/signals`、`/companion/signals/stream` |

能力只说明协议代码存在。删除前必须重新读取 `/sessions/deletion` 并取得 `supported: true`；回忆、signals、媒体与文件继续检查其既有运行状态、用户同意、归属和当前代次。固定列表既不授权删除，也不表示已经启用任何插件。GET 与 HEAD 都走已有 Connection 认证和 Host/Origin 守卫，响应 `Cache-Control: no-store`；其他方法是 405 `method-not-allowed`。

## 错误形状

桥业务错误使用 `{error:{code,message}}`。已有 `v` 保留；plugin-config 的安全字段路径是 `error.path`。原稳定错误码、HTTP 状态以及 session、companion 的命名空间不改。桥总兜底的未知路由是 404 `route-not-found`；路由内资源缺失继续用原来的 `not-found`、`entry-unavailable` 等码。

客户端先读嵌套 `error`，再兼容旧平铺 `{code,message}`。文本或 HTML 仍映射到 `dsh-go/http-<status>`，不直接把 HTML 当作显示消息。

通用认证拒绝保留原传输形状。上游 webserver 可在桥之前拒绝，`zzzz-plugin-config-readability.diff` 仍可回答旧平铺的 `host-unavailable` 503；桥自身的 unavailable 响应为嵌套形式。不能把“业务错误统一”解读为反向代理或上游守卫的每个响应都必定具有 `error`。

## 客户端入口与 404

`DshGoApi.readDshGoBridgeCapabilities()` 返回 `DshGoBridgeCapabilities?`。只有无机器码或 `route-not-found` 的 404 返回 null（旧桥/未协商）。非 404、其他机器码、错误 JSON/字段、未知协议主版本都抛出，不缓存成“不支持”。未知整数主版本产生 `dsh-go/unsupported-version`；缺少或不合法的 `v` 是协议错误。未知能力名允许保留，调用方只识别自己使用的名字。

`readDshGoContributions` 的成功 200 校验显式 `v:1`；`previous` 应来自同一桥、同一组 caps 的先前成功读取，304 直接返回该对象，不重复检查已经解析过的主版本。成功不先发能力查询，桥实现版本较高或较低也不改变 v1 的解析。

| contributions 结果 | 行为 |
|---|---|
| 200，`v:1` | 正常返回，无额外协商 |
| 304，已有先前成功读取的 previous | 返回同一 previous 对象，无额外协商 |
| 404，嵌套或平铺的资源码 | 原码抛出，无额外协商 |
| 404，`route-not-found` | 返回 null，无额外协商 |
| 404，无码；能力响应 v1 包含 native-ui | 抛原 HTTP 404，不隐藏实现不一致 |
| 404，无码；能力响应 v1 不含 native-ui | 返回 null，明确未宣告 |
| 404，无码；协商端点也无路由 | 返回 null，保持旧桥降级，含义仍是未协商 |
| 协商中 401/403/5xx、其他结构化404、网络异常、未知主版本 | 实际错误向上传播 |

`ClientInventoryApi.readBridgeInventory()` 对 404 使用同样的顺序，检查的能力名为 `inventory`：先读嵌套错误，再兼容平铺错误；资源码抛为 `client-inventory/<code>`，保留消息、path 和 status；`route-not-found` 直接返回 null；只有无码404才调用上述协商入口。协商明确有 inventory 时抛 `client-inventory/http-404`，无此能力或旧桥未协商时才返回 null。协商自身的错误保持 `dsh-go/...` 或协议/传输异常，不改写成 inventory 不支持。

inventory 成功仍只发一个请求，成功模型保持原有读取方式；其非404 HTTP错误仍是 `client-inventory/http-<status>`。`readClientInventory()` 是尽力聚合接口，boot 与 bridge 这两个可选部分失败时仍降低 tier；它没有把失败保存成“桥不支持”。需要区分资源错误的调用方使用 `readBridgeInventory()`。

占位表的 `bootRev` 是上报页面的 graph，`currentRev` 是桥读取 inventory 时的 graph。合法的插件变更或仍打开的旧页面可以使两者不同；桥保留旧表，同时返回 `occupancy.stale: true`。Dart 的 `BridgeInventory.occupancyStale` 保留该信号；聚合时即使独立的 `GET /` 失败、尚未完成或取得的仍是旧 graph，也不能把它改判为新鲜表。`stale: false` 不覆盖客户端已有的缺表、缺 `bootRev` 或与页面版本不同的判断；旧桥缺省该字段时沿用这些旧判据。该标记只描述这次桥响应的快照，不保证两次 HTTP 读取原子一致，也不增加协商或重试请求。

每次需要探测时重新读取，没有进程级缓存或第二套连接状态机。`timeout` 是每个 HTTP 请求的超时，不是整个方法的共享预算；无码404时最多再做一次能力请求，网络等待最坏接近两倍 `timeout`（默认约16秒）。成功、资源错误与明确路由缺失不增加请求。显式 `route-not-found` 是当前请求的直接路由缺失证据，当前 API 不接收调用方缓存的协商对象。持有其他代次声明的调用方不应据旧声明覆盖当前结果。

## 新旧双向兼容

| 组合 | 行为 |
|---|---|
| 支持嵌套和平铺错误的旧客户端 + 新桥 | 成功体与既有路由保持兼容；新增协商端点不影响旧调用 |
| 新客户端 + 未实现协商端点的 v1 桥 | contributions 的 v1 成功照常；协商端点旧404返回 null；旧平铺错误仍可读取 |
| 新 App + 新桥 | v决定可解析性，列表决定实现是否宣告；资源404不再泛化成旧桥 |
| 新 App + 无桥 Host | 业务端点与协商端点均旧式404时仍可降级；认证/服务器错误不会误报无桥 |
| 新 App + 未支持的主版本 | 抛 `dsh-go/unsupported-version`，不套用v1默认值 |
| 非 HTTP carrier | 原生 API 沿用 `dsh-go/unsupported`，inventory 沿用 `client-inventory/unsupported`；不创建旁路连接 |

contributions 的 HTTP 成功体必须显式携带 `v`；缺少或不合法的值是协议错误。`DshGoContributions.fromJson` 是宽松模型读取器，缺省值不改变 HTTP 合同。plugin-config 客户端先读嵌套 `error`，再兼容平铺字段；服务端无需重复输出平铺别名。

## 缓存与契约验证

协商入口不缓存结果。调用方若缓存协商对象，必须按当前 Host/mux generation 管理失效；不得永久缓存 null，也不得把旧代次的声明用于新连接。

`bridge-http-errors.test.mjs` 使用 loopback HTTP 与模拟 Cordis/Connection，验证能力列表、GET/HEAD 元数据一致、HEAD 无正文、动态权限接口独立以及401/403/503入口。`route-guard.mjs`、`native-bridge.mjs` 覆盖实际 Host 路由契约。Dart fake Host 覆盖旧桥、空能力列表、未知能力、资源404、协商失败、主版本检查和成功读取的请求次数。
