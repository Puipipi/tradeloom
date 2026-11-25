# 插件接缝与原生界面声明式自定义（实现规格）

> 2026-10-25。依据只读调研：npm 包 `@deepseek-ai/dsh@0.2.1-rc.2`（其 `node_modules/@deepseek-ai/` 下的官方包）、DSH 0.2.0-rc.2 源码（https://github.com/deepseek-ai/deepseek-harness ）、npm 上 15 个热门浏览器插件抽样。
> 宠物另见 [pets.md](pets.md)。
> 调研数据：当前版本的 slot 目录 JSON 在 `app/test/plugins/seams/fixtures/`；插件抽样的结论汇总在 §1.3（重新生成方法见附录 A）。

## 0. 结论

网页插件进原生 UI，按 slot 走 **「原生适配器优先，网页岛兜底」**：

- 有原生适配器的（插件设置 schema、Cordis 列表、`dsh_ui` 面板、以后的宠物协议）原生画。
- 没有的挂**网页岛**：一个 WebView 加载本机 DSH 的官方网页版，导航到目标位置，只露出目标 slot。
- 不能做「每条消息一个岛」。岛是整个官方客户端，一个约百 MB 量级，只能整页、面板、浮层三种形态，同屏最多 1–2 个。

另加一个口子：**`$DSH_HOME/dsh-go/ui.json`**，只能声明不能执行，让用户叫 AI 改原生界面（§10）。

必须先补的安全洞：本机 webserver 上插件路由不鉴权，手机上任何 App 都能调（§9）。网页岛上线前，本机引擎必须先装路由守卫。

## 1. 现状事实

### 1.1 slot 系统

- slot 是官方 Web 客户端的类型化 React 组合系统（`deepseek-harness/docs/subsystems/slots.zh.md`）。插件在 `apply` 里调 `ctx.slots.inject(key, () => ctx.slots.register({name, id, order, label?}, Component))`。
- 每个 slot 有基数（single / list / keyed / chain）和作用域（root / session / session-maybe）。single 和已占用的 keyed 是「替换点」，list 新 id 是「追加点」。
- 组件拿到的上下文：
  - 框架标准 props，全部 scope 都有：`useSessions`、`useSessionStatus`、`useWorkspaces`、`usePanelInfo`、`useResource`、`useRemoteAccess`。
  - session scope 再加：`sessionId`、`useSession`、`useProjection`、`useConversation`、`useInput`、`inputActions`、`useChat`、`useTrajectory`。
  - 注册时 `inject` 工厂返回的私有数据和回调；slot 级 inject（例如 `conversation.chat.node` 的 `useTurnData`）。
- 插件常用的客户端服务：`slots`、`locale`、`theme`、`layout`、`sessions`、`workspaces`、`uiWorkspace`、`timer`，以及 `connection`、`remote`、`commandUi`、`styles`、`modules`。
- 每个 slot 出口都渲染一个 `<div data-slot="KEY" style="display:contents">`（`dsh-client-ui-renderer/lib/client.js:1117-1126`）。网页岛靠它定位；同一个 list slot 里的各个条目没有逐条标记。
- 0.2.1-rc.2 共 **100 个 slot**。完整机器可读目录内嵌在 `dsh-cordis-client-runner/lib/client.js`（每项含 key、kind、scope、summary、ownerProps、standardProps、declaredBy、occupants、replaceRisk），提取方法见附录 A。

### 1.2 客户端插件怎么加载

```
插件包 package.json: dsh.client { platform: web, inject?, external? } + exports["./client"]
  → 宿主 dsh-client-modules 扫描已启用的 Loader 条目，组合启动图
  → index.html 注入 window.__ModuleLoader__ facade、window.__DSH_BOOT__（WebBootGraph：entries[{id=包名, url, rev, inject, external}]）
  → /plugins/??<combo>&rev=… 返回批量脚本；每个 bundle 调 __ModuleLoader__.load({id, factory: require => module})
  → factory 惰性物化；react / react-dom / cordis / ui-primitives 等来自外壳冻结的平台模块表
```

依据：`dsh-client-modules/README.zh.md`、`dsh-client-modules/lib/types/client/manifest.d.ts:48-99`、`dsh-pet/src/client/index.ts`。

**不能另写一个「只渲染某个 slot」的最小外壳**，原因有三：

1. 平台模块表打包在官方外壳 `dsh-web-frontend` 里，不单独提供。
2. 插件依赖的标准 props 由官方 `ui-session`、`ui-conversation`、`ui-chat` 等适配器提供。
3. slot 只有在声明它的父条目挂载后才存在，而声明在注册时就占住了（`slots.zh.md`「声明与生命周期」），不能另起一个父条目去渲染别人的子 slot。

要复刻这些，等于重写一遍官方客户端。所以网页岛就是**官方客户端本身**加一层隔离（§6）。

### 1.3 现有插件实际用哪些 slot（抽样 15 个带 `dsh.client` 的热门包）

| slot | 包数 | slot | 包数 |
|---|---|---|---|
| settings.section | 9 | sidebar.right.pane.tab | 3 |
| conversation.input.dock | 5 | shell.overlay | 3 |
| plugins.bundle.config | 3 | conversation.chat.turnTail | 3 |
| conversation.chat.assistant-actions | 3 | conversation.session.header.actions / utilities | 各 2 |
| main + sidebar.panellist | 各 2 | conversation.input.overlay | 2 |
| settings.general.item | 2 | tool.call.toolview | 2 |
| sidebar.footer.action | 2 | 其余（view、composer.dock、input.left、input.model、chat.node、plugins.tab、plugins.row.config …） | 各 1 |

