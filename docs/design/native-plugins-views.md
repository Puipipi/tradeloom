# 原生插件视图格式 v1 / v2

> 2026-10-25。`native-plugins.md` §3.3、§3.4、§3.7、§3.8 的落地规格：插件交给 App 的界面长什么样、App 怎么画、画不了怎么办。
> 机器可读真源：`sdk/plugin-kit/schema/view.schema.json`（与本文同步，冲突时以 schema 为准）。
> 传输、清单、invoke 请求体见原生插件协议（NA 协议，`native-plugins-protocol.md`）。本文只管「视图」这一层。

## 0. 要点

| 项 | 规定 |
|---|---|
| 是什么 | 一棵 JSON 组件树。`dsh-ui` 一期 10 种组件的超集，另加 `list`、`keyValue`、`progress`、`table`、`actions`、`image`，共 16 种 |
| 谁来画 | App 的 `dsh_ui` 渲染器。模型输出的 ```` ```dsh-ui ```` 卡和插件视图走同一个解析器，只是「档案」不同（§6） |
| 用在哪 | 工具卡 `tool.card`（第 0 期）、面板 `panel`、状态条 `composer.strip`（第一期） |
| 数据 | 视图和数据分开。任何值的位置都可以写绑定 `{ "$": "data.a.b" }`，取不到就显示「—」 |
| 观感 | v1 保留原组件和语义色调；v2 显式开放有界样式（§7），实际几何、可读颜色和署名由 App 决定 |
| 点按 | 只会变成一次 invoke 回到插件自己；没有任何授权、发送、跳转类的直接能力 |
| 出错 | 能画多少画多少：不认识的组件画灰色占位，超限截断并标注，根节点坏了整块降级成一行「插件界面有误」 |

## 1. 结构

```jsonc
{
  "type": "stack",                // 根节点：任意组件，通常是 stack
  "title": "东京 · 未来 3 天",      // 可选，只认根节点上的；工具卡折叠行的摘要就是它
  "v": 1,                         // 可选；现在只有 1
  "children": [
    { "type": "row", "children": [
      { "type": "metric", "label": "最高", "value": "21°" },
      { "type": "metric", "label": "最低", "value": { "$": "data.low" } } ] },
    { "type": "chart", "kind": "line", "categories": ["周六", "周日", "周一"],
      "series": [{ "name": "气温", "values": [21, 19, 17] }], "unit": "°C" }
  ]
}
```

- 每个节点是 `{ "type": 组件名, ...属性 }`。属性名大小写敏感。
- **不认识的属性一律忽略**（不报错），方便插件同时兼容新旧版本的 App。
- 文字属性收字符串；写成数字或布尔时按文字显示（`3` → 「3」，`true` → 「是」）。数字一万以上自动加千分位。
- 宽松处理与 `dsh-ui` 一致：数组被包成 `{ "item": [...] }` 会解包；数字字段（`value`、`max`、`values` …）写成数字字符串也认；JSON 里的注释和尾逗号只在模型卡里容忍，插件视图必须是严格 JSON。

## 2. 组件目录

「文字」= 字符串（或数字、布尔）。所有属性都可以写绑定（§3），`type` 除外。

### 2.1 一期 10 种（与 `dsh-ui` 相同）

| 组件 | 属性 | 说明 |
|---|---|---|
| `stack` | `children`：1 个以上组件 | 竖排 |
| `row` | `children` | 横排；按最宽的子组件算一行放几个，窄屏自动折行，列始终对齐 |
| `text` | `text`：文字；`tone?`：`muted` | 段落。插件视图里只认段落、换行、`**粗体**`、`` `行内代码` ``；链接只显示文字，图片只显示替代文字，HTML、表格、公式按原文（§7） |
| `metric` | `label`、`value`；`tone?`：good · warn · bad · info；`caption?` | 一个关键数字。单位小一号、次要色，数字等宽 |
| `chart` | `kind`：bar · hbar · line · donut；`categories`；`series: [{name?, values}]`；`unit?`；`caption?` | 图表。环形图只画第一组 |
| `compare` | `items: [{title, badge?, rows: [[名称, 值]]}]` | 2–4 张对比卡 |
| `steps` | `items: [{label, status, detail?}]`，`status`：done · current · todo · failed | 步骤与进度 |
| `callout` | `text`；`tone?`：info · good · warn · bad | 提示条。文字规则同 `text` |
| `options` | `id`；`options: [{label, description?, value?}]`；`multi?`；`selected?` | 选项。点按走 invoke（§4），不发消息 |
| `confirm` | `id`；`confirmLabel?`、`cancelLabel?`（≤ 12 字） | 一对确认 / 取消按钮。点按走 invoke |

插件视图里比模型卡多出的属性：`metric.tone` 可以是 `info`；`options` 的 `value`（点按时回传的值，缺省用 `label`）和 `selected`（当前选中的 `value` 或 `label`，单个或数组，由插件维护）。

### 2.2 新增 6 种

| 组件 | 属性 | 说明 |
|---|---|---|
| `list` | `items: [{title, subtitle?, trailing?, icon?, tone?, action?}]` | 一组行，装在一个浅底井里，行间不画线。单行 52、两行 64。`trailing` 是行尾的值或状态（数字等宽）；`tone` 给行尾文字和图标上色；有 `action` 的行可点，行尾带箭头 |
| `keyValue` | `items`：`[[名称, 值], …]`、`[{label, value, tone?}, …]` 或 `{名称: 值}` | 「名称 …… 值」两列，值右对齐、数字等宽 |
| `progress` | `value`；`max?`（缺省 100）；`label?`；`caption?`；`tone?`：good · warn · bad · info | 一条进度。`caption` 缺省显示百分比；超出 0–`max` 的值按边界画 |
| `table` | `columns: [文字 \| {label, align?: start \| end}]`；`rows: [[单元格, …], …]` | 表格。整列都是数字时自动右对齐；放不下时横向滑动。单元格收文字或数字 |
| `actions` | `items: [{label, icon?, style?: primary \| plain, action}]` | 按钮组。1–2 个并排等宽，3–4 个竖排。一张视图里至多一个 `primary`，多的按 `plain` 画 |
| `image` | `src`；`alt?`；`aspect?`（宽 / 高，0.25–4）；`caption?` | 图片。`src` 只收两种：插件自己的资源 `asset:<路径>`（`dshGo.assets` 目录里的 png / jpg / webp / gif，App 拼成 NA 协议 §4.6 的 `/dsh-go/v1/assets/<包名>/<路径>` 并带凭据去取），和 ≤ 64 KiB 的 `data:image/{png,jpeg,webp,gif};base64,…`。写了 `aspect` 就先按比例占位，不跳动 |

`icon` 只收 ui.json 的图标名（与 `app/assets/skills/dsh-go-ui/schema.json` 的 `icon` 枚举相同，共 43 个）。不认识的名字画默认图标。

### 2.3 色调白名单

| 色调 | 含义 | 用在 |
|---|---|---|
| `good` | 成功、正向 | metric、callout、list、keyValue、progress |
| `warn` | 注意 | 同上 |
| `bad` | 失败、风险 | 同上 |
| `info` | 中性提示 | metric、callout、list、keyValue、progress |
| `muted` | 次要 | text、list、keyValue |

别名照收：`success` / `positive` → good，`warning` / `caution` → warn，`danger` / `error` / `negative` → bad，`note` → info，`secondary` → muted。其余值忽略，按无色调画。色值随 App 深浅色变化，插件拿不到具体颜色。

## 3. 数据绑定

```json
{ "type": "metric", "label": "本对话", "value": { "$": "data.session.cost" } }
```

| 规则 | 说明 |
|---|---|
| 写法 | 只有一个键 `$`、值是路径字符串的对象。多一个键就是普通对象 |
| 路径 | 以 `data` 开头，后接 `.键` 或 `[下标]`：`data.rows[0].name`、`data.rows.0.name` 等价。最多 16 段 |
| 位置 | 任何属性值、数组元素，乃至整个子节点或整个 `children` 数组。`type` 不能绑定（绑了按缺少 type 处理） |
| 求值 | 先求值再校验：绑出来的值和直接写的值受同样的类型检查和上限 |
| 取不到 | 文字显示「—」；图表里的点留空；需要数组的组件（list、table、chart 等）拿到空数组或取不到时，原位显示一行「暂无数据」，不算错误；按钮组（`actions`）没有按钮时什么都不画。直接写字面量 `[]` 也一样（schema 不要求至少一项；只有 `table.columns` 不能为空） |
| 工具卡 | 没有数据模型，所有绑定都取不到。工具卡请直接写值 |
| 第二期 | 公式 `{ "=": "…" }`，与输入控件一起做（与 DS Bot `formula.js` 行为兼容，来源见 THIRD_PARTY_NOTICES.md） |

数据由插件推送，补丁合并规则见 NA 协议；App 每次拿到新数据就整棵重新求值（视图有上限，代价很小）。

## 4. 点按 → invoke

插件视图里的可点元素，只会产生一次「动作」，由 App 发 invoke 回到**这个插件自己**，效果（插入输入框、提示、复制……）由插件的返回决定，走 `native-plugins.md` §3.5 的白名单。

动作引用的写法：

```jsonc
"action": "refresh"                                  // 简写：只有 id
"action": { "id": "open", "args": { "row": 3 } }     // 带参数
```

- `id`：`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`。
- `args`：JSON 对象，求值后 ≤ 1 KiB；超了这个动作作废（元素不可点，记一条问题）。

| 元素 | invoke 的 `id` | invoke 的 `args` |
|---|---|---|
| `actions` 的按钮 | 按钮的 `action.id` | 按钮的 `action.args`（缺省 `{}`） |
| `list` 的行 | 行的 `action.id` | 行的 `action.args` |
| `options`（单选） | `options.id` | `{ "value": 选项的 value ?? label }` |
| `options`（`multi: true`） | `options.id` | `{ "values": [点按后所有选中项的 value] }`，每点一次发一次 |
| `confirm` | `confirm.id` | `{ "confirmed": true \| false }` |

App 附上插件包名和作用域后发出，对应 NA 协议 §4.4：`surface: "panel"`，`id` = 面板 id，`action` = 上表的 invoke id，`value` = 上表的 args。工具卡在 v1 没有 invoke（桥接对 `surface: "tool.card"` 返回 400），见下表「不能点的地方」。

| 行为 | 规定 |
|---|---|
| 反馈 | 点下后这个元素显示小环，直到 invoke 返回。等结果时同一个元素不重复触发（`options`、`confirm` 整组一起等）；视图里的其他元素照常可点 |
| 选中态 | `options` 点下先按选中画；invoke 失败就退回。之后以插件推来的 `selected` 为准 |
| 失败 | 元素恢复可点；错误提示由 App 统一给，插件视图里不出现报错文字 |
| 不能点的地方 | 第 0 期的工具卡没有 invoke 通道：`actions`、`confirm` 不显示；`options` 显示成只读清单（`selected` 打勾）；`list` 行不带箭头 |
| 不发消息 | 插件视图里的 `options` / `confirm` 永远不会像模型卡那样发出 `[dsh-ui reply]` 消息 |

## 5. 上限

| 项 | 工具卡 `toolCard` | 面板 `panel` | 状态条 `strip` | 模型卡（不变） |
|---|---|---|---|---|
| 视图大小（UTF-8 JSON，不含数据） | 8 KiB | 32 KiB | 2 KiB | 16 KiB |
| JSON 嵌套层数（原始结构） | 64 | 64 | 64 | 64 |
| 组件节点 | 40 | 120 | 8 | 40 |
| 组件层数 | 6 | 8 | 3 | 6 |
| 每个 `stack` / `row` 的子节点 | 16 | 32 | 4 | 16 |
| `list` 行 · `table` 行 | 50 · 50 | 50 · 50 | — | — |
| `table` 列 | 8 | 8 | — | — |
| `keyValue` 项 | 24 | 24 | — | — |
| `actions` 按钮 | 4 | 4 | — | — |
| `options` 选项 · `steps` 步 | 8 · 12 | 8 · 12 | — | 8 · 12 |
| `chart` 点 · 系列 | 60 · 6 | 60 · 6 | — | 60 · 6 |
| `compare` 项 · 行 | 4 · 8 | 4 · 8 | — | 4 · 8 |
| 文字 · 标签 | 2000 · 200 字 | 2000 · 200 字 | 200 字 | 2000 · 200 字 |
| `image` 的 `data:` | 64 KiB，且受 8 KiB 总量约束 | 64 KiB | — | 不收 |
| 图片像素 | 单边 ≤ 4096，总数 ≤ 400 万 | 同 | — | — |
| 动作 `args` | 1 KiB | 1 KiB | — | — |

- 视图大小、JSON 嵌套超限：整块降级（§6）。其余超限一律截断，在被截的组件下方标一行小字（「已截断：还有 3 项没有显示」）。
- 状态条预算下只画一行：`text` 的文字、`metric` 的「名称 值」、`progress` 的标签和百分比，用「 · 」连起来；别的组件跳过。v1 的 `composer.strip` 不走组件树（NA 协议 §4.5：插件推 `{text, icon, tone}`，App 直接画），这一档留给以后。

### 5.1 视图 v2 输入与结构预算

完整字段约定与状态顺序见 [`docs/plugins/inputs.md`](../plugins/inputs.md)（[English](../plugins/en/inputs.md)）。这些上限叠加在上表，不替换原有总预算。新节点仅在根 `v: 2` 下识别；模型卡不开放。

| 项 | 面板 | 工具卡 | 状态条 |
|---|---|---|---|
| 输入／表单 | 可编辑；每视图最多 32 个输入 | 只读、无提交；仍限 32 与总节点预算 | 不开放 |
| tabs／折叠组／分页／grid／timeline／展示组件 | 开放 | 开放，本地切换不 invoke | 不开放 |
| 每个新容器的直接孩子 | 32 | 16 | — |
| options | 每字段 24 个，值唯一 | 同 | — |
| tabs／accordion／carousel 组数 | 8 | 8，另受总节点约束 | — |
| timeline 项 | 24 | 24，另受总节点约束 | — |
| grid 列 | 1–4 | 1–4 | — |
| textField 长度／行数 | 2000 个 Unicode 标量／8 行 | 同 | — |
| slider 等分数／rating 最大值 | 1–1000／1–10 | 同 | — |
| codeBlock | 8000 个 UTF-16 单元 | 同，另受 8 KiB 约束 | — |
| avatar | 沿用 image 的来源／像素预算，48dp 方形 | 同 | — |
| form／onChange 动态 invoke.value | 4 KiB UTF-8 JSON，含静态 args | 不发送 | — |
| 公式 | 256 UTF-16 单元／128 tokens／16 层解析递归 | 同 | 不用于新增组件 |

隐藏的后代仍计入预算，分组标题也占一个节点。超过输入数量的字段变成占位；集合超限截断并诊断。表单的非法值与超大提交保留草稿、就地报错，不截断后发送。可写路径最多 16 段／256 字，禁止数组下标、原型名称和父子重叠绑定。固定 pattern 名称为 email／integer／decimal／alphanumeric／slug。

每个面板最多一个在途 invoke、120 个待发送请求；同字段变化合并，变化发送窗口为 250ms，提交采用值快照。该 250ms 是沿用原有 4Hz 通道策略的调度选择，不是真机延迟数据。失败保留草稿，离线停止待发请求且不自动重放。完整并发边界、有限公式语言与跨面板限制见作者文档。

## 6. 容错

| 情况 | 显示 |
|---|---|
| 视图不是对象、超大小、嵌套过深、根节点 `type` 缺失或不认识 | 整块降级成一行「插件界面有误」（工具卡在这行下面照常显示结果文本） |
| 子节点 `type` 不认识、缺必填属性 | 这个子节点换成一行灰色占位，其余照画 |
| 根节点是容器、但子节点全是占位 | 按根节点坏了处理 |
| 未知属性、未知色调、未知图标 | 忽略（图标画默认图标） |
| 绑定取不到 | 见 §3 |
| 图片地址不合规、尺寸超限、没有图片解析器 | 原位一行浅底占位「图片无法显示」（高 48） |
| 图片加载失败 | 已经占好的图片位置里显示「图片无法显示」，不跳动 |
| 数据里有 NaN、无穷大、超长字符串 | 数值留空，文字截断 |

同一个解析器，按「档案」分两种：

| | 模型卡（```` ```dsh-ui ````） | 插件视图 |
|---|---|---|
| 组件 | 一期 10 种 | 16 种 |
| 绑定 | 不认 | 认 |
| `text` | 完整 Markdown | 受限文字（§7） |
| `options` / `confirm` | 发 `[dsh-ui reply]` 消息 | invoke |
| 上限 | 一期上限（不变） | 按预算（§5） |

