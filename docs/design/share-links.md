# 托管对话链接（分享链接）

> 2026-10-25 上线：`https://go.dshtui.com`。服务端代码在 `services/share-worker/`；对话文件格式、查看器源码、分享面板归 [share-codes.md](share-codes.md)。本文只讲托管这一侧：服务、加密、限速、过期、成本和运维。

## 1. 架构

```
App（分享面板「链接」）
  → .dshgo 文件字节 → gzip → AES-256-GCM（手机上加密，随机密钥）
  → POST https://go.dshtui.com/api/v1/c        只上传密文
  ← {id, deleteToken, expiresAt}
  → 链接 https://go.dshtui.com/c/<id>#k=<key>   密钥只在 # 后面

微信里点开链接
  → GET /c/<id>             Worker 返回查看器（构建出的 c.html，静态）
  → GET /api/v1/c/<id>      查看器取回密文
  → 浏览器用 #k 解密（WebCrypto）→ 渲染并回放
```

| 部分 | 位置 |
|---|---|
| Worker（API、限速、查看器路由、插件市场） | `services/share-worker/src/` |
| 部署配置（无 secret） | `services/share-worker/wrangler.jsonc` |
| 页面构建（拷贝查看器、着陆页与首页，提取 CSP，生成 `_headers` / `_redirects`） | `services/share-worker/scripts/build-site.mjs` |
| 首页（社区制作的展示网站） | `site/home/`（说明见其 `README.md`） |
| 开通与部署脚本 | `services/share-worker/scripts/provision.sh`（账号与 KV id：`scripts/cloudflare.sh`） |
| 线上 / 本地端到端检查 | `services/share-worker/scripts/e2e.mjs`、`smoke.mjs` |
| App 客户端、加密、「我的分享链接」状态 | `app/lib/share_hosted/` |
| 「我的分享链接」页、分享面板适配器 | `app/lib/ui/share_hosted/` |

服务器从不接触明文和密钥：浏览器不会把 `#` 后面的内容发给服务器，Worker 也不记录 URL 片段。

## 2. 域名与页面

- 域名：`go.dshtui.com`（Workers Custom Domain，DNS 记录由 Cloudflare 自动建）。被占用时退到 `s.dshtui.com`，由 `provision.sh` 自动判断。不用 `*.workers.dev`，它在大陆被污染。
- 页面：

| 路径 | 内容 |
|---|---|
| `/c/<id>` | 查看器 `c.html`（`site/build/share/c.html`） |
| `/share/` | 着陆页（`site/share/`，从 `site/build/share/` 拷贝）；App 的 `shareLandingUrl` 指向这里 |
| `/` | 首页（`site/home/dist/`，拷到 `public/` 根下）；页面引用的文件按原路径提供（`/app.js`、`/styles.css`、`/assets/…`），直接访问 `/index.html` 是 404 |
| `/robots.txt` | 只放行首页和它的文件，其余 `Disallow` |

- 首页、着陆页和它们的文件是静态资源，**不经过 Worker**（不计 Worker 请求数）：`build-site.mjs` 把每个文件的安全头写进 `public/_headers`（逐个路径，不用通配），`/` 和 `/share/` 由 `public/_redirects` 的 200 改写指到 `index.html`。只有 Worker 自己的路由先进 Worker（`wrangler.jsonc` 的 `run_worker_first` 列表：`/api/*`、`/c/*`、`/market*`、`/p*`、`/beta*`、`/download*`、`/share`（301 到 `/share/`），以及要藏起来的 `/c.html`、`/index.html`）。路径按字面匹配（`html_handling: none`）；没有对应文件的路径也落到 Worker，返回同样的 404。
- 和全部走 Worker 时相比，头部逐项相同（`wrangler dev` 对比过 111 个请求）；只差两处无关紧要的：对静态文件用 GET/HEAD 以外的方法，405 由资源服务直接给（不带 `Allow`，带该文件的安全头）；304 也带上该文件的 `Cache-Control`。
- 旧着陆页 `https://ccch1mneyyy.github.io/dsh-go/share/` 保留不下线：已经发出去的分享码链接照常能开，App 也继续认（`legacyShareLandingUrls`）。新生成的分享码链接都用 `go.dshtui.com/share/`。
- 安全头：
  - HTML：CSP 与页面自带的 `<meta>` 一致，再加 `frame-ancestors 'none'`（构建时从页面里提取，没有 CSP 或允许 `unsafe-inline` 脚本时构建失败）；另有 `X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`nosniff`、`COOP`、`Permissions-Policy`、`noindex`。
  - 首页：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`。没有内联脚本；开场动画靠内联 `style` 属性里的 CSS 变量，所以只放开 `style-src-attr`（不认识它的旧浏览器退回 `style-src` 的 `'unsafe-inline'`）。首页和它的文件不带 `noindex`，其余头部同上；HTML `no-cache`，其余文件一小时。
  - 密文：只用 `application/octet-stream`，带 `nosniff`、`Content-Disposition: attachment`、`CSP: default-src 'none'; sandbox`、`CORP: same-origin`、`Cache-Control: no-store`。不发 CORS 头，别的网站无法在浏览器里读取。

## 3. 加密

- 明文：`.dshgo` 文件（`kind: conversation`）的 UTF-8 字节，先 gzip。
- 算法：AES-256-GCM，IV 12 字节随机，无 AAD，tag 16 字节。
- 存储格式：`"DSG1"` ‖ IV ‖ 密文（含 tag）。
- 密钥：32 字节随机，base64url 无填充（43 字符），只出现在 `#k=` 里。每条链接一把新密钥。
- App 实现：`package:cryptography` 的纯 Dart 实现（`DartAesGcm`，和 `packages/dsh_remote` 一样），测试和后台 isolate 里行为一致；4 MB 文件加密约 0.25 秒（桌面 JIT），256 KB 以上放到后台 isolate。
- 互通：`app/test/share_hosted/fixtures/webcrypto_vectors.json` 是 node WebCrypto 生成的向量，Dart 逐字节一致；反方向由测试调用 node（WebCrypto + `site/share/viewer.js`）解开 App 加密的结果。
- 解包上限 64 MB（防 gzip 炸弹）。

