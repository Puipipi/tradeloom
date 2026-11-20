# S7-01 冻结基线更新预检

2026-11-18 10:48:55 UTC，从冻结提交 0d4c15afe32d85364c2b323771cdbb31e5ac940b 运行现有 Windows x64 更新入口。Python 真实退出码为 1。入口请求成功、解析出官方 nightly 0.2.2-rc.3、落盘 feed 收据，随后在 scripts/update-dsh-candidate.py:74 的 resolve_release 拒绝未注册版本。冻结 manifest 配方仅有 rc.1、rc.2。

    ValueError: unsupported official version 0.2.2-rc.3; review upstream SDK/desktop/own-overlay differences before downloading assets

## 执行与写入

从新隔离根 [local-path-redacted] 取所有参数。命令参数里的 <scratch> 代表这个绝对路径。

    python -B scripts/update-dsh-candidate.py --cache-root <scratch>/cache --work-root <scratch>/work --output-root <scratch>/output --python-packages <scratch>/pinned-python-not-supplied --postgresql <scratch>/pinned-postgresql-not-supplied --plugin-seed <scratch>/pinned-plugin-seed-not-supplied --data-root <scratch>/isolated-data

临时根内保留 command.json、stdout.log（0 B）、stderr.log 及 work/feed.json、work/nightly.yml。参数使用独立占位路径以观察版本选择，未传同路径 apply 参数。版本拒绝发生在安装包下载、缓存创建及候选构建前。隔离 DATA、输出目录与缓存未生成；没有应用或安装器执行。

## 已核的官方来源

- GitHub 发布 443956880 是 immutable prerelease，标签 dsh-v0.2.2-rc.3 独立解析到 38a6a5c965aa99ab525161efb7cc5cf1fe62fced。发布 API 的 assets 字段为空。Windows 桌面二进制身份由现有入口读取的 DeepSeek 官方 Windows x64 nightly feed 提供。 [官方发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)
- 实际响应为 HTTP 200，533 B，SHA-256 404311d1fe360f9e06059fa28b0b7cb26ca9b7d8950608788fb476f6a6669e45。feed 的 path 与唯一 files 项一致，版本 0.2.2-rc.3、大小 299595752 B、releaseDate 2026-11-13T07:31:42.937Z，SHA-512（Base64）GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==。 [官方 Windows x64 nightly feed](https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml)
- 对 feed 原样提供的地址单独发 HEAD，服务器返回 HTTP 200、Content-Length 299595752、Content-Type application/vnd.microsoft.portable-executable。没有获取正文，SHA-512 和 Authenticode 仍待用实际文件实证。 [feed 指定的官方安装器](https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.3-win-x64.exe)

## 下一批所需输入

官方二进制下载地址已定位。仍需在新隔离路径获取并校验完整安装器、Authenticode、归档边界及内部程序树，再由真实 rc.3 官方 ASAR 提取 preimage。TradeLoom 自有覆盖须重放并读回生成 postimage，其中也包括已验收阶段 5 的最终 source06 覆盖。旧 rc.2 归档列表、摘要和 postimage 不能直接沿用。此次未改代码、manifest 或配方。

## 官方二进制与 preimage 实测

主控随后授权下载同源安装器到上述隔离目录的 official 子目录。用现有 open_official 和 verify_installer 完整读取，HTTP 200，实际 299595752 B，SHA-512 与 feed 一致，SHA-256 为 786c9b26050c35b62c7be6a01dee2541dc1c2c5d9bd5f2dbe77beeeb8d50704e。下载和摘要核验退出 0。

原有 powershell.exe -NoProfile -File scripts/verify-dsh-authenticode.ps1 退出 1，日志为 PSSecurityError / UnauthorizedAccess，提示脚本未经数字签名无法运行。只读 Get-ExecutionPolicy -List 显示 LocalMachine 为 RemoteSigned，其他作用域 Undefined。通过当前 PowerShell 的 Windows Get-AuthenticodeSignature 单独读回同一文件，状态 Valid，发布者与 rc.2 配方逐字一致，证书指纹 84032578657219876E273E0D1BD303CFE1B82E6F。策略未改，原脚本仍未执行成功。

沿现有归档校验函数和本机配方匹配的 7-Zip，依次检查外层列表、逐项路径／链接／加密边界、内层列表及实际提取目录的路径和大小。四项命令均退出 0。安装器和桌面程序均未启动。