15 个包一共只用到 100 个 slot 里的 24 个。比 slot 更难的是另外两件事：

- **14/15 依赖自己的宿主侧**（13 个自定义 HTTP 路由，1 个 RPC）。网页岛与宿主同源，这一点天然满足。
- **7/15 改写官方 DOM**（claude-style、status-rotator、wallpaper-engine 重度改写）。在岛里这些改动作用在被隐藏的官方节点上，无害但失效。
- 两个宠物插件不走 slot，直接挂 `document.body` 或用 `webServer.tapIndex` 注入 HTML。

### 1.4 声明式这条路

- **`@dsh-std/ui`**：仍是草案（`dsh-TUI/vendor/dsh-std/docs/proposals/ui-contribution.zh.md:4`「状态：草案」）。远端 host-rendered surface 一个都没定义，官方客户端也不用它，用的是自己的 slot 系统。短期内指望不上。
- **已有的原生声明式实现**：
  - `settings/describe` 的 JSON Schema → `app/lib/ui/engine_settings/schema_form.dart`，已经能原生画插件的宿主侧配置。
  - `dsh_ui` 渲染器（`app/lib/ui/chat/dsh_ui/`）：节点有 layout / text / metric / chart / compare / steps / callout / options / confirm。它和准备提给上游 `@dsh-std/ui` 的 Panel 块（markdown / list / keyValue / progress / table / actions）高度重合。补上 list、keyValue、progress、table 四种块，再把「回答」改成可路由的 action，就能做「声明式插件面板」的原生实现（§4.3）。

## 2. 总体架构

```
                    ┌──────────── 插件清单（§5）────────────┐
                    │ 哪些包有浏览器半侧 · 每个 slot 的占用者  │
                    └───────────────┬───────────────────────┘
原生界面里的「座位」 PluginSeat(slot, sessionId?)
   └─ SeatPlanner：过滤官方占用者 → 每个第三方占用者选一种呈现
        ├─ 原生适配器（注册表命中）：schema 表单 / Cordis 列表 / dsh_ui 面板 / 宠物协议
        ├─ 网页岛（slot 可做岛）：整页岛 / 面板岛 / 浮层岛（§6）
        ├─ 「在网页版打开」行（岛不可用：远程无网页、内存紧张、slot 不支持）
        └─ 隐藏（ui.json 或用户设置关掉）
```

原则：

- 原生界面自己的功能不让插件替换。`shadows-shipped-ui` 类的替换点（顶栏、输入框本体、侧栏、皮肤）一律不做。
- 座位只出现在有第三方占用者的地方。没有插件时界面零变化。

## 3. slot 清单与优先级

位置写的是原生 App 里的对应处。完整 100 项见附录 A。

| 优先级 | slot（基数 · 作用域） | 原生位置 | 形态 |
|---|---|---|---|
| **P0** | settings.section（list · root） | 插件详情 › 「插件设置」；设置 › 能力分组里「插件」一行下面 | 有宿主 schema → 原生表单；否则整页岛（按 section id 导航） |
| **P0** | plugins.bundle.config / plugins.row.config（keyed · root） | 插件详情页 | 同上 |
| **P0** | sidebar.right.pane.tab + .title（keyed · session） | 会话详情页「插件」页签（roadmap ⬜） | 每个 tab 一个整页岛；标题原生画（取 `label`） |
| **P0** | main + sidebar.panellist（keyed / list · root） | 「全部功能」里的插件面板入口 | 整页岛 |
| **P0** | tool.view.cordis（keyed · session） | Cordis 原生页 › 插件 › 交互区 | Cordis 列表原生（已有）+ 交互区整页岛 |
| **P1** | conversation.input.dock / input.left / input.right / input.overlay / composer.dock（list · session） | 聊天页一个「插件」面板（只在有第三方占用者时出现入口） | 面板岛：一个 WebView 把这几个 slot 竖排露出 |
| **P1** | conversation.session.header.actions / utilities（list · session） | 同一个「插件」面板顶部 | 面板岛 |
| **P1** | settings.general.item（list · root） | 设置 › 能力分组里「插件」一行下面 | 整页岛（打开「通用」分区并只露出第三方条目） |
| **P2** | shell.overlay（list · root） | 全屏透明浮层 | 浮层岛，逐个插件由用户手动开启；宠物走原生（pets.md） |
| **P2** | 声明式面板（新 surface，见 §4.3） | 会话详情页「插件」页签 / 聊天页面板 | 原生 `dsh_ui` 面板 |
| 不做岛 | conversation.chat.turnTail / assistant-actions / chat.node / user.text.node、tool.call.toolview / tool.call.images（消息级） | 消息流 | 每条消息一个平台视图会拖垮滚动和内存。只给「在网页版查看」入口，长期靠声明式 |
| 不做 | root、sidebar*、conversation.header / composer.bar / session、main.conversation、shell.leading / bottom、settings.trigger / header / launcher 等 `shadows-shipped-ui` 替换点 | — | 原生界面是我们的；换肤类需求走 ui.json 主题 |

## 4. 原生适配器注册表

### 4.1 接口（Dart，新目录 `app/lib/plugins/seams/`）

