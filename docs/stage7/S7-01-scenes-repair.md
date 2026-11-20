# S7-01 场景路由加载修复

第二个 rc.3 包在 [local-path-redacted] 实机启动，Host ready、认证与三端口监听均已观察。源壳在首次已认证 GET /tradeloom/scenes 返回 404 后停止。[local-diagnostic-redacted] 的 crash-2026-11-18T12-20-30-262Z-main.log 给出 lib/main.js:25323 的调用位置。Terra 正常退出，w2 回退事务退出 0，旧正式 ASAR 9ffc96c6…3f82 和 wrapper 76312c4f…ccb55 精确恢复，launcher.json 67a8b6ab…e310 与同一外置 DATA 选择保留。w2/restored-entry-manifest.json 的 SHA-256 为 f43dede65a99a70698ded568a84b73cfeeabbea13d9b00cb93983d84cca30d10，R2 程序保留在 w2/failed-app。

## 根因与修复

实际隔离 profile 声明 @tradeloom/dsh-business-shell@0.1.0，并有完整 77 件，已安装 package.json、Host 源及 cordis.patch.yml 与候选一致。官方 rc.3 app-boot 的 evaluatePluginCompatibility 按已安装 peer 声明拒绝该 bundle，其 @deepseek-ai/dsh-scope 只允许 rc.2，且无豁免。真实 loadProfileDirectory 在合成 RootInclude 前把该 bundle 列入 skippedBundles，导致业务 Host 和 native-task-authority 无法注入，场景路由未被注册。

现行自有包的 peer 只声明逐一已审的 0.2.2-rc.2 或 0.2.2-rc.3，保包名、导出、现有业务授权和官方兼容性检查。守卫按登记配方校验这两个精确版本，并拒绝未登记版本。Stage 5 冻结原件、历史 rc.2 recipe 和前两个候选保留。

## 实际 Host 验证与产物

在两份新 app-owned scratch profile 中用官方 rc.3 Host 和随包 Node 在临时 loopback 端口启动。旧 peer 实际跳过业务 bundle，正常认证 303 后仍 404。新 peer 未认证返回 401，正常认证 303 后返回 200，7 个场景、6 个角色及有效 sessionBindings 对象。两个探针均正常 IPC 关停，临时认证数据未记录。用 R3 的真实严格重放生成物执行同一可复现用例和 SDK 套件，14/14，登记边界 11/11。官方兼容判断对 rc.2 和 rc.3 通过，rc.4 拒绝。

官方 nightly 此次已返回 rc.5，现有入口退出 1 且停于官方资产下载前。沿已审 runbook 固定已验签的 rc.3 官方目录离线装配，真实退出 0、内层 strict replay 通过。完整程序路径集合与 R2 相同，ASAR 保持 0079bb6476ac89649af100961c33ca0c60b9feb99d86039b77602bcdf54e4700。唯一业务包变化是 package.json，4709 B、SHA-256 272cd3fcfa462359253be1e4a27da9d1664f6d74f834221d2a18e7b3153ee2d8。实际业务库存 77 件、3037925 B，SHA-256 036fd1c76c8e2dba24988fd962e3d42e719d0c8b1d90e738d2d28698f8b7f48b。

[local-path-redacted] 中的 r3-freeze-readback.json 和相应日志记录完整程序与源。程序 ZIP 819388090 B、SHA-256 caf14db3914a58a03040e2c276b9160b4442cd45629f23dd2bb2b2ae19faf004，源码 ZIP 19640183 B、SHA-256 331a28146a6d8315797901f5e67469848634af7d0b772176aaa2ce0b0573ae0f。候选清单 SHA-256 35f415d135aed13a830ffff6429ff10030478a5167b61eeb891283fd318a0008。源码身份为 e24eed788c033ac0f098a159012a6d40903a1e54 加当时工作树改动，354 消费文件逐件核对，摘要 de6c1b8fa75f03e3da98c0bcdb2fc93a1dd292e66c896ce4e2bfe860645b6f4f。

本记录只覆盖隔离 Host 探针、固定版本产物与已完成的真实 R2 回退。R3 的同路径正式冷启和完整实机功能另行记录。
