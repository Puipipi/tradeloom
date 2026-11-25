# 工坊本地 HTTP 联调演练

这条命令在本机启动 HTTPS 的 GitHub API 替身、真实 Worker 本地实例和隔离存储，经过投稿、审核、公开 ZIP／预览 PNG 下载，再让真实 Dart client／repository 安装和卸载。它不部署，不接收远端目标或真实密钥参数。

## 运行

在仓库正常开发环境完成既有依赖准备后，从仓库根运行：

```sh
node services/share-worker/scripts/workshop-e2e.mjs
```

或在 `services/share-worker/` 运行 `node scripts/workshop-e2e.mjs`。需要锁文件对应的 Worker `node_modules`、支持 `module.registerHooks` 与 `stripTypeScriptTypes` 的 `transform` 模式的 Node（项目所用 Node 22.19 及以后、26 之前；Worker 源码用了构造函数参数属性，单纯去类型不够，Node 不支持时报 `node_type_transform_unavailable`）、PATH 中的 Flutter，以及 App 已完成的正常依赖准备。命令不安装工具或包。

入口先调用已有 `scripts/build-site.mjs`，所以正常构建使用的 `site/build/share/c.html` 等输入必须已准备好；缺少时按既有构建说明补齐。入口不另造替代页面。普通 `public/`、`src/generated/` 输出遵循原构建流程；演练结束只删除自己新建的临时配置、密钥与 R2／KV 目录。

Windows 从 PATH 查找 `flutter.bat`，只在这个固定命令使用 `cmd.exe /d /s /c` 和 verbatim 参数；Node／Wrangler 用普通参数数组。Flutter 路径含 `" % & | < > ^` 或换行时直接报错。依赖或 Flutter 缺失会失败，不偷偷改成部分通过。

仅临时检查 Node／Worker 段时可显式运行：

```sh
node services/share-worker/scripts/workshop-e2e.mjs --skip-dart
```

它最终为 **`PARTIAL`、退出码 2**。完整成功为 `PASS`、退出码 0；步骤或清理失败为 `FAIL`、退出码 1。只有指定 Dart 测试真正运行且通过、JSON reporter 报整次运行成功，才可能完整通过；进程退出 0 或测试被跳过不能代替这一条件。

Dart 阶段通过时另打印一行 `{"dartTest":{"name":"local Worker catalog installs and uninstalls through the real Dart stack","result":"success","skipped":false}}`；这行由目标 testDone 与整次 done 事件共同确认后输出。仅有阶段名、退出0或跳过不会产生这行成功证据。

## 顺序和断言

| 步骤 | 必须得到的结果 |
|---|---|
| 能力和 GitHub 替身 | 两开关均开；`account` 为 `{origin: "https://github.com", clientId: "Iv1.local_rehearsal"}`（合成 client id，只证明变量传到了 capabilities）；公开预览合同为 schema1／PNG／512每边／262144像素／2MiB，支持两种固定来源；真实 Worker 在 create、upload 时向替身请求 `/user` 核对身份。 |
| 首次投稿 | 现有 workshop-fixtures.ts 生成宠物 ZIP；v1声明 pet-idle，create是无图draft，上传后pending并登记图；身份与metadata相符。pending图片匿名GET／HEAD不可取，固定admin端点无key为401，有key得到登记SHA／大小的PNG。 |
| 审核和下载 | approved；目录kind／id／version／ZIP SHA／size正确；公开ZIP与原字节相同。公开预览GET与管理员看到的PNG逐字相同，摘要／长度／尺寸与登记描述一致，HEAD有相同长度且无正文。 |
| 新版本 | v2同样声明预览并成为唯一当前指向；v1的ZIP和PNG URL为404 workshop_not_found。另发布未声明预览的宠物和伙伴，验证旧包／无图条目并作开关对照。 |
| Dart | 同一Worker的真实HTTP、client、repository、包存储完成安装、列表核对、卸载；真实目录中的preview被解析，publicPreviewUri同步返回同来源、同版本／ZIP／图片摘要的地址。此方法不下载图片。 |
| 举报 | 管理列表能看到；handled记录理由和actor，目标仍current，公开ZIP与预览PNG都不变。处理举报不等于撤回。 |
| 撤回 | v2移出目录，withdrawn保留；v2和v1的ZIP URL及PNG GET／HEAD均为约定404，不回退旧版。 |
| 两开关 | 同一存储重启；上传关拒新投稿、对照资源仍可读；伙伴关过滤伙伴，专门目录／伙伴下载／新伙伴投稿为 503，宠物仍可读、可投。 |
| 恢复和 ETag | 重开恢复未撤回伙伴，撤回作品及两版PNG均不复活；开关变化使旧ETag请求得到200／新值，同状态同开关返回无正文304。 |
| 审核页 | 200、text/html；实际唯一内联脚本 SHA-256 与完整固定 CSP 逐字比对；无管理 key 的 admin 数据请求为 401。 |