所有问题带路径（`view.children[2].items[0].action`）收集在解析结果里，插件详情页「原生界面」一行据此显示，不弹窗。

## 7. v2 的样式与边界

根节点显式 `v: 2` 启用新样式；省略或 `v: 1` 保持原渲染路径。详细作者语法、色值与例子见 [样式](../plugins/styles.md)，唯一机器规格仍是 `sdk/plugin-kit/schema/view.schema.json`。NA 主协议的 `v: 1` 不随视图版本改变。

### 7.1 已开放

| 范围 | 有界语法 |
|---|---|
| 文字 | 28 / 24 / 20 / 16 / 13 / 14 dp 对应 display / title / subtitle / body / caption / mono；四档字重，斜体、下划线、删除线；start / center / end；1–20 行后省略；系统 TextScaler 继续作用 |
| spans | 每段 text / color / weight / mono / background；每个 text ≤ 32，工具卡 / 面板 / 条带整树 ≤ 64 / 256 / 16；共用节点文字预算，保留必填 text 作为 v1 回退 |
| 颜色 | 根 accent、十个命名色、#RRGGBB；对浅深色实际不透明背景分别求值；所有新文字均 ≥ 4.5:1，大字也使用这一更强下界 |
| 容器 | plain / surface / tinted / outlined；gap、四边相等 padding 为 S / M / L（8 / 12 / 16）；对齐、等分或 1–8 列的整数权重（1–12）、分隔线；圆角跟随 App |
| 操作 | v2 的 actions / confirm 为插件描边按钮，至少 48 dp，四边内边距 12 dp；同行等高，长标签可换行 |

