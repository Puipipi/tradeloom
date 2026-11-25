# dsh-go-example-usage

[English](README.en.md) | 中文

一个 dsh-go 原生插件示例：输入框上方一行状态条，显示本对话和今天用了多少 token；点开是「用量」面板。

| 位置 | 内容 |
|---|---|
| 状态条 | `本对话 12.4k · 今日 186k`，生成回复时让位；点按打开面板 |
| 面板（对话详情页「插件」页签） | 本对话 / 今日 / 缓存命中三个数字，近 7 天柱状图，本对话的明细（输入、缓存读取、缓存写入、输出、其中推理、模型调用次数），今日按模型的列表，「复制统计」按钮 |
| 面板（全部功能） | 同上，以今天为主 |

数据全部来自引擎自己的会话事件（每次模型调用的 `assistant/message` 里的 `usage`），不联网、不估算：

- **本对话**：打开时从这段对话的记录里现算，之后随每次调用累加；
- **今日 / 近 7 天**：插件装上后实时累计；一个对话第一次被看到时，它装插件之前的调用也补算进去（按事件序号去重，不会重复计）。按主机本地日期记在 `$DSH_HOME/cache/dsh-go-example-usage/days.json`（保留 30 天）。

## 安装

只在装了 dsh-go 桥接的主机上显示（手机本机引擎自带）。需要 DSH 0.2.1-rc.2 及以上。

```sh
dsh plugin --profile web add /绝对路径/dsh-go-example-usage
```

手机本机引擎：把文件夹放进本机环境（例如 `/root/.dsh/dsh-go/plugins/`，重置引擎时保留），在 App 的「终端」里执行。卸载：`dsh plugin --profile web remove dsh-go-example-usage`。

## 怎么做的

| 文件 | 作用 |
|---|---|
| `package.json` 的 `dshGo` | 声明一条状态条（点按开面板）和一个面板（放在对话详情页和全部功能） |
| `lib/index.js` | 监听 `session/event` 计数；`ctx.dshGo.strip()` 推状态条文字，`ctx.dshGo.panel()` 给视图、推数据、处理「复制统计」 |
| `lib/view.js` | 面板视图（结构固定，数字全是绑定 `{ "$": "data.today.total" }`）、数据模型、状态条文字、复制文本 |
| `lib/tally.js` | 纯函数：从事件里取 `TokenUsage`、累加、格式化（12.4k） |
| `lib/ledger.js` | 每日账本：原子写入、延迟保存、只留 30 天；按对话记下已计到的事件序号，每次调用只计一次 |

要点：

- 视图只发一次，之后数据变了桥接只推补丁（≤ 4 次每秒），所以视图里不写数字、只写绑定；
- 数据模型不带语言，一份数据服务所有语言；状态条文字按数据函数第三个参数 `caps.locale` 给中文或英文；
- 数据函数返回取消函数，没人看时桥接会停掉它。

## 自查

```sh
npm test                       # 用仓库里 sdk/plugin-kit 的测试宿主跑（桥接自己的清单与效果代码）
npm run check -- --load        # 清单 + 加载宿主半侧，检查视图
```

## 许可

MIT © DSH-TUI (ccch1mneyyy)
