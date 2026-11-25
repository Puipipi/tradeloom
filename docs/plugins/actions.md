# 动作与效果

插件不能直接动 App。用户点了插件的东西，插件只能**返回效果**，由 App 在白名单里执行。

```
用户点按 ──▶ App ──invoke──▶ 桥接 ──▶ 插件 handler(scope, event)
                                             │ 返回效果
App 执行（点按后 3 秒内到达才执行） ◀──────────┘
```

## 效果白名单

| 效果 | 写法 | 约束 | App 做什么 |
|---|---|---|---|
| 放进输入框 | `{ type: 'insert', text }` | 1–2000 字 | 插到光标处，**不发送**，由用户自己点发送 |
| 斜杠命令 | `{ type: 'command', name, args? }` | `name` 不带 `/`；`args` ≤ 500 字 | 在当前对话执行；没有当前对话就忽略 |
| 打开页面 | `{ type: 'open', page }` | App 页面 id，或 `panel:<本插件面板 id>` | 打开；不认识的页面忽略 |
| 打开链接 | `{ type: 'link', url }` | 只收 `https://`，≤ 2048 字符 | 每次弹确认、显示域名，再用浏览器打开 |
| 提示 | `{ type: 'toast', text }` | ≤ 40 字，超长截断 | 一行轻提示，App 节流 |
| 复制 | `{ type: 'copy', text }` | 1–8000 字 | 写进剪贴板 |
| 刷新面板 | `{ type: 'refresh', id? }` | 本插件的面板 | 重新取视图 |
| 改面板数据 | `{ type: 'patch', data, id? }` | JSON Merge Patch，≤ 16 KiB | 立刻合并进面板数据 |

一次最多 4 个效果。清单里的静态 `effect` 只能用前六种。

## 简写

handler 可以返回效果对象、效果数组，也可以返回简写；一个简写对象里写多个键，按键的顺序展开。

| 简写 | 等价 |
|---|---|
| `{ insert: '…' }` | `{ type: 'insert', text: '…' }` |
| `{ toast: '…' }`、`{ copy: '…' }` | 同理，字段名 `text` |
| `{ link: 'https://…' }` | `{ type: 'link', url }` |
| `{ open: 'panel:usage' }` | `{ type: 'open', page }` |
| `{ command: 'compact' }`、`{ command: { name, args } }` | `{ type: 'command', … }` |
| `{ refresh: true }`、`{ refresh: 'usage' }` | `{ type: 'refresh', id? }` |
| `{ patch: { … } }` | `{ type: 'patch', data }` |
| `{ copy: md, toast: '已复制' }` | 先复制，再提示 |
| `undefined` | 什么都不做 |

SDK 里有同名构造函数：`effects.insert(text)`、`effects.openPanel(id)` 等。

## 视图里的点按

v1 面板视图里的四种点按元素，点了都变成一次 invoke，落到 `panel(id, { actions })` 里同名的 handler（没有 `actions` 表时落到 `on(面板 id)`，用 `event.action` 区分）。

| 元素 | 视图里写 | handler 收到的 `event` |
|---|---|---|
| 按钮 | `actions` 组件：`{ label, action: 'refresh' }` | `action: 'refresh'`，`value: {}` |
| 列表行 | `list` 行：`{ title, action: { id: 'open', args: { row: 3 } } }` | `action: 'open'`，`value: { row: 3 }` |
| 单选 / 多选 | `options`：`{ id: 'range', options: [...] }` | `action: 'range'`，`value: { value }` / `{ values }` |
| 确认 | `confirm`：`{ id: 'clear' }` | `action: 'clear'`，`value: { confirmed: true \| false }` |

- 动作 id：`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`；`args` 求值后 ≤ 1 KiB。
- 点下后这个元素显示小环直到返回；失败时复原，报错文字由 App 统一给，插件视图里不会出现。
- `options` 的选中态以插件推来的 `selected` 为准：点了之后，记得在数据里更新它。
- 工具卡（第 0 期）不能点：按钮和确认不显示，选项只读。

## 3 秒窗口

App 从用户点按算起，3 秒内收到的效果才执行，迟到的静默丢弃（并轻提示「没有响应」）。桥接给 handler 的时限也是 3 秒。要更久的，用延后效果。