颜色校正在 8 位量化后检验，不对比度取整。颜色到黑、白各搜索 16 步，每个保留的候选都已达到下界；黑、白至少有一个对任意不透明 sRGB 背景达到 `sqrt(21) > 4.5`，所以总有可行结果。此构造证明返回值的下界，不证明它是所有色空间中的最小色差。两主题的原色、修正色和下界写入解析诊断，SDK 校验器复现同一算法。背景 tint 固定为浅 10%、深 16%，每次从固定底色计算，不叠加透明度。

所有大小预算仍由 §5 管。styles 不增加任意尺寸、像素坐标或执行能力；工具卡继续只读，状态条继续一行纯文字。列宽不足时自动减列；测试覆盖 320 / 390 dp、0.85× / 1× / 1.3× / 2× 文字，按钮四边内边距和同行高度由组件测试实际测量。

布局令 `M = 136 × clamp(字号倍率, 1, 2)`：容器当前宽 W、请求 padding P 时，四边实际值均为 `min(P, max(0, (W−M)/2))`。窄宿主不再消耗额外留白；多层嵌套不能重复侵蚀 M。row 扣除 gap 后按权重检查每列，不足则减列；actions/confirm 在每按钮不足 M 时纵排，只有实际同行者等高。布局时的缩减由 `plugin-v2-padding:<路径>` 可检查，不虚构解析错误或增加布局期通知。七层 L、加权 row、1/2/4 动作与 confirm 的 160/320/960 dp、1×/2× 回归量真实目标边界，不只检查局部 minWidth。