```dart
/// 一个占用者：某个包在某个 slot 里的一格。
@immutable
class SlotOccupant {
  final String slot;        // 'settings.section'
  final String package;     // npm 包名；官方包 official=true
  final String cell;        // list 的 id / keyed 的 key / single 为 ''
  final int order;
  final String? label;      // register 的 label（已按 App 语言取值）
  final bool official;
}

/// 座位上下文：主机、会话、位置约束。
@immutable
class SeatContext {
  final HostRef host;
  final String? sessionId;  // session / session-maybe slot 才有
  final SeatPlacement placement; // page | panel | overlay | row
}

/// 原生适配器：能用原生组件画某些占用者。
abstract interface class NativeSlotAdapter {
  String get id;                          // 'schema-config' | 'cordis' | 'dsh-ui-panel' | 'pet'
  Set<String> get slots;                  // 能服务的 slot key
  /// 只读判断，不得发请求；info 来自插件清单（§5）。
  bool canRender(SlotOccupant o, PluginClientInfo info);
  Widget build(BuildContext context, SeatContext seat, SlotOccupant o);
}

enum SeatMode { native, island, webLink, hidden }

@immutable
class SeatItem {
  final SlotOccupant occupant;
  final SeatMode mode;
  final NativeSlotAdapter? adapter;       // mode == native
  final IslandSpec? island;               // mode == island
}

class SlotAdapterRegistry {
  void register(NativeSlotAdapter adapter);      // App 启动时登记，顺序即优先级
  /// 纯函数：过滤官方占用者 → 用户覆盖（ui.json plugins.seats，§10.3）→ 适配器 → 岛 → 网页版链接。
  List<SeatItem> plan(String slot, List<SlotOccupant> occupants, SeatContext seat,
      {required IslandBudget budget, required SeatOverrides overrides});
}

/// 原生界面摆的座位；没有第三方占用者时渲染 SizedBox.shrink。
class PluginSeat extends ConsumerWidget {
  const PluginSeat({required this.slot, this.sessionId, required this.placement});
}
```

### 4.2 第一批适配器

| id | slot | 判据 | 实现 |
|---|---|---|---|
| `schema-config` | plugins.bundle.config、plugins.row.config、settings.section | 该包在 `settings/describe` 有 namespace 且 `autoGenerate != false` | 复用 `schema_form.dart` |
| `cordis` | tool.view.cordis | 总是（列表部分） | 复用 `app/lib/ui/cordis/`；交互区仍是岛 |
| `dsh-ui-panel` | 声明式面板 surface（§4.3） | 包注册了 `dshGoPanels` | `dsh_ui` 渲染器 + 新增块 |
| `pet` | shell.overlay | 包声明 Codex / linxin manifest | 以后做（pets.md） |

### 4.3 声明式面板（P2，给愿意适配原生的插件）

在 `@dsh-std/ui` 落地前，由宿主侧桥接插件（§5.2）提供一个可选 Cordis 服务：

```ts
ctx.dshGoPanels.register({
  id: 'cost',
  placement: 'session-panel' | 'chat-panel',
  title: () => '用量',
  snapshot(sessionId): PanelDoc,                    // JSON，≤ 16 KiB
  subscribe(sessionId, onChange): () => void,
  invoke(sessionId, actionId, value?): Promise<void> // 只接收面板里声明过的 actionId
})
```

- `PanelDoc` = `dsh_ui` 的节点表，加 list / keyValue / progress / table / actions 五种块。
- App 走守卫后的路由读取 `GET /dsh-go/v1/panels` 加流式更新；`invoke` 走 `POST`。
- 插件只要 `inject: ['dshGoPanels?']`（可选依赖），没有 App 时零影响。
- 以后 std 定稿，按 std 改坐标，渲染器不动。

## 5. 插件清单查询

### 5.1 Tier A：任何主机，不需要宿主改动

1. `pluginManager/listBundles`（已有，`packages/dsh_client/lib/src/plugins_api.dart`）：包、版本、启用状态、`official`。
2. 带 cookie 的 `GET /` 取 index HTML，解析 `window.__DSH_BOOT__` 的 `entries[].id`，得出**哪些包有浏览器半侧**，以及 `release.version`。
   - 新文件 `packages/dsh_client/lib/src/client_inventory_api.dart` 负责解析。只读 JSON，不执行。
3. 结果：`PluginClientInfo { package, hasClient, rev, official }`。没有 slot 占用信息，所以座位只能显示「在网页版打开」，加上设置类的整页岛（整页岛按 section id 导航，不需要占用信息）。

### 5.2 Tier B：本机引擎，带宿主侧桥接插件 `dsh-go-bridge`

`dsh-go-bridge` 是 App 运行时自带的一个 DSH 包，有宿主和浏览器两半，经 `/etc/dsh-app/dsh-web.patch.yml`（`runtime/lib/rtbuild.py:26`）加载。远程主机可选从 npm 安装，要用户确认。

- **浏览器半侧**：`inject: ['slots']`。每次页面启动读 `slots` 的实时组合（`SlotCore.snapshot()` / `entries(key)`，签名见 `dsh-cordis-client-runner/lib/client.js:2226`），按 slot 汇总占用者（包名、cell、order、label），`POST /dsh-go/v1/occupancy` 报给宿主，带 `__DSH_BOOT__.rev`。
- **宿主半侧**：
  - 缓存最新一份占用表（按 boot rev）。
  - `GET /dsh-go/v1/inventory` 返回 `{release, bootRev, packages[{name, hasClient, rev}], slots{key: SlotOccupant[]}}`。
  - 同时承载 §4.3 的面板服务。