| 实测项目 | rc.3 |
| --- | --- |
| 外层及内层列表 | 15 / 8785 项 |
| 内层 app-64.7z | 298410282 B，SHA-256 75eb5591c9e0574491119ff23a382ba7308fe8e9611b7967849233e9c753559d |
| 官方程序树 | 7880 文件，1129318464 B，SHA-256 c4f24cceea2e865a1b27a394086cae9aa5b3f72d76bb65e8ae699faaa817a7ff |
| DeepSeek Harness.exe | 246341104 B，SHA-256 93e0e6e31a2db74eb2e4905b3c79e339537f2c7cc9c9ff72eac2ff5d226f6780 |
| 官方 ASAR | 209021953 B，SHA-256 14cfd81c9135bf0afb89417543c94f9ecfe09266574452a9b106890c698725ae |
| ASAR 版本及逻辑项 | @deepseek-ai/dsh-desktop 0.2.2-rc.3，21717 项，其中 1666 项 unpacked |

与 rc.2 配方逐条对照，15 个 SDK preimage 有 13 项字节一致。settings-general 的 client.js 改动；旧前端 index-ghOpC9uV.js 缺席，rc.3 唯一对应入口为 index-Ciz7DZxv.js。五个桌面 preimage 中 package.json 和 lib/main.js 改动，另三个一致。完整数据在 official/archive-metrics.json 和 official/desktop-preimages.json，签名见 official/authenticode-independent.json，原入口失败见 official/installer-signature.*.log。

## 待审的最小改动

- 针对 rc.3 在 dsh-base.manifest.json 登记固定配方，把实测安装器、外内层、官方树和 ASAR 身份纳入版本记录。只对真实变化的 SDK、桌面入口及受影响 overlay 调整补丁，重放后读回 postimage；复核最终 stage5 source06 生效覆盖。当前只证官方 preimage。
- scripts/replay-dsh-candidate.py:14–15 固定 rc.2，scripts/build-dsh-candidate.py:173 发起 replay 时未传版本。传入已审 registry 的版本并保持既有 rc.2 调用兼容。
- scripts/update-dsh-candidate.py 原签名调用用 powershell.exe -File 加载未签脚本。可将该步骤改为正式调用受支持的系统 Authenticode 接口，保留 Windows 信任判断 Valid 和预期发布者逐字比较；文件路径经参数通道传递，签名检查前仍核固定版本与文件摘要。隔离测试覆盖官方已签样本、错误发布者、未签文件、签名调用失败、输出损坏及下载摘要错误。该方案不修改系统执行策略。源与配方尚未改动。

## rc.3 实施与首轮真实构建

rc.2 官方安装器按冻结 program-recipe 的 URL、完整长度、SHA-512 及 Windows Authenticode 校验，提取 app.asar 与旧配方 pin 一致。rc.3 官方签名包内 dshBuildCommit 为 6b729fedde0c8fd03af7afdf5a711aa64fe87c3b，dshBuildDirty=false；公开源码 tag 的提交另列为 38a6a5c965aa99ab525161efb7cc5cf1fe62fced。两种来源身份分记。

SDK 真实六张补丁依序 apply。rc.3 前端入口实际为 index-Ciz7DZxv.js，HTML 加载和 hook 均为唯一。settings-general preimage 按新版本核验，root 诊断补丁使用 LF 后实际命中。SDK dry-run 验 15 preimage/16 postimage。桌面两代官方原件与 S5 自有覆盖相交处，主进程仅合入一处 desktopClientVersion 变化；欢迎页脚本的 S5 字节等于 rc.2 官方，沿用 rc.3 官方。84 项桌面自有记录、77 项业务壳、168 项业务后端和正式 launcher 源按真实来源生成。正式 ZIP 的 Python 与 PostgreSQL 依赖树沿 builder 排序摘要验，与既有 pins 一致；seed 清单固定为正式 ZIP 内实际 SHA-256 ce6f03e89a87c60b79f611392e82822a8e7a57113559b359579233d90fd4703e。

升级器用 Windows 系统 Security 模块的 Get-AuthenticodeSignature 读取实际 Authenticode，LiteralPath 从独立环境参数取得。系统策略保持原样；摘要和版本门仍前置。实际 signed、错误发布者、无签名文件和坏 JSON 都已检查，rc.2 默认重放参数保留。新 rc.3 源配方显式选择 exact-source，要求完整包文件与字节钉；旧 patch 仍须存在并登记。