图表选择状态同样受最终合成后的对比度约束：v2 Canvas 和环图图例均保留未选类别不透明，名称、数值、单位、百分比继续 ≥4.5:1，色键继续 ≥3:1。v1 仍保留原有淡化像素行为。

### 7.2 机械可检查的防仿冒规则

1. 面板和工具卡的 v2 内容始终在 App 控制的不透明外边界内，固定「插件内容」标记位于作者树之外，内容裁在边界内；状态条保留固定图标署名。视图的 style 无法覆盖或隐藏这些标记。
2. 组件白名单中没有审批卡、原生授权按钮、系统弹窗。`role` 为 system / approval / authorization / dialog / permission 的节点无效；其他 role 不映射到原生角色。`actions.items[].style: primary` 在 v2 降为插件描边按钮并诊断。
3. 只读白名单样式字段。position / left / right / top / bottom / width / height / radius / borderRadius / elevation / shadow / fontFamily / fontSize / lineHeight / opacity / gradient / transform / zIndex 等均不能执行，未知样式也诊断后忽略。
4. span 没有事件或链接识别器；动作仍为所属插件的 invoke，审批语义和授权效果不因新样式获得。

**保证的范围**是宿主归属边界、组件和动作权限、可执行样式、实际前景背景的对比度和资源预算。它不能证明任意内容的视觉语义都不仿冒系统：现有合法 PNG / JPEG 等可包含系统截图，普通文字也可能误导。保留图像能力的同时必须如实说明这一残余风险，不能把结构白名单称作任意位图的语义识别。