- **冷启动**：App 发现 bootRev 变了而占用表还是旧的，就开一个隐藏的「探针岛」加载一次页面，报完即销毁（计入内存预算，§7）。
- 所有 `/dsh-go/*` 路由都经过 §9 的守卫。App 用已有的 API 鉴权调用。

## 6. 网页岛

### 6.1 宿主页 = 官方客户端 + 隔离层

- **URL**：同 `localWebUri(baseUrl, token)`（`app/lib/ui/web/local_web_screen.dart:21`），SSH 隧道主机同理。中转主机不提供网页，没有岛。
- **导航**：复用 `app/assets/web/dsh_web_open.js` 的会话 / 设置分区 / 面板 / 右栏能力，只读加载。岛脚本补三个目标：设置分区、右栏页签、主面板。rc.4 的设置导航和侧栏面板行上没有 id，只能按名字找，所以岛只认**整个名字相等、且只有一个**的那一项（桥接占用表里另有同名条目也不点），点后要它变成 `aria-current`、槽位内容换过才算打开；客户端只把当前分区 / 面板放在内存里，读不回 id。右栏页签由桥接按 tab type id 打开（它确认该 kind 成了活动页签），桥接打不开就不再按名字猜；没有桥接 `openTab` 时按名字找引导页条目，点后从 `dsh.sidebar-right.v1.<会话>` 读回活动页签的 kind 核对，岛只显示这个页签自己的槽位（分屏时别的窗格也画同一个 slot）。任何一项没确认，都按「没找到」上报，退回网页版——槽位本身一直在（`main` 默认画对话、设置默认画第一个分区），不能把它当成找到（CR-7881a22）。
- **隔离**：页面加载后注入 `islands/island.js` + `island.css`。
  1. `<html>` 加 `dsh-go-island` 类；`[data-slot="root"]` 整体 `visibility:hidden`。
  2. 目标 slot 的子孙 `visibility:visible`，再按「配方」把目标容器拉满视口。配方见 `app/assets/islands/recipes.json`：`{slot, open, stretch}`，选择器只用 `data-slot`、角色和 CSS 模块类名后缀，原则同手机布局。
  3. 背景改透明（`html, body { background: transparent }`），WebView `setBackgroundColor(transparent)`。
- **就绪门**：岛先隐藏（`Offstage` / 不透明度 0）。脚本确认目标 slot 存在且非空后发 `ready`；5 秒内没有 `ready`，或报 `empty` / `slot-missing`，就销毁岛、换成「在网页版打开」。DSH 升级弄坏配方时，最坏结果是「不生效」，不会出错页。
- **list slot 里的官方条目**：Tier B 的浏览器半侧在**岛模式下**（`location.hash` 带 `#dsh-go-island=<slot>`）用同 id、更低 priority 注册空组件，遮掉官方占用者（依据：同 id 复用即替换，`slots.zh.md`「Cardinality 与 scope」）。只剩第三方条目。Tier A 主机上面板岛不可用，只有整页岛。

### 6.2 三种形态

| 形态 | 用于 | 尺寸 | 触摸与滚动 |
|---|---|---|---|
| 整页岛 | P0 各项 | 占满一页或一个页签 | WebView 自己滚，原生只管返回 |
| 面板岛 | P1 聊天页「插件」面板 | 固定高度的底部面板；内容高度经 `size` 上报，超出就内部滚动 | 面板拖动把手是原生的；WebView 区域内的手势全交给 WebView |
| 浮层岛（P2） | shell.overlay | 全屏透明，叠在原生界面上 | 原生 `RenderBox.hitTest` 只认岛上报的命中区（≤16 个矩形，10 Hz 节流），区外触摸落到下层 Flutter 组件。可行的依据：Flutter 先在 Dart 侧做命中测试，平台视图只有被命中才收到事件（webview_flutter_android 4.14.1 默认 TLHC） |

浮层岛的已知限制：移动中的元素（被甩出去的宠物）命中区有约 100 ms 滞后；整页常驻一个完整客户端。所以只做逐插件手动开启，宠物走原生。

### 6.3 桥接 API

通道：`JavaScriptChannel('DshGoIsland')`，页面侧全局 `window.__dshGoIsland`，由 `island.js` 安装。

岛 → 原生（JSON，`t` 为类型）：

| t | 字段 | 原生处理 |
|---|---|---|
| `ready` | `slot, cell?, release, found` | 显示岛 |
| `empty` / `error` | `slot, code: boot\|slot-missing\|crash, detail` | 销毁，换「在网页版打开」 |
| `size` | `h`（CSS px） | 面板岛调整内容高度（上限为面板高度） |
| `hit` | `rects: [[x,y,w,h]…], dpr` | 浮层岛更新命中区 |
| `link` | `url` | 只收 https；原生弹确认（显示域名）后用外部浏览器打开 |
| `session` | `id` | 插件想打开某个对话：校验存在后开原生对话页 |

原生 → 岛（`runJavaScript`）：`__dshGoIsland.init({slot, cell, mode, theme, insets, textScale})`、`setTheme(theme)`、`setInsets({top, bottom})`。

**桥是不可信输入**：`addJavascriptInterface` 对页面里所有 frame 都可见，所以桥只做呈现类消息。不提供任何读写 App 数据、发消息、装插件的能力。导航限制在主机同源，复用 `dshWebNavigation` 的判定逻辑，在岛组件里另写一份。

