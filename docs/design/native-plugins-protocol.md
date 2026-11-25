# 原生插件协议 v1（冻结稿）

> 2026-10-25 冻结。规格依据：`docs/design/native-plugins.md`（总设计，下称「总设计」）§3、§7.1；`docs/design/plugin-seams.md`（接缝规格）§5.2、§9。
> 实现：`runtime/bridge/dsh-go-bridge/`（宿主侧桥接）。机器可读：`sdk/plugin-kit/schema/{manifest,contributions,stream,invoke}.schema.json`。
> 视图本身（组件树）不在本文：见 `docs/design/native-plugins-views.md` 与 `sdk/plugin-kit/schema/view.schema.json`。本文只规定视图怎么送达、多大、怎么更新。
> 改协议：在提交说明里写一行「NA protocol v1 change: …」。v1 内只允许**加可选字段**；删字段、改含义、收紧上限一律算 v2。
> **v1.1**（2026-10-25，桥接 0.3.0）：延后效果（§4.7）——handler 可返回 `pending`，结果之后经流推回发起点按的那条连接。全部是可选新增，v1 的 App 与插件不受影响。
> **v1.2**（2026-10-26，桥接 0.4.0）：可选能力（§11）——有限音频、开口检测、小字幕通道、悬浮字幕。只有声明了 `capabilities` 的插件、并且 App 在 `features` 里提出的能力才会启用；不声明、不提出时，清单解析、路由响应、流消息、效果校验与 v1.1 逐字节相同。

## 0. 一页看完

| 件 | 方向 | 内容 |
|---|---|---|
| `package.json` → `dshGo` | 插件 → 桥接 | 静态清单：协议版本、显示名、图标、`wants`、四种贡献 |
| `ctx.dshGo` | 插件 ↔ 桥接（进程内） | `panel` / `strip` / `on` / `refresh`：视图、数据、点按处理 |
| `GET /dsh-go/v1/contributions` | App ← 桥接 | 所有已启用插件的贡献、署名、问题列表；带 `ETag` |
| `GET /dsh-go/v1/views/<pkg>/<id>` | App ← 桥接 | 一个面板的视图 + 初始数据（按 scope） |
| `WS /dsh-go/v1/stream` | App ↔ 桥接 | 一台主机一条；按 `{pkg, id, scope}` 订阅数据，合并补丁、心跳、重连补拉 |
| `POST /dsh-go/v1/invoke` | App → 桥接 | 用户点按 → 插件处理 → 白名单效果；3 秒窗口由 App 执行 |
| 流 `done` / `void`（v1.1） | App ← 桥接 | 延后效果：invoke 先回 `pending`，插件做完后结果只推给发起点按的那条流连接（§4.7） |
| `GET /dsh-go/v1/assets/<pkg>/<path>` | App ← 桥接 | 插件声明目录下的图片（`image` 组件用），可选 |

```
App                                   dsh-go-bridge（宿主）                     插件（宿主半侧）
 │ 连上主机 / 收到 changed                │                                         │
 ├─ GET contributions?v=1&locale=… ─────▶│ 读已启用插件的 dshGo（缓存）              │
 │◀──────────── plugins[] + rev ─────────┤                                         │
 │ 打开面板                               │                                         │
 ├─ GET views/<pkg>/<id>?sessionId=… ───▶│ view(scope, caps) ─────────────────────▶│
 │                                       │ data(scope, emit) ─────────────────────▶│ emit(d)
 │◀──── view + data + rev ───────────────┤                                         │
 ├─ WS sub {pkg,id,scope,rev} ──────────▶│                                         │ emit(d′)
 │◀──── patch {rev, base, merge} ────────┤ ≤ 4 Hz 合并                              │
 │ 用户点按胶囊                           │                                         │
 ├─ POST invoke {pkg,id,surface,scope} ─▶│ on(id) handler ────────────────────────▶│
 │◀──── effects[]（≤ 3 s 内才执行）───────┤                                         │
```

没有任何插件时：`contributions` 返回 `plugins: []`，App 界面零变化；桥接不启动任何订阅。

## 1. 插件清单：`package.json` 的 `dshGo`

### 1.1 顶层

```jsonc
"dshGo": {
  "v": 1,
  "minApp": "0.10.0",
  "title": { "zh": "用量", "en": "Usage" },
  "icon": "chart",
  "wants": ["draft", "clipboard"],
  "assets": "./assets",
  "contributes": {
    "composer.actions": [{ "id": "translate", "label": { "zh": "译成英文", "en": "To English" }, "icon": "translate" }],
    "message.actions":  [{ "id": "speak", "label": "朗读", "icon": "speaker" }],
    "composer.strip":   [{ "id": "cost", "icon": "coin", "panel": "usage" }],
    "panels":           [{ "id": "usage", "title": "用量", "icon": "chart", "placement": ["session.tab", "features"] }]
  }
}
```

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `v` | 整数 | 是 | 协议主版本，v1 写 `1`。桥接或 App 不支持 → 插件状态 `unsupported` |
| `minApp` | `"x.y.z"` | 否 | App 版本低于它 → 状态 `needs-app`，原生部分不显示，退回网页岛 |
| `title` | Text，≤ 24 字 | 否 | 插件显示名（署名外框、菜单分组）。缺省用包名 |
| `icon` | IconName | 否 | 插件图标。缺省 App 画通用插件图标 |
| `wants` | `("draft" \| "clipboard" \| "message")[]` | 否 | 点按时要附带的内容（§1.4）。不声明就永远拿不到 |
| `assets` | 相对路径 | 否 | 图片目录，供 `GET /assets` 和 `image` 组件。不声明则该路由对本插件 404 |
| `contributes` | 对象 | 是 | 键是 surface，值是数组（§1.2） |

整个 `dshGo` 序列化后 ≤ 16 KiB，超出整份作废（状态 `invalid`）。

**公共类型**

