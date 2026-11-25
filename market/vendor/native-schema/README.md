# 原生协议 JSON Schema 快照

来源：私有 dsh-app 仓库 `4f03e98e`，`sdk/plugin-kit/schema/*.json`，SDK 版本 0.1.0，MIT（同目录 LICENSE）。保持原文件内容，供拆出后的独立市场仓库使用，不依赖私有仓库路径。

检查器只用 manifest schema 判定包内 `package.json.dshGo` 的结构，其他 schema 是其引用依赖。清单通过与源码协议标识同时存在才给 adapted；这是静态声明检查，不代表运行时适配测试通过。协议升级时从 SDK 同步并重跑市场测试。
