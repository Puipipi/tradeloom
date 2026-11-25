# TradeLoom 基座更新（Android 首条路径）

复用上游现有的「设置 → 关于 → 检查更新」入口、`UpdateChecker`、`update.json`、版本化 APK 下载、SHA-256 校验及原生 `PackageInstaller`。只有构建时配置了有效清单入口，关于页才显示更新项；入口为空或无效时，清单源为空、自动与手动检查均不发起网络请求，关于页隐藏更新项。

唯一更新源通过编译期参数 `TRADELOOM_UPDATE_FEED=https://<发布主机>/<路径>/update.json` 固定。只接受无凭据、查询或片段的 HTTPS URL。清单、APK 和校验和下载均使用这个源；HTTP 传输逐跳限制重定向到同一 HTTPS 主机和端口。TradeLoom 不启用 GitHub API、GitHub 资产地址、DSH Go 镜像、公共加速站或用户可编辑的下载源。安装前仍由原生安装器核对目标包身份、签名和版本兼容性。

## 从基座候选到 APK 清单

在已提交织贸适配且工作区干净的 DSH Go checkout 根目录运行：

```sh
node tooling/tradeloom/sync-upstream.mjs --check --repo "<干净 Go checkout>"
node tooling/tradeloom/sync-upstream.mjs --candidate --repo "<干净 Go checkout>" --dest "<新候选目录>"
```

同步工具拒绝含未提交改动的源树；它只在新候选副本中 fetch 和合并固定上游 `main`。记录候选内 `refs/remotes/upstream/main` 的 SHA 作为 `sourceCommit`，不要用标签、本地候选提交或旧日志中的 SHA 替代。

在 D 盘的候选 checkout 根目录构建并签名 TradeLoom APK。构建必须使用已有的 TradeLoom 签名材料；没有同签名的既有安装包时，不能把这条路径视为可升级发布。以下构建命令不设置更新源：

```sh
tooling/build-apk.sh --tradeloom --no-companion --no-star --release -f all
```

`--product tradeloom` 使资产工具使用 TradeLoom 名称及标题；它仅接受 `--delta-from 0`，不读取 DSH Go 旧版资产，也不输出 DSH Go GitHub 发布命令。`release_assets.py` 会检查 APK 架构、JNI、版本和签名包体，但不会替你创建签名材料。传入品牌化 APK 路径，产生文件大小和 SHA-256，再加入候选上游 SHA：

```sh
python3 tooling/release_assets.py --product tradeloom --delta-from 0 --out dist/tradeloom \
  arm64=app/build/app/outputs/flutter-apk/tradeloom-app-arm64-release.apk
python3 tooling/tradeloom/stamp_update_manifest.py dist/tradeloom/update.json \
  --source-commit "<40 位 upstream main SHA>"
```

清单 stamping 工具要求 schema 1、`tradeloom-app-<版本>-<架构>.apk` 文件名、正数大小和 SHA-256，并拒绝 delta 补丁；它增加 `sourceCommit`，并把 APK 地址写成版本目录下的相对路径。当前客户端忽略 schema-1 中这个可选来源字段。发布者必须提供实际控制的 HTTPS 更新主机和真实清单/APK 源；不得使用示例域名或 DSH Go 发布源。正式发布前，用 `apksigner verify -v --print-certs` 检查证书 SHA-256 与已安装 TradeLoom APK 相同，并用 `aapt2 dump badging` 核对包名和版本。本候选验证不发布文件，也不配置真实 feed。

## 源测试与待原生验收项

合成源测试覆盖空/无效配置、唯一 HTTPS 主机、逐跳重定向策略、版本化架构路径、SHA-256 下载，以及错误包名和签名不匹配时的安装拒绝。原生 Android 验收仍需：安装同包名、同签名的 TradeLoom 包；在设备信任的本机 HTTPS 测试源上配置测试构建；检查新版本、核验下载摘要并确认系统安装界面；取消后重试并确认匹配签名的安装成功；再验证错误包名、错误签名、相同或更低版本、损坏清单和不可达主机都被拒绝，且不会回退到 DSH Go 或公共源。


## 正式 Android OTA 本地构建入口

在干净的隔离候选工作树中完成 arm64 和 x64 运行时准备，使用 WSL/Linux 检出 LF 版本的 shell 脚本。保留同步工具写入的 `refs/remotes/upstream/main`，并确保该提交已合入当前候选。使用已有正式 Android 签名配置，从已授权的既有安装包确认公开证书 SHA-256，以及该发布渠道允许升级的最高版本。正式 feed 来自已获授权的发布配置。

```sh
python3 tooling/tradeloom/release_android.py \
  --feed "$APPROVED_HTTPS_UPDATE_JSON" \
  --previous-version "$PUBLISHED_VERSION_NAME_AND_CODE" \
  --version "$NEXT_VERSION_NAME_AND_CODE" \
  --signer-sha256 "$PUBLISHED_CERTIFICATE_SHA256" \
  --out "$NEW_STAGE_DIRECTORY"
```

版本参数使用 `X.Y.Z+versionCode`，新构建号须严格大于发布基线且版本名不得回退。入口构建两个 ABI，构建前将已存在的原始和品牌双 ABI release APK 移入同目录的独立留存目录，在 Gradle 配置阶段要求完整的已有发布签名，在生成清单前逐个验签并校对包名、ABI、版本及公开证书指纹。清单的 `sourceCommit` 从候选已合入的上游引用读取。启用 Mesh 的候选沿用 `TRADELOOM_RUNTIME_MESH=1` 及对应运行时构建方式。

成功后新目录同时包含 `update.json`、按完整版本号存放的 APK 和 `SHA256SUMS`，以及记录 feed、证书指纹、版本基线和 Git 提交的 `release-provenance.json`。先把完整版本目录放到已授权 feed 的同一 HTTPS 路径下，再发布 `update.json`。失败不会产生可发布的输出目录，已存在的发布目录保持原样。发布由已有部署流程负责。

常规 QA、单 ABI 构建和历史手动清单工具继续使用原入口。离线回归可在带 Android SDK 和既有 QA 物料的干净候选上运行：

```sh
TRADELOOM_RELEASE_TEST_APKS=/path/to/qa-artifacts \
  python3 -B -m unittest discover -s tooling/tradeloom -p test_release_android.py -v
```

离线测试使用现有的 `11251201` 双 ABI 和 `11251200` x64 负例。用例中的 HTTPS 地址只用于验证相对路径解析，测试不连接该地址。
