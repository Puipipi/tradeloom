# 真实 npm 压缩包夹具

此目录中的 `.tgz` 是从 npm 官方注册表下载的原始文件，没有重打包或执行其中代码。对应 `.json` 记录源 URL、下载时间、npm SHA-512 integrity、许可证、精确版本元数据和当次 bulk advisory API 的原始响应。包内保留原作者许可证。

- `@liustack/modsearch@5.10.11`，MIT，170839 字节
- `@liustack/modlens@3.27.2`，MIT，239567 字节

刷新：在 market 根目录运行 `node scripts/capture-fixtures.mjs`。正常 `npm test` 不访问网络，也不运行下载的安装脚本。负向测试另外在临时目录生成明确标注为修改过的压缩包，覆盖缺许可证、身份不匹配、安装脚本、路径穿越、链接及重复文件名。

历史 advisory 响应只为复现测试；发布检查每次在线查询，不能将本夹具当作当前安全结论。