| 类型 | 定义 |
|---|---|
| Text | 字符串，或 `{ "<locale>": 字符串 }`（如 `{"zh": "用量", "en": "Usage"}`）。桥接按 App 的 `locale` 取值：完全匹配 → 语言部分（`zh-CN` → `zh`）→ `en` → `zh` → 第一个值。去掉控制字符和换行；长度按 Unicode 码点计，超长截断并记 `too-long` |
| IconName | `^[a-z][a-z0-9-]{0,31}$`。名称表由 App 定（`app/lib/ui/theme/app_icons.dart` 插件段），不认识的名字画通用图标，不报错 |
| Id | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$`。**同一插件内所有贡献的 id 不得重复**（跨 surface 也不行），所以 `{pkg, id}` 唯一定位一个贡献 |
| 包名 pkg | npm 包名，`^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$` |

### 1.2 surface（v1 四种）

| surface | 原生位置 | 条目字段 | 每插件上限 | 文字上限 |
|---|---|---|---|---|
| `composer.actions` | 输入框上方胶囊行（与 ui.json `quickActions` 合并；ui.json 的排序、隐藏优先；总计显示 ≤ 8 个由 App 管） | `id`、`label`（必填）、`icon`、`effect` | 2 | `label` ≤ 10 |
| `message.actions` | 助手消息长按菜单，按插件分组，组名 = 插件 `title` | `id`、`label`（必填）、`icon`、`effect` | 2 | `label` ≤ 12 |
| `composer.strip` | 输入框上方一行（与活动条互斥，生成中让位；多插件轮流，同时 1 条，App 管） | `id`、`icon`、`text`（静态兜底）、`panel` | 1 | `text` ≤ 24 |
| `panels` | 对话详情页「插件」页签、全部功能、聊天页面板 | `id`、`title`（必填）、`icon`、`placement`、`view` | 4 | `title` ≤ 16 |

条目字段说明：

| 字段 | 用于 | 规则 |
|---|---|---|
| `effect` | 两种 actions | 静态效果：一个效果对象或 ≤ 4 个的数组，只能用 `insert` `command` `open` `link` `copy` `toast`（§5）。**有 `effect` 的条目由 App 直接执行，永不 invoke**；没有 `effect` 的条目点按时走 invoke，需要宿主半侧 `on(id)` |
| `panel` | strip | 点按状态条打开本插件的哪个面板（必须是本插件 `panels` 里的 id）。不写则点按走 invoke（有 `on(id)` 时），都没有就不可点 |
| `text` | strip | 宿主半侧还没推数据时显示的静态文字；也可以不写，等数据 |
| `placement` | panels | `"session.tab"`（对话详情页页签，scope 带 `sessionId`）、`"features"`（全部功能，scope 为空）、`"chat.panel"`（聊天页面板，scope 带 `sessionId`）。缺省 `["session.tab"]`。重复值去重，不认识的值丢弃并记 `invalid-field` |
| `view` | panels | 静态视图文件，相对包目录的 `.json`，≤ 32 KiB。宿主半侧用 `panel(id)` 注册了视图时以注册的为准 |

### 1.2.1 较新的 surface 与位置

v1 内新增，规则和取舍见 [plugin-platform.md](plugin-platform.md) §2、§3。

| surface | 原生位置 | 条目字段 | 每插件上限 | 文字上限 |
|---|---|---|---|---|
| `composer.tools` | 加号面板 | `id`、`label`（必填）、`icon`、`effect`、`panel`、`requires`。`panel` 是打开本插件面板的简写，和 `effect` 互斥 | 2 | `label` 8 |
| `session.actions` | 右侧栏「信息」 | `id`、`label`（必填）、`icon`、`effect`、`requires` | 2 | `label` 12 |
| `turn.note` | 回合脚注 | `id` | 1 | 每段 16 |

面板另有 `placement: "plugin"`（协商：App 的 `surfaces` 没有列出时，只放这里的面板退回 `session.tab`）和 `presentation: "page" | "sheet"`。

`turn.note` 的数据走 §4.3 的流，`scope` 必须带 `sessionId`，否则 `end(not-found)`。数据是 `{ <回合序号>: { text, tone? } }`，桥接逐条清洗，最多保留最新的 `turnNotesPerFeed`（64）个。宿主注册用 `ctx.dshGo.turnNote(id, dataFn)`。App 在一段对话里最多订阅 8 个插件的尾注，给面板和状态条留出流的预算（每条连接 32 个订阅）。

### 1.3 校验规则

- **逐项校验**：每个条目独立判定，出错的条目丢弃，其余照常；问题记到插件的 `issues`（§3.3）。
- `severity: "error"` = 该条目或字段被丢弃；`"warn"` = 保留（可能已截断）。
- 未知顶层键、未知条目字段：忽略，记 `unknown-field`（warn）。
- 未知 surface（如第二期的 `pets`）：忽略，记 `unknown-surface`（warn）。
- 超过每插件上限：保留前 N 个，记 `too-many`（warn）。
- `panel` 指向不存在的面板：去掉该字段，记 `invalid-field`（error）。
- 没有 `effect`、宿主半侧也没注册处理的 actions，以及既没注册又没静态视图的面板：保留，但 `ready: false`，记 `no-handler`（warn）。App 对 `ready: false` 的条目置灰或不显示（由 App 决定）。
- 宿主半侧注册了清单里没有的 id：注册被忽略，记 `undeclared`（warn）。清单是唯一的贡献来源。

### 1.4 `wants` 与随点按附带的内容

| want | 附带字段 | 只在哪个 surface 附带 | 上限 |
|---|---|---|---|
| `draft` | `context.draft`：输入框当前文字 | `composer.actions`、`composer.tools` | 16 KiB（UTF-8） |
| `clipboard` | `context.clipboard`：剪贴板文字 | `composer.actions`、`composer.tools` | 16 KiB |
| `message` | `context.message`：被长按的那条助手消息的正文 | `message.actions` | 16 KiB |

- App 在插件首次被点按前提示一次，用户拒绝就不附带。
- 桥接再兜一层：没声明、或 surface 不对的 `context` 字段，桥接直接丢掉，插件收不到。
- 插件在宿主上本来就能读对话（与网页插件同权），`message` 只是省掉插件按 id 查消息的麻烦，不新增暴露。

## 2. 宿主服务 `ctx.dshGo`

### 2.1 拿到服务

```js
export function apply(ctx) {
  // 只有装了 dsh-go-bridge 的主机才会进这个回调；没有 App 的主机上什么都不发生。
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('usage', { view, data })
    ctx.dshGo.on('translate', async (scope) => ({ insert: await translate(scope.clipboard) }))
  })
}
```

**注意：写 `['dshGo']`，不要写 `['dshGo?']`。** DSH 0.2.1-rc.2 的 cordis 4.0.5 没有可选依赖语法，`'dshGo?'` 会被当成一个永远不存在的服务名，回调永不执行（总设计 §3.2 的草案写法作废）。`ctx.inject` 本身就是「有就跑、没有就挂起」，不会报错。也不要把 `dshGo` 写进插件顶层的 `inject` 声明，那样没有桥接的主机上整个插件都起不来。

注册与调用方插件的生命周期绑定：插件卸载、停用或热重载时，它的全部注册自动撤销，桥接推 `changed`。

### 2.2 API

| 方法 | 签名 | 说明 |
|---|---|---|
| `panel` | `panel(id, { view, data?, actions? }) → dispose` | `view`：视图对象，或 `(scope, caps) => 视图 \| Promise<视图>`。`data`：`(scope, emit, caps) => 取消函数 \| void \| Promise<…>`。`actions`：`{ <action>: handler }`，处理视图里按钮 / options / confirm 的点按 |
| `strip` | `strip(id, { data })` 或 `strip(id, dataFn) → dispose` | `dataFn` 同面板的 `data`：`(scope, emit, caps)`。数据形状固定为 `{ text, icon?, tone? }`（§4.5） |
| `on` | `on(id, handler) → dispose` | 处理 `composer.actions` / `message.actions` / `composer.tools` / `session.actions` / strip 的点按；面板没给 `actions` 表时，面板里的点按也落到这里（`event.action` 区分） |
| `refresh` | `refresh(id, scope?)` | 声明视图变了：桥接给订阅了该面板（且 scope 匹配）的连接发 `stale`，App 重新 GET 视图 |
| `v` / `bridge` | 只读属性 | 协议主版本 `1`；桥接版本字符串 |

**回调参数**

| 名称 | 内容 |
|---|---|
| `scope` | `{ sessionId?, turnId?, messageId?, callId? }`。invoke 时再合并 `draft?` / `clipboard?` / `message?`（只有声明过 want 且用户同意时才有） |
| `caps` | 视图函数：`{ protocol: 1, app: "0.10.0", locale: "zh-CN", surfaces: [...], components: [...] }`，来自 App 的请求参数（§3.1），供视图按能力降级。数据函数：`{ protocol: 1, locale }`（GET 视图来自查询参数，流里来自 `hello.locale`），供插件按 App 语言推文字 |
| `event` | `{ surface, id, action?, value?, locale, signal }`。`signal` 是 AbortSignal：handler 超时、延后结果过期 / 被取消 / 连接断开时触发，插件可以用它停掉网络请求 |
| `emit(data)` | 推一份**完整**数据模型（JSON 对象或 `null`）。桥接负责算差量、限频、限大小。取消后再调无效 |

**handler 返回值**：`undefined`（无效果），一个效果对象 `{type: …}`，效果数组，或简写对象：

| 简写 | 等价 |
|---|---|
| `{ insert: "…" }` | `{ type: "insert", text: "…" }` |
| `{ toast: "…" }` / `{ copy: "…" }` | 同理，字段名 `text` |
| `{ link: "https://…" }` | `{ type: "link", url }` |
| `{ open: "panel:usage" }` | `{ type: "open", page }` |
| `{ command: "compact" }` / `{ command: { name, args } }` | `{ type: "command", name, args? }` |
| `{ refresh: true }` / `{ refresh: "usage" }` | `{ type: "refresh", id? }` |
| `{ patch: {...} }` | `{ type: "patch", data }` |

一个简写对象里写多个键，按键的顺序展开成多个效果。

**延后结果**（v1.1，§4.7）：要调大模型、联网这类 3 秒内做不完的事，handler 立即返回

```js
ctx.dshGo.on('translate', (scope, event) => ({
  pending: { label: event.locale.startsWith('zh') ? '翻译中' : 'Translating', timeoutMs: 30000 },   // 或 pending: true
  result: (signal) => translate(scope.clipboard, { signal }).then((text) => ({ insert: text })),  // 或直接给一个 Promise
}))
```

`result` 的值和普通返回值一样写（效果、数组或简写），但只能用 `insert` `copy` `toast` `patch`。与 `pending` 并列的其他键被忽略（记一条问题）。

### 2.3 隔离

插件回调里的同步异常、被拒绝的 Promise、超时，桥接全部接住：对应请求返回错误（§3.2），计一次违规（§6），桥接和其他插件不受影响。`emit` 传入不可序列化的值（循环引用、BigInt）同样按违规处理。

## 3. 公共约定

### 3.1 鉴权、能力参数、scope

| 项 | 规则 |
|---|---|
| 鉴权 | 所有 `/dsh-go/*` 路由和 WebSocket 升级都走路由守卫（`Connection.requestRejection`）：无凭据 **401**、跨站 Origin / Host 不符 **403**、Connection 未就绪 **503**。这些响应由守卫发出，正文是纯文本，App 只看状态码。桥接在路由内再查一遍（未打补丁的主机也安全） |
| 能力参数 | `contributions` 和 `views` 的查询参数：`v`（App 支持的协议主版本，逗号分隔，如 `1`）、`app`（App 版本 `x.y.z`）、`locale`（BCP 47，如 `zh-CN`）、`surfaces`（逗号分隔）、`components`（逗号分隔）。缺 `v` 按 `1`；缺 `app` 按 `0.0.0`（声明了 `minApp` 的插件会是 `needs-app`） |
| scope 字段 | `sessionId`、`turnId`、`messageId`、`callId`，每个是 1–256 个字符、不含控制字符的字符串。HTTP 里是同名查询参数，流和 invoke 里是 `scope` 对象。未知键丢弃 |
| scope 规范化 | 去掉空值后按键名排序；两个 scope 相等当且仅当规范化后相等。订阅按 `{pkg, id, 规范化 scope}` 共享同一份数据源 |
| 编码 | 请求和响应都是 UTF-8 JSON；`POST` 必须带 `content-type: application/json`（否则 415），这也挡住跨站表单 |
| 缓存 | 除 `assets` 外一律 `cache-control: no-store` |

### 3.2 错误格式

HTTP 错误（守卫的 401/403/503 除外）的正文：

```json
{ "v": 1, "error": { "code": "not-found", "message": "unknown panel usage" } }
```

`message` 是给开发者看的英文，App 不直接显示，按 `code` 映射成自己的文案。

| HTTP | code | 何时 |
|---|---|---|
| 400 | `bad-request` | 参数缺失或格式不对 |
| 400 | `unsupported-version` | 请求的 `v` 里没有桥接支持的版本 |
| 404 | `not-found` | 包、贡献 id 或资源不存在（含插件已停用） |
| 405 | `method-not-allowed` | 方法不对 |
| 409 | `no-handler` | invoke 的条目没有宿主半侧处理（静态 `effect` 的条目不该 invoke） |
| 409 | `degraded` | 插件本次运行已降级（§6） |
| 409 | `not-native` | 插件状态是 `unsupported` / `needs-app` / `invalid` |
| 413 | `too-large` | 请求体或某个字段超限 |
| 415 | `unsupported-media-type` | 不是 JSON |
| 429 | `rate-limited` | invoke 频率超限，带 `retry-after`（秒） |
| 409 | `no-stream` | v1.1：handler 要延后，但请求没带 `stream` 或那条流连接已断开；这次的结果作废 |
| 429 | `too-many-pending` | v1.1：该插件已有 2 个未兑现的延后结果，带 `retry-after: 1` |
| 500 | `plugin-error` | 插件回调抛错，或返回了不合格的视图 / 数据 |
| 500 | `invalid-view` | 视图不是对象、不可序列化或超过 32 KiB |
| 504 | `timeout` | 插件回调超过 3 秒没有结果 |

### 3.3 问题（issue）格式

```json
{ "path": "/dshGo/contributes/composer.actions/2/label", "code": "too-long", "severity": "warn", "message": "label exceeds 10 characters; truncated" }
```

`path` 是相对 `package.json` 根的 JSON Pointer（运行期问题用 `/runtime/<id>`）。App 在插件详情页安静显示一行「原生界面 · N 项有误」，点开看路径和按 `code` 本地化的说明。

| code | severity | 含义 |
|---|---|---|
| `invalid-manifest` | error | `dshGo` 不是对象、超过 16 KiB 或 `contributes` 缺失 |
| `unsupported-version` | error | `v` 不被支持 |
| `needs-app` | error | App 版本低于 `minApp` |
| `missing-field` / `invalid-field` | error | 必填缺失 / 类型或格式不对 |
| `duplicate-id` | error | 插件内 id 重复，后出现的丢弃 |
| `unknown-field` / `unknown-surface` | warn | 忽略 |
| `too-many` / `too-long` | warn | 已截断 |
| `no-handler` | warn | 条目暂时不可用（`ready: false`） |
| `undeclared` | warn | 宿主半侧注册了清单里没有的 id |
| `view-file` | error | 静态视图文件读不到、不是 JSON、越出包目录或超过 32 KiB |
| `bad-effect` / `unknown-effect` | warn | invoke 响应里被丢弃的效果：结构或上限不对 / 不认识的 `type` |
| `violation` | warn | 最近一次违规的说明（§6），附 `count` |
| `degraded` | error | 已降级 |

## 4. 路由

**NA protocol v1 change（#656，能力缺省兼容）：** `surfaces`、`components` 查询参数分别独立处理。未提供某参数时，桥接向插件的视图回调省略对应可选字段，让 SDK 沿用原有 v1 surface / component 默认；显式空参数（例如 `surfaces=`）仍传空数组，表示该类能力均未声明，不自动回退。明确提供的列表按解析规则规范化后传递：按逗号拆分，去掉每项两端空白，丢掉空项和超过 64 个 UTF-16 代码单元的项，最多保留 64 项（例如 `surfaces=panels,,plugin` 得到 `["panels", "plugin"]`）。此规则不改变 `v` 的版本准入；`placement: "plugin"` 仍须在 `surfaces` 明确列出才保留，否则退回 `session.tab`。清单的 `contributes` 类别和 placement 是不同集合，`plugin` 不是新的清单类别。

### 4.1 `GET /dsh-go/v1/contributions`

请求：`GET /dsh-go/v1/contributions?v=1&app=0.10.0&locale=zh-CN&surfaces=composer.actions,message.actions,composer.strip,panels&components=stack,row,text,…`，可带 `If-None-Match`。

响应 200（`ETag: "<rev>"`；`If-None-Match` 命中返回 304 空体）：

```jsonc
{
  "v": 1,
  "bridge": "0.2.0",
  "rev": "3f9a1c0be27d",          // 本响应内容的哈希（同一 caps 下内容不变则不变）
  "bootRev": "k3x9…",              // 官方启动图 rev，仅供参考
  "limits": { … },                 // §7 上限表的机器可读版
  "plugins": [
    {
      "pkg": "dsh-go-example-usage",
      "version": "1.0.0",
      "title": "用量",               // 已按 locale 取值
      "icon": "chart",
      "wants": [],
      "state": "ok",                // ok | degraded | unsupported | needs-app | invalid
      "native": true,               // state == "ok"；false → App 退回网页岛 / 「在网页版打开」
      "contributes": {
        "composer.actions": [],
        "message.actions": [],
        "composer.strip": [{ "id": "cost", "icon": "coin", "text": null, "panel": "usage", "ready": true }],
        "panels": [{ "id": "usage", "title": "用量", "icon": "chart", "placement": ["session.tab", "features"], "ready": true, "live": true }]
      },
      "issues": []
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `plugins` | 只含**已启用**且 `package.json` 有 `dshGo` 的包，按包名排序。没有就是 `[]` |
| `contributes` | 四个键总是齐全（可能是空数组）；`state` 不是 `ok` 时全部为空数组 |
| 条目 `ready` | actions：有 `effect` 或已 `on(id)`；strip：有 `panel`、已 `strip(id)`、已 `on(id)` 或有静态 `text` 之一；面板：已 `panel(id)` 或有静态 `view` |
| 面板 `live` | 已注册 `data`：App 打开面板后应订阅流 |
| 条目 `effect` | 静态效果（已校验，统一成数组）下发，App 本地执行 |
| strip `tappable` / `live` | `tappable`：有 `panel` 或 `on(id)`，点按有反应；`live`：已 `strip(id)`，App 应订阅流 |

**缓存与失效**：桥接按「插件启停代数」缓存解析后的清单（任一插件 fiber 状态变化、启动图 rev 变化、`ctx.dshGo` 注册变化都会让代数 +1），`package.json` 另按 mtime 复查。App 的拉取时机：连上主机一次；收到流的 `changed` 一次；回到前台一次（带 `If-None-Match`，没变化就是 304）。目标：本机冷启动 300 ms 内拿到。

### 4.2 `GET /dsh-go/v1/views/<pkg>/<id>`

`<pkg>` 是包名（带 scope 的包占两段：`/views/@acme/usage-meter/usage`），`<id>` 是面板 id。查询参数 = 能力参数 + scope 字段。

响应 200：

```jsonc
{
  "v": 1,
  "pkg": "dsh-go-example-usage",
  "id": "usage",
  "title": "用量",
  "view": { "type": "stack", "children": [ … ] },   // 见 view.schema.json
  "data": { "session": "¥0.42", … },               // 初始数据；没有 data 或 1 秒内没推出来则为 null
  "rev": "a7.3",                                    // 这份数据的版本；data 为 null 且未就绪时为 null
  "live": true,                                     // 有数据源：应订阅流以收后续补丁
  "stats": { "bytes": 2140, "nodes": 18, "depth": 4 },
  "issues": []
}
```

- 视图来源优先级：`panel(id).view` > 清单静态 `view` 文件。都没有 → 409 `no-handler`。
- 视图函数 3 秒超时 → 504；抛错 → 500 `plugin-error`；不是对象、不可序列化或 > 32 KiB → 500 `invalid-view`。三者都计违规。
- 桥接只卡**字节**（32 KiB）。节点数（≤ 120）和层数（≤ 8）由 App 渲染器截断并标注；桥接把数出来的值放在 `stats`，超了另记一条 `too-many`（warn）。节点 = 带字符串 `type` 字段的 JSON 对象，层数 = 这种对象的嵌套深度（与视图 schema 无关，所以组件增加不用改桥接）。
- 初始数据：桥接启动（或复用）该 `{pkg, id, scope, locale}` 的数据源，最多等 1 秒第一份 `emit`。数据源按 locale 分开（不区分大小写，`_` 视同 `-`），所以 App 的 GET 视图和流 `hello` 要带同一个 locale，订阅才能接上 GET 时启动的那份。数据源在最后一个订阅者离开 30 秒后才取消，所以「GET 视图 → 马上订阅流」不会重启插件的数据函数。
- 状态不是 `ok` → 409（`degraded` / `not-native`）；包或面板不存在 → 404。

### 4.3 `WS /dsh-go/v1/stream`

一台主机一条连接，App 进后台 60 秒后关（code 1000），回前台重连并补拉。消息都是 JSON 文本帧，`t` 为类型；双方忽略不认识的 `t` 和字段。

**App → 桥接**（每帧 ≤ 4 KiB，超出关连接 1009）

| t | 字段 | 说明 |
|---|---|---|
| `hello` | `v: [1]`, `locale?` | 必须是第一帧；桥接回 `welcome`。没有共同版本 → `error {code:"unsupported-version"}` 并关 1008。`locale`（BCP 47，可选）作用于本连接的全部订阅，传给数据函数并参与数据源分组 |
| `sub` | `sub, pkg, id, scope?, rev?` | 订阅面板或状态条的数据。`sub` 是 App 起的名字（1–32 字符），同一连接内唯一；对已有的 `sub` 再发一次 = 替换（用于补拉）。`rev` 是 App 手里那份数据的版本 |
| `unsub` | `sub` | 退订，无回复 |
| `ping` | `at?` | 应用层心跳，回 `pong {at}` |
| `cancel` | `pending` | v1.1：用户取消一个延后结果。只认发起它的连接；回 `void {reason: "cancelled"}` |

**桥接 → App**（每帧 ≤ 48 KiB）

| t | 字段 | 说明 |
|---|---|---|
| `welcome` | `v, bridge, hb, conn` | `hb` = 心跳间隔秒数（25）。`conn`（v1.1）= 这条连接的 id，invoke 时放进 `stream` 字段，延后结果才知道推给谁；重连后是新 id |
| `data` | `sub, rev, data` | 整份替换（`data` 可为 `null`：还没有数据） |
| `patch` | `sub, rev, base, merge` | 在版本 `base` 上应用 JSON Merge Patch（RFC 7386）得到 `rev`。App 手里不是 `base` → 重发 `sub`（带自己的 `rev`）补拉整份 |
| `sync` | `sub, rev` | 订阅时 App 带的 `rev` 已是最新，无需整份 |
| `stale` | `sub` | 视图变了（插件 `refresh`），重新 GET 视图；订阅保持 |
| `end` | `sub, reason, code?` | 订阅被桥接结束：`not-found`（包 / 贡献不存在或插件停用）、`degraded`、`not-native`、`limit`（超出订阅数）、`error` |
| `changed` | — | 插件启停或注册变化，App 带 `If-None-Match` 重新拉 `contributions`（去抖 300 ms） |
| `error` | `code, message` | 连接级错误；`bad-request` 不关连接，其余随后关闭 |
| `pong` | `at?` | — |
| `done` | `pending, effects, issues?` | v1.1：延后结果兑现。`effects` 已按 §4.7 校验，App 照常执行（不受 3 秒窗口限制，但受下面的「过期」限制） |
| `void` | `pending, reason` | v1.1：延后结果作废，不会再有结果。`reason`：`timeout`（过期）、`error`（插件出错）、`cancelled`（用户取消，或插件已停用 / 降级） |

**数据与补丁**

- 插件每次 `emit` 都给整份；桥接与上次发出的那份比较，算 Merge Patch。补丁 ≤ 16 KiB 就发 `patch`，否则发整份 `data`（≤ 32 KiB）。整份也超限 → 丢弃这次 `emit`，计违规，App 保留旧数据。
- Merge Patch 里 `null` 表示删除，所以**数据里的 `null` 等同于缺失**（视图里取不到值都画「—」，结果一致）。数组整体替换。
- 每个数据源 ≤ 4 Hz：250 ms 内的多次 `emit` 只发最后一份。
- `rev` 是不透明字符串，只比较相等。数据源重建（插件重载、闲置取消后重开）后版本序列换新，旧 `rev` 一定不相等，App 会收到整份。

**心跳与断线**

| 项 | 值 |
|---|---|
| 桥接发 WebSocket ping 帧 | 每 `hb` = 25 秒 |
| 桥接判定 App 掉线 | 60 秒内没收到任何帧（含 pong）→ 关 1001 |
| App 判定桥接掉线 | 60 秒内没收到任何帧 → 重连 |
| 重连退避 | 1、2、4、8、16、30、30… 秒；成功后重发 `hello` 和全部 `sub`（带各自的 `rev`）= 补拉 |
| 发送积压 | 连接待发数据 > 1 MiB → 关 1013（App 按掉线处理） |

**关闭码**：1000 正常、1001 超时、1002 帧格式错、1008 协议违例（首帧不是 `hello`、不是 JSON 对象）、1009 帧过大、1011 桥接内部错误、1013 积压 / 连接数已满。

### 4.4 `POST /dsh-go/v1/invoke`

请求（≤ 64 KiB）：

```jsonc
{
  "v": 1,
  "pkg": "dsh-go-example-quick",
  "id": "translate",                  // 贡献 id（面板点按时是面板 id）
  "surface": "composer.actions",      // composer.actions | message.actions | composer.tools | session.actions | composer.strip | panel
  "action": "refresh",                // 仅 panel：视图里按钮 / options / confirm 的 action 名（1–64 字符）
  "value": "b",                       // 仅 panel：options 选中的值等，任意 JSON，≤ 4 KiB
  "scope": { "sessionId": "…" },
  "context": { "draft": "…", "clipboard": "…" },   // 只在 §1.4 允许的组合下有效
  "locale": "zh-CN",
  "stream": "Yc1…"                    // v1.1：welcome.conn；要接收延后结果就必须带
}
```

响应 200（v1.1：handler 延后时 `effects` 为空并带 `pending`）：

```json
{ "v": 1, "effects": [ { "type": "insert", "text": "Hello" } ], "issues": [] }
```

**视图里的点按**（`native-plugins-views.md` §4）：`surface: "panel"`，`id` = 面板 id，`action` = 元素的 `action.id`，`value` = 元素的 `args`（按钮 / 列表行：`action.args`，缺省 `{}`；单选 `{value}`；多选 `{values}`；确认 `{confirmed}`）。插件在 `panel(id, { actions: { <action.id>: handler } })` 或 `on(<面板 id>)` 里收到，`event.action` / `event.value` 即上述两项。

处理顺序：版本 → 包与状态（404 / 409）→ `id` 必须是该 surface 里声明过的条目（404）→ 条目有静态 `effect` 或没有处理函数（409 `no-handler`）→ 频率（429）→ 去掉不允许的 `context` 字段 → 调 handler（3 秒超时）→ 规范化并校验效果（§5）→ 返回。

| 规则 | 值 |
|---|---|
| 频率 | 每插件令牌桶：容量 8，每秒补 4；同一插件同时进行中的 invoke ≤ 4。超出 429 `rate-limited`（不算插件违规） |
| handler 超时 | 3 秒 → 504 `timeout`（计违规）。桥接不取消插件里还在跑的工作，只丢弃结果 |
| **3 秒窗口（App 执行）** | App 从用户点按算起，3 秒内收到的响应才执行其中的效果；超时就静默丢弃（可以轻提示「插件没有响应」）。桥接永远不主动推效果；数据补丁不受窗口限制 |
| 不合格效果 | 逐个丢弃并记在响应 `issues` 里；结构不对或超上限计一次违规；未知 `type` 只记问题，不算违规（向前兼容） |
| 效果个数 | ≤ 4，多出的丢弃（记 `too-many`） |
| 保留 | `surface: "tool.card"` 留给第二期，v1 桥接返回 400 |

### 4.5 状态条数据

`strip` 的数据源 `emit` 的形状：

```json
{ "text": "本对话 ¥0.42 · 今日 ¥3.1", "icon": "coin", "tone": "muted" }
```

| 字段 | 规则 |
|---|---|
| `text` | ≤ 24 字，超长截断；空字符串或 `null` = 这条暂不显示 |
| `icon` | IconName，覆盖清单里的 `icon` |
| `tone` | `good` \| `warn` \| `bad` \| `info` \| `muted`，缺省 `muted` |

桥接在发出前截断 `text`、丢弃其他字段。订阅方式与面板相同（`sub {pkg, id: <strip id>, scope: {sessionId}}`），没有视图，不需要 GET：App 直接画 `icon` + `text`（v1 状态条不走组件树，视图 schema 的 `strip` 预算档留给以后）。

### 4.6 `GET /dsh-go/v1/assets/<pkg>/<path>`（可选）

- 只服务 `dshGo.assets` 目录内的文件；路径越出目录（含符号链接）→ 404。
- 扩展名白名单：`png`、`jpg`、`jpeg`、`webp`、`gif`；单个 ≤ 1 MiB。
- `cache-control: private, max-age=300`，`ETag` = 大小 + mtime；支持 `If-None-Match`。
- 视图里怎么引用（建议 `"src": "asset:icons/a.png"`，App 拼成本路由并带 cookie）由 view schema 定。

### 4.7 延后效果（v1.1）

handler 在 3 秒内返回 `{ pending, result }`（§2.2），桥接立即回：

```json
{ "v": 1, "effects": [], "pending": { "id": "p3f9a1c0be27d4411", "label": "翻译中", "timeoutMs": 30000 }, "issues": [] }
```

之后在请求 `stream` 指定的那条连接上，**恰好一条**：`{t: "done", pending, effects}` 或 `{t: "void", pending, reason}`。

| 规则 | 值 |
|---|---|
| 允许的效果 | `insert`、`copy`、`toast`、`patch`。`command` / `open` / `link` / `refresh` 不允许（仍必须在 3 秒窗口内直接返回）；混进来的被丢弃并记 `bad-effect`，算违规 |
| `label` | 可选，≤ 16 字，超长截断。App 在点按的元素上显示「进行中」+ label |
| `timeoutMs` | 缺省 30000；取值夹在 1000–60000 之间。到点 → `void timeout`，`signal` 触发 |
| 投递对象 | 只推给 `stream` 指定的连接；其他连接（包括同一台主机上的别的 App 实例）收不到 |
| 只兑现一次 | 每个 `pending.id` 只会有一条 `done` 或 `void`；过期、取消、断线之后才到的结果直接丢弃 |
| 取消 | App 发 `cancel {pending}` → `void cancelled`；插件的 `signal` 触发 |
| 断线 | 连接断开，它名下所有未兑现的 pending 立即作废（`signal` 触发），**不补发**。App 重连后自己把这些点按标成「没完成」提示一次 |
| 限额 | 每插件同时 ≤ 2 个未兑现；第 3 个 → 429 `too-many-pending`。普通 invoke 的令牌桶和并发照常计 |
| 没有流 | 请求没带 `stream` 或连接已断 → 409 `no-stream`，结果作废。所以 App 在有原生插件时应先建流 |
| 插件停用 / 降级 | 结果到达时插件已不在或已降级 → `void cancelled` |
| 乱序 | `done` / `void` 走流、invoke 响应走 HTTP，`done` 可能先到。App 对不认识的 `pending` id 暂存 ≤ 5 秒等 invoke 响应 |
| 违规 | `result` 缺失或 `pending` 形状不对、结果里有不允许或不合格的效果 → 计违规。**过期和 `result` 出错不计**（网络慢、上游报错是常态，不该把插件降级） |
| `patch` | 目标面板同普通 `patch`（缺省 = 发起点按的面板），并入数据源 |
| 兼容 | `welcome` 有 `conn` 字段（桥接 ≥ 0.3.0）才支持；老桥接上插件返回 `pending` 会被当成不合格的返回值（空效果 + 问题） |

## 5. 效果白名单

| type | 字段 | 约束 | App 行为 |
|---|---|---|---|
| `insert` | `text` | 1–2000 字 | 插到输入框光标处，**不发送**（总设计 §7.1 决定 2：v1 没有「直接发送」） |
| `command` | `name`, `args?` | `name` 匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`（不带 `/`）；`args` ≤ 500 字 | 在当前对话执行斜杠命令（`commands/execute`）；没有当前对话就忽略 |
| `open` | `page` | `panel:<id>`（必须是本插件声明的面板）或 App 页面 id `^[a-z][a-z0-9-]{0,31}$`（`feature_catalog.dart` 的 id，App 校验，不认识就忽略） | 打开页面 / 本插件面板 |
| `link` | `url` | 只收 `https://`，≤ 2048 字符，不得带用户名密码 | 每次弹确认（显示域名），外部浏览器打开 |
| `toast` | `text` | ≤ 40 字，超长截断（warn） | 一行提示，App 节流 |
| `copy` | `text` | 1–8000 字 | 复制到剪贴板 |
| `refresh` | `id?` | 本插件面板 id；缺省 = 发起点按的面板 | 重新 GET 视图 |
| `patch` | `data`, `id?` | Merge Patch 对象，≤ 16 KiB；`id` 同上 | App 立即合并到该面板的数据；桥接同时并入该 `{pkg, id, scope}` 的数据源（若在运行），其他订阅者经流收到 |

- 清单里的静态 `effect` 只能用前六种（没有 `refresh` / `patch`）。
- 延后结果（§4.7）只能用 `insert`、`copy`、`toast`、`patch`。
- **永不开放**：批准工具调用、改权限模式、手机操控、装卸插件、切主机、读 App 设置或凭据、无点按自动触发（总设计 §3.5）。
- 第二期：`attach {asset}`、`play {asset}`（只认本路由的同源资源）。

## 6. 违规与降级

| 计为违规 | 不计 |
|---|---|
| 视图函数抛错 / 超时 / 返回不合格或超 32 KiB 的视图；数据函数抛错；`emit` 非对象、不可序列化或超 32 KiB；handler 抛错 / 超时 / 返回结构不对或超上限的效果；延后请求形状不对、延后结果含不允许或不合格的效果 | 文字超长截断、条目超数截断、未知效果类型、App 侧的 429、插件主动返回空效果、延后结果过期或出错、`no-stream`、`too-many-pending` |

- **连续 5 次**违规（中间任一次成功的视图 / 数据 / invoke 清零）→ 该插件本次运行**降级**：`state: "degraded"`、`native: false`，取消它的全部数据源，流里给订阅者发 `end {reason: "degraded"}`，之后的视图和 invoke 返回 409 `degraded`，并推 `changed`。App 把它的原生位置换成网页岛或「在网页版打开」。
- 降级持续到该插件重新加载（停用再启用、热重载）或引擎重启。
- 每次违规在插件 `issues` 里留一条 `violation`（只保留最近一条，附累计次数）。

## 7. 上限总表

| 项 | 上限 | 谁执行 | 超出时 |
|---|---|---|---|
| `dshGo` 清单 | 16 KiB | 桥接 | 整份作废（`invalid`） |
| 条目数（每插件） | actions 2 + 2、strip 1、panels 4 | 桥接 | 截断（warn） |
| 文字 | 插件名 24、胶囊 10、菜单项 12、面板标题 16、状态条 24、toast 40 | 桥接 | 截断（warn） |
| 视图 | 32 KiB | 桥接 | 500 `invalid-view`，违规 |
| 视图节点 / 层数 | 120 / 8 | App（桥接只报 `stats`） | App 截断并标注 |
| 工具卡视图（第 0 期） | 8 KiB、40 节点 | App | 降级成通用工具行 |
| 数据整份 / 补丁 | 32 KiB / 16 KiB | 桥接 | 补丁超 → 发整份；整份超 → 丢弃这次 `emit`，违规 |
| 数据频率 | 每个数据源 4 Hz | 桥接 | 合并，只发最后一份 |
| invoke 请求 / `value` / 每个 `context` 字段 | 64 KiB / 4 KiB / 16 KiB | 桥接 | 413 |
| invoke 频率 | 每插件桶 8、每秒 4；并发 4 | 桥接 | 429 |
| 效果 | 每次 4 个；`insert` 2000 字、`copy` 8000 字、`args` 500 字、`url` 2048、`patch` 16 KiB | 桥接（App 再校验一次） | 丢弃该效果 |
| 插件回调超时 | 视图 3 s、handler 3 s；首份数据等 1 s | 桥接 | 504 / `data: null` |
| 效果执行窗口 | 点按后 3 s | App | 丢弃 |
| 流 | 每主机 8 条连接、每连接 32 个订阅、上行帧 4 KiB、下行帧 48 KiB、积压 1 MiB | 桥接 | 1013 / `end limit` / 1009 / 1013 |
| 数据源 | 最后一个订阅者离开 30 s 后取消；全局 64 个，满了先回收闲置的 | 桥接 | `end limit` |
| 图片资源 | 1 MiB / 个 | 桥接 | 404 |
| 延后结果（v1.1） | 每插件同时 2 个；`timeoutMs` 缺省 30 s、1–60 s；`label` 16 字；先到的结果 App 暂存 5 s | 桥接（暂存由 App） | 429 `too-many-pending` / 夹到边界 / 截断 |

`contributions.limits` 以 JSON 给出同一张表（键名见 `contributions.schema.json`），SDK 的 `check` 与 App 都从这里取数，避免三处各写一份。下发的是**本主机的生效值**：六项计时（`handlerTimeoutMs`、`viewTimeoutMs`、`firstDataWaitMs`、`heartbeatSeconds`、`idleTimeoutSeconds`、`feedLingerMs`）可由桥接配置 `native: {…}` 调整（测试用来缩短），所以 schema 里只约束为正数，表中数字是协议默认值；其余各项是协议常量。App 一律以下发值为准（`welcome.hb` 同理）。

## 8. 版本兼容

| 情形 | 处理 |
|---|---|
| 插件 `dshGo.v` 不在 App 的 `v` 列表或桥接不支持 | `state: "unsupported"`，`native: false`，App 退回网页岛 |
| `minApp` 高于 App | `state: "needs-app"`，App 可提示「需要更新 App」 |
| 未知 surface / 组件 / 效果 / 字段 / 流消息类型 | 忽略（问题列表里记一条），其余照常 |
| v1 内演进 | 只加可选字段、新 surface、新效果、新组件；老 App 忽略。App 通过 `caps.surfaces` / `caps.components` 告诉插件自己认识什么 |
| 桥接比 App 旧（第二期 SSH 主机） | App 看 `bridge` 版本号决定是否用新字段；路由 404 = 没装桥接，原生插件全部不显示。延后效果看 `welcome.conn` 是否存在 |
| 不兼容变更 | 升 `v` 到 2，新旧并存：桥接同时服务 App 请求的最高共同版本 |
| 工具卡（`meta["dsh-go/view"]`） | 写进对话记录，只增不删字段，App 永久兼容老格式 |

## 9. 典型时序

1. **冷启动**：App 连上本机 → `GET contributions`（无插件则到此为止，零变化）→ 有 `composer.strip` 时打开聊天页即建流 `hello` → `sub {pkg, id: cost, scope: {sessionId}}` → `data`。
2. **打开面板**：`GET views/<pkg>/usage?sessionId=…` → 画视图和初始数据 → `sub {…, rev}` → `sync`（或 `data`）→ 之后持续 `patch`。离开页面 → `unsub`。
3. **点胶囊**：有静态 `effect` → App 直接执行。否则 `POST invoke` → 3 秒内拿到 `effects` → 执行；超时 → 丢弃。
4. **插件停用**：桥接推 `changed`，对其订阅推 `end {reason: "not-found"}` → App 重新拉 `contributions`（rev 变了）→ 胶囊、面板消失。
5. **回前台**：重连 → `hello` → 逐个 `sub` 带旧 `rev` → 没变的回 `sync`，变了的回整份 `data`。
6. **延后效果**（v1.1）：点胶囊 → `POST invoke {…, stream: welcome.conn}` → `{effects: [], pending: {id, label}}`，元素显示「进行中」→ 若干秒后流里 `done {pending: id, effects}` → App 执行；或 `void` → 元素复原，`timeout` / `error` 轻提示「没完成」。用户可以发 `cancel`。断线 → App 把还在进行中的标成「没完成」。

## 10. 各组件用本文的什么

| 组件 | 用本文的什么 |
|---|---|
| App 视图渲染器 | §4.2 的 `view` 字段承载 `view.schema.json`；节点 / 层数截断规则（§7）；`asset:` 引用约定（§4.6）；`patch` 效果与流补丁的合并语义（§4.3） |
| App 插槽与 `dsh_client` | 全部路由、错误码、`ready` / `live` / `native` 语义、3 秒窗口、`wants` 首次提示、重连与补拉；v1.1：invoke 带 `stream`、显示「进行中」、执行 `done`、处理 `void` 与断线作废、`cancel`、乱序暂存 |
| SDK（`sdk/plugin-kit/`）与示例插件 | §1 清单、§2 服务 API 与简写、§3.3 问题码、§7 上限；`check` 输出与 §3.3 同格式。SDK 原样拷桥接的 `lib/native/{manifest,effects,util,limits}.js`（只 import 彼此和 `node:` 内置）：`checkManifest(pkgJson, pkgDir, opts) → {state, plugin, issues}`、`checkEffects(result, {panels, source}) → {effects, issues, violation}` |

## 11. 可选能力（v1.2）

给朗读这类插件的四样东西：放一段声音、用户开口时停、高频小字幕、悬浮一行字幕。全部可选，协议主版本仍是 `v: 1`。实现：桥接 `lib/native/{capabilities,capability-runtime}.js`；App `lib/plugins/native/native_capabilities.dart`、`android/…/nativemedia/`；测试 `runtime/tests/native-capabilities*.mjs`、`app/test/plugins/native/native_capabilities_test.dart`。示例：`examples/plugins/dsh-go-example-readaloud/`。

| 能力 | 插件得到什么 | 谁做 |
|---|---|---|
| `audio` | 一段有限音频（≤ 16 MiB），播 / 暂停 / 继续 / 停，播完有事件 | 插件在主机上生成字节（比如向主机上的 TTS 引擎要），App 从同源媒体路由取，本地播放 |
| `voice` | 用户开口 / 说完的事件 | App 在手机上检测；检测到开口**先在本地停掉同一实例的声音**，再通知插件 |
| `micro` | 一条只放 `{text, progress}` 的小通道，最快 10 Hz | 插件推，App 画（面板下一行字幕，或悬浮字幕） |
| `overlay` | 一行悬浮字幕，内容来自 `micro` 通道或静态文字 | App 画在自己的界面上（不覆盖其他 App），× 由 App 画 |

### 11.1 声明与协商

```jsonc
"dshGo": {
  "v": 1,
  "capabilities": ["audio", "voice", "micro", "overlay"],
  "contributes": {
    "message.actions": [{ "id": "read", "label": "朗读", "requires": ["audio"] }],
    "media":    [{ "id": "speech" }],
    "micro":    [{ "id": "caption" }],
    "overlays": [{ "id": "subtitle", "channel": "caption", "text": "朗读中" }],
    "panels":   [{ "id": "now", "title": "正在读", "micro": "caption" }]
  }
}
```

| 字段 | 规则 |
|---|---|
| `capabilities` | `audio` `voice` `micro` `overlay` 的子集；不认识的值忽略并记 `invalid-field`（warn）。**不写这个字段**时，下面几项都按 v1.1 处理：`media` / `micro` / `overlays` 是未知 surface（`unknown-surface` warn），`requires` / 面板 `micro` 是未知字段 |
| `media` / `micro` / `overlays` | 各 ≤ 2 个；`id` 守 §1.1 的 Id 规则，并和其他贡献一起在插件内唯一。分别需要 `audio` / `micro` / `overlay` 能力 |
| `overlays[].channel` / `text` | `channel` 必须是本插件的 `micro` id（写在它前面）；`text` ≤ 240 字，通道还没数据时显示。两者至少一个 |
| actions 的 `requires` | 能力列表，必须是插件声明过的。App 没提出其中任何一项时该条目 `ready: false`（App 不显示），invoke 返回 409 `unsupported`。写错按「永不可用」处理 |
| 面板的 `micro` | 本插件的 `micro` id：面板视图下多一行字幕 |

App 端协商：`contributions` 的查询参数 `features=audio,voice,micro,overlay`（缓存键包含它）；流的 `hello` 带 `features: [...]`，`welcome` 回两边共有的 `features`。App 只在**看到有插件声明了能力**之后才去问系统支持什么、才在请求里带 `features`；没有这样的插件时 App 发出的请求与 v1.1 相同。`contributions` 永远原样带回插件的声明（`capabilities` 与三种资源），与 App 是否支持无关。

### 11.2 宿主服务

| 方法 | 签名 | 说明 |
|---|---|---|
| `media` | `media(id, (scope, { key, locale, signal }) => { body, contentType })` | 生成或取来一段**完整**音频：`body` 是 `Buffer` / `Uint8Array`（1 字节 – 16 MiB），`contentType` 只能是 `audio/mpeg` `audio/wav` `audio/ogg` `audio/mp4` `audio/aac`。生成和发送共用 30 秒；`signal` 在停播、断线、超时时触发 |
| `micro` | `micro(id, { data: (scope, emit, caps) => cancel })` | 同 `strip` 的数据函数；`emit` 的值必须是小模型（§11.5） |
| `onCapability` | `onCapability((scope, { instance, event, reason?, seq, signal }) => void)` | 能力事件（§11.4）。返回值**永不**当效果执行；`signal` 跟随租约，最后一个角色结束后中止 |

### 11.3 效果与租约

只在**普通 invoke 的直接返回**里有效（静态 `effect`、延后结果里出现算 `bad-effect` 违规），且只在这次点按的 App 提出了该能力、带了 `stream` 时执行：

| 效果 | 字段 |
|---|---|
| `{ type: "audio", op: "play", instance, src: "media:<id>", key? }` | `key` 可选，`^[A-Za-z0-9_-]{1,128}$`，原样传给 `media` handler（用来指认要读哪段） |
| `{ type: "audio", op: "pause" \| "resume" \| "stop", instance }` | 不带 `src` / `key` |
| `{ type: "voice", op: "start" \| "stop", instance }` | 只检测开口，不上传任何声音或文字 |
| `{ type: "overlay", op: "show" \| "hide", instance, id }` | `id` 是本插件的 overlay |

- `instance` 守 Id 规则。同一次返回里同一 `instance` 的几个效果绑定**同一个租约**（桥接加上 `lease` 字段，插件自己写的忽略）；App 把它们当作一个「声音会话」（owner）。
- 租约绑定连接、插件、`instance`、scope 和媒体 id；每连接 ≤ 8 个、每插件每连接 ≤ 2 个。对一个已经播过的 `instance` 再 `play` 会换新租约（旧的作废）。暂停 / 继续 / 停 / 隐藏只作用于本连接已有的租约。
- 插件**没声明**这种能力却返回了这种效果：按 v1.1 处理（`unknown-effect`，不计违规）。声明了但这台 App 没提出：丢弃，记 `unknown-effect`，不计违规。声明且提出了但格式不对：`bad-effect`，计违规。
- 角色全部结束、连接断开、插件停用 / 降级 / 重载时租约撤销，`media` 的 `signal` 触发。
- 租约记录所引用 `media` 的注册代次；该注册被撤销或替换后，整个旧租约失效。绑定后续效果和投递事件时同步检查这一点，不等待注册钩子的延后清扫：旧租约不接收晚到终态，同一 `instance` 的后续 `voice.start` / `overlay.show` 可取新租约。仅替换 `onCapability` 或变更无关资源，不使仍有效的租约退休。

### 11.4 媒体路由与事件

`GET /dsh-go/v1/media/<pkg>/<id>?lease=…&key=…`：鉴权与其他路由相同（守卫 401 / 403）；只认这两个查询参数；`lease` 必须是活着的、有 audio 角色且媒体 id 相同的租约，`key` 与 `play` 时一致，否则 404。全桥接同时 2 个、每插件 1 个（429）。响应 `cache-control: no-store`、`nosniff`，没有重定向、没有插件给的响应头；超时 504、取消 410、不合格 502 / 413，半截音频不会当成功。App 整段下载（不跟随任何重定向、字节上限、一个总时限）到私有缓存再播放。手机永远不直接访问插件给的地址；`127.0.0.1` 是主机上的事，由插件在 `media` 里自己去取。

App → 桥接：`{ t: "cap.event", lease, seq, event, reason? }`，`seq` 在租约内递增。

| event | 角色 | 含义 |
|---|---|---|
| `audio.ended` / `audio.stopped` / `audio.error` | audio | 自然播完 / 被停（插件、用户、开口以外的打断、退到后台…）/ 出错 |
| `voice.speechStart` | voice | 用户开口。**同一实例的声音已在 App 内停掉**，所以它同时结束 audio 角色，后面不再跟 `audio.stopped` |
| `voice.speechEnd` | voice | 说完（约 0.7 秒静音） |
| `voice.stopped` / `voice.error` | voice | 不再检测（插件停、声音结束后自动停、用户点了指示条的「停止」…）/ 出错（含用户不同意：`reason: "declined"` / `"permission"`） |
| `overlay.closed` | overlay | 字幕关了（插件、用户点 ×、声音结束后自动关…） |

终态每角色一次；开口 / 说完这类边沿每租约最多 10 次每秒（突发 4）；陌生租约、别的连接、旧 `seq` 一律丢弃。

### 11.5 `micro` 通道

App → 桥接：`micro.sub { sub, pkg, id, scope? }`、`micro.unsub { sub }`；桥接 → App：`micro.data { sub, rev, data }`、`micro.end { sub, reason }`。独立于 `sub` / `data` / `patch`，不改面板的 4 Hz、32 KiB、16 KiB。

- `data` 是完整小模型：`{ text?: string, progress?: number | null }`，至少一项；`text` ≤ 240 字（码点），`progress` 0–1 或 `null`；序列化 ≤ 1 KiB；没有别的字段。不合格的 `emit` 丢弃并计违规。
- 每个数据源最快 10 Hz（100 ms 内只发最新一份，和上次相同不发）；首个订阅才启动数据函数，最后一个退订立刻取消，没有 30 秒的保留。每连接 ≤ 8、每插件 ≤ 2 个订阅。
- `rev` 是 `<16 位小写十六进制>.<从 1 递增的整数>`；同一订阅只接同 epoch 且更大的序号。

### 11.6 App 里的规矩（插件改变不了）

| 项 | 规则 |
|---|---|
| 一个会话 | 全 App 同一时间只有一个声音会话；新的点按换下旧的（旧的先在本地停掉，再按终态通知插件） |
| 前台 | 只在 App 在屏幕上时有：退到后台、锁屏、换对话、换主机、断流都立刻在本地停掉，不会自动恢复 |
| 麦克风 | 每个插件第一次要听时，App 先问「允许「插件名」听你开口？」（按主机 + 插件记住，插件设置里有「听你开口」开关可改），再走系统的录音权限。听的时候界面上方（对话顶栏下）有 App 自己的指示条，名字是插件的，点「停止」立刻结束听和播。输入框的语音输入优先：一按语音输入，插件的聆听和朗读先停 |
| 跟着声音走 | 一个会话里有声音时，声音结束（播完、被停、开口打断）后 App 自动停掉聆听（等用户说完）并关掉字幕 |
| 回声 | App 用系统的通话录音通道和回声消除（有的话），朗读时提高开口门槛、忽略开头 0.4 秒。外放声音很大、设备没有回声消除时仍可能把朗读声当成开口（朗读会自己停下）；小声说话也可能听不出 |
| 字幕 | 一行纯文字，App 的字体和颜色，没有链接、没有输入；文字只是文字 |
| 主机 | 本机引擎可用；SSH 主机等桥接能装上之后同样可用（路由一致）；中转主机没有 `/dsh-go/*`，这些能力不可用 |

### 11.7 上限

| 项 | 上限 |
|---|---|
| 每种资源（media / micro / overlays） | 每插件 2 |
| 音频 | 16 MiB；生成 + 发送 30 s；全桥接并发 2、每插件 1 |
| 租约 | 每连接 8、每插件每连接 2 |
| 能力事件 | 边沿 10 次 / 秒（突发 4）；终态每角色 1 次 |
| micro | 10 Hz；`text` 240 字；数据 1 KiB；订阅每连接 8、每插件 2 |
| 字幕文字 | 240 字 / 1 KiB |

---

## 12. NA v1.3：用户选择文件

`files` 是独立可选能力；只增加自己的桥接协议，不改变 DSH 引擎接口。清单声明 `capabilities: ["files"]`，`hello.features` / `welcome.features` 取交集；缺失即不可用。协议主版本、路由和帧中的 `v` 仍为 `1`。普通 v1 视图也能使用选择效果，视图 v2 另行协商。

### 12.1 点按授权与效果

普通 invoke 新增可选布尔字段 `userGesture`。只有 App 当场点按才写 `true`；节流 `onChange` 写 `false`，缺省不授予文件选择权。插件返回 `{ type: "pickFile" | "pickImage", action, maxFiles? }`，`action` 为普通动作 id，`maxFiles` 为 `1–4` 的整数，默认 `1`。静态效果、延后效果、数据推送和选择回调不能发起选择。新效果与旧效果共享每次最多四项的既有预算。

桥在调用实际 panel action 或回落 handler 之前捕获插件 uid/stamp、发起注册的 token，以及同 id 的 panel/handler callback 候选与函数快照。初始 invoke 返回后，只能从这个快照选 callback；发起注册与实际 callback 注册必须均仍为原 token。任一在等待期间被替换、或 callback 到调用后才注册，均拒绝文件效果，不分配 request 或选择槽。

桥验证声明、协商、活跃 stream、当前插件世代及上述两方注册后，加入自己生成的 `request`（24 随机字节的无填充 base64url，32 字符）、`maxBytes: 8388608`、`maxTotalBytes: 16777216`。插件给的授权字段被丢弃。请求绑定 `pkg`、插件 uid/stamp、stream、原 scope、surface/id、locale、发起注册与 callback 注册的 token，不能跨连接/插件/热重载复用；签发后两方任一撤销也立即使请求失效。每连接一个请求，全桥最多八个，五分钟到期。

App 仍在既有三秒点击窗口内启动，核对当前 host/stream/plugin 后取得全 App 单一选择槽。选择器等待期间不把原点击权延长给其他效果；系统返回后只能完成本次请求。

### 12.2 有界传输

同原路由的认证与 Origin 检查先于以下接口；App 使用现有主机 HTTP carrier（含 SSH 隧道），不跟随重定向：

| 接口 | 请求 | 响应 |
|---|---|---|
| `POST /dsh-go/v1/files/<request>/upload?stream=…&name=…&mediaType=…` | `application/octet-stream` 原始字节；name 必填，mediaType 可省略 | `{ v: 1, file: { handle, name, bytes, mediaType, access: "read" } }` |
| `POST /dsh-go/v1/files/<request>/complete?stream=…` | `application/json`，`{ status: "selected" | "cancelled" | "error" }`，≤ 1 KiB | `{ v: 1, effects, issues }`，执行一次被等待的选择回调后返回 |

上传前检查数量和已知长度，随后独立统计实际读入字节。单文件 ≤ 8 MiB、单次 ≤ 16 MiB；未知长度先预留剩余容量与单文件上限的较小值。桥接保留的内容缓冲区共享 64 MiB，预算包含未知长度的预留，不采用不断增长的 chunk 数组。每上传 30 秒，不允许同时上传和 complete。错误会清除整批已上传内容并阻止后续上传，只能 complete error/cancelled；无部分成功。桥接回给 App 的收据体上限为 4 KiB，complete 响应上限 96 KiB。

`handle` 独立随机生成，name 仅是最多 128 字符的显示名，清理目录/控制字符；没有手机路径、URI、主机任意写入路径。请求不接受客户端指定文件句柄、完成文件列表或目标目录。无效请求/其他连接 404，失效 410，并发冲突 409，内容越限 413，主机缓存/调用限流 429，上传时限 408。

### 12.3 回调与只读句柄

回调选择同面板的 `actions[action]`，否则回落原贡献 id 的 `on(id)`。事件保留原位置、locale 与 action，`value` 为 `{ status, files }`；取消或错误的 files 为空。`signal` 随请求撤销。它仍受现有 handler 三秒预算与 invoke 限流约束。

新增 `ctx.dshGo.readPickedFile(handle): Uint8Array`，只有拥有这次被等待回调的插件可读。返回独立内容副本；异步 await 延续有效，回调结算后、超时、断线、插件世代或注册变化后均抛错。`AsyncLocalStorage` 关联回调，运行时再次核对活跃请求，故遗留异步 continuation 不能继续读。需要长期处理者在回调中复制或 await 持久化到自己的位置；复制后的预算与清理由插件负责。

回调效果只有 `patch`、`refresh`、`toast`，不能延后或再发起选择/命令/剪贴板操作。App 同样再查一次白名单。回调完成的 finally、请求过期、断流与插件卸载均撤销句柄并释放保留缓冲区。`selected` 必须有至少一个完整文件；重复 complete 失败。

这保证交付链不修改用户原文件，并防止 service 的误归属/迟到读取；Node 插件仍共享宿主进程，不是针对恶意宿主插件的隔离机制。

### 12.4 Android 与连接能力

Android 文件走 `ACTION_OPEN_DOCUMENT` / `CATEGORY_OPENABLE`；图片在 API 33 起走 `MediaStore.ACTION_PICK_IMAGES`，多选数量不超过 `getPickImagesMaxLimit()`，旧版本/无对应 Activity 回退文件选择器的 `image/*`。只请求读授权，不保留 persistable permission。原生仅保留 content URI，Dart 只收到本地读句柄；通过带 CancellationSignal 的查询和 `openAssetFileDescriptor(..., "r", ...)` 在后台读取。Cursor 使用 use 关闭，InputStream 在结束、取消或销毁时关闭。每次通道传递 ≤ 64 KiB，未知/虚报元数据也计数，读到预算之外的首字节即拒绝。取消时晚到结果不再产生上传；并发 chooser 全 App 单一实例。

原生读连续十秒没有新增字节，App 的独立 timer 先向原 owner 发原生 cancel，再取消源订阅并以 error 结算；不等待暂停于 MethodChannel read 的 async generator 清理后才发 cancel。取消、超限、源错误和到期均只结算一次，部分字节不作为 selected，晚回不再上传或取消新 owner。App gate 与后台 hold 可释放；尚未返回的原生 worker 仍受 ioBusy/closing 限制，不能靠重复启动 worker 绕过。系统 chooser 的后台阶段允许把原有断流宽限延长至该次请求的五分钟 deadline，释放时恢复原后台 deadline，不能不断续租。

当前只有 Android 实现本适配器；无 native channel 则不协商。DSH Remote relay 的 `canReachDshGo` 为 false，不开放 files。现有 `fileUploads/upload` 返回对话附件 receipt，不提供插件可读位置，因此本能力用上述桥路由；SSH 复用原认证 HTTP 隧道，不添加 SFTP 或引擎协议。上游需提供中转 bridge 路由后才可支持 relay。

作者约定、理由与 API 官方依据见 [files.md](../plugins/files.md)。自动测试覆盖真实 HTTP/WebSocket、Dart carrier、App tap runner 和原生预算；系统选择器 UI、厂商 provider 与真机进程重建另列设备回归，不将 API 编译等同于设备测量。