## 7. 内存上限策略

依据：一个岛就是一整个官方客户端，外壳 JS 约 1.7 MB，官方插件 bundle 合计约 12 MB（本机 0.2.1-rc.2 文件体积），另有自己的 `remote.mux` 连接和会话投影。**估计 JS 堆 80–150 MB / 岛**，需真机测量（§12）。Android WebView 的所有页面共用一个渲染进程，渲染进程崩了，所有岛一起没。

| 规则 | 值 |
|---|---|
| 同时存活的岛 | `totalMem < 6 GB` → 1；6–10 GB → 2；≥ 10 GB → 3。实测单岛 PSS（App 进程 + sandboxed_process）> 150 MB 时一律 1 |
| 优先级 | 前台整页 / 面板岛 > 浮层岛 > 探针岛；超额时先关浮层、再关最久未见的 |
| 离开所在页面 | 30 秒后销毁（返回再进可复用热岛） |
| App 进后台 | 对可见岛调 WebView `onPause()`，60 秒后全部销毁；不在后台留岛 |
| `onTrimMemory(RUNNING_LOW)` 及以上 | 销毁全部不可见岛 |
| 渲染进程丢失 | 全部岛销毁；所在位置显示「插件界面已关闭」，点按重载 |
| 首开 | 显示骨架；WebView 初始化 + 客户端启动预计 1–3 秒 |

`SlotAdapterRegistry.plan()` 只读 `IslandBudget` 的「还能不能开岛」。

## 8. 主题同步

- **亮暗**：让 WebView 的 `prefers-color-scheme` 跟随 App。
  - Kotlin 经 `WebViewFlutterAndroidExternalApi.getWebView(engine, id)` 拿到 WebView（webview_flutter_android 4.14.1 自带此类）。
  - 再用 androidx.webkit 的 `WebSettingsCompat.setForceDark` + 只用网页主题的暗色策略（targetSdk 28 走这条）。androidx.webkit 1.15.0 已是传递依赖，App 需显式声明同版本。
  - DSH 主题为 `system` 时随之切换。不写宿主设置：`ui-theme` 的模式存在宿主上，跨浏览器共享，改了会影响用户电脑上的网页版。
- **配色**：注入 `<style id="dsh-go-island-theme">`，用 App 配色覆盖 DSH 的核心别名 token（共 107 个，取最影响观感的约 15 个）：
  - 背景：`--dsw-alias-bg-base`（岛内设为透明）、`--dsw-alias-bg-layer-1/2`。
  - 文字：`--dsw-alias-label-primary/secondary/tertiary`。
  - 描边：`--dsw-alias-border-l1…l4`。
  - 强调：`--dsw-alias-brand-primary`、`--dsw-alias-link`。
  - 状态：`--dsw-alias-state-{success,warn,error}-primary`。
  - 交互：`--dsw-alias-interactive-bg-hover`。
  - 再加 `color-scheme`。用户在 DSH 显式设了 light / dark 时，靠这层覆盖保证外观跟 App 一致。
- **字体与字号**：同手机布局，注入 App 自带字体。字号按 App 字号缩放，用 CSS `zoom` 或覆盖字号 token，二选一，以实测对齐为准。
- **切换**：App 亮暗、强调色、字号变化时调 `__dshGoIsland.setTheme(...)`，不重载页面。

## 9. 安全：插件路由不鉴权

### 9.1 问题

- `dsh-host-webserver` 只做路由分发，不做鉴权（`dsh-host-webserver/lib/index.js` 的 `handle`：`match` 命中即调 handler）。官方 `/api` 自己验 cookie，插件注册的前缀路由多数不验。
- dsh-pet 的 `/dsh-pet-7340/chat` 能直接花用户模型额度（`pets.md` §3.1）。
- 本机引擎监听 `127.0.0.1:3080`，Android 上回环地址对所有 App 共享，任何装了联网权限的 App 都能调这些路由。手机浏览器里的网页也能对它发「简单请求」（CSRF / DNS rebinding）。
- 抽样里 13/15 的插件有自定义路由。

### 9.2 兜法

| 层 | 作用范围 | 做法 |
|---|---|---|
| **G1 路由守卫（必须，网页岛之前）** | 本机引擎 | 在运行时构建里给 `dsh-host-webserver/lib/index.js` 打补丁：`match` 命中 exact / prefix 路由后，调 `ctx.get('connection')?.requestRejection(req)`（`dsh-client-connection/lib/index.js:736-750`）。它同时检查 Host/Origin 白名单和 cookie / API 鉴权；返回 401 / 403 就直接拒绝。例外只有 `GET /`（自带启动令牌换 cookie）和显式白名单。同源页面里插件自己的 fetch、`<video>`、`<script>`、EventSource 都自带 cookie，不受影响；App 的 Dart 客户端走 API 鉴权，同样放行 |
| G1 的保障 | 本机引擎 | 补丁按 DSH 版本钉住原文件 sha256，对不上就构建失败。构建期测试启动 profile 后列出全部已注册路由，逐个断言：没有 cookie 时 401，有 cookie 时照常 |
| G1 的退路 | 本机引擎 | 补丁维护不动时，由 `dsh-go-bridge` 宿主半侧在最先加载时包装 `webServer.register` 给每个 handler 套同样的检查。依赖加载顺序，PoC 证明可行才用 |
| G2 桥最小化 | 所有主机 | §6.3：桥只收呈现类消息；外链要确认；导航限同源 |
| G3 令牌不外泄 | 所有主机 | 岛只经 `/?token=` 换 cookie，和现在的网页版相同；不向页面注入任何 App 侧凭据 |
| 远程主机 | — | 管不了对方的进程，在文档里如实说明。SSH 主机可在用户同意后安装 `dsh-go-bridge`，由它的宿主半侧走退路做守卫 |