## 4. API

| 请求 | 说明 | 成功 | 失败 |
|---|---|---|---|
| `POST /api/v1/c?ttl=7d\|30d\|forever` | 体为密文，`Content-Type: application/octet-stream`，≤ 20 MB；缺省 `30d` | `201 {id, deleteToken, expiresAt}`（永久为 `null`） | 400 格式 / 415 类型 / 413 太大 / 429 限速 |
| `GET /api/v1/c/<id>` | 取回密文 | `200` 密文 | 404 不存在、已删除或已过期 |
| `DELETE /api/v1/c/<id>` | `Authorization: Bearer <deleteToken>`，或 `X-Admin-Key` | `204` | 401 无凭据 / 403 不对 / 404 |
| `GET /api/github/stars` | 首页的 Star 数（`src/github.ts`）：Worker 去问 `api.github.com/repos/ccch1mneyyy/dsh-go`，访客不连 GitHub | `200 {stars}`，`max-age=600` | 503 从没拿到过 |

- 校验：魔数 `DSG1`、最小 32 字节、`Content-Type`、大小（先看 `Content-Length`，流式读取时也截断）。
- `deleteToken`：32 字节随机，只返回一次；R2 里只存它的 SHA-256（`customMetadata.dt`），比较为常量时间。
- `id`：10 位 base62，随机约 58 位；写入前检查是否撞号。
- Star 数：每个机房在边缘缓存（键 `/__edge/github/stars`，外部访问 404）里记最近一次的数，10 分钟后再问 GitHub；GitHub 出错时继续给旧数，一分钟后再试。不带 token 时 GitHub 按出口 IP 每小时 60 次，Workers 的出口 IP 是共用的，常会被限；设了可选的 `GITHUB_TOKEN` 就是每小时 5000 次。

## 5. 限速（按 IP；IPv6 按 /64）

| 对象 | 规则 | 实现 |
|---|---|---|
| 上传 | 每分钟 5 次 | Rate Limiting 绑定 `UPLOAD_BURST` |
| 上传 | 每小时 20 次（成功的才计数） | KV `QUOTA` 固定窗口计数，键为 IP 的哈希，2 小时过期 |
| 读取、删除 | 每分钟 120 次 | Rate Limiting 绑定 `READ_LIMIT` |
| 管理员删除 | 不限 | — |

- Rate Limiting 绑定只能按 10 秒或 60 秒计，所以小时额度放在 KV。KV 最终一致，跨机房时是近似值；同一个客户端通常落在同一机房。
- 全部失败放行：绑定缺失、KV 读写出错（包括免费额度用完）都不拦请求。
- 超限返回 429 和 `Retry-After`，App 显示「分享太频繁，稍后再试」。

## 6. 过期

- `id` 的首字符编码过期档，读取时不查索引：

| 档 | 首字符 | R2 前缀 | 生命周期规则 |
|---|---|---|---|
| 7 天 | `0-9 A-J` | `7d/` | 7 天后删除 |
| 30 天（默认） | `K-Z a-d` | `30d/` | 30 天后删除 |
| 永久 | `e-z` | `keep/` | 无 |

- R2 生命周期按上传时间计，实际删除可能晚一天以内，所以 `GET` 自己也按 `uploaded + 天数` 判断，过期即 404。
- 另有一条规则：未完成的分片上传 1 天后清理。
- `beta/`（内测包，见 §14）不在任何过期规则里，文件一直保留。

## 7. App 端

- `HostedShareClient`（`hosted_client.dart`）：`upload(bytes, ttl, title:) → HostedLink`、`delete(link)`、`download(url)`；错误统一成 `HostedShareException`，`message` 可直接显示。
- 「我的分享链接」（`hosted_links_state.dart`）：每条存 id、密钥、deleteToken、标题、创建与过期时间、域名。因为含密钥，整份列表放在 Keystore 支持的安全存储里（和 API Key 一样），键为 `hosted_links`。
  - 删除：确认后立即从列表隐藏，4 秒内可撤销；窗口结束才请求服务器。期间 App 被杀，下次启动补删。删除失败时链接回到列表并提示。已过期或服务器上已不存在的，删除即从列表移除。
  - 过期超过 30 天的条目自动从列表清掉。
- 管理页 `HostedLinksPage`（列表页骨架）：标题、到期时间（「11 月 24 日到期」「明天到期」「永久有效」「已过期」）、复制、删除。
- 分享面板接入：`hostedConversationLinkMaker`（`ui/share_hosted/hosted_link_maker.dart`）实现分享面板的 `ConversationLinkMaker`，经它生成的链接都会进「我的分享链接」。
- 域名常量：`shareHostOrigin`（`share_hosted/hosted_config.dart`），`share_link.dart` 的 `shareLandingUrl` 由它派生。每条链接自带域名，以后换域名旧链接仍能删除。
- 入口：设置首页「对话」组「我的分享链接」（右侧条数，`HostedLinksSettingsTile`）；分享面板「链接」页底部的「我的分享链接」（`ManageLinksButton`，经 `conversation_out.dart` 导出给面板用），不必先生成链接。
- 分享面板里刚生成的链接可以直接「停止分享」：`ConversationLinkMaker.revoke / restore`，即本页的 `remove / undo`。

**在 App 里打开托管链接**（`ui/share_hosted/hosted_link_host.dart`）：

