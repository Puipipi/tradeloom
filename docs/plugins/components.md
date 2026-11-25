# 组件目录

插件视图是一棵 JSON 组件树：每个节点 `{ "type": 组件名, …属性 }`。v1 共 16 个组件，前 10 个和模型输出的 `dsh-ui` 卡相同，后 6 个是插件视图独有；v2 再加 26 个（输入、结构、空状态、图集）。规格原文：[`docs/design/native-plugins-views.md`](../design/native-plugins-views.md)；机器可读：[`sdk/plugin-kit/schema/view.schema.json`](../../sdk/plugin-kit/schema/view.schema.json)。

截图是 App 的 golden 测试图（浅色 / 深色，390 宽），和真机渲染同一套代码。

## v2 样式

根节点写 `v: 2`，即可给文字加语义字号、字重、富文本和可读颜色，给容器加卡片样式、间距、对齐和比例列。完整语法、预算和向后兼容规则见 [样式](styles.md)。省略版本仍按 v1 渲染。

## 布局与文字

| 组件 | 属性 | 说明 |
|---|---|---|
| `stack` | `children`：组件数组 | 竖排。根节点可以多带 `title`（工具卡折叠时的摘要）和 `v: 1` / `v: 2` |
| `row` | `children` | 横排；按最宽的子组件算一行放几个，窄屏自动折行，列对齐 |
| `text` | `text`；`tone?: muted` | 段落。插件视图只认段落、换行、`**粗体**`、`` `代码` ``；链接只显示文字 |
| `callout` | `text`；`tone?: info\|good\|warn\|bad` | 提示条 |
| `steps` | `items: [{ label, status: done\|current\|todo\|failed, detail? }]`（≤ 12） | 步骤；项可以直接写字符串（按 todo） |
| `compare` | `items: [{ title, badge?, rows: [[名称, 值]] }]`（2–4 项，每项 ≤ 8 行） | 竖排对比卡；`rows` 也可写 `{ 名称: 值 }` |

| 浅色 | 深色 |
|---|---|
| ![text、steps、callout、compare（浅色）](../../app/test/chat/dsh_ui/goldens/dsh_ui_content_light.png) | ![text、steps、callout、compare（深色）](../../app/test/chat/dsh_ui/goldens/dsh_ui_content_dark.png) |

## 数字与图表

| 组件 | 属性 | 说明 |
|---|---|---|
| `metric` | `label`、`value`；`tone?: good\|warn\|bad\|info`；`caption?` | 一个关键数字。数字一万以上自动加千分位；单位小一号、数字等宽 |
| `chart` | `kind: bar\|hbar\|line\|donut`；`categories`；`series: [{ name?, values }]`；`unit?`；`caption?` | ≤ 60 个点、≤ 6 组；环形图只画第一组；值写 `null` 留空 |
| `progress` | `value`；`max?`（缺省 100）；`label?`；`caption?`；`tone?` | 一条进度；`caption` 缺省显示百分比 |

| 浅色 | 深色 |
|---|---|
| ![metric、chart（浅色）](../../app/test/chat/dsh_ui/goldens/dsh_ui_display_light.png) | ![metric、chart（深色）](../../app/test/chat/dsh_ui/goldens/dsh_ui_display_dark.png) |

## 插件视图独有的 6 个

| 组件 | 属性 | 上限 | 说明 |
|---|---|---|---|
| `list` | `items: [{ title, subtitle?, trailing?, icon?, tone?, action? }]` | 50 行 | 一组行。`trailing` 是行尾的值；有 `action` 的行可点，带箭头 |
| `keyValue` | `items: [[名称, 值]]`、`[{ label, value, tone? }]` 或 `{ 名称: 值 }` | 24 项 | 「名称 …… 值」，值右对齐、数字等宽 |
| `progress` | 见上 | — | — |
| `table` | `columns: [文字 \| { label, align?: start\|end }]`；`rows: [[单元格]]` | 8 列、50 行 | 整列是数字时自动右对齐；放不下时横向滑动 |
| `actions` | `items: [{ label, action, icon?, style?: primary\|plain }]` | 4 个，至多一个 primary | 1–2 个并排等宽，3–4 个竖排 |
| `image` | `src`；`alt?`；`aspect?`（宽 / 高，0.25–4）；`caption?` | `data:` ≤ 64 KiB，单边 ≤ 4096、总像素 ≤ 400 万 | `src` 只收 `asset:icons/a.png`（清单 `assets` 目录里的 png / jpg / webp / gif）或 `data:image/…;base64,…` |