宠物固定 id 为 `workshop-local-pet`，v2 为 `2.0.0`，minApp 显式 `1.0.0`，清单 id 同步。对照宠物为 `workshop-local-keep`。伙伴只用现有合成夹具，不运行模型、脚本或 GPU。小 ZIP 的真实 HTTP 字节校验不是设备渲染证据。

预览断言分布在这 11 个阶段里，不另外占用投稿意图或作者的 create 配额。只有主宠物 v1／v2 的 metadata 带 `previewSource: pet-idle`，ZIP仍是原manifest和引用sheet，没有新增图片成员；`keep`、`keepNext`及伙伴继续省略该字段，上传／审核／目录必须继续无图。两版原sheet像素相同，归档因动画时间不同而不同；这能同时验证共享图片摘要仍按版本／归档路径授权。

预览响应核对五字段规范路径、Content-Type、Content-Length、private/no-store、nosniff、实际字节SHA及PNG签名／IHDR尺寸。PNG完整CRC、压缩流及像素验证由真实Worker承担；本演练的HTTP断言不另写一套图片解码器。匿名图片请求不附 GitHub 令牌或管理凭据，且仍受本次回环来源门约束。不能用管理员端点成功代替公开授权断言。图片GET／HEAD不要求206或304。

## HTTPS 和本地隔离

生产 HTTPS 来源门保持不变。两端只监听 `127.0.0.1`。Worker 通过只供测试和演练的 `WORKSHOP_GITHUB_API_URL` 指向替身（仍只接受 HTTPS origin，所以替身同样用本次证书）；替身只接受 `GET /user` 和本次随机合成的 `gho_` 令牌，回答固定的 `{id: 7601, login: "local-rehearsal-user"}`。作者请求带 `Authorization: Bearer <令牌>` 和 `X-Workshop-Account-Origin: https://github.com`。临时 ADMIN_KEY 也随机生成，仅写本次临时 `.dev.vars`。二者不放命令行、URL 或成功摘要。