另提一条上游 issue：请 DSH 给插件路由默认套 `requestRejection`，或者给 `register` 加 `auth` 选项。合入后删掉 G1 补丁。

## 10. 原生界面的声明式自定义（`ui.json`）

### 10.1 位置与读取

| | 本机引擎 | 远程主机 |
|---|---|---|
| 路径 | `$DSH_HOME/dsh-go/ui.json`，即 rootfs 内 `/root/.dsh/dsh-go/ui.json`，App 侧是 `filesDir/runtime/rootfs/root/.dsh/dsh-go/ui.json` | 对方的 `$DSH_HOME/dsh-go/ui.json` |
| 读 | App 直接读文件（Dart） | `workspaceFiles/read`（`packages/dsh_client/lib/src/workspace_api.dart` 已封装）。这个端点接受工作区外的绝对路径，权限由对方文件系统组合决定；需要带一个会话 id（`workspaceFileScopeId`），取最近一个对话；主机上一个对话都没有时暂不读 |
| 找到 `$DSH_HOME` | 固定 `/root/.dsh` | ① SSH 主机：启动时读远端环境变量；② 其他主机：`skills/list`（`features_api.dart:493`）里 `dsh-go-ui` 技能的 `path` 往上三级（`<dshHome>/skills/dsh-go-ui/SKILL.md`）；③ 都拿不到 → 设置里显示「这台主机还没装界面技能」+ 安装入口（§10.5） |
| 自动重读 | `Directory('<rootfs>/root/.dsh/dsh-go').watch()`（inotify；目录不存在时 App 先建），加上回到前台时补读一次；去抖 300 ms | `workspaceFiles/changes` 流（文件监听沿用文件读权限，可在工作区外）；不支持时退回前台每 60 秒一次 `stat` 比对 `version`；重连和回到前台时补读 |
| 写 | App 不写 ui.json（只读）。可选：本机 App 把读取结果写到 `$DSH_HOME/dsh-go/ui.status.json`，供 agent 自查 | 远程只读（`dsh-api-workspace-files` 不提供写操作） |

- 每台主机各自一份。App 按 `hostId` 缓存最后一次有效配置，冷启动时先用缓存，避免界面闪变。
- 中转主机若不开放 `workspaceFiles/*`，就不支持 ui.json（用 `supportsEndpoint` 判定）。

### 10.2 schema v1

严格 JSON（不允许注释和尾逗号），文件不超过 64 KiB。示例：

```json
{
  "version": 1,
  "header": { "actions": ["schedule", "detail", "newChat",
    { "id": "daily", "icon": "bolt", "label": "日报", "action": { "type": "send", "text": "按模板写今天的日报" } }] },
  "composer": { "quickActions": [
    { "label": "总结", "action": { "type": "send", "text": "总结上面的对话，列三条要点" } },
    { "label": "压缩", "action": { "type": "command", "name": "compact" } } ] },
  "emptyState": { "suggestions": [
    { "title": "看看今天的待办", "subtitle": "读工作区里的 TODO.md", "action": { "type": "send", "text": "读一下 TODO.md，告诉我今天先做什么" } } ] },
  "drawer": { "groups": ["pinned", "folders", "today", "yesterday", "thisWeek", "earlier"], "sort": "activity", "filter": "all" },
  "density": "compact",
  "hide": ["turnFooter", "tokenCount", "reasoningDetails"],
  "theme": { "mode": "system", "accentPreset": "daiqing" },
  "pet": { "id": "deepy-whale", "position": "bottom-right", "quiet": true },
  "shortcuts": [ { "keys": "ctrl+k", "action": { "type": "open", "page": "search" } } ],
  "plugins": { "seats": { "conversation.input.dock": { "dsh-cost-meter": "hidden" } } }
}
```

| 键 | 内容与约束 | 覆盖的 App 设置 |
|---|---|---|
| `version` | 必填，整数。大于 App 支持的版本时整份忽略，提示「需要更新 App」 | — |
| `header.actions` | 顺序即显示顺序；内置 id 取自 `chat_header.dart` 的现有按钮（实现时以代码为准列出白名单，至少 `newChat`、`detail`、`schedule`）；不在列表里的内置按钮隐藏；自定义按钮 ≤ 3 个，`icon` 取自 App 图标白名单，`label` ≤ 8 字 | — |
| `composer.quickActions` | ≤ 8 个胶囊，`label` ≤ 10 字；显示在输入框上方（与活动条互斥：生成中隐藏） | — |
| `emptyState.suggestions` | ≤ 6 张卡；`title` ≤ 20 字，`subtitle` ≤ 40 字 | — |
| `drawer` | `groups` 顺序与可见性（取值对齐 `drawer_view_state.dart` 的 `SessionDay` 与置顶、文件夹）；`sort`：activity / created；`filter`：all / running / pending / unread | 抽屉排序、筛选 |
| `density` | compact / comfortable | （新设置） |
| `hide` | 枚举：turnFooter、tokenCount、reasoningDetails、activityStrip、whaleTail、todoPill、goalBar、pluginCapsule（App 的「插件」聚合入口） | 「折叠已完成回合」等对应项 |
| `theme` | `mode`：system / light / dark；`accentPreset`：mist / daiqing / dusk / turquoise / amber / graphite（`app/lib/ui/theme/accent.dart`）；或 `accent`：`#RRGGBB` | 外观页的主题、强调色 |
| `pet` | `id`、`position`（四角）、`quiet`；宠物功能落地前只校验不生效 | 宠物设置 |
| `shortcuts` | 平板键盘；`keys` 形如 `ctrl+k`、`ctrl+shift+n`，不得覆盖系统和输入法保留键；≤ 20 条 | — |
| `plugins.seats` | `{slot: {package: "native" \| "island" \| "web" \| "hidden"}}`，接入 §4 的 `SeatOverrides` | — |