## 延后效果（调模型、联网）

handler 先回一个 `pending`，App 立刻在被点的元素上显示等待状态；真正的结果最多 60 秒后到。

```js
import { effects } from '@dsh-go/plugin-kit'

ctx.dshGo.on('translate', (scope, event) =>
  effects.deferred(async (signal) => ({ insert: await translate(scope.clipboard, signal) }), { label: '正在翻译' }))

// 不用 SDK 的等价写法
ctx.dshGo.on('translate', (scope) => ({
  pending: { label: '正在翻译', timeoutMs: 60_000 },
  result: async (signal) => ({ insert: await translate(scope.clipboard, signal) }),
}))
```

| 项 | 规则 |
|---|---|
| 什么时候用 | 结果要等模型、网络、慢的本地命令；3 秒内能回的就直接回，不要用它 |
| `pending` | `true`，或 `{ label?, timeoutMs? }`。`label` ≤ 16 字，显示在等待状态里 |
| `timeoutMs` | 1–60 秒，缺省 30 秒；超出范围按边界算 |
| `result` | Promise，或 `(signal) => 值 \| Promise`。值的写法和普通 handler 一样（效果对象、数组、简写） |
| 结果里能放的效果 | **只有 `insert`、`copy`、`toast`、`patch`**。打开页面、链接、命令都必须由用户当场点出来，不能延后 |
| 每插件同时 | 最多 2 个；再点会被拒绝（App 提示稍后再试） |
| 只结算一次 | 完成、超时、用户取消、App 断开，四者先到先算；后到的结果丢弃 |
| `signal` | 超时、取消、断开时触发。收到就停手：取消网络请求、停止模型调用 |
| 出错 | `result` 抛错或 Promise 被拒 → 这次作废，App 复原，不执行任何效果。过期和出错不算违规（网络慢是常态）；`pending` 写错、结果里混进不允许的效果才算 |

**写的时候注意**

- `insert` 是在**结果到达时**插到光标处：用户这期间可能已经改了输入框，所以只插入，不要假设输入框是空的。
- 用到模型就会消耗用户的额度：只在用户点按后调用，一次点按一次调用，提示里写清在做什么（如「正在翻译」）。
- 示例：[`examples/plugins/dsh-go-example-quick`](../../examples/plugins/dsh-go-example-quick/) 的「译成英文」用 DSH 里设的默认模型翻译剪贴板，没有模型服务时退回成「把请求放进输入框」。

## 在测试里看效果

SDK 的 `checkEffects` / `checkPending` 就是桥接自己的代码，单测里直接用：

```js
import { checkEffects, checkPending } from '@dsh-go/plugin-kit'

checkEffects({ copy: md, toast: '已复制' })
// → { effects: [{ type: 'copy', … }, { type: 'toast', … }], issues: [], violation: false }
checkEffects({ link: 'http://x' }).violation           // true：只收 https
checkEffects({ open: 'panel:usage' }, { panels: ['usage'] })
checkPending(result)                                    // 延后请求怎么被读：{ ok, label, timeoutMs, … }
```

要连 handler 一起跑，用测试宿主 `createTestHost`（`@dsh-go/plugin-kit/testing`）：`await host.invoke('translate', { context: { clipboard } })` 返回 `{ effects, pending?, settled? }`，`await settled` 得到 `{ t: 'done', effects }` 或 `{ t: 'void', reason }`。

## 选择文件与图片（NA v1.3）

声明并协商 `files` 后，用户点按可返回 `pickFile` / `pickImage`。选择结果通过一次性只读句柄交给原插件；回调仅允许数据效果与提示。上限、Android API、远程主机与完整示例见[选择文件与图片](files.md)。

## 永远不开放

批准工具调用、改权限模式、手机操控、装卸插件、切换主机、读 App 设置或凭据、没有用户操作的自动触发。v2 允许受限输入与表单，但仍没有审批卡样式和密码框。

## v2 输入与提交

用户编辑可通过 `onChange` 合并节流后 invoke，`form.submit` 在有界校验后提交快照。字段级错误、4 KiB 动态值上限、单面板串行顺序和离线草稿见[输入与表单](inputs.md)。`patch` 和数据推送本身不会触发变化动作。