### 7.3 继续不开放

| 不开放 | 原因 / 替代 |
|---|---|
| 字体文件、任意字号、行高、圆角、宽高、定位、层叠、阴影 | App 管字体、几何和署名边界；改用语义档和容器组合 |
| 作者透明度、渐变、动画参数 | 背景变化会增加对比度验证复杂度；用固定浅底和 App 已有动效 |
| `http(s)` 外链图片、桥接其他路由、SVG | 图片只来自插件资源目录或内联位图；保持原有路径、字节和像素校验 |
| 文字中的可点链接、HTML | 通过 invoke 的 link 效果，保留现有域名确认 |
| 审批、授权、系统弹窗、密码能力 | 不属于插件视图语言；新的普通输入也不能获得密码类型 |
| 自定义组件、外部代码、任意表达式 | App 解释受限 JSON；公式只允许另行定义的有界求值器 |

方案取舍：仅维持语义色表达力不足；任意 CSS / RGBA / 渐变会扩大几何和颜色证明面。采用不透明宿主边界、固定浅底和有界语义样式，保留任意六位请求色，并分别说明结构保证和语义残余风险。

## 8. 工具卡（第 0 期）

### 8.1 作者怎么写

```ts
defineTool({
  name: 'weather',
  // …
  output: {
    schema, render,
    presentationMeta: (args, value) => ({
      'dsh-go/view': {
        type: 'stack', title: `${value.city} · 未来 3 天`,
        children: [/* metric / chart … */],
      },
    }),
  },
})
```