| 来路 | 走法 |
|---|---|
| 别的 App 分享进来的文字（微信转发） | `IncomingShare.hostedLink` → `SystemEntryHost` 交给 LinkRouter |
| 网页查看器的「用 dsh-go 打开」 | `dshgo://go.dshtui.com/c/<id>#k=<key>`（和 https 链接同一条路由） |
| App Links（以后） | `https://go.dshtui.com/c/…`；需要清单里的 `autoVerify` intent-filter 和本域名的 `/.well-known/assetlinks.json`，等发布签名定了再加 |

- LinkHost 启动时调 `registerHostedLinks` 注册 `go.dshtui.com/c`；收到链接后取回密文、在手机上解密、进回放页。超过 0.6 秒才提示「正在打开…」。
- 只从自己的域名取（`hostedOrigins`）；已删除或过期提示「链接已过期或被删除」，密钥不对提示「链接不完整或已损坏」。

## 8. 部署

一次性开通（只建自己的资源，写操作前都先确认）。下表是本项目部署用的资源名，自托管时换成你自己的域名和账号。账号 id 和 KV id 不进仓库、不记在文档里：公开仓库的 `wrangler.jsonc` 只有占位符，脚本从环境变量或 `~/keys/` 下的文件读（`scripts/cloudflare.sh`，见 `docs/release.md`「内测通道」），只写进 `wrangler.jsonc` 旁边的临时副本交给 `wrangler --config`，退出即删；读到占位符时什么都不做就报错。

```bash
cd services/share-worker
npm ci
CF_TOKEN_FILE=<token 文件> scripts/provision.sh check   # 只读：zone、域名是否空闲、已有资源
CF_TOKEN_FILE=<token 文件> scripts/provision.sh apply   # 建 R2 + 生命周期 + KV，部署，设 ADMIN_KEY，跑线上 e2e
```

| 资源 | 名字 |
|---|---|
| Worker | `dshgo-share` |
| Custom Domain | `go.dshtui.com` |
| R2 bucket | `dshgo-share`（私有；规则 `expire-7d`、`expire-30d`、`abort-multipart`） |
| R2 bucket | `dshgo-dl`（公开读，放发版文件和插件市场的 `market/`，自定义域名 `dl.dshtui.com`；后台建，脚本不建，§14；Worker 绑定为 `DL`，只写 `market/`） |
| KV | `dshgo-share-quota`（id 在 `~/keys/dshgo-cloudflare-kv-quota-id` 或 `CF_KV_QUOTA_ID`；`provision.sh apply` 发现或新建时写这个文件） |
| Rate Limiting 命名空间 | `42001`（上传）、`42002`（读取）、`42003`（App 使用统计，§15）；账号内唯一，别的 Worker 不要复用 |
| Analytics Engine 数据集 | `wrangler.jsonc` 绑定 `dshgo_downloads`、`dshgo_checks`、`dshgo_usage`（第一次写入时自动建）；`provision.sh` 默认带上，没开通 Analytics Engine 的账号用 `--no-analytics`（§15） |
| Cron Trigger | 每 10 分钟一次，把插件市场写到 `dshgo-dl` 的 `market/`（[plugin-market.md](plugin-market.md) §3） |
| Redirect Rule（zone 级，单条重定向） | 描述 `dshgo-share: plugin market from the public bucket`：`go.dshtui.com/market/index.json`、`/market/dsh-go.json` → 302 `https://dl.dshtui.com/market/<同名>`（带 `Origin` 头的请求不跳）；`provision.sh` 在 `dl` 上的文件和 Worker 一致后按描述建或改，不碰别的规则 |
| Durable Object | `BetaGuard`（migration `v1`）、`StatsSalt`（`v2`，§15） |
| Worker secret | `ADMIN_KEY`（管理员删除用；`provision.sh apply` 生成并设置，本地副本默认 `~/.config/keys/dshgo-share-admin.txt`（`ADMIN_FILE`），权限 600，放在仓库外） |
| Worker secret | `BETA_SECRET`（内测发包，§14；`scripts/beta-keys.sh init` 生成并设置，本地副本默认 `~/keys/dshgo-beta-secret`（`BETA_SECRET_FILE`），权限 600） |
| Worker secret | `USAGE_SECRET`（App 使用统计里安装编号的哈希密钥，§15；生成方法见 `docs/release.md`「统计」，本地副本放在仓库外，权限 600） |
| Worker secret（可选） | `GITHUB_TOKEN`（首页 Star 数查 GitHub 用，§4；不需要任何权限的 fine-grained token 即可：`npx wrangler secret put GITHUB_TOKEN`） |

- token 只以 `$(cat 文件)` 的形式直接交给 curl / wrangler，脚本不打印、不落盘、不进 URL。
- 之后改了 Worker 代码或查看器：先 `python3 app/tool/make_replay_viewer.py`，再 `CF_TOKEN_FILE=… scripts/provision.sh deploy`（会重新拷贝页面、部署并跑 e2e）。
- 本地：`npm test`（单测）、`npm run smoke`（`wrangler dev` 本地冒烟，不连 Cloudflare）。

## 9. 成本（Workers 免费计划）

