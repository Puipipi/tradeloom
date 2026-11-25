# dsh-go-example-quick

[English](README.en.md) | 中文

一个 dsh-go 原生插件示例：输入框上方两个胶囊，助手消息长按菜单里两项。

| 位置 | 项 | 做什么 | 怎么实现 |
|---|---|---|---|
| 胶囊 | 总结 | 把「总结上面的对话，列三条要点。」放进输入框 | 清单里的静态 `effect`，App 直接执行，没有宿主代码 |
| 胶囊 | 译成英文 | 用你在 DSH 里设的默认模型翻译剪贴板，译文放进输入框 | invoke → **延后效果**：先显示「正在翻译」，最多 60 秒后插入译文；主机没有模型服务时，改为把「请翻译……」放进输入框 |
| 消息菜单 | 复制为 Markdown | 这条回复去掉原生卡片（` ```dsh-ui `）后复制 | invoke → `copy` + `toast` |
| 消息菜单 | 存进笔记 | 这条回复追加到对话工作目录的 `notes/今天.md` | invoke → 宿主上写文件 → `toast` |

所有动作都不自动发送：放进输入框的东西由你自己点发送。

`wants: ["clipboard", "message"]`：点「译成英文」时附带剪贴板，点消息菜单时附带那条回复的正文。App 在第一次点按前问一次，你不同意就不附带。「译成英文」会用掉一次模型调用的额度。

## 安装

只在装了 dsh-go 桥接的主机上显示（手机本机引擎自带）。需要 DSH 0.2.1-rc.2 及以上。

```sh
dsh plugin --profile web add /绝对路径/dsh-go-example-quick
```

手机本机引擎：把文件夹放进本机环境（例如 `/root/.dsh/dsh-go/plugins/`，重置引擎时保留），在 App 的「终端」里执行。卸载：`dsh plugin --profile web remove dsh-go-example-quick`。

## 怎么做的

| 文件 | 作用 |
|---|---|
| `package.json` 的 `dshGo` | 两个胶囊（一个带静态 `effect`）、两个菜单项、`wants` |
| `lib/index.js` | `ctx.inject(['dshGo'], …)` 里注册三个 `on(id)` |
| `lib/actions.js` | 三个处理函数：返回效果（简写）或延后效果 |
| `lib/model.js` | 用 DSH 的 `agentDefaultModel` 和 `llm` 服务发一次无历史、无工具的模型调用，响应 `signal` 取消 |

延后效果的写法：

```js
return {
  pending: { label: '正在翻译', timeoutMs: 60_000 },
  result: async (signal) => ({ insert: await model.complete(text, signal) }),
}
```

结果里只能放 `insert`、`copy`、`toast`、`patch`；用户取消、超时、断开时 `signal` 触发，结果作废。详见 [`docs/plugins/actions.md`](../../../docs/plugins/actions.md)。

## 自查

```sh
npm test                       # 用 sdk/plugin-kit 的测试宿主跑，含延后效果的完成、失败、取消
npm run check -- --load
```

## 许可

MIT © DSH-TUI (ccch1mneyyy)
