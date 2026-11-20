# S7-02 与 S7-03 串行集成回执

本轮集成工作树基于 `761af0a601052a0337ac795c36e301a9c0162677`，tree `d205c72d54aa739e9a2d78d20924cdfdba28cc42`。两个作者工作树读回同一 HEAD、tree。逐项核对 16/118 个许可路径的唯一归属、基线 blob 和实际差异，交集 0。作者来源和选入字节的 SHA-256 记录在 `[local-path-redacted]`。

- S7-02 合入三个壳源码内的私有整理与 `scenes.test.js` 三项实际契约更新。Host 的 GET/PUT 走 `normalizeDockLayouts` / `validateDockLayouts`，客户端恢复和重置将记录交给 `fromJSON`。两个默认生成器保留冻结逻辑，作者建议的 `business-plan` 非活动标签及新增断言均排除。R3 旧版实机截图 `[local-path-redacted]` 显示业务计划与工作流画布各自独立可见。
- S7-03 合入执行计划的 API 与服务整理及作者原字节 fragment。沿原路由、事务及依赖运行，现有模型和迁移路径继续适用。
- rc.3 配方仅更新上述三个业务壳源码的 pre/post exact-source 字节与 SHA-256，另有业务库存的总字节和 SHA-256。原 74 项逐项字节和 SHA-256 相同。新库存 77 件、3,037,867 B，SHA-256 `651b5e476de1d43e92761761cb9a7431ab2c5fa50f7f413aafc9a1618bcadf5b`。

## 运行结果

日志位于 `[local-path-redacted]`。

| 真实运行 | 结果和范围 |
| --- | --- |
| 七个 S7-02 文件，React/ReactDOM 18.3.1、JSDOM 30.1.3、固定官方 rc.3 SDK | 原测试合同与基线源码 36/42。用集成测试合同分别运行冻结源码和集成源码均 39/42、退出 1、零跳过。两者同样失败于推荐结构、布局标准化初始化、真实 Dockview HTTP 保存/恢复，原因均为 `open views and panel records do not match`。日志 `repro-baseline.log`、`repro-same-fixtures-base.log`、`repro-working.log`。原客户端及 Host 默认生成契约保留。 |
| S7-03 十个现有计划 HTTP 测试 | 隔离 PostgreSQL `127.0.0.1:56438`，使用 `tradeloom_test_wave1` 和新建媒体根。10/10、退出 0，集群正常停止（退出 0），两个临时端口均已释放。日志 `s703-test2.log`、`pg2-stop.log`。初次端口 56437 的控制器日志管道迟迟未返回，单独正常关闭该私有集群后，原脚本连接已关闭集群而超时，随后在新私有集群按独立进程方式复验。 |
| DSH boundary | 11/11、退出 0、零跳过。正式守卫另跑退出 0、问题 0，导出 28/28。日志 `boundary-test.log`、`boundary-guard.log`。 |
| 严格重放官方 rc.3 app.asar 与 unpacked 树 | 退出 0，`fixed 0.2.2-rc.3 replay exact`。输出 ASAR 228,830,378 B，SHA-256 `0079bb6476ac89649af100961c33ca0c60b9feb99d86039b77602bcdf54e4700`，独立 native-FS 读取复核 77 项新库存。日志 `replay.log` 和 `replay/evidence/business-nativefs-readback.json`。 |

本轮运行限自动验证。原生窗口、打包以及 S7-08 集中回归仍待各自阶段。三个继承布局失败保留在本回执。