隔离 strict replay 的 ASAR 为 228830342 B，SHA-256 61b26ca87b28daec1b21f02c8c155e127818ea91353b5c771ae6a74823a71677，21788 项、1666 个 sidecar。首轮真实 update 退出 0，实际读官方 feed、复用同摘要安装器、重新验签及冷解包，再完整封包。程序 ZIP 为 819387730 B、SHA-256 815cf1065d831e62d4343c5ffb9ff819c0c8da691dacde5ee56abe14aea5518a，39822 文件、2286994738 B。收据在 [local-path-redacted] 记录补齐，首轮源和软件保留为实测过渡输出。

冻结 HEAD 原守卫与修订前的候选守卫逐字同报 10 条历史问题，校对证据 guard-baseline-comparison.json。最终 guard 区分历史 runtime 钉 0.2.1-rc.3 与当前壳的冻结 peer 0.2.2-rc.2，逐项登记六个 rc.2 文件并核 finalOverlay。该 overlay 在 verified rc.2 原件上复现 9 个 preimage/9 个 postimage。当前壳的 28 项导出目标按最终源码逐项匹配，新出现的撤回能力名、未登记 patch、混合模式和越界路径均由自动测试拒绝。旧 rc.2 整体重放已知两个 business preimage 偏差继续保留。

## 下一步真实同路径升级准备

目前标准端口仍有监听；现行 apply 对目标 launcher.json 固定要求 3088、3090、55432。等端口合法释放，另在 D 盘用唯一短 scratch 路径准备新 p/d，p 来自冻结 S5 正式 ZIP，d 为新外置空目录。仅该隔离副本配置选择 d，保留原 ZIP SHA，随后按现有 builder.inventory 和 writer.tree 生成实际 p 的逐文件清单及清单 SHA。w1/w2 与 p 同卷、在 p 和 d 外且初始不存在。首次升级、回退、再次升级之前各确认本次所属进程正常退出。回退把首轮候选保留为 w1/failed-app，所以磁盘预算包括旧程序和两份新程序约 6.86 GB，再加隔离 DATA 与清单。此轮未创建 QA p/d 或 w1/w2，未执行 apply 或 GUI。

    python -B scripts/apply-dsh-candidate.py apply --target <p> --work-root <w1> --candidate-root <候选program> --candidate-manifest <program-entry-manifest.json> --candidate-manifest-sha256 <候选清单SHA256> --target-manifest <p的初始清单> --target-manifest-sha256 <初始清单SHA256>
    python -B scripts/apply-dsh-candidate.py rollback --target <p> --work-root <w1>
    python -B scripts/apply-dsh-candidate.py apply --target <p> --work-root <w2> --candidate-root <候选program> --candidate-manifest <program-entry-manifest.json> --candidate-manifest-sha256 <候选清单SHA256> --target-manifest <w1/restored-entry-manifest.json> --target-manifest-sha256 <回退清单SHA256>

## 最终隔离源码与完整程序

最后一次真实 updater 退出 0。[local-path-redacted] 内有 update-work/update-receipt.json、output/build-receipt.json、freeze-readback.json、各 suite 日志和 strict-replay/RESULTS.json。该次复用已实证官方缓存，重新读取 nightly、验证原件哈希和 Authenticode，重验完整提取树，再重放和构建。首次正常入口的冷解包收据仍在 C 盘独立目录。

| 核对项 | 实际值 |
| --- | --- |
| 完整程序 ZIP | output/TradeLoom-0.2.2-rc.3.zip，819387962 B，SHA-256 844b25b4b4d4e2865601251c64691180b91991e9bd3d96853193839caf0dbbb5 |
| 消费源码 ZIP | output/current-source.zip，19639366 B，SHA-256 f69bdd729eabc8ff8975b560568a8c888e0de640b0b8b6390a1a2fc4dc68de48 |
| 候选逐文件清单 | output/program-entry-manifest.json，14670309 B，SHA-256 23f532f31d8702df99a5c8daa9c62002bd761e4479a5536fe36f56fd3c5b8378 |
| 完整程序树 | 39822 件，2286996438 B，SHA-256 246c5838dc8499ea48750173e12049012696dd5da7a223b0e0d1ecd7fff315b7 |
| 消费源码身份 | ownSourceHead=0d4c15afe32d85364c2b323771cdbb31e5ac940b，dirty=true，353 件，sourceFilesSha256 49740eb67be79d90eae24e5c8187b40b4accfbc65f32ab162670f5f6d1b37608 |
| 自动验证 | boundary 10、SDK 12、rc.3 acquisition 6、build 4、apply 10，均退出 0；另用真实 rc.2 cache 通过 acquisition 6 项 |
| 严格实际重放 | 真实 rc.3 ASAR，退出 0，21788 logical entries / 1666 sidecar，全部实际 payload 读回吻合 |

