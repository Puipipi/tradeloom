# 专注小看板：视图 v2 样式示例

[English](README.en.md)

一个带复制和指南按钮的小看板，演示六档字号、四档字重、斜体 / 下划线 / 删除线、对齐、行数省略、行内 spans、主题色、背景高亮、四种卡片、间距、比例列和分隔线。数字是固定示例数据，不读取会话、不联网统计。

```sh
dsh plugin --profile web add /绝对路径/dsh-go-example-styles
```

需要主机提供 `dsh-go-bridge`。安装后在「全部功能」或会话详情的插件页打开「本周专注」。视图根节点是 `v: 2`，清单 `dshGo.v` 仍为 `1`。旧 App 会忽略样式和 spans，但每个 text 都保留普通文字回退，仍可读、可复制。

`lib/view.js` 只产生有界 JSON；显示数值用数据绑定。`lib/index.js` 注册面板、发出初始数据并处理按钮。指南按钮通过 invoke 的 link 效果打开 WCAG 页面，保留 App 的域名确认；span 中的 URL 从不直接执行。

在仓库内验证：

```sh
node --test examples/plugins/dsh-go-example-styles/test/*.test.js
node sdk/plugin-kit/bin/check.mjs examples/plugins/dsh-go-example-styles --load
```

诊断里的颜色校正是正常提示：App 分别生成浅深色、将文字对比度校正到至少 4.5:1。详细规则见 [样式文档](../../../docs/plugins/styles.md)。新的输入控件和表单由交互示例另行演示。