**动作只能取预定义集合**，没有脚本、HTTP、安装：

| type | 字段 | 触发时 |
|---|---|---|
| `send` | `text`（≤ 2000 字） | 把文字放进输入框（复用 `app/lib/state/composer_insert.dart`），**用户点发送才发**；绝不自动发送 |
| `open` | `page`：`feature_catalog.dart` 的 id（session-detail、files、terminal、jobs、skills、schedules、models、plugins、cordis、search、engine、web …），另加 `new-chat`、`settings` | 打开对应原生页 |
| `command` | `name`（不带 `/`）、`args?` | 用户点按后经 `commands/execute`（`session_api.dart:620`）在当前对话执行；需要有当前对话 |
| `link` | `url`：只收 `https://` | 每次弹确认（显示完整域名）后用外部浏览器打开 |

所有动作只在用户点按时触发，配置加载本身不产生任何副作用。

### 10.3 校验与反馈

- **逐项校验**：每个条目独立校验，出错的项忽略，其余照常生效。错误记为 JSON Pointer，例如 `/composer/quickActions/2/action/url：只支持 https 链接`。
- **语法错误**：整份无法解析时，保留上一次有效配置，记录行列号。
- **字段规则**：
  - 未知顶层键忽略并记一条提示；未知 `type` 和枚举值算错误。
  - `label` / `title` 去掉控制字符和换行；超长截断并记一条提示。
- **设置里的提示**：设置 › 外观（或「界面配置」行）安静显示一行，例如「ui.json · 已应用 12 项，2 项有误」，点开看错误列表。没有 ui.json 时这一行不出现。不弹窗，不发通知。
- **被覆盖的设置项**：控件旁标「来自 ui.json」并置灰，附「恢复默认」。
  - 「恢复默认」= App 按 `hostId + JSON Pointer + 当前值的哈希` 记一条忽略。该项回到 App 自己的设置；文件里这个值变了，忽略自动失效，重新生效。
  - App 不改写 ui.json：远程本来就只读，本机也保持文件只归用户和 AI。

### 10.4 实现形态（`app/lib/ui_config/`）

```dart
class UiConfig { final int version; final HeaderSpec? header; final List<QuickAction> quickActions; … }
class UiConfigIssue { final String pointer; final String message; final bool fatal; }
class UiConfigLoad { final UiConfig config; final List<UiConfigIssue> issues; final DateTime readAt; final String? sourceVersion; }

abstract interface class UiConfigSource {               // 本机文件 / 远程 workspaceFiles 两种实现
  Stream<String?> watch();                               // 文本或 null（文件不存在）
}
UiConfigLoad parseUiConfig(String text, {UiConfig? lastGood});   // 纯函数，单测覆盖
final uiConfigProvider = Provider.family<UiConfigLoad?, HostRef>(…);
final uiOverridesProvider = …;   // 合并 App 设置、ui.json 与忽略表，给各界面读
class FromUiJsonBadge extends StatelessWidget { … }     // 「来自 ui.json」+「恢复默认」
```

各界面怎么消费（顶栏、输入框胶囊、空状态、抽屉、疏密、隐藏项、主题、快捷键）逐个界面接入（§11）。

### 10.5 教会 AI：技能

- **技能位置与格式**（`dsh-skill-filesystem/README.zh.md`）：
  - 用户根是 `<dshHome>/skills`（rank 400，跳过 `.system` 子目录）；
  - 目录形式 `<name>/SKILL.md`，YAML frontmatter 必填 `name`（kebab-case）和 `description`，可选 `whenToUse`；
  - 根目录受监视，**新增无需重启**。
- **内容**：`$DSH_HOME/skills/dsh-go-ui/`：
  - `SKILL.md`：何时用（「把手机 App 的 XX 改成 YY」）、文件路径、改法（读 → 改 → 写回 → 自查）、动作集合、限制、常见示例。
  - `schema.json`：v1 的 JSON Schema，与 App 的 Dart 校验同源。
  - `examples/*.json`。
  - `scripts/check.mjs`：零依赖校验器，`node $DSH_HOME/skills/dsh-go-ui/scripts/check.mjs` 输出与 App 相同的 Pointer 错误。
  - 本机另可读 `ui.status.json`。
  - 两套校验共用 `app/test/ui_config/fixtures/`。
- **本机自动安装**：每次引擎启动前由 Dart 写入 rootfs（与 `GuestSetup.writeAgentsMd` 同样的「受管标记」做法：`SKILL.md` 首行带 `<!-- dsh-go:managed -->`，用户删掉这行后不再覆盖）。不改 `GuestSetup.kt`。
- **远程安装**（必须用户确认）：
  - ① SSH 主机：经已有的 SSH 通道写文件。
  - ② 其他主机：App 准备一条消息（含技能文件内容和写入指令），放进输入框由用户点发送，让对方 agent 用自己的工具写入。
  - 装好后 `skills/list` 能看到 `dsh-go-ui`，同时解决 `$DSH_HOME` 定位（§10.1）。