| 项 | 免费额度 | 本服务用量 | 够用到 |
|---|---|---|---|
| Worker 请求 | 10 万 / 天 | 打开一次 2 次（查看器、密文；图标等静态文件不算），上传 1 次；首页、着陆页不算；插件市场在 `dl.dshtui.com`，不算 | 约 4 万次打开 / 天 |
| Worker CPU | 10 ms / 次 | 以 I/O 为主；20 MB 上传的拷贝在毫秒级 | — |
| R2 存储 | 10 GB-月 | 每条约 50 KB（纯文字）到几 MB（带图） | 约几万条存活链接 |
| R2 写（A 类） | 100 万 / 月 | 上传 1 次（删除不收费） | 约 3 万次上传 / 天 |
| R2 读（B 类） | 1000 万 / 月 | 打开 1 次；上传、删除前各查 1 次 | 约 30 万次打开 / 天 |
| R2 流量 | 免费 | — | — |
| KV 读 / 写 | 10 万 / 1000 每天 | 每次上传各 1 | 约 1000 次上传 / 天（超了小时额度失效，分钟限速仍在） |
| Analytics Engine 写 | 10 万个数据点 / 天（以 Cloudflare 价格页为准） | 每次点下载、每次带令牌的更新检查、每份 App 使用报告各 1 | 三者合计约 10 万 / 天；超了只是少记，不影响下载 |

- 早期完全够用。最先碰到的是 KV 写入（1000 次上传 / 天）和 Worker 请求（下载页、更新检查、使用统计等每天约 2 万次，剩下的够约 4 万次打开）。
- 超出后升级 Workers Paid（$5 / 月）：请求 1000 万 / 月，KV 写 100 万 / 月；R2 超额按 $0.015 / GB-月、A 类 $4.5 / 百万、B 类 $0.36 / 百万计。
- 「永久」链接会持续占空间，是长期成本的主要来源。

## 10. 举报处理

服务器看不到内容，判断靠举报人提供的完整链接（带 `#k`）。确认违规后：

```bash
curl -X DELETE "https://go.dshtui.com/api/v1/c/<id>" \
  -H "X-Admin-Key: $(cat <ADMIN_KEY 文件>)"
# 204：已删除；404：已不存在
```

- `<id>` 是链接里 `/c/` 后面的 10 个字符。删除立即生效（密文不缓存）。
- 被大量滥用时：临时把 `UPLOADS_PER_HOUR` 调小再部署；必要时在 Cloudflare 里对该路径加 WAF 规则。

## 11. 轮换

**Cloudflare API token**：

1. Cloudflare 后台 → My Profile → API Tokens：新建 token。本服务只需要：Account · Workers Scripts:Edit、Workers R2 Storage:Edit、Workers KV Storage:Edit；Zone（你的域名）· Zone:Read、Workers Routes:Edit、DNS:Edit（Custom Domain 会建自己的那条 DNS 记录）。
2. 写入新 token 文件，删除旧 token（Roll 或 Delete）。
3. 更新所有存着这把 token 的地方：本地的 token 文件，以及 CI 里用到它的 secret。
4. 线上服务不依赖 token 运行，轮换不影响已部署的 Worker。用新 token 跑一次 `provision.sh check` 确认权限够用。

**ADMIN_KEY**：

```bash
(umask 077; openssl rand -base64 33 | tr '+/' '-_' | tr -d '=\n' > <ADMIN_KEY 文件>)
CLOUDFLARE_API_TOKEN="$(cat <token 文件>)" npx wrangler secret put ADMIN_KEY < <ADMIN_KEY 文件>
```

## 12. 回滚与下线

- 回滚代码：`CLOUDFLARE_API_TOKEN="$(cat <token 文件>)" npx wrangler rollback`（回到上一个版本；`wrangler deployments list` 查看历史）。不影响 R2 里的数据。
- 暂停上传：把 `UPLOADS_PER_HOUR` 设为 `0` 后部署（读取和删除照常）。
- App 侧关闭入口：不覆盖 `conversationLinkMakerProvider`（保持 `null`），分享面板就不出现「链接」。
- 整体下线（不可逆，链接全部失效）：删除 Custom Domain → 删除 Worker `dshgo-share` → 清空并删除 bucket `dshgo-share` → 删除 KV `dshgo-share-quota`。下载桶 `dshgo-dl`（和它的 `dl.dshtui.com`）与分享无关，单独处理。

## 13. 测试

| 范围 | 命令 | 内容 |
|---|---|---|
| Worker 单测 | `npm test` | id 与过期档、IPv6 /64、上传校验与大小上限、分钟与小时限速、失败放行、读取头部、过期 404、删除权限、管理员删除、页面路由与 CSP；首页的 CSP、文件类型与缓存、页面引用的文件都在、`robots.txt`；Star 数（模拟 GitHub：缓存 10 分钟、出错给旧数、从没拿到时 503、token） |
| 本地冒烟 | `npm run smoke` | 真实 workerd + 本地 R2 / KV / 限速，跑完整 e2e 和分钟限速；内测部分按密钥模式跑（`--var DOWNLOAD_ACCESS:key`） |
| 线上 e2e | `node scripts/e2e.mjs https://go.dshtui.com [--admin-key-file …]` | 上传 → 取回 → node 解密 → 查看器解密 → `/c/<id>` → `/share/` → `/`（首页 CSP、`image/webp`） → 删除 → 404 |
| Dart | `flutter test test/share_hosted/` | WebCrypto 向量互通、双向解密、篡改与炸弹、客户端错误映射、删除与撤销、管理页交互、行几何、浅深 golden |
| 内测发包 | `npm test`（`test/beta.test.ts`）、`npm run smoke` | 页面头部与 CSP、微信 / QQ 提示页、密钥对错 / 吊销 / 过期同一答复、输入归一、错误限流与封禁、签名链接过期与篡改、Range（206 / 416）、边缘副本只在鉴权后可达、通道令牌 401 / 200、密钥模式下 `/download`、`/update.json` 404 |
| 下载线路与公开模式 | `npm test`（`test/download.test.ts`） | 线路选择（CN / 非 CN / `?via=` / 国内未配置 / 清单没传到）、海外线路指向公开下载桶（清单有 `dl` 且配了 `DL_BASE_URL`；否则仍是 `/download/…`；密钥模式仍是签名链接）、`DOWNLOAD_ACCESS` 开关、`/beta` 302 到 `/download`、通道与签名链接不受影响、公开文件的 Range 与缓存头、边缘副本共用、读限流、更新说明转义、中英 |
| 统计 | `npm test`（`test/stats.test.ts`、`test/stats-script.test.ts`）、`npm run smoke` | 三条线路的下载按钮都计数并 302 到对的地址、HEAD / 旧版本 / 乱填 / 刷量不计、密钥模式 404；更新检查只记通道应答；设备码一天内不变、跨天变、按 IP 和 UA 区分、盐过了当天被删；使用报告字段白名单、类型和上限、日期窗口、2 KB、重复上报、限流、没有密钥时 404；所有存下的东西里没有 IP、安装编号原文和 UA；`stats.sh` dry-run 什么都不执行、对假 API 出报表、出错时报错；`github-downloads.sh` |
| 发布脚本 | `npm run smoke:publish` | dry-run（OSS / COS / 无国内线路 / 无 dl / 预发布版 / 缺配置 / 补丁与 `SHA256SUMS` 不符，确认什么都没执行）；对着本地 `wrangler dev`、充当公开桶的本地目录和假的 ossutil / coscli / gh 真跑：公开 / 密钥两种模式、补丁和 APK 一起上每条线路、dl 的两份 `update.json`、海外按钮指向 dl、重跑跳过、同版本换包被拒、某条线路文件损坏时不上线 |
| App 内测通道 | `flutter test test/update/beta_channel_test.dart test/update/mirror_config_test.dart` | 有令牌时先问 `/beta/update.json`（不被「上次成功」挤掉）、令牌只发往通道自己的地址、下载与续传带令牌、通道拒绝时回落 GitHub 且不带令牌、缓存的更新提示重启后照样下载；无令牌时只查 GitHub |

