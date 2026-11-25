# 不写 App 代码就原生显示的东西

DSH 插件里有六样东西，dsh-go App 已经用原生界面画，不需要任何 dsh-go 专属代码（第 6 样只多一个函数）。先把这些用足，再考虑[插槽](slots.md)。

| 插件里写了 | App 里出现在 | 原生程度 | 主机 |
|---|---|---|---|
| 斜杠命令（`ctx.commands`） | 输入框 `/` 菜单；执行结果显示在对话里 | 完全原生 | 全部 |
| 技能（`SKILL.md`） | `/` 菜单的技能组、「技能」页 | 完全原生 | 全部 |
| 插件配置（导出 `Config`，可在线修改的字段） | 插件详情页、设置里的插件分组：原生表单 | 完全原生 | 本机、SSH；中转视主机而定 |
| 工具（`defineTool`） | 对话里的工具行：图标 + 名字 + 一行摘要，展开看参数和结果 | 通用样式 | 全部 |
| 教模型输出 ` ```dsh-ui ` 代码块（写进技能或系统提示） | 助手消息里的图表、指标、对比卡、选项 | 完全原生 | 全部 |
| 工具的 `presentationMeta` 里放 `"dsh-go/view"` | 工具行展开区的原生卡片 | 完全原生 | 全部 |

## 工具行的摘要怎么取

工具没有卡片时，App 用通用工具行。名字就是工具名（`mcp__服务__工具` 只取最后一段），摘要按下面的顺序取第一个非空的字符串参数：

`command` → `file_path` → `path` → `pattern` → `query` → `url` → `description` → `prompt` → `name` → 其余参数里第一个字符串

所以给工具起参数名时，把最能说明这次调用的那个参数叫 `query`、`url`、`path` 或 `name`，折叠的工具行就好读。有卡片时，摘要改用视图的 `title`。

## 插件配置的原生表单

插件导出的 `Config`（schemastery）会画成原生设置页，入口在插件详情和 设置 › 引擎参数 › 插件。`.volatile()` 的字段改了立即生效，其余字段点「保存」后重新载入插件。密钥类字段（`role('secret')`）只写不读。对象嵌套成组，`.collapse()` 的组默认折叠；`description` 写成 `{ zh, en }` 两种语言。插件自带网页设置页时，在 `apply` 里注册 `configure({ auto: false })`，App 会在页首给出「在网页版设置」，原生能画的字段照样画。

主机装有提供 `/dsh-go/v1/plugin-config` 的 dsh-go bridge 时，所有字段都会出现；否则 App 只拿得到 volatile 字段。密钥要用 `role('credential-ref')` 绑定到凭据，裸的 `role('secret')` 在 App 里只显示是否已设置、不能填写（[设计](../design/plugin-config.md)）。

## dsh-ui 代码块

模型在回复里写一个 ` ```dsh-ui ` 代码块，App 画成原生视图；网页版显示成代码。组件是[组件目录](components.md)的前 10 个（插件视图独有的 6 个不认），建议 ≤ 4 KiB、40 个节点（模型输出越长越慢）。适合「让模型在需要时画个图」，例如在插件的技能里写：

~~~markdown
需要比较数值时，用 ```dsh-ui 代码块输出一个 chart：{"type":"chart","kind":"bar","categories":[…],"series":[{"values":[…]}]}
~~~

模型输出的视图里，`options` / `confirm` 被点按后会以一条消息发回模型；插件视图里的同名组件走插件自己的处理（见[动作与效果](actions.md)）。

### genui 写法

装了 `@changfenhuang/dsh-genui` 的主机，模型会在同样的 ` ```dsh-ui ` 代码块里写 genui 自己的 JSON（根是 `{ title?, items: [...] }`）。App 认得出它，把能对上的部分换成原生只读卡片，不再显示原始 JSON：

| genui | 原生 |
|---|---|
| `stat` / `hero`（`delta`、`spark`） | `metric`（涨跌定色调，`spark` 成趋势线） |
| 全是数字的 `grid` | 一行指标 |
| `callout` | 着色面板 |
| `progress`（`variant: ring`） | 环形进度 |
| `chart`、`table`、`keyvalue`、`list`、`steps`、`timeline`、`tabs`、`accordion`、`code`、`diff` | 对应的原生组件 |
| `image` / `image-group` | `image` / 图集（只认 `data:`） |
| 按钮、表单这类交互组件 | 一个「可交互内容」标签 |
| `echart`、`svg`、`mermaid`、地图、三维场景等 | 「… · 在网页版查看」标签，连着的几个合成一个 |

卡片只读：没有按钮能点，也不会发消息。整块对不上时显示一行「这块内容在网页版查看」，没有「让它重发」。想让 App 画得更完整，就在技能里让模型写上面左列能对上的组件。

## 什么时候需要插槽

上面六样覆盖不到的，才需要 `package.json` 里的 `dshGo` 清单：输入框上方的胶囊、消息长按菜单、输入框上方的状态条、原生面板。见[插槽参考](slots.md)。