### 10.6 重置与升级会不会清掉（核实结果）

| 操作 | 代码 | 结果 |
|---|---|---|
| **运行时升级** | `RuntimeInstaller.install` → `activateRootfs`（`app/android/.../runtime/RuntimeInstaller.kt:32-58、106-126`） | **保留**。用户的 `/root` 先移到 `home.carry`，新 rootfs 换上后再移回，`/root/.dsh` 里的插件（`profiles/web`）、`cordis.patch.yml`、`skills/`、`dsh-go/ui.json` 都在。被替换的只有运行时自有文件，如 `/etc/dsh-app/dsh-web.patch.yml`（每次升级重写，`rtbuild.py:696-705`） |
| **「重置运行环境」** | `RuntimeController.reset` → `RuntimeInstaller.reset()` = `baseDir.deleteRecursivelySafely()`（`RuntimeController.kt:296-325`、`RuntimeInstaller.kt:71-73`） | **全部删除**：整个 `filesDir/runtime`，包括 `/root/.dsh` 下的插件、补丁、技能、ui.json、对话记录。对话框文案只提到「对话记录和工作区文件」（`app/lib/ui/engine/engine_screen.dart:365-368`） |

建议：

1. 重置对话框加一个勾选「保留界面配置和技能」，**默认勾选**。
   - 保留 `/root/.dsh/dsh-go/` 和 `/root/.dsh/skills/`：用户写的、体积小、不会把引擎弄坏。
   - 做法：删除前移到 `filesDir/runtime-keep/`，重新解压完成后移回。
2. 再加一个勾选「保留已装插件和设置」，**默认不勾**。
   - 保留 `profiles/`、`cordis.patch.yml`、`.env`。重置多半是为了救坏插件，默认不留。
3. 文案改成如实列出会删什么（插件、设置、技能、对话、工作区）。

## 11. 实现顺序与上线门槛

接缝内核与清单（`app/lib/plugins/seams/`）、网页岛运行时（`app/lib/ui/plugins/islands/`、`app/assets/islands/`）、宿主桥接与路由守卫（`runtime/bridge/dsh-go-bridge/`、运行时补丁）、`ui.json` 内核（`app/lib/ui_config/`、`app/assets/skills/dsh-go-ui/`）互不依赖，可以并行。整页岛接入依赖前三者；聊天页面板岛、`ui.json` 在各界面的接入排在其后；浮层岛和声明式面板服务属于 P2。

**上线门槛**：G1 路由守卫随运行时出包之前，本机引擎的整页岛不对用户开放。远程主机的整页岛可先开，那里的风险与现在的「网页版」入口相同。

## 12. 待验证项

| 项 | 涉及部分 | 通过标准 |
|---|---|---|
| 单岛内存 | 网页岛 | 真机 `dumpsys meminfo`：App 进程 + WebView 渲染进程的增量，写回本文 §7 |
| 隔离配方 | 网页岛 | settings.section（dsh-pet「桌宠配置」）、plugins.bundle.config、sidebar.right.pane.tab、main 四类各一个真插件，`ready` 后只露目标内容 |
| force-dark 跟随 | 网页岛 | App 切深色后岛内 `matchMedia('(prefers-color-scheme: dark)')` 为 true，DSH 主题为 system 时跟随 |
| 岛模式遮官方条目 | 宿主桥接 | 在 `conversation.input.dock` 用同 id、更低 priority 注册空组件，官方条目消失，第三方条目保留 |
| G1 守卫 | 路由守卫 | 构建期列出全部路由：无 cookie 401 / 403；网页版、插件页面、App 原生功能回归全部正常 |
| `__DSH_BOOT__` 解析 | 接缝内核 | 本机与 SSH 主机都能列出带浏览器半侧的包 |
| 远程读 ui.json | `ui.json` | 工作区外绝对路径 `read` + `changes` 在 SSH 主机可用；对方沙箱策略拒绝时给出明确提示 |
| 技能热加载 | `ui.json` | 写入 `skills/dsh-go-ui/` 后不重启，下一轮对话 `skills/list` 可见 |

## 附录 A：slot 目录与抽样数据的来源

- **slot 全表（100 项）**：对 `dsh-cordis-client-runner/lib/client.js` 做文本解析（不执行），按 `key: "…", kind: "…", scope: "…", summary: "…"` 逐项提取 `declaredBy`、`occupants`、`replaceRisk`。结果存为 `slot-catalog-<DSH 版本>.json`；当前版本的 `key` / `kind` / `scope` / `replaceRisk` 四列提交在 `app/test/plugins/seams/fixtures/`，`slot_catalog_test.dart` 拿它核对 `slotCatalog`。DSH 升级后照此重新生成，与本文 §3 对比增删。
- **slot 树**：`deepseek-harness/docs/subsystems/slots.zh.md`「当前层级」（0.2.0-rc.2 源码）。
- **插件抽样**：16 个包（15 个带浏览器半侧 + 1 个只有宿主侧的 dsh-whale-widget）的 tarball 从 npm 下载后解包阅读（解包内容不入库）。逐包的 slot、inject、是否挂 body、是否改官方 DOM、宿主路由已汇总进本文 §1.3。
