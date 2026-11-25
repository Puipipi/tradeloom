# 给 dsh-go 写原生插件

从空目录创建、验证、安装并发布一个插件：见[从零到市场](from-zero.md)。

**不知道从哪开始？** 先看[选一条路](choose-path.md)：已有插件、已有网页界面、专门给 dsh-go 写，各走哪条路。想知道哪些能依赖，看[稳定性承诺](stability.md)。

[English](en/README.md)

dsh-go 的原生界面可以显示 DSH 插件的内容：工具结果画成卡片，输入框上方加胶囊，消息菜单加操作，再加状态条和面板。插件照常是一个 DSH 插件（npm 包，逻辑跑在引擎里），只是多给 App 一份**声明**和一些 **JSON 视图**；App 用自己的组件画出来，不执行插件的任何代码。

| 你想要 | 要写的 | 读 |
|---|---|---|
| 工具结果显示成原生卡片 | 工具的 `presentationMeta` 里加一个视图，5 分钟 | [快速开始](quickstart.md) |
| 先看看什么已经是原生的 | 命令、技能、设置表单、dsh-ui 卡——都不用写 App 代码 | [不写 App 代码就原生显示的东西](native-for-free.md) |
| 胶囊、消息菜单、状态条、面板 | `package.json` 的 `dshGo` 清单 + `ctx.dshGo` | [插槽参考](slots.md) |
| 加号面板工具、对话操作、回合尾注 | 同上，较新的位置 | [插槽参考](slots.md#较新的位置) |
| 视图里能放什么 | v1 / v2 组件、绑定、上限 | [组件目录](components.md) |
| 原生输入与表单 | v2 输入、结构组件、双向绑定、有界公式 | [输入与表单](inputs.md) |
| 点了之后能做什么 | 8 种效果，3 秒窗口 | [动作与效果](actions.md) |
| 朗读、开口即停、高频字幕、悬浮字幕 | `capabilities` + `media` / `micro` / `overlays`（v1.2，可选） | [声音与字幕](voice.md) |
| 在哪些主机上有、怎么装 | 本机 / SSH / 中转；按路径安装 | [主机覆盖、安装与降级](hosts.md) |
| 发布 npm、进发现索引、上架官方市场 | 三层流程与四个独立状态 | [发布与上架](market.md) |
| 什么不能自定义、为什么 | 有界样式、字体文件、尺寸、链接 | [设计规则](design-rules.md) |
| 插件能做什么、不能做什么 | 一张总表：能力、两种 overlay、降级、未来项 | [能力边界](capabilities.md) |
| 新旧 App 都能用 | `caps`、`adaptView` | [兼容与版本](versions.md) |
| 发出去之前 | 逐条过 | [自查清单](checklist.md) |

## 工具

| 件 | 在哪 | 用途 |
|---|---|---|
| `@dsh-go/plugin-kit` | [`sdk/plugin-kit/`](../../sdk/plugin-kit/) | 类型、组件构造函数、`toolCard()`、`caps` 工具、测试宿主、`check` 命令。零运行时依赖 |
| 原生视图本地预览 | [使用说明](preview.md) | 用 App 的 Flutter 渲染器把视图 JSON 和数据快照画成深浅色 PNG，附诊断 |
| 示例插件 | [`examples/plugins/`](../../examples/plugins/) | 天气（工具卡）、用量（状态条 + 面板）、快捷（胶囊 + 消息菜单）、朗读（声音 + 开口即停 + 字幕），MIT |
| 技能 `dsh-go-plugin` | App 自动装进本机引擎的 `$DSH_HOME/skills/` | 让你自己的 agent 写一个本地小插件并自查 |

## 一张图

```
插件（DSH 插件，跑在引擎里）
 ├─ 工具 presentationMeta → { "dsh-go/view": 视图 }   ─── 对话记录 ──▶ App：工具卡（任何主机）
 ├─ package.json "dshGo"：胶囊、菜单、状态条、面板     ─┐
 └─ ctx.dshGo：视图、数据推送、点按处理                 ├─ dsh-go 桥接 ──▶ App：原生插槽（本机引擎）
                                                      ─┘
```

规格原文：[`docs/design/native-plugins-protocol.md`](../design/native-plugins-protocol.md)（协议）、[`docs/design/native-plugins-views.md`](../design/native-plugins-views.md)（视图）。

想让 App 里有自己的**像素宠物**或 **Live2D 伙伴**？那不属于插件，是 App 内容：[宠物包](../pets/README.md) · [Live2D 伙伴](../live2d/README.md)。
