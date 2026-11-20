# S7-01 Host 桥接修复

首包已在隔离目录 [local-path-redacted] 同路径装配，ASAR SHA-256 为 61b26ca87b28daec1b21f02c8c155e127818ea91353b5c771ae6a74823a71677。Terra 首启 rc.3 时主窗显示 DeepSeek Harness 无法使用，3088 未监听。自有 crash-2026-11-18T11-48-12-429Z-host.log 记录 [local-diagnostic-redacted] 在 Host startup 由 lib/main.js:15817 的 resolveDesktopHostBridge 抛出 runtime version is not covered by this recipe。Django 和 PostgreSQL 此次已进入监听。该进程随后自行退出，主控独立核目标无进程、标准端口空闲。

同路径事务已回退成功，退出 0，w1 状态 restored。旧阶段 5 ASAR 恢复到 9ffc96c6178ab7634435860d37bf8fcc384f01362737f9564210eb77feaa3f82，wrapper 恢复到 76312c4f5508eacee45e5f6d426687d3429518a2e91c3153b983aaae233ccb55，原 launcher.json 保持 139 B / 67a8b6ab8f9e1fdac988f472e42361f0a85492c17549adae3ef189765537e310。w1/restored-entry-manifest.json 的 SHA-256 为 f43dede65a99a70698ded568a84b73cfeeabbea13d9b00cb93983d84cca30d10。保留同一外置 DATA 路径、w1/failed-app 与启动日志。回退后旧程序实际冷启到四面板，商品切换和正常退出由主控复核。

## 修改和验证

官方 rc.3 ASAR 的 dsh runtime 与 plugin-manager 均为 0.2.2-rc.3，公开 ./diagnostic 的实际代码与 rc.2 字节相同。新增的 rc.3 版本专用 host-bridge-rc3.patch 经 desktop finalOverlay 实际重放。唯一变化是给桥接明确允许的版本追加 rc.3，未知版本、版本不等、缺公开解析器和既有版本分支均保留。另一个 renderers.js 的适配提示值未改，源代码显示它只驱动提示。S5 源、首包与旧 rc.2 配方保留。

实际生成的主进程与官方随包 Node/SDK 做离线测试。新用例对首包复现相同拒绝，修复包通过真实 rc.3 解析器绑定、UUID 校验、三个历史版本分支以及未知版本、错 manager、缺公开解析器三个拒绝例。SDK 测试 13/13、boundary 10/10、实际 rc.3 获取与签名测试 6/6。更新器真实再次完成后，builder 内严格重放通过。两个生成 ASAR 的 21788 个逻辑条目逐项比较，只有 lib/main.js 变化，1666 个 unpacked 条目元信息相同。离线测试覆盖模块加载边界，真实 Host 启动须由后续实机重验。

## 修复包身份

[local-path-redacted] 下的 r2-freeze-readback.json、update-work/update-receipt.json、output/build-receipt.json 和 final-sdk-tests.log 记录实际生成与验证。修复包的 354 个消费源在源码 ZIP、source-manifest 和工作树逐字节匹配，构建时 sourceHead=7b92a3cdbbe65692b08334b6ca1d2b3028237f0c，dirty=true。

| 产物 | 真实摘要 |
| --- | --- |
| output/TradeLoom-0.2.2-rc.3.zip | 819388079 B，SHA-256 2f6eb457b1f6f6bbd348d12fa628587b57b08151b3c767bb0707d4293d1d9428 |
| output/current-source.zip | 19640173 B，SHA-256 11b3ba8edc79862e4ce767c21b385f6c67daf07f9d2ebd0d48ab43905f4b42c1 |
| output/program-entry-manifest.json | SHA-256 e8fb253c33576b6eabba0b5d0f54d4a92bc228309391e243bd703ea007b07534 |
| app/resources/app.asar | 228830378 B，SHA-256 0079bb6476ac89649af100961c33ca0c60b9feb99d86039b77602bcdf54e4700 |
| lib/main.js | 1109511 B，SHA-256 dd6bd598a9fd98158078197517e932831ca2a5fcb71a6323ec0de9c0c48c6634 |
