# 本地验收记录 · 2026-10-30

基线：dsh-app `4f03e98e`。没有创建公开仓库、发 npm 包、开远端 PR、上传 Pages 或部署 Worker。以下结果来自本地执行，不能当作 GitHub/Cloudflare 线上验收。

| 范围 | 结果 |
| --- | --- |
| `npm test`（market） | 24 个离线测试通过；含两份原始 npm tarball、官方格式校验、拒绝规则、风险标记、原生清单、归档路径/链接检查与 CI 固定版本边界 |
| `npm test -- --maxWorkers=1`（Worker） | 112 个测试通过，包含既有回归和市场新增路由测试 |
| `npm run typecheck`（Worker） | TypeScript 通过 |
| actionlint 1.7.7 | check / publish / watch 三个工作流通过 |
| GitHub Actions 内嵌 JavaScript | 使用 AsyncFunction 编译检查语法通过；没有调用 GitHub 写 API |
| `npm run build`（market） | 从 npm 实际下载 4 个包、核对 SHA-512、扫描并查公告后通过，直接调用官方 0.2.1-rc.2 validator 生成格式 1 |

本次在线扫描：

| 包 | 固定版本 | 解包字节 | 风险特征 | 该包精确版本的高危公告 |
| --- | --- | ---: | --- | --- |
| `@liustack/modlens` | 3.27.2 | 732368 | shell, network, filesystem, not-adapted | 无命中 |
| `@liustack/modsearch` | 5.10.11 | 518726 | shell, network, filesystem, not-adapted | 无命中 |
| `@xmanrui/dsh-im` | 5.8.0 | 28403878 | shell, network, filesystem, obfuscated, not-adapted | 无命中 |
| `dsh-context` | 0.78.2 | 764434 | shell, network, filesystem, obfuscated, not-adapted | 无命中 |

四个条目均为 community、medium、未通过原生适配声明检查。这不等于“恶意”，也不等于“不能在 App 使用 Host 工具”。未递归解析依赖或执行任何插件。媒体候选 @dsh-go/media@0.2.0 尚未发布；dsh-univer-office@0.3.9 因包体超限保持候选，不出现在索引。

本轮生成文件保留在隔离工作区 `market/dist/`（被 Git 忽略）。2026-10-30 15:20–15:21 UTC 这次成功生成的 SHA-256：

```text
58077ac92eac40bc5bacb966e5d15f5de43e6386e397b2933505322eb7fde2b2  index.json
d098719013aad93bbceff9e6423334dcf84191c067456588aa253607272d6b81  dsh-go.json
15a95f29e494ae1f226211374ac03d3ab771bd5d6630ead1f30a08ffd457febf  audit.json
```

首次尝试 dsh-im 下载遇到 30 秒超时，正确拒绝生成；tarball 下载上限单独改为 180 秒后重新实扫通过。其余元数据/公告请求仍有 30 秒上限，大小检查不变。

Worker 测试覆盖十分钟缓存及剩余有效期、上游失败/坏 JSON/超大响应、索引与 sidecar 版本不一致、KV 持久副本与读写失败、首次不可用 503、编码包名、方法/404、HEAD、HTML 转义、CSP、风险展示、App deep link 和下载回退。复用 QUOTA KV，无新增 Cloudflare 资源。

未验证：GitHub 分支保护/auto-merge/Pages 的真实部署行为、真实公网 Worker 路由、App 到已发布市场的完整安装链路、宿主实际安装字节一致性、依赖树安全性和真机运行适配。上线准备步骤和这些边界见 README，不伪造人工审核或安全背书。

## 独立审查后的输入边界修复

- 目录 PR 检查固定使用捕获的 base/head SHA。变更列表取不可变比较，内容沿同一个 head 的 Git tree 读取，并核对比较结果与 blob SHA。移动分支不会改变本次审核对象。
- 目录与 JSON 的 Git mode/type 均需匹配，拒绝符号链接、子模块和截断的 tree；向可信 base 工作区写入前也拒绝非普通文件。
- tar 路径拒绝空段、相对穿越和非规范名称；目录末尾斜杠先规范化，再与所有条目一起检查目标重复，避免审核路径与实际安装路径不一致。

修复后运行 `npm test`：22/22 通过。新增用例覆盖固定 SHA 读取、分支在读取期间变化后返回、工作流实际 JavaScript 接线、非法 Git mode、内容身份不一致、非规范 tar 路径和重复目标。GitHub API 全部用本地测试对象模拟，没有向远端写入或执行工作流。三个工作流的 actionlint 1.7.7 与全部五段内嵌 JavaScript 语法检查通过。Worker 路由没有改动，112 项既有 Worker 验证仍为上表记录的先前结果。

后续跨平台路径检查：拒绝任意路径段的尾部点/空格或冒号，并将解包目标忽略大小写后去重。新增 manifest/嵌套文件/目录冲突与正常混合大小写文件用例，`npm test` 24/24 通过，两份原始 npm tarball 夹具结果不变；`node --check scripts/core.mjs` 与 `git diff --check` 通过。本轮是 Linux 上的离线归档解析验证，没有执行 Windows 安装或远端操作。

## 2026-10-31 线上目录部署

已创建公开仓库 `ccch1mneyyy/dsh-go-market`，Pages 工作流运行 `41099576267` 成功；公开 index 与 sidecar 返回 HTTP 200。main 已配置严格分支保护并要求 GitHub Actions 的 `market/catalog` 检查，启用 squash / auto-merge。以上更新了前文的本地验证边界；插件安装和真机适配仍不在此验证范围。Worker 接口验收见下。


