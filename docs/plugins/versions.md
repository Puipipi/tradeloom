# 兼容与版本

## 三个版本号

| 版本 | 在哪 | 谁管 | 现在 |
|---|---|---|---|
| 协议 `v` | 清单 `dshGo.v` | 主版本，不兼容才升 | `1` |
| 视图格式 `v` | 视图根节点 `v`（可选） | 样式和组件语言，独立于 NA | `1` 与 `2` 并存；省略为 `1` |
| App 版本 `minApp` | 清单 `dshGo.minApp` | 你写，插件依赖某个 App 版本才有的东西时 | 不写 |

另外，`package.json` 的 `engines.dsh` 写插件支持的 DSH 版本（DSH 安装时检查）。

## v1 内怎么演进

v1 内只**加**不**改**：新组件、新属性、新插槽、新效果、新的可选字段。老 App 遇到不认识的东西：

| 不认识的 | 老 App 怎么做 |
|---|---|
| 组件 | 画成一行灰色占位，其余照画 |
| 组件属性 | 忽略 |
| 插槽 | 忽略 |
| 效果 | 丢弃，其余效果照常 |
| 清单字段 | 忽略 |

NA 的破坏性变化需要另升主版本。视图 v2 则是明确选择的新渲染分支：保留 v1，不改变旧视图的含义。

## 视图 v2：显式启用样式

在根节点写 `v: 2` 开启 [样式](styles.md)。没有版本或 `v: 1` 的旧插件继续原样渲染；未知版本记录诊断并按 v1 处理。NA 信封、清单仍写 `v: 1`，不要改成 2。

旧 App 忽略新 style / accent / spans 属性，继续画原来的 text / value。因此 text 节点同时写 spans 时，text 仍必填。未知新组件依照原规则变成局部占位；不要把仅新 App 认识的组件放在根节点，也不要让整棵树只剩未知组件。按 `caps.components` 选组件或用 `adaptView` 准备回退。

后加的 `emptyState`、`gallery` 也按这条：老 App 画占位，`adaptView` 换成 `callout` 加按钮、`grid`（或竖排）里的 `image`。`progress.shape: "ring"` 和 `metric.trend` 是属性，老 App 忽略，照旧画进度条和数字；`accent: "app"` 老 App 按默认蓝色画。

v1 golden 仍用原基准，不因 v2 更新；v2 的浅深色、窄屏、大字号用独立 golden。工具卡中已有 v1 字段的含义不变。

## 较新的位置

`composer.tools`、`session.actions`、`turn.note`、面板 `placement: "plugin"`、`presentation: "sheet"` 在协议 v1 内增加，不改已有含义。App 在 `caps.surfaces` 里列出自己能画的；视图函数用 `hasSurface(caps, …)` 判断。

| 组合 | 结果 |
|---|---|
| 新桥接 + 老 App | 老 App 忽略这些键。只放在 `plugin` 的面板退回 `session.tab`，不会消失；`presentation` 被忽略，仍然推页 |
| 老桥接 + 新 App | 这些键不存在，也不算错误；清单里写了新位置时老桥接记一条 `unknown-surface` |

尾注的上限收紧过一次：一段对话最多跟前 8 个开着尾注的插件，第 9 个起不再显示。之前没有这个上限，排在后面的插件在前面的没占满一轮 2 个名额时也能显示。

## NA v1.3：选择文件

新增可选能力 `files`、直接点按效果 `pickFile` / `pickImage`、invoke 可选字段 `userGesture`，以及桥接专用的有界上传/一次性读取句柄。协议主版本仍为 `1`，NA 的小版本与视图版本分别演进。

新旧双方必须在 `hello` / `welcome` 协商 `files`。旧 App 不发送该能力，清单中的 `requires: ["files"]` 项被隐藏，插件未声明或设备未协商的选择效果被忽略且不算违规；旧桥不返回它，新 App 不启用。面板用 `caps.features` 显示说明文字，保留普通内容。旧插件、旧效果、旧视图的语义与预算不变。见[选择文件与图片](files.md)。

## v1.2：可选能力

声音、开口检测、小字幕通道、悬浮字幕（[声音与字幕](voice.md)）是 v1 里的可选能力，靠协商而不是版本号：

| 情形 | 结果 |
|---|---|
| 插件不写 `capabilities` | 与 v1.1 完全一样 |
| App 不支持某能力（老 App、中转主机、设备没有麦克风） | 带 `requires` 的按钮不出现；返回的这类效果被丢弃（记一条问题，不算违规） |
| 桥接比 App 旧 | `welcome` 里没有 `features`：App 不启用这些能力 |

视图函数的 `caps.features` 是这次请求里 App 提出的能力，可以据此决定要不要放字幕之类的内容。

## 按 App 能力降级

视图函数的第二个参数 `caps` 告诉你 App 能画什么：

```js
import { hasComponent, adaptView, localize } from '@dsh-go/plugin-kit'

view: (scope, caps) => {
  const v = buildView(scope)
  return adaptView(v, caps)          // App 不认识的新组件换成老组件，按钮、图片去掉
}
```

| 工具 | 用途 |
|---|---|
| `hasComponent(caps, 'table')` | App 认不认识这个组件 |
| `hasSurface(caps, 'composer.strip')` | App 显不显示这个插槽 |
| `appAtLeast(caps, '0.10.0')` | App 版本 |
| `localize(caps, { zh, en })` | 按 App 语言取字 |
| `adaptView(view, caps, fallbacks?)` | 整棵视图按能力降级 |

工具卡没有 `caps`（它写进记录，以后的 App 也要能画），所以工具卡只用最稳的组件：`stack` `row` `text` `metric` `chart` `compare` `steps` `callout`。

## 工具卡永久兼容

工具卡写进对话记录，一年后打开老对话也要能画。App 对 `meta["dsh-go/view"]` 只增不删，老格式永久能画。你这边：

- 改工具卡结构时，不要删老字段的含义；
- 不要在工具卡里放会过期的东西（临时链接、带时效的图片地址）。

## 和 DSH 版本的关系

| DSH | 状态 |
|---|---|
| 0.2.2-rc.1 | DSH Go 内置的引擎：插槽目录（109 个）和网页岛配方按它核对 |
| 0.2.1-rc.4 | 开发基线：插槽目录（103 个）和网页岛配方按它核对 |
| 0.2.1-rc.2 | 已验证（工具卡链路、插件安装、桥接） |
| 0.2.x 其他 | 按 `engines.dsh` 自行声明；`presentationMeta` 自 0.2.0 起存在 |

将来官方 `@dsh-std/ui` 定稿了面板格式，我们会换坐标，渲染器和这套格式不动。