| 浅色 | 深色 |
|---|---|
| ![list、keyValue、progress、table、actions、image（浅色）](../../app/test/plugins/view/goldens/plugin_view_blocks_light.png) | ![list、keyValue、progress、table、actions、image（深色）](../../app/test/plugins/view/goldens/plugin_view_blocks_dark.png) |

## 空状态、图集、环形进度、趋势线（v2）

根节点写 `v: 2` 才有。老 App 不认 `emptyState` / `gallery`，画灰色占位；`progress.shape` 和 `metric.trend` 它直接忽略，照旧画进度条和数字。要兼顾老 App，用 SDK 的 `adaptView(view, caps)`：图集换成 `grid` 里的 `image`（没有 `grid` 时竖排），空状态换成 `callout` 加它的按钮。

| 组件 / 属性 | 写法 | 上限 | 说明 |
|---|---|---|---|
| `emptyState` | `title`；`message?`；`icon?`；`action?: { label, action, icon? }` | 标题 40、说明 120、按钮 12 字；按钮至多一个 | 和 App 自己的空状态同一个样子：48 的圆底图标（跟随视图 accent）、标题、一行说明、一个和文字一样宽的描边按钮，整体居中。工具卡里没有按钮 |
| `gallery` | `items: [{ src, alt?, caption?, action? }]`；`columns?: 2–4`；`aspect?: 0.5–2`（宽 / 高，缺省 1） | 面板 24 张、工具卡 8 张；`src` 同 `image` | 等宽格子，间距 8，圆角 8。没写 `columns` 时内容宽 ≥ 320 排 3 列，否则 2 列；格子窄于 72 就减列。同一行有一格带 `caption`，整行都留出说明高度。带 `action` 的格子点按交给插件；其余点按、以及任何格子的长按，打开 App 的看图页（左右滑这一组、双指缩放、保存和分享是 App 的动作，插件拿不到）。`src` 不合规的格子画浅底占位，不进看图页 |
| `progress` 的 `shape` | `"bar"`（缺省）\| `"ring"` | — | 环：直径 64、线宽 6，中间是百分比（或 `caption`），`label` 在环下居中；在 `row` / `grid` 里各自列里居中 |
| `metric` 的 `trend` | 2–30 个数字，可夹 `null` | 30 点 | 值下方一条高 24、和指标同宽的折线，色调色或 accent；`null` 断开，最后一个点画圆点；没有坐标轴和数字 |

| 浅色 | 深色 |
|---|---|
| ![环形进度、趋势线、图集（浅色）](../../app/test/plugins/view/goldens/plugin_view_figures_light.png) | ![环形进度、趋势线、图集（深色）](../../app/test/plugins/view/goldens/plugin_view_figures_dark.png) |
| ![空状态（浅色）](../../app/test/plugins/view/goldens/plugin_view_empty_light.png) | ![空状态（深色）](../../app/test/plugins/view/goldens/plugin_view_empty_dark.png) |

```json
{ "v": 2, "type": "stack", "accent": "app", "children": [
  { "type": "row", "children": [
    { "type": "progress", "shape": "ring", "value": 72, "label": "本月额度" },
    { "type": "metric", "label": "今日", "value": "¥3.1", "tone": "good", "trend": [1.2, 2.0, 1.4, null, 2.6, 3.1] }
  ]},
  { "type": "gallery", "items": [
    { "src": "asset:stickers/sea.webp", "alt": "海", "caption": "海边" },
    { "src": "asset:stickers/sunset.webp", "alt": "日落", "action": { "id": "pick", "args": { "id": "sunset" } } }
  ]}
]}
```

## 选项与确认

| 组件 | 属性 | 点按 |
|---|---|---|
| `options` | `id`；`options: [{ label, description?, value? }]`（≤ 8，可直接写字符串）；`multi?`；`selected?` | invoke `id`，`value: { value }`（多选 `{ values }`）。选中态以你推来的 `selected` 为准 |
| `confirm` | `id`；`confirmLabel?`、`cancelLabel?`（≤ 12 字） | invoke `id`，`value: { confirmed: true \| false }` |

