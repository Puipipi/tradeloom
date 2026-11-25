# @dsh-go/plugin-kit

[English](README.en.md) | 中文

给 dsh-go 原生插件作者的工具包。零运行时依赖，Node 22.19+。不发布到 npm：在仓库里引用，或把需要的文件拷进你的插件。

| 件 | 入口 | 用途 |
|---|---|---|
| 类型 | `types/index.d.ts`（`types/schema.d.ts` 由 schema 生成） | 视图、清单、效果、`ctx.dshGo`、`caps` 的 TypeScript 类型 |
| 组件构造函数 | `stack()` `row()` `text()` `metric()` `chart()` `list()` `keyValue()` `progress()` `table()` `actions()` `image()` … `bind()` `action()` | 产出普通 JSON 节点，去掉 `undefined` 属性 |
| 工具卡 | `toolCard(build)` | 包住 `presentationMeta`：不抛错、无损 JSON、≤ 8 KiB |
| 能力判断 | `hasComponent` `hasSurface` `appAtLeast` `localize` `adaptView` | 按 App 能力和语言降级 |
| 效果 | `effects.insert()` … `effects.deferred()`；`checkEffects` `checkPending` | 构造效果；用桥接自己的代码检查 handler 返回值 |
| 测试宿主 | `@dsh-go/plugin-kit/testing` → `createTestHost()` | 不起 DSH 跑你的 `apply(ctx)`：清单解析、invoke、视图、数据推送、延后效果，结果和桥接一致 |
| 检查 | `bin/check.mjs`；`@dsh-go/plugin-kit/check` | 清单（桥接的解析器）+ 视图（App 解析器的逐行孪生，措辞同 App）+ `--load` 加载宿主半侧 |
| Schema | `schema/*.schema.json` | 协议与视图的机器可读定义，`lib/json-schema.js` 可直接校验 |

## check

```sh
node sdk/plugin-kit/bin/check.mjs <插件目录 | package.json | 视图.json | -> [--load] [--json] [--lang en] [--budget toolCard|panel|strip] [--app x.y.z]
```

```
dsh-go-example-quick 0.1.0
  原生界面能显示（胶囊 2 · 菜单 2）
  已加载宿主半侧：4 项可用
```

```
broken-demo 0.0.1
  错误 /dsh/bundle/patch：找不到组合包补丁文件 ./missing.yml
  原生界面能显示（胶囊 2 · 菜单 1 · 状态条 1 · 面板 1）
    错误 /dshGo/contributes/composer.actions/1/id：id a is already used by composer.actions
    提示 /dshGo/contributes/composer.actions/0/label：exceeds 10 characters for locale en-US; truncated
    提示 /dshGo/icon：不认识的图标，已换成默认图标
  已加载宿主半侧：1 项可用
    错误 /runtime/inject：写成了 ctx.inject(['dshGo?'])：cordis 没有可选依赖语法，这个回调永远不执行，改成 ['dshGo']
  视图 views/p.json（面板）：能显示，3 处问题
    错误 view.children[0].type：未知组件 "gauge"；可用：stack, row, text, …
    错误 view.children[1].value：应该是字符串或数字
    提示 view.children[2].items[0].action：动作 id "bad id" 不合规，这个元素不可点
```

| 退出码 | 含义 |
|---|---|
| 0 | 没有错误（可以有提示） |
| 1 | 有条目不生效 |
| 2 | 原生部分整体不显示（清单无效、协议不支持），或视图整块无法显示，或宿主半侧加载失败 |
| 3 | 读不了文件 |

- 清单问题：路径是相对 `package.json` 的 JSON Pointer，说明是桥接给开发者的英文原文（App 插件详情页显示的也是它）；App 自己加的（图标不认识）是中文。
- 视图问题：路径和措辞与 App 插件详情页逐字相同（`lib/messages.json` 从 App 的 ARB 同步，`test/parity/` 里的用例 App 侧也在跑）。
- 中英文各量一遍文字长度；`--load` 在临时 `DSH_HOME` 里加载你的代码，不碰真的 DSH 主目录。

`--load` 从空配置开始，先通过插件自身 `Config` 的 Standard Schema 校验并应用默认值，再调用 `apply`；未导出 `Config` 时传入空对象。与 Host 一样，只接受同步配置校验；必填字段没有默认值、校验抛错或异步校验都会报告加载失败，不调用 `apply`。检查器不读取用户的主机配置。

参数值必须完整：`--lang zh|en`、`--budget toolCard|panel|strip`、`--app x.y.z`。参数错误返回 3；带 `--json` 时也输出可解析的诊断对象。多个目标会分别检查，标准输入读取失败不会阻止后面的文件。以 `-` 开头的文件名放在 `--` 后面，例如 `node bin/check.mjs -- --view.json`。

`package.json` 必须是 JSON 对象；错误的 `contributes.panels` 会保留桥接诊断。静态视图使用桥接的包内路径规则，拒绝的包外路径和符号链接不会再被当成 App 视图读取。这是检查行为的一致性约束，`--load` 仍会执行插件自己的代码，不是代码沙箱。

## 测试宿主

```js
import { createTestHost } from '@dsh-go/plugin-kit/testing'
import { apply } from '../lib/index.js'

const host = createTestHost({ dir: pluginDir, services: { sessions } })
apply(host.ctx)
host.contributions()                                                   // App 收到的这一行
await host.invoke('translate', { context: { clipboard: '你好' } })     // { effects, pending?, settled? }
await host.view('usage', { sessionId: 's1' })                          // { view, stats }
const feed = host.subscribe('today', { sessionId: 's1' })              // feed.data / feed.history
host.emitEvent('session/event', session, event)
```

## 维护

| 脚本 | 什么时候跑 |
|---|---|
| `node scripts/gen-types.mjs` | schema 改了 |
| `node scripts/sync-bridge.mjs` | 桥接 `runtime/bridge/dsh-go-bridge/lib/native/{limits,util,effects,manifest,capabilities}.js` 改了 |
| `node scripts/sync-messages.mjs` | App 的 `view` / `plugview` ARB 改了 |
| `node scripts/gen-parity.mjs` | 改了 `lib/view-check.js`（App 解析器改了之后）；审过差异再提交 |
| `node scripts/sync-skill.mjs` | 以上任何一项，或 `skill/` 改了：重建 App 自带的 `dsh-go-plugin` 技能 |
| `scripts/wire-check.sh` | 想用真实桥接报文验 schema：协议集成测试和示例端到端都走录制代理，逐条校验 |

`npm test`（`node --test`）会检查以上产物是否过期。类型检查需要 `npm install`（只装 devDependency `typescript`）。

## 许可

MIT © DSH-TUI (ccch1mneyyy)
