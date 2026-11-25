# 工具箱（dsh-go-example-toolbox）

[English](README.en.md)

演示较新的原生位置，每个只用几行：

| 位置 | 在这个插件里 |
|---|---|
| `composer.tools` | 加号面板里的「选模板」（打开弹层，不写宿主代码）和「数字数」（读输入框） |
| `session.actions` | 右侧栏「信息」里的「标记这段对话」 |
| `turn.note` | 脚注末尾的「第 N 轮」（演示只写前 20 轮） |
| `placement: "plugin"` | 插件详情页里的「状态」 |
| `presentation: "sheet"` | 「选模板」用弹层打开 |

安装：

```sh
dsh plugin --profile web add /绝对路径/dsh-go-example-toolbox
```

说明见[插槽参考](../../../docs/plugins/slots.md#较新的位置)。
