# 快速开始：给插件加一张原生工具卡

5 分钟。前提：你已经有一个用 `defineTool` 注册工具的 DSH 插件。做完之后，这个工具在 dsh-go App 里显示成原生卡片，在 DSH 网页版照旧显示官方通用卡。

完整可运行的例子：[`examples/plugins/dsh-go-example-weather`](../../examples/plugins/dsh-go-example-weather/)。

## 1. 写一个视图函数

纯函数，输入工具的返回值，输出一棵组件树。不做 I/O，不读时间以外的外部状态。

```js
// lib/view.js
export function weatherView(value) {
  return {
    type: 'stack',
    title: `${value.city} · 未来 3 天`,              // 折叠时这一行就是工具行的摘要
    children: [
      { type: 'row', children: value.days.map((d) => ({
        type: 'metric', label: d.label, value: `${d.high}° / ${d.low}°`, caption: d.text,
      })) },
      { type: 'text', text: '数据：Open-Meteo', tone: 'muted' },
    ],
  }
}
```

能用哪些组件、每个组件有哪些字段，见[组件目录](components.md)。

## 2. 接进 `presentationMeta`

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolCard } from './tool-card.js'          // 或 @dsh-go/plugin-kit 的 toolCard
import { weatherView } from './view.js'

ctx.tools.register(defineTool({
  name: 'weather_forecast',
  // …parameters、execute 不变
  output: {
    schema,
    render: (args, value) => [{ type: 'text', text: summary(value) }],   // 模型看到的
    presentationMeta: toolCard((args, value) => weatherView(value)),    // App 画的
  },
}))
```

`toolCard()` 把视图放进 `{ "dsh-go/view": 视图 }`，并且兜住三件会让**整次工具调用失败**的事：

| DSH 的规则 | `toolCard()` 怎么处理 |
|---|---|
| `presentationMeta` 抛错 → 工具调用失败 | 捕获，返回 `{}`（不出卡片） |
| 返回值不是无损 JSON（含 `undefined`、`NaN`、`Infinity`、`-0`、`Date`、`Map`）→ 工具调用失败 | 过一遍 JSON：`undefined` 字段去掉，非有限数变 `null` |
| 视图超过 8 KiB | 返回 `{}`。工具卡要写进对话记录，必须小 |

不用 SDK 时，把这 12 行抄进插件即可：

```js
// lib/tool-card.js
export function toolCard(build, maxBytes = 8 * 1024) {
  return (args, value) => {
    try {
      const text = JSON.stringify(build(args, value))
      if (text === undefined || Buffer.byteLength(text, 'utf8') > maxBytes) return {}
      return { 'dsh-go/view': JSON.parse(text) }
    } catch {
      return {}
    }
  }
}
```

## 3. 自查

```sh
node sdk/plugin-kit/bin/check.mjs card.json           # 单个视图；文件是 { "dsh-go/view": … } 时按工具卡的上限查
node sdk/plugin-kit/bin/check.mjs . --load            # 插件目录：package.json、清单，并加载代码确认工具注册上了
```

在单测里直接校验视图函数的输出更省事：

```js
import { checkView } from '@dsh-go/plugin-kit/check'
const result = checkView(weatherView(sample), { budget: 'toolCard' })
assert.deepEqual(result.issues, [])
```

输出和 App 插件详情页看到的一样，带路径，例如 `错误 view.children[0].children[2].value：应该是字符串或数字`。

## 4. 装上，在 App 里看

```sh
dsh plugin --profile web add /绝对路径/你的插件
```

手机本机引擎在 App 的「终端」里执行；远程主机在主机上执行。然后让模型调用这个工具。

## 卡片没出现？

| 现象 | 原因 |
|---|---|
| 工具行照旧是名字 + 参数 | `presentationMeta` 返回了 `{}`：视图函数抛错、超过 8 KiB，或者结果是失败的（失败的工具调用不出卡片） |
| 整次工具调用失败，错误里有 `presentationMeta` | 没用 `toolCard()`，返回了 `undefined` 字段或 `NaN` |
| 卡片里有一行灰色「这部分无法显示」 | 某个子节点写错了，其余照画。跑一遍 check 看路径 |
| 整张卡只剩一行「插件界面有误」 | 根节点坏了：不是对象、`type` 拼错 |
| 旧对话里的卡片没有 | 只有装上之后的调用才有卡片；`presentationMeta` 不会补算旧记录 |

## 下一步

- 卡片之外的原生位置（输入框胶囊、消息菜单、状态条、面板）：[插槽参考](slots.md)
- 什么不能自定义、为什么：[设计规则](design-rules.md)
- 发布前过一遍：[自查清单](checklist.md)