## 14. 内测发包（凭密钥下载）

内测包不公开发布：人凭**密钥**在 `https://go.dshtui.com/beta` 下载，已装的 App 凭构建时编进去的**通道令牌**检查更新、App 内下载。之前的公开镜像（`/download`、`/update.json`）已撤下：`/update.json` 恒为 404，`/download` 只在公测开关打开后作为公开下载页回来（见本节末「公测：三条线路与公开下载」）。发版步骤见 `docs/release.md`「内测通道」「发版到三条线路」。

**地址**

| 路径 | 谁能用 | 内容 |
|---|---|---|
| `GET /beta` | 任何人 | 品牌页：输入密钥 → 三条下载线路、版本、大小、发布日期、SHA-256、安装说明、更新说明。亮 / 暗跟随系统，中英跟随浏览器（`?lang=` 可指定），服务端渲染。微信、QQ 内置浏览器里改为「在浏览器打开」提示页（它们不下 APK）。`noindex, nofollow`，`robots.txt` 不放行，解锁前页面上没有外链 |
| `POST /beta/api/unlock` | 凭密钥 | `{key, lang?}` → 最新版信息、`routes`、10 分钟有效的签名链接、渲染好的发布卡片（`card`）；密钥不对 / 已吊销 / 已过期一律 `403 {"error":"invalid_key"}` |
| `GET /beta/<版本>/<文件>` | `?exp&sig`（签名链接）或 `Authorization: Bearer <通道令牌>` | APK、`SHA256SUMS`、该版本的 `update.json`；`Range` 续传（206 / 416），`Content-Disposition` 带版本号文件名，`Cache-Control: private, no-store` |
| `GET /beta/update.json` | 只认通道令牌 | App 的更新清单（schema 1，下载地址指向 `/beta/<版本>/`，`page` 指向 `/beta`，另有 `notesByLocale` 中英分开），没有或不对 401 |

**凭据**

| | 形式 | 存储 | 管理 |
|---|---|---|---|
| 密钥（给人） | `dsh-` + 8 位，字母表去掉 0 1 i l o（约 40 位熵）；输入时全角、大小写、空格、各种横线、漏写前缀都能认 | KV `beta:key:<HMAC-SHA256(BETA_SECRET, "key\n"+密钥)>` → `{label, created, expires, revoked}`；不存明文，KV 泄露也反推不出（短密钥加了盐） | `scripts/beta-keys.sh add / list / revoke`，可设过期 |
| 通道令牌（给 App） | `dshc_` + 32 字节随机 | KV `beta:chan:<SHA-256(令牌)>`；本机 `~/keys/dshgo-beta-channel.token`（600），`tooling/build-apk.sh` 编进 release 包 | `channel-add / channel-list / channel-revoke`；可以同时有多把，换令牌时新旧并存 |
| `BETA_SECRET` | 32 字节随机 | Worker secret；本机 `~/keys/dshgo-beta-secret`（600） | `beta-keys.sh init`（`--rotate` 让所有密钥失效，不影响通道令牌） |
| 签名链接 | `?exp=<秒>&sig=<HMAC(BETA_SECRET, "dl\n"+路径+"\n"+exp) 前 16 字节>` | 不存 | 10 分钟有效，只开它自己的路径；过期后页面会用同一把密钥自动换新链接。已开始的下载不会被掐断，但过期后的续传要回页面重取 |

- 通道令牌的校验结果每个 isolate 记 60 秒，KV 本身最终一致：新加或吊销的密钥 / 令牌约一分钟内全球生效。
- 令牌编在 APK 里，能被提取：它挡的是没有安装包的人。泄露了就换（`docs/release.md`）。

**限流**（按 IP，IPv6 按 /64）

| 对象 | 规则 | 实现 |
|---|---|---|
| 解锁请求 | 每分钟 120 次 | `READ_LIMIT`，键 `beta-unlock:<ip>` |
| 错误密钥 | 答错 5 次（每次答错重新计 10 分钟窗口，慢慢猜也算）；第 6 次起封 10 分钟，期间正确密钥也 429（`Retry-After: 600`），封禁中继续猜不延长 | Durable Object `BetaGuard`（`src/beta-guard.ts`），每个客户端一个，按 IP 的哈希命名，不存 IP 原文；到期由 alarm 清掉 |
| 下载、清单 | 每分钟 120 次 | `READ_LIMIT`，键 `beta:<ip>` |