- `presentationMeta` 的返回值是一个对象，dsh-go 只读其中的 `"dsh-go/view"` 键；同一个对象里放别的键（官方网页版的元数据）互不影响。
- 必须是纯函数、不抛错：DSH 在工具成功后调用它，**抛错会让这次工具调用失败**。
- 只在工具成功时才有；失败的调用照常显示错误。
- 视图 ≤ 8 KiB（它会写进对话记录）。工具卡没有数据模型，直接写值；第 0 期不能点。
- 图片只能用 `data:`：对话记录里只有工具名，App 不知道它属于哪个插件包，`asset:` 取不到。

### 8.2 链路（已查源码，DSH 0.2.1-rc.2）

```
defineTool output.presentationMeta(args, value)
  → ToolRegistry.createSuccessResult：成功后调用，快照成无损 JSON，作为 result.meta
      @deepseek-ai/dsh-tools  lib/types/schema.d.ts:192，lib/index.js:3637-3667
  → appendToolResult：session.append("tool/result", { turn, step, message, error?, meta })
      @deepseek-ai/dsh-agent-loop  lib/index.js:691-707
  → 会话日志（jsonl，持久化；重进对话、重放、导出都带着）
  → App：SessionLogEvent.fromJson → ToolResultEvent.meta = data["meta"]
      packages/dsh_client/lib/src/models.dart:1264、1523
  → ChatTranscript：ToolChatItem.meta = result.meta
      packages/dsh_client/lib/src/transcript.dart:525
  → ToolView.pluginView = parsePluginView(meta["dsh-go/view"], budget: toolCard)
      app/lib/ui/chat/tool_view.dart
```

