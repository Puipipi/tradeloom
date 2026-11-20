# S7-04 与 S7-05 串行集成回执

集成基线 `69e65681d407c5993cb364dd0965a4b29806fab6`，tree `4a1685c69dc5e6a0eee5a1a6904b9e6bd5e9f244`。两作者树的 HEAD、tree、19/40 个许可路径基线 blob 和实际全差异已核对。原始变化文件 SHA-256 在 `[local-path-redacted]`。

- S7-04 仅合入 `apps/tradeloom-launcher/bootstrap-core.mjs` 及交接。rc.3 desktop-recipe 直接消费当前 active 源码，更新同一成员的来源、preimage 和 additions。成员 16,820 B，SHA-256 `c5c8d2d5957060c6c2774a0441203479e0be478ff96952df13e1b58a918550a7`，保留 CRLF。打包版 `core.mjs` 已有同名私有 IPv4 地址判断导出。阶段 5 历史镜像与清单保持冻结。
- S7-05 仅合入 `customers.js`、`agent-run-receipts.js`、`test_customers.js` 及交接。两个静态源使用现行程序清单已有 Django 后端路径，保原消费方式。客户测例覆盖 HTTP 409 后按钮解禁、重试、清除错误并刷新，以及原 URL、方法、CSRF 和请求字段。

## 验证

日志位于 `[local-path-redacted]`，测试用 Node v24.16.0、JSDOM 30.1.3。冻结基线以 Git archive 展开，运行与集成相同测试文件集合及筛选条件。

| 核对 | 基线及集成实际结果 |
| --- | --- |
| S7-04 启动器筛选测试 | 9/10 → 9/10，均退出 1，零跳过。唯一失败同名同因，managed-entry 夹具未生成有效 Native Bridge key。 |
| S7-05 两个直接测试 | 2/2 → 2/2，均退出 0，零跳过。 |
| S7-05 四文件队列 | 3/7 → 3/7，均退出 1，零跳过。继承失败同名同因，分别是主题桥请求计数、嵌入隐藏样式、独立页面字号、工作流创建 payload 多出 `execution_mode: local_mock`。 |
| DSH boundary | 11/11，零跳过，直接运行正式守卫退出 0、问题 0。 |

使用已验签的官方 rc.3 ASAR 与对应 unpacked 树。先运行隔离 `--derive-pins`，结果仅为派生。与首波严格重放逐成员比较，21,788 个逻辑成员中只有 `lib/tradeloom/bootstrap-core.mjs` 内容变动，20,121 个其他内嵌成员字节相同，1,666 个外置成员元数据一致，两轮重放各校验相同官方 sidecars。证据为 `logical-member-comparison.json`。随后将现行 `expectedAsar` 固定为 228,830,030 B，SHA-256 `2c062d456069a6bdad4177509cfb84001f8b839d4125148fdd7b7be8ab819d0f`。

另建目录实际严格重放，退出 0，状态 `fixed 0.2.2-rc.3 replay exact`。独立读回同一 ASAR 摘要，容器及成员完整性通过。业务壳仍为 77 件、3,037,867 B，SHA-256 `651b5e476de1d43e92761761cb9a7431ab2c5fa50f7f413aafc9a1618bcadf5b`。派生与严格日志分别为 `derive.log`、`strict.log`，各自证据在对应输出目录。

本轮仅自动验证。完整程序打包、真实冷启、正常退出、同路径回退、客户页面和窄宽行为仍归 S7-08 集中验收。继承失败原样记录。