- 只数答错的，是因为国内运营商 NAT 下一群人共用一个 IP，群公告一发会同时来很多人。答对从不计数，App 的通道下载也不受封禁影响。
- 为什么不用现成的限速绑定或 KV：线上实测 `UPLOAD_BURST`（5 次 / 分钟）对连续 15 次答错一次都没拦（绑定按机房近似计数）；KV 读有约一分钟缓存，计数永远停在 1。Durable Object 单线程、强一致，免费计划可用（SQLite 后端）。
- 全部失败放行（绑定或 Durable Object 出错）；40 位熵的密钥本身就不怕猜。

**存储与缓存**

- R2 `beta/<版本>/<文件>`，最新版指针 `beta/update.json`（`publish-release.sh` 最后才写它）。Worker 把最新清单在 isolate 里记 30 秒。
- APK 在 Cloudflare 边缘留一份副本（Cache API），键是 `/__edge/beta/<版本>/<文件>`：只在鉴权通过后查，直接访问这个路径是 404。所以同一版本不能换文件，修包要升版本名（脚本会拒绝）。

**App 侧**（`app/lib/update/update_config.dart`，从下一个带令牌的包起生效；0.9.1 及更早的包没有令牌）

- 有令牌：先问 `/beta/update.json`（永远第一，不参与「上次成功的源排最前」，否则 GitHub 上的旧版会挡住内测版），失败再走 GitHub。下载先走 `/beta/…`（带令牌，断点续传照旧），再回落 GitHub 和加速镜像。
- 令牌只发往通道自己的 HTTPS 地址、`/beta/` 下的路径；dart:io 跨域重定向时也会去掉 `Authorization`。
- 没令牌（开发包、`--debug`）：只查 GitHub。
- 校验不变：SHA-256 和签名预检。

**公测：三条线路与公开下载**（`src/routes.ts`、`src/download.ts`、`src/download-page.ts`；运维见 `docs/release.md`「发版到三条线路」）

| 线路 | 地址 | 出现条件 | 默认给 |
|---|---|---|---|
| 国内 `cn` | `<CN_BASE_URL><版本>/<文件>`（香港对象存储，公共读） | 变量 `CN_BASE_URL` 是 https 地址，且清单 `routes` 含 `cn` | `request.cf.country == "CN"` |
| 海外 `global` | 密钥模式：签名链接；公开模式：`<DL_BASE_URL>download/<版本>/<文件>`（公开下载桶 `dl.dshtui.com`，字节不经 Worker），清单 `routes` 没有 `dl` 或没配 `DL_BASE_URL` 时是 `/download/<版本>/<文件>` | 总有 | 其他地区 |
| GitHub `github` | `github.com/ccch1mneyyy/dsh-go/releases/download/v<版本>/<文件>` | 清单 `routes` 含 `github` | — |

- `routes` 由 `publish-release.sh` 在每条线路下载核对之后写进 `beta/update.json`，所以页面不会给出还没传上去的线路。`?via=` 可指定线路；切换是单选按钮 + CSS，公开页不跑脚本。
- 公开下载桶 `dshgo-dl`（`DL_BASE_URL`，默认 `https://dl.dshtui.com/`）：`download/<版本>/<文件>` 放每个发版文件（APK、增量补丁、`SHA256SUMS`、这一版的 `update.json`，都是 `immutable`），根目录 `update.json` 是最新正式版的清单（`max-age=300`，给 App）。和放分享链接的 `dshgo-share` 分开，`dshgo-share` 保持私有：公开了的话，拿到对象键的人能绕过 Worker 的过期和额度。`routes` 里的 `dl` 只说明文件也在这个桶，页面上不是单独一条线路。
- 开关 `DOWNLOAD_ACCESS`（Worker 变量，默认 `key`）。`public` 时：`/download` 无需密钥直接给出三条线路，按钮先经过 `/download/get` 计数再 302（§15）；`/download/<版本>/<文件>` 公开提供 APK 和 `SHA256SUMS`（同一 R2 对象，`READ_LIMIT` 键 `dl:<ip>`；海外线路改指公开桶以后，留给已经发出去的链接）；`/beta`、`/beta/` 302 到 `/download`。通道令牌、`/beta/update.json`、签名链接、解锁接口在两种模式下都不变。
- 公开 APK 的响应：`Cache-Control: public, max-age=31536000, immutable`（版本内的 APK 不会变，脚本拒绝覆盖），和通道共用同一份边缘副本（`/__edge/beta/<版本>/<文件>`），Range 续传从副本回 206。通道和签名链接即使命中副本也仍是 `private, no-store`。`SHA256SUMS` 一小时。

**部署**

- 代码：`CF_TOKEN_FILE=… scripts/provision.sh deploy`（跑完线上 e2e）。
- 需要的 Worker secret：`ADMIN_KEY`、`BETA_SECRET`；Durable Object `BetaGuard`（migration `v1`）。

## 15. 统计与隐私

> 我们的账号已开通 Analytics Engine，`provision.sh` 默认带着三个数据集部署。Fork 的账号没开通时用 `provision.sh deploy --no-analytics`（或 `DSH_ANALYTICS=0`）：带着绑定的部署在没开通的账号上会失败；去掉后下载按钮和更新检查照常工作但不计数（也不去取当天的盐），`POST /api/usage/v1` 恒为 404（App 当天不再上报），`scripts/stats.sh` 没有数据可读。`wrangler dev` 本地一直带着这三个绑定。