- 字段名：`tool/result` 事件的 `data.meta` 就是 `presentationMeta` 的返回值本身，没有再包一层。所以 App 读 `meta["dsh-go/view"]`。
- DSH 不限制 meta 的大小；8 KiB 是我们的规矩，App 超限就降级。
- 官方网页版（`dsh-client-ui-tool`）只对内置工具读 meta，插件工具画通用卡，多出的键不影响它。
- 中转主机：meta 随对话记录走，不经桥接，理论上可用，待实测。
- 实测（10-25）：用 `runtime/.work/x86_64/dsh-prefix` 里的 DSH 0.2.1-rc.2 跑 `dsh headless`（一次性 HOME、假模型、一个带 `presentationMeta` 的测试工具），落盘的 `tool/result` 事件里 `data.meta` 就是 `{"dsh-go/view": {…}, "other": "kept"}`。这份日志去掉系统提示和路径后存成 `app/test/plugins/view/fixtures/live_tool_card.jsonl`，`plugin_tool_card_test.dart` 用它走 `ChatTranscript` → `ToolRow` 验证卡片画得出来。

### 8.3 App 怎么显示

| 位置 | 有 `dsh-go/view` 且能画 | 有但画不了 | 没有 |
|---|---|---|---|
| 工具行 | **默认展开**：原生卡片（与模型卡同一套卡片）；参数和原始结果收在卡片下的「详情」里，默认收起。行里照常写参数摘要；行收起时摘要换成视图 `title`（没写 `title` 就照旧） | 默认收起；展开是一行「插件界面有误」，下面照常显示参数和结果 | 照旧 |
| 工具组 | 带卡片的调用不进组：它把连续的调用切开，前后各段照旧（≥ 3 次成组） | 照旧 | 照旧 |
| 一轮结束、折叠后 | 工具行收进「已完成 · N 次工具调用」，**卡片本身留在消息流里**，接在折叠行后面、最终回答前面（和产物卡一样留在折叠外面）；点开折叠，里面是不带卡片的工具行，不会出现第二张卡 | 照旧折叠 | 照旧折叠 |

- 结果晚到（运行中 → 成功）时卡片随之展开；用户手动收起过的不再自动展开。
- 折叠后外露的卡片沿用这次调用的行主键（`t<callId>`），从「工具行 + 卡片」变成「只有卡片」是同一个元素，不播入场；折叠键规则（`tp<起点>`、插话切片 `tp<起点>@<插话 seq>`）不变。
- 实现：`ToolCallRow.card`（`ToolCardPlacement.inline` / `cardOnly` / `rowOnly`，`app/lib/ui/chat/tool_view.dart`），`deriveRows` 的 `flushTools` 和 `fold`（`app/lib/ui/chat/chat_rows.dart`）。

解析结果按 `meta` 对象缓存，列表滚动不重复解析；一张坏卡只影响它自己那一行。

## 9. App 侧 API