### Worker 线上验收与运行时修复

2026-10-30 17:39 UTC（本地 2026-10-31 01:39）部署并验收 Worker 版本 `3c31b096-b938-41a6-92ce-ff90e603999d`，代码修复为 `8ec9b86b`、`8b014d75`。市场初次上线返回 503；受限线上日志记录 `TypeError`，根因为 Workers 不支持 `redirect: 'error'`，在构造请求时即抛错。改用 `redirect: 'manual'`，并由既有 `!response.ok` 检查拒绝 3xx，保持禁止跟随重定向的边界；增加 302 回归覆盖。运行时限制见 [Cloudflare Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)。失败诊断仅记录固定原因、受限异常类型和 HTTP 状态，不记录 URL、响应正文或任意异常消息。

| 验证范围 | 结果 |
| --- | --- |
| `https://go.dshtui.com/market/index.json` | HTTP 200、JSON、`X-Market-Stale: false` |
| `https://go.dshtui.com/market/dsh-go.json` | HTTP 200、JSON、`X-Market-Stale: false` |
| 真实线上双文件执行导出的 `validateCatalog` | 通过，4 个插件，索引与 sidecar 配对有效 |
| Worker 全量正式测试（排除本机临时验收脚本） | 7 个已提交测试文件、113 项通过；排除临时线上验收脚本以免混入正式测试计数 |
| Worker `tsc --noEmit` | 通过 |
| 部署脚本真实分享链路 E2E | 上传、读取、解密、页面及安全头、token/admin 删除全部通过 |

默认 `npm test` 亦通过，共 115 项，其中另外 2 项为临时的 Pages/Worker 真实目录配对校验。以上确认公开市场接口和既有分享链路运行正常；没有扩大到 App 插件安装、宿主安装字节一致性、依赖树安全性或真机适配验证。

## 2026-10-31 媒体插件 0.2.1 正式发布与市场收录

正式收录包为 `@ccch1mneyyy/dsh-media@0.2.1`。2026-10-30 19:55:51 UTC 已验证匿名精确版本 HTTP 200、公开 tarball 完整下载；19 个文件、压缩 48019 字节，SHA-256 为 `9829f5106dec8cb354c203c74cc0510656f0f94538c36abf0fb80226388d13c9`，内容与本地发布包一致。注册表 SHA-512 为：

```text
sha512-OCm2F4PwrCaNptn2TLTiZvlcK2RY7vmSNW8Qa3uu8YlUzt49pMSS9VdHQ3sKUUB9VEvST3+bjxs0TlfR4wdbmg==
```

媒体源码此前通过 306 项 Node 测试；`0.2.1` 与该已测包只有 package.json 版本号差异。市场在 19:56 UTC 起重新读取真实 npm 发布物：解包 163812 字节，MIT/OSI 许可、归档安全、包身份和 DSH bundle patch 均通过，精确版本公告为空。识别为 `adapted: true`、`minApp: 1.0.2`、`features: [media]`，风险为 medium，保留 shell、network、filesystem 特征及实际文件证据。

`plugins/` 只加入这个媒体条目，维护者 policy 将其标为 official；总目录为 5 个固定版本。原计划 `@dsh-go/media` 发布失败；备用包 `0.2.0` 曾成功暂存并核对下载内容，但审批接口返回 404，根因未定。新发布凭据获得直发权限后，`0.2.0` 因已暂存返回 409，因此只升级版本号到 `0.2.1` 完成正式发布。未将旧包名、暂存版本或占位版本加入市场。

本轮市场 `npm test` 24 项离线测试通过，`npm run check` 与 `npm run build` 通过全部 5 个精确版本；构建重新下载并检查 npm tarball、核对 SHA-512 和公告，再调用官方格式 1 validator。市场静态检查不执行插件、不解析依赖树，也不证明 App 安装字节一致性、真实付费生成或设备完整媒体链路。

### 媒体目录线上验收

公开市场提交 `4d822e9735e00e39b72b433af26608d5d93c9c82` 已发布到 main，使用既有 owner bypass 推送，没有修改分支保护。GitHub Pages 工作流 [41119356203](https://github.com/ccch1mneyyy/dsh-go-market/actions/runs/41119356203) 的依赖安装、24 项测试、完整在线构建和部署均成功，部署于 2026-10-30 19:57:38 UTC 完成。

| 验证时间（UTC） | 对象 | 真实结果 |
| --- | --- | --- |
| 2026-10-30 19:57:57 | Pages `index.json` 与 `dsh-go.json` | 两份均 HTTP 200，5 个插件，媒体条目为 `@ccch1mneyyy/dsh-media@0.2.1`、official |
| 2026-10-30 19:58:47 | Worker `/market/index.json` 与 `/market/dsh-go.json` | 两份均 HTTP 200、`X-Market-Stale: false`，5 个插件，正确媒体版本与官方身份 |
| 上述两组真实响应 | 实际 Worker `validateCatalog` 与官方 `parseMarketIndex` | 均通过；索引与 sidecar 名称、版本配对，媒体 SHA-512 与 npm 精确版本元数据一致；adapted、minApp、features、风险标记均符合扫描结果 |

Worker 首次请求命中尚未过期的旧 4 条缓存，响应剩余有效期为 28 秒；等待自然过期后完成上述验收，没有清空 KV 或重部署 Worker。最终目录不包含原包名、暂存的 0.2.0 或占位版本。以上验证市场的真实公开分发，仍不扩展为 App 设备安装或付费供应商生成的验证。