公测起统计三样东西，都只在服务端，都写进 Workers Analytics Engine（AE），**没有公开的查询端点**：只能用 `scripts/stats.sh` 凭 API token 读。代码在 `src/stats.ts`、`src/usage.ts`。

| 数据集 | 什么时候写 | 存什么（`blob` / `double`） | 不存什么 |
|---|---|---|---|
| `dshgo_downloads` | 点下载按钮：`GET /download/get?via=cn\|global\|github&v=<版本>`，记一次再 302 到这条线路的真实地址 | `blob1` 日期（UTC+8）、`blob2` 线路、`blob3` 版本、`blob4` 国家（`request.cf.country`，没有记 `XX`）、`blob5` 当天设备码；`double1` 1 | IP、UA、完整 URL |
| `dshgo_checks` | 带通道令牌的 App 检查更新：`GET /beta/update.json` 答 200 | `blob1` 日期、`blob2` 当天设备码、`blob3` App 版本、`blob4` ABI（UA 写了才有，见下）、`blob5` 国家 | IP、UA、令牌 |
| `dshgo_usage` | App 的匿名使用报告：`POST /api/usage/v1`（0.9.9 起，App 里可关） | `blob1` 报告的日期、`blob2` 安装编号的哈希、`blob3` 版本、`blob4` ABI、`blob5` 厂商（小写）、`blob6` 语言、`blob7` 运行方式、`blob8` 机型（小写，v2 起）、`blob9` 厂商系统及版本（小写，v2 起）；`double1` 构建号、`double2` 系统 API、`double3`–`double8` 对话轮次、语音输入、手机操控、分享、生成、插件，`double9` 报告版本（1–3），`double10`–`double14` 酒馆消息、伙伴小屋、语音通话、输入 token、输出 token（v3 起，之前记 0） | IP、安装编号原文、对话、角色卡、文件、账号、模型名 |

**当天设备码**（下载和更新检查用来估「多少台设备」）：`HMAC(当天的盐, IP + "\n" + User-Agent)` 取 64 位。IPv6 按 /64（同 §5）。盐是 32 字节随机数，由 Durable Object `StatsSalt`（全站一个）在当天第一次用到时生成，存到当天结束，alarm 一到就删；Worker 在内存里记着当天的盐，日期变了就换。所以：
- 同一天内同一 IP + 同一浏览器 / App 是同一个码，可以去重；
- 第二天换盐，码对不上，**不能跨天追踪**；盐过了当天就从线上删掉，正常运行里谁也算不回去（Durable Object 的 SQLite 有约 30 天的时间点恢复，所以不承诺「历史上永远不可恢复」）；
- 存下来的只有码，没有 IP。
- **会低估**：同一个公网 IP 后面的设备（校园网、公司网、运营商 NAT）只要 UA 一样就算一台；App 的更新检查 UA 都是 `dsh-app-updater`，所以「近似日活」实际接近「当天有多少个出口 IP 在用」。反过来，同一台手机一天里换了网络（Wi-Fi ↔ 流量）会算两台。数字适合看趋势，不适合当真实装机量。
- 更新检查只来自带通道令牌的包（内测包、编进了令牌的公测包）；只查 GitHub 的包（0.9.1 及更早、开发包）不在里面。

**App 版本和 ABI**：App 的更新检查目前只发 `User-Agent: dsh-app-updater`，所以 `blob3` / `blob4` 是空的。以后的版本把 UA 写成 `dsh-app-updater/<版本>+<构建号> (<ABI>)`（例：`dsh-app-updater/0.9.9+11061200 (arm64-v8a)`）就会自动记上，服务端不用改。

**App 使用报告 v1**（`POST /api/usage/v1`，`Content-Type: application/json`，≤ 2 KB，不需要 CORS）：

```json
{"v":1,"iid":"<16 字节随机数的 base64url，22 位>","day":"YYYY-MM-DD","app":"0.9.9","build":10301000,"sdk":34,
 "abi":"arm64-v8a","maker":"vivo","lang":"zh","engine":"direct|proot|none",
 "counts":{"turns":0,"voice":0,"phone":0,"share":0,"gen":0,"plugins":0}}
```

| 字段 | 规则 |
|---|---|
| 全部 | 只能有这些字段，一个不能少，多了少了都是 `400 {"error":"unknown_field"\|"missing_field","field":…}` |
| `v` | 整数 `1` |
| `iid` | 22 位 base64url（末位只能是 `A Q g w`，即正好 128 位）；带 `==` 填充也收，按去掉填充处理 |
| `day` | 真实存在的日期，在 UTC+8 的「今天往前 7 天」到「明天」之间（时区比 UTC+8 早的手机） |
| `app` | `X.Y.Z` 或 `X.Y.Z-pre`，不带 `+构建号` |
| `build` | 整数 1–2,100,000,000 |
| `sdk` | 整数 26–60 |
| `abi` | `arm64-v8a`、`armeabi-v7a`、`x86_64`、`x86` |
| `maker` | 1–32 个 ASCII 字母、数字、空格、`. _ -`，存小写 |
| `lang` | `zh`、`en`、`zh-Hant` 这类 |
| `engine` | `direct`、`proot`、`none` |
| `counts` | 正好这六个键，非负整数，上限 `turns` 5000、`voice` 2000、`phone` 2000、`share` 1000、`gen` 1000、`plugins` 500 |

**v2**（1.0.15 起，同一个地址）：`"v":2`，在 v1 的字段之外正好再多两个，同样 1–32 个 ASCII 字母、数字、空格、`. _ -`，存小写：

| 字段 | 内容 |
|---|---|
| `model` | `Build.MODEL`，例：`v2405a`、`pjz110` |
| `rom` | 厂商系统和版本，按系统属性依次认 HarmonyOS、HyperOS、MIUI、OriginOS / Funtouch、realme UI、ColorOS（一加的 OxygenOS 也报这个属性）、MagicOS、EMUI、One UI；都不是写 `android` |

