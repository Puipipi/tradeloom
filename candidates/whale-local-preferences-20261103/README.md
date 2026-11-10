# Whale 局域网偏好写入候选 r2

## 范围与来源

候选仅替换 `server/lib/index.js`。正式插件、Main、Host listener、安装包和用户设置均未修改。交付实现见 `after/server/lib/index.js`，单文件差异见 `server-index.patch`。

冻结的 p/202 基线文件为 `C:/Users/23825/Desktop/TLUI-Biz-R1-20261101/data-ui-r2/harness-home/profiles/desktop/.plugins/p/202/lib/index.js`，265430 字节，SHA-256 `9F7EC013F56FC4F102AD4F739BD254AD247C66F023AE6F7E00BB0FF425C79485`。r2 after 为 266538 字节，SHA-256 `B5D12DF27D57E82AD7F09311C8C55391EB23C4DA57B9962E456F716F1B431284`。历史 r1 `SOURCE-SHA256.txt` 不代表当前内容；当前清单是 recovery 下的 `FINAL-SOURCE-SHA256.txt`。

Main 组合 fixture 使用冻结 Main r12 原文件 `C:/Users/23825/Desktop/ICT/workspace/testing/source-shell-ui-wiring-r2-20261031/candidate/product/ui18-whale-native-origin-r12-20261103/after/main.js`，713885 字节，SHA-256 `470BA376C3D413F980C80C7709875019CBB2A9DA4EDED398FB75BCF3771BECAE`。测试校验哈希并执行其 `classifyWhaleRequestTarget` 和 `forwardWebRequest` 原函数。

## 行为

对非回环 Host，只有注册闭包中的 `kind === 'exact'`、精确路径 `/dsh-whale/size.json` 或 `/dsh-whale/usage-settings.json`，且请求为 PUT 时，才考虑本例外。它要求 HostConnection fence 存在、`Origin` 是规范 HTTP(S) origin（原值等于 `new URL(origin).origin`）、origin authority 与 Host 一致，并拒绝 trim/lowercase 后的 `Sec-Fetch-Site: cross-site`。随后仍由原 `connection.requestRejection()` 执行唯一认证判定。

例外不适用于缺失/opaque/异源/非规范 Origin、跨站请求、缺失 HostConnection、其它路由或方法。回环和 `DSHW_ADMIN_HOSTS` 原有行为保留，GET 不变。尺寸与用量接口只保存偏好；该判断不改变监听地址，也不放宽模型、凭据或其它写入路由。

## 验证

当前 r2 插件组 16/16、0 skip、exit 0；真实 BrowserAuth、HostConnection、Cordis Context 和候选 wrapped routes 组合，网络出口被拦截。

Main r12 组合组 8/8、0 skip、exit 0；同一隔离 fixture 执行 Main 原转发函数，再进入真实 BrowserAuth、HostConnection 和候选路由。涵盖可信 native 两条 PUT、默认不可信拒绝、Main 对 opaque/foreign/cross-site 的 403、GET、其他敏感 LAN 写和缺失/无效 Cookie 的 401。fetch 被替换为内存 route dispatch，HTTP(S)/socket 出站封锁；测试不启动完整 Desktop 或正式 Host。

记录与命令见 `recovery-20261029/whale-local-preferences-20261103/VALIDATION.md` 和 `*-GREEN.txt`。`node --check` 与规范 patch `git apply --check --no-index` 均 exit 0。所有验证均为候选隔离证据，不表示正式包已安装或正式 UI 已验收。