插件面板里的样子（指标、进度、列表、按钮、单选、文字、提示）：

| 浅色 | 深色 |
|---|---|
| ![插件面板（浅色）](../../app/test/plugins/view/goldens/plugin_view_panel_light.png) | ![插件面板（深色）](../../app/test/plugins/view/goldens/plugin_view_panel_dark.png) |

## 工具卡

工具行展开区里的卡片；折叠时摘要是视图的 `title`。第 0 期不能点：按钮和确认不显示，选项只读。

| 浅色 | 深色 |
|---|---|
| ![工具卡（浅色）](../../app/test/plugins/view/goldens/plugin_toolcard_light.png) | ![工具卡（深色）](../../app/test/plugins/view/goldens/plugin_toolcard_dark.png) |

## 出错和没数据时

| 情况 | 显示 |
|---|---|
| 子组件写错（不认识的 `type`、缺必填属性） | 这一个换成灰色占位「这部分无法显示」，其余照画 |
| 根节点坏了、视图超大小、嵌套太深 | 整块一行「插件界面有误」 |
| 需要数组的组件拿到空数组或绑定取不到 | 一行「暂无数据」，不算错 |
| 绑定的文字取不到 | 「—」 |
| 图片地址不合规或解不开 | 浅底占位「图片无法显示」 |

| 浅色 | 深色 |
|---|---|
| ![出错与空状态（浅色）](../../app/test/plugins/view/goldens/plugin_view_states_light.png) | ![出错与空状态（深色）](../../app/test/plugins/view/goldens/plugin_view_states_dark.png) |

## 共同规则

| 项 | 规则 |
|---|---|
| 文字属性 | 字符串；写数字按文字显示（一万以上加千分位） |
| 色调 | `good` `warn` `bad` `info` `muted`；别名 `success` `warning` `danger` `error` `note` `secondary` 也认。具体颜色由 App 定 |
| 图标 | bolt star sparkle heart flag bookmark pin bell clock alarm calendar todo note document folder search code terminal globe chart lightbulb book puzzle robot chat mail translate image camera mic link summary wrench bug travel school home play refresh archive team wallet palette coin money speaker read copy quote share edit write save paste add remove delete clear fork regenerate reply select-text qr download downloads external info warning check done success error question pending running tip list table panel sidebar menu more expand collapse file folder-open workspace storage pdf zip slides article text diff gallery audio music video video-file play-video pause stop replay generate-image generate-video diagram plugin bot agent skill model tool workflow goal plan job automation command trajectory web web-search browser history time today timezone schedule repeat reminder user account group chats mention invite announcement reaction poll notification send community forum feedback wechat qq telegram discord phone computer cloud server power restart retry theme color text-size pet featured badge favorite settings（共 162 个；没有锁、钥匙、盾牌这类安全语义的图标）；不认识的画默认图标 |
| 未知属性 | v1 忽略；v2 的未知 / 保留 style 字段忽略并记诊断 |
| 绑定 | 任何值写 `{ "$": "data.a.b" }` 或 `data.rows[0].name`，从推来的数据里取；`type` 不能绑定。工具卡没有数据 |
| 动作 | `"action": "id"` 或 `{ "id": "open", "args": { … } }`，`args` ≤ 1 KiB |

## 上限

| 项 | 工具卡 | 面板 | 状态条 |
|---|---|---|---|
| 视图大小（JSON） | 8 KiB | 32 KiB | 2 KiB |
| 组件 / 层数 | 40 / 6 | 120 / 8 | 8 / 3 |
| 每个 `stack` / `row` 的子组件 | 16 | 32 | 4 |
| 文字 / 标签 | 2000 / 200 字 | 2000 / 200 字 | 200 字 |

超大小、嵌套超过 64 层：整块降级。其余超限截断，在被截的组件下标一行小字。`check` 报的就是这些，措辞和 App 插件详情页一样。

## 视图 v2 输入与结构组件

输入与结构的 24 个组件、表单、双向绑定、有限公式、调度与位置预算见[输入、表单与本地状态](inputs.md)；空状态和图集见上面。完整可运行示例是[工作台](../../examples/plugins/dsh-go-example-workbench/)。