v1 照收，`blob8`、`blob9` 记空。App 先发 v2，答 `400` 就把同一天改发 v1，这次运行里后面都发 v1，所以 Worker 部署前后都不丢数。报表里机型和系统版本只列至少 20 个安装共用的值，其余算「其他」。

**v3**（1.0.17 起，同一个地址）：`"v":3`，字段和 v2 一样（`model`、`rom` 必填），`counts` 在 v1 的六个键之外正好再多五个，都是当天的非负整数：

| 键 | 口径 | 上限 |
|---|---|---|
| `tavern` | 在酒馆里发出的消息条数：打字发送、点快捷回复、群聊里点名各算一条。重新生成、续写、「帮我写」、`/sys` 和 `/send` 这类不调模型的命令不算；预览里的不算 | 5000 |
| `room` | 打开伙伴小屋的次数（每进一次页面算一次） | 1000 |
| `call` | 接通的语音通话次数：麦克风开始收音才算，没给权限、没接通的不算 | 500 |
| `tok_in` | 当天模型回复里报告的输入 token 合计，含缓存命中和缓存写入的部分 | 2,000,000,000 |
| `tok_out` | 当天模型回复里报告的输出 token 合计 | 200,000,000 |

- **`voice` 和 `call` 是两回事**：`voice`（v1 起）是语音输入，把说的话识别成文字填进输入框一次算一次；`call` 是语音通话（对话页的通话按钮），一通算一次，通话里说的每句话照旧算进 `turns`。
- **token 只用服务商自己报的数，不估算**：主对话取主机日志里每次模型调用（`assistant/message`）的 `usage`，只算 App 连着看到的新记录，重连时快照里的历史不再算，所以 App 没打开那段对话时跑完的调用会漏掉（偏低，不会重复）；酒馆取每条回复（含重新生成、续写、「帮我写」）的 `reportedUsage`，导演、脚本这类引擎内部的调用看不到；伙伴小屋轻量模式取 Anthropic 格式流里 `message_start`、`message_delta` 的 `usage`。没报用量的渠道和没跑完的回复都不计。只有数字，没有模型名。
- App 先发 v3，答 `400` 就把同一天改发 v2，再答 `400` 改发 v1；降下来的版本这次运行里一直用。Worker 部署前发出的 v3 因此会落成 v2，新加的五个数丢掉，旧字段不丢。

- 成功 `204`；格式不对 `400`；不是 JSON `415`；超过 2 KB `413`；同一客户端每分钟超过 20 次 `429`（`USAGE_LIMIT`，限速只在 Cloudflare 的分钟计数里用到 IP，不落盘）；没配 `USAGE_SECRET` 时 `404`。
- `iid` 只以 `HMAC(USAGE_SECRET, "iid\n" + iid)` 的前 128 位存下：能按天数不同的安装、算留存，反推不出 `iid`。`USAGE_SECRET` 换了，新旧哈希对不上，留存从换的那天断开。
- **同一安装同一天只算一次**：Worker 在内存里记着写过的（日期, 哈希），重复的不再写；跨 isolate 的重复由 `stats.sh` 按（日期, 安装）去重，功能计数取较大的一份。

**读数**：`CF_TOKEN_FILE=<token 文件> scripts/stats.sh [--days 14] [--dry-run]`。token 需要 Account → Account Analytics → Read。报表：

| 段 | 内容 |
|---|---|
| 下载 | 每天点击次数、人（当天设备码去重）、分线路、分版本；窗口内国家 / 地区占比 |
| 近似日活 | 每天带令牌检查更新的设备码数、检查次数、按设备的版本分布 |
| App 统计 | 每天日活（安装去重）和各功能日总量；7 日留存（D 天新出现、D+7 天仍上报；此前 21 天没出现过才算新，所以是粗略值）；版本、ABI、厂商、运行方式、语言、系统 API 分布；机型、厂商系统版本分布（v2 起，少于 20 个安装的值归入「其他」）；v3 起每天用过酒馆、伙伴小屋、语音通话的安装数和次数，token 输入 / 输出合计和人均（人均 = 合计 ÷ 当天有 token 记录的安装数） |

- 点击次数不等于下载完成次数：直链、断点续传、App 内更新都不经过按钮。HEAD、旧版本的按钮、刷量（同一客户端每分钟超过 120 次）不计，但照常跳转。
- AE 数据量大时会采样，计数用 `SUM(_sample_interval)` 还原；去重的设备数在采样时会偏低。AE 只保留约 3 个月，要长期留存就定期把 `stats.sh` 的输出存档。
- GitHub 这条线路另有 GitHub 自己的累计下载数：`scripts/github-downloads.sh`（`gh api`，每个 release 每个文件的 `download_count`；`update.json` 的数近似「经 GitHub 查更新的次数」）。

**页面上的说明**（下载页页脚，`src/download-page.ts`）：

> 隐私：我们只统计下载和更新检查的次数（含线路、版本、国家/地区），设备数用每天更换、无法还原的哈希估算。App 的匿名使用统计只含版本、系统及厂商系统版本、厂商和机型、语言、运行方式、各功能使用次数和模型回复报告的 token 数，以随机安装编号区分设备，可在 App 里关闭。不存 IP，不收集账号、对话和文件。

> Privacy: we count downloads and update checks (with route, version and country) and estimate device numbers with a one-way hash that changes daily. The app's anonymous usage stats hold only its version, Android version, maker, model, the maker's system version, language, engine mode, feature counts and the token counts model replies report, tell devices apart by a random install ID, and can be turned off in the app. These records hold no IP addresses, and we never collect accounts, chats or files.