最终与首轮程序相同的路径集合。实物变化限 deployment.json、恢复源码 manifest、对应 runtime-inputs.json、显式外部 DATA launcher.json、重新编译的 wrapper，ASAR 与业务壳无字节变化。构建输出未创建 build-data，未进行 apply 或正式切换。

## 已预置的独立实机 QA 根

[local-path-redacted] 取自正式 Stage 5 ZIP 的唯一顶层归档目录内。原始提取全树与 PACKAGE-READY.json 一致（39836 文件、2286629962 B、e9e7be09eb92f3c4a7adf0e851efbd92fc38198b0565419ac89c33ecb190299a）。仅配置副本 p/launcher.json 的 dataDirectory 从 [local-path-redacted] 改为 [local-path-redacted] 初始为空，w1/w2 尚不存在。schemaVersion 2 与 3088/3090/55432 原样，实际配置 139 B / 67a8b6ab8f9e1fdac988f472e42361f0a85492c17549adae3ef189765537e310。原配置与预置收据都留在 QA 根。

从源码 checkout 执行离线复核与 apply 命令。GUI 部分仅由获授权 Terra 用文件资源管理器从 [local-path-redacted] 正常启动及 X 退出。首次启动先在旧包和空 d 做基准，核标准端口空闲，既有实例保留；启动后只验该 p 和 d 的归属。每次真实退出后再用 verify-qa-program.py 检查 p 的 app 文件、wrapper、launcher.json 与该代清单，并另外读回标准端口释放。apply 与 rollback 保持 launcher.json 原字节和 d 目录；工作台运行本身会正常写新的隔离 d。

    $q = '[local-path-redacted]
    $b = '[local-path-redacted]
    $candidateManifest = "$b/output/program-entry-manifest.json"
    $candidateSha = '23f532f31d8702df99a5c8daa9c62002bd761e4479a5536fe36f56fd3c5b8378'
    $baseManifest = "$q/target-entry-manifest.json"
    $baseSha = '5a814e0ed87f18d2ef9a4a248657036e6978c84d08a0050b6b4e77b081d3201f'

旧包首启及 X 退出后先复核，再执行首次升级。升级后先核 w1/installed-entry-manifest.json 并记录 SHA，再用同一入口完成对应回归与退出。回退后核 restored manifest，再次复核旧版可启动及退出，随后执行第二次升级。w2 安装清单也须核 SHA。变更 DATA 配置或替换目标后，之前的清单须重核。

    python -B "$b/verify-qa-program.py" "$q/p" $baseManifest $baseSha
    python -B scripts/apply-dsh-candidate.py apply --target "$q/p" --work-root "$q/w1" --candidate-root "$b/output/program" --candidate-manifest $candidateManifest --candidate-manifest-sha256 $candidateSha --target-manifest $baseManifest --target-manifest-sha256 $baseSha

    $installed1 = "$q/w1/installed-entry-manifest.json"
    $installedSha1 = (Get-FileHash -LiteralPath $installed1).Hash.ToLowerInvariant()
    python -B "$b/verify-qa-program.py" "$q/p" $installed1 $installedSha1
    python -B scripts/apply-dsh-candidate.py rollback --target "$q/p" --work-root "$q/w1"

    $restored = "$q/w1/restored-entry-manifest.json"
    $restoredSha = (Get-FileHash -LiteralPath $restored).Hash.ToLowerInvariant()
    python -B "$b/verify-qa-program.py" "$q/p" $restored $restoredSha
    python -B scripts/apply-dsh-candidate.py apply --target "$q/p" --work-root "$q/w2" --candidate-root "$b/output/program" --candidate-manifest $candidateManifest --candidate-manifest-sha256 $candidateSha --target-manifest $restored --target-manifest-sha256 $restoredSha

    $installed2 = "$q/w2/installed-entry-manifest.json"
    $installedSha2 = (Get-FileHash -LiteralPath $installed2).Hash.ToLowerInvariant()
    python -B "$b/verify-qa-program.py" "$q/p" $installed2 $installedSha2

预置时实机程序尚未运行，初次升级、回退、再升级、运行表现及官方 rc.3 与 S5 壳在 Host 内的实际兼容性均待实证。
