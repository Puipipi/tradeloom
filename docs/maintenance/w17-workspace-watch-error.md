# 文件观察流不吞掉元数据读取期间的 watcher 错误

## 合同及原因

workspaceFiles/changes 在 ready 后等待 fs.stat 时，watcher 可能报告 I/O 错误。既有 ChangeFollower.fail 保存错误并中止 signal；stat 路径将 abort 转为 undefined，随后 follow 直接 return，跳过 read 迭代器尾部的错误传播，客户端因此收到正常结束。

本次只在 live metadata await 后先检查并抛出已保存的 watcher 错误，再处理普通取消；已关闭 follower 忽略迟到的 fail，首个故障身份保持。正常用户取消、服务释放不转成故障；初始化 watch-unsupported 包装保持。没有修改 URL、权限、文件内容、UI 或协议字段。

## 证据及复跑

使用真实 rc1 Cordis、LocalFileSystem、WorkspaceFiles 与真实目录/文件/watcher；测试只控制元数据 await 边界并将合成 EIO 送入实际注册的 watcher callback，不伪造业务结果、不等待真实时钟。该测试不声称在物理设备诱发了内核 watcher 错误。

```sh
DSH_PREFIX=/absolute/patched-rc1 node --test runtime/tests/workspace-watch-error.test.mjs runtime/tests/workspace-observation-queue.test.mjs runtime/tests/workspace-lifecycle.test.mjs
```

新增 6 例在当前累计基线为 4 pass / 2 fail，候选相关三模块 16/16。两失败覆盖 stat 遵从取消与仍成功返回两种情况；控制覆盖用户取消/服务释放后的迟到错误、idle 故障原身份、setup 错误代码与一次 unwatch。使用 Promise gate，不使用 sleep。Android 未编译。

## 应用与生成

源码补丁相对 ce00763，新增 vendor diff 按文件名排序接在本轮 K+606/607 的 57 条 rc1 链后，严格 58 条可应用，输出与测试模块逐字节相同。独立源码补丁可应用 ce，但运行它必须先使用本轮固定 0.2.2-rc.1 累计升级，不能将它当 rc4 运行时升级包。pins 由本机按最终构建链记录，本包不修改。

vendor diff 用 Python difflib.unified_diff 比较严格 57 链的 dsh-api-workspace-files/lib/index.js 与候选，fromfile/tofile 为 a/b/node_modules/@deepseek-ai/dsh-api-workspace-files/lib/index.js。源码导出只选择本 diff、本测试和本文；没有覆盖已有 observation queue 补丁。无需 golden 更新。

真机复核：本机或远程正常打开文件观察，编辑目标应继续刷新；取消/切换会话后应释放观察、无错误提示。内核 watcher 错误仅可在可控测试环境触发，不以删除真实用户文件作故障注入。此修复不改变现有取消和重连策略。