每次运行由 `workshop-e2e-tls.mjs` 用 Node 内置 crypto 现场生成 RSA-2048 密钥和自签名 X509 证书，SAN 仅含 `127.0.0.1`，有效期从生成前5分钟至生成后24小时。证书和私钥只写入本次 mkdtemp 目录（文件模式0600），随清理删除；仓库里没有私钥或证书文件，脚本也不依赖 OpenSSL 可执行文件或额外的 npm 包。生成器只接受测试时钟，不接受外部主机名；使用 [Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html) 的密钥生成和签名，以及 [RFC 5280](https://www.rfc-editor.org/rfc/rfc5280.html) 的有限 v3 证书编码。

Node 只给本次 Agent 加该 CA；Worker 子进程通过本次临时 `NODE_EXTRA_CA_CERTS` 文件使用它。锁定 Miniflare core 插件把该变量的证书加入 workerd 出站 TLS 配置。源码事实不代替实际握手：首次作者请求成功，才证明当前 Wrangler／workerd 真正信任了这次生成的 CA 并联系到 GitHub 替身。

临时配置保留真实 `src/index.ts`、兼容日期、必要 bindings 和静态页入口，不复制生产 account、routes、cron、Analytics Engine 目的地或外部下载来源。显式 `--local`、R2／KV 本地 binding，每次开关重启用本次同一 `--persist-to`。请求构造只允许本次数字回环 HTTPS origin，不接受任意来源，也不跟随重定向。

本地 rate-limit bindings 的 limit 为 1000，避免生产 5 次／分钟突发门遮住协议顺序；这是专用演练配置，不改生产值，也不验证生产限流性能。作者 create 小时配额保持原实现，正常演练恰好创建五条意图。

子进程移除继承的服务凭据、代理和 Node hooks，关闭 Wrangler banner 更新查询、遥测、磁盘日志及 Miniflare cf 元数据获取。不得加 `rejectUnauthorized:false`、全局证书放行或真实 token/key 来让演练通过。

## Dart 段接口

入口在 v2 批准后、撤回和开关重启前运行 `app/test/workshop/workshop_local_e2e_test.dart`，传入：

| 环境变量 | 本次值／作用 |
|---|---|
| DSH_WORKSHOP_E2E_ORIGIN | 本次 Worker 数字回环 HTTPS origin；未设置时默认 skip。 |
| DSH_WORKSHOP_E2E_CA_FILE | 本次临时生成的 CA 文件，仅测试自己的 HttpClient 信任。 |
| DSH_WORKSHOP_E2E_ITEM_ID | workshop-local-pet。 |
| DSH_WORKSHOP_E2E_ITEM_VERSION | 2.0.0。 |

固定测试名为 `local Worker catalog installs and uninstalls through the real Dart stack`。Flutter 使用 `--no-pub` 和 JSON reporter；默认 CI 未设环境仍跳过，不改 workflow。Dart 选 appVersion `1.0.0`，用真实安装／卸载事务和独立临时目录；同一测试在安装前核对公开预览描述与纯地址方法，PNG网络字节核验由Node阶段完成。桌面 freeBytes 未知，不据此声称 Android 空间平台通道、页面或真机已验证。

## 失败和收尾

失败摘要包含阶段、method／相对 path、已收到的 status／字节数／Content-Type 和白名单形式的稳定错误码，不输出任意响应正文。连接、TLS、超时失败也先记录本次 method／path。子进程输出先拼完整行再替换本次 key，超长行整体省略，避免跨 chunk 泄漏；不转储 headers、环境或私钥。

`finally` 关闭 GitHub 替身、本次子进程并删除临时存储。POSIX 使用独立进程组，先 INT、必要时 KILL，有界等组消失；Windows 对本次活着的子进程有界执行 `taskkill /t /f`，再等退出。每个 handle 的停止只执行一次。Wrangler 包装进程若在主动停止前意外退出，不能据此确认 workerd 退出，结果保留清理失败，不把包装进程结束算整个服务树已关闭，也不向已释放 PID 盲目发信号。

删除在上述停止/close 等待之后执行。Windows 刚关闭的 SQLite 文件仍可能短暂被占用；仅对 EBUSY、EMFILE、ENFILE、ENOTEMPTY、EPERM 最多尝试6次，间隔200、400、600、800、1000毫秒，其他错误直接失败。成功摘要的 `tempRemovalAttempts` 给出实际删除尝试次数；用尽后仍报 `temporary_storage_cleanup_failed` 和整体 FAIL，不忽略残留目录。

强制结束 Node、断电或外部工具遗留进程不在 finally 能保证的范围；清理失败时按摘要查本次实例，不批量清理其他进程或目录。
