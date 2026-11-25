# 文件摘要

在插件面板点「文件」或「图片」，系统选择器允许最多 4 个文件（单个 8 MiB、合计 16 MiB）。内容经当前主机连接上传；插件在选择回调里读取真实字节，显示文件名、实际字节数与 SHA-256。不会自动发消息、调用模型或保留文件副本。面板的摘要随数据订阅生命周期保留；重新订阅后从空状态开始。

本示例仅依赖 NA v1.3 的 `files`，视图全部使用既有 v1 组件，故 F3 可单独应用。完整第二期样式和表单见同批 F1/F2 示例。旧 App 或无能力的连接显示说明文字，无选择按钮。现阶段 Android 适配器及本地/SSH 直连可协商；DSH Remote 中转不可用。

在带本轮桥的主机安装：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-files
```

开发验证（仓库根目录）：

```sh
node sdk/plugin-kit/bin/check.mjs examples/plugins/dsh-go-example-files
node --test examples/plugins/dsh-go-example-files/test/*.test.js
node --test runtime/tests/native-files.test.mjs
```

第三个命令通过真实 HTTP/WebSocket、生产桥路由和本示例 handler 验证读取与摘要，不需要 DSH 引擎。系统选择器 UI 和远程设备仍需本机验证，详见[作者文档](../../../docs/plugins/files.md)。

句柄只在被等待的选择回调内有效；长任务需在回调结束前复制或持久化字节。`file.name` 不是路径，MIME 不是内容校验结果。桥接只读交付不等于隔离宿主 Node 插件的沙箱。
