# 工作台：视图 v2 示例

一个无运行时依赖的原生设置面板，展示 F1 样式、全部 24 个 F2 组件、本地公式、表单提交、节流变化与 `patch` 回写。数据只保存在插件进程内，重载会恢复初始值。没有网络请求或文件权限。

```sh
dsh plugin --profile web add /path/to/dsh-go-example-workbench
```

在全部功能、对话详情的插件页签或聊天页面板打开「工作台」。设置页中，提醒开关与强度滑块通过 `onChange` 同步；其余字段在「保存设置」时提交。合计在本地随单价和数量变化。预览页展示卡片、头像、页签、折叠组、分页、时间线和代码块。

`caps.components` 缺少 `textField` 或 `form` 时返回 v1 只读摘要；不会把全部未知组件交给旧 App。宿主重新验证每个值，修剪名称首尾空白，再同时更新订阅数据与返回现有 `patch` 效果。

```sh
node examples/plugins/dsh-go-example-workbench/test/workbench.test.js
node sdk/plugin-kit/bin/check.mjs examples/plugins/dsh-go-example-workbench --load
```

App 需要 F1、F2 补丁；JS 示例本身不依赖 SDK 包。TypeScript builders 及生成命令见 [输入与表单](../../../docs/plugins/inputs.md)。