```dart
import 'package:dsh_app/ui/plugins/view/plugin_view.dart';
```

| 名称 | 签名 | 说明 |
|---|---|---|
| `PluginView` | `PluginView({required Object? view, Object? data, PluginActionHandler? onAction, PluginViewBudget budget = PluginViewBudget.panel, PluginImageResolver? imageResolver, bool showTitle = true, bool animate = false})` | 只画内容（标题 + 组件），不带外框。`view` / `data` 是已解码的 JSON。`onAction` 为 null 时只读（§4「不能点的地方」）。根节点坏了画一行「插件界面有误」 |
| `PluginFrame` | `PluginFrame({required String pluginName, String? icon, Widget? trailing, bool surface = true, required Widget child})` | 署名外框：玻璃卡片（圆角 20、内边距 16），顶部一行插件图标 + 插件名（次要色），`trailing` 放在这一行末尾（如刷新键）。`icon` 是 ui.json 图标名，缺省画插件名首字。`surface: false` 只画署名行，给已经在卡片或弹层里的地方用 |
| `PluginViewBudget` | `toolCard` · `panel` · `strip` | §5 的三档上限 |
| `PluginActionHandler` | `Future<bool> Function(PluginAction action)` | 发 invoke 并执行效果；返回 false 表示失败（元素复原）。不要在里面抛错 |
| `PluginAction` | `{String id, Map<String, Object?> args, PluginActionSource source, String path}` | `source`：button · row · option · confirm；`path` 是元素在视图里的路径，调试用 |
| `PluginImageResolver` | `ImageProvider? Function(String src)` | 收到 `asset:<路径>`，拼成 `/dsh-go/v1/assets/<包名>/<路径>`、带凭据取图；返回 null 画占位（`data:` 图片 App 自己解码，不经它）。也可以在上层放 `PluginImages(resolver:, child:)` |
| `parsePluginView` | `DshUiParse parsePluginView(Object? view, {Object? data, PluginViewBudget budget = PluginViewBudget.panel})` | 解析 + 求值 + 校验，按对象身份缓存。`DshUiParsed.view.issues` 是带路径的问题列表（插件详情页用） |
| `resolvePluginBinding` | `Object? resolvePluginBinding(Object? value, Object? data)` | 纯函数：`value` 是绑定就返回取到的值（取不到为 null），否则原样返回 |
| `pluginBindingText` | `String pluginBindingText(Object? value, Object? data, {int max = 200})` | 纯函数：求值后转成显示文字，取不到为「—」，超长截断加「…」。状态条用 |
| `resolvePluginBindings` | `Object? resolvePluginBindings(Object? value, Object? data)` | 纯函数：深度求值整棵 JSON（取不到为 null） |
| `toolCardViewKey` | `'dsh-go/view'` | 工具 meta 里的键 |
| `PluginViewBody` · `PluginViewError` · `PluginToolCard` · `PluginMark` | — | 已解析视图的内容、一行「插件界面有误」、工具行展开区、署名小标记（20 × 20），给需要拆开用的地方 |

- **缓存按对象身份**：`parsePluginView` / `PluginView` 以 `view`、`data` 的对象身份做键（字符串按内容）。数据变了（合并补丁后）请传一个**新的** Map，不要原地改旧的，否则会画旧数据。
- `PluginView` 的 v1 不带外框；v2 额外保留不可覆盖的内容署名边界，两者都不做加载态；面板没拿到数据前，`data` 传 null 即可（绑定显示「—」、数组显示「暂无数据」），或由插槽画骨架。

## 10. 兼容

- 插件视图只增不删：新组件、新属性在老 App 上分别画成占位、被忽略；老格式永久能画（工具卡写进了对话记录）。
- App 能力声明里的 `components` 是实际支持的组件目录，插件可以据此降级（NA 协议 `caps`）。v2 样式遇到旧 App 时按未知属性忽略；text 仍必填，原有节点可继续画。
- 将来官方 `@dsh-std/ui` 定稿了 Panel surface，换坐标，渲染器不动。
