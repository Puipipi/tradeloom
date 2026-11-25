# 运行时分层资产：构建与验收

当前构建默认仍为单包 schema 1。`RUNTIME_LAYERS=1` 显式选择 schema 2，基础层与引擎层仍随 APK 携带；不新增联网下载。默认切换须等完整构建、安装及升级恢复验证后另作决定。

## 构建入口

在仓库根目录使用已有 Linux 构建环境：

```sh
# 旧入口：rootfs-<abi>.tar.xz
bash runtime/build-runtime.sh arm64-v8a

# 新入口：base-<abi>.tar.xz + engine-<abi>.tar.xz
RUNTIME_LAYERS=1 bash runtime/build-runtime.sh arm64-v8a

# 缓存可独立保留；RUNTIME_OUT 只改变产物目录，不改 App 取资产的位置。
RUNTIME_LAYERS=1 BASE_LAYER_CACHE=/path/to/base-cache \
  RUNTIME_OUT=/path/to/staging bash runtime/build-runtime.sh arm64-v8a
```

默认资产仍位于 `runtime/out/<abi>/assets/runtime/`，默认 base 缓存在 `runtime/.cache/base-layers/`。模式只接受 `0` 或 `1`；无效值在下载或组装之前失败。`COMPRESS=gz` 也可配合两种模式。`XZ_THREADS` 默认 4 不变，线程数和分层模式进入 runtimeVersion 的构建输入；实际复制进运行时的 `session-deletion` 源文件也进入该输入摘要。

`tooling/build-apk.sh` 打包已有的 runtime/out 资产，不代替上面的运行时构建。使用独立 RUNTIME_OUT 后，要由现有发布流程选择正确产物；不能以 staging 构建成功宣称 APK 已带上它。

## 身份与格式

基础层包含最终归一化文件树中非引擎条目；引擎层沿用 `rtbuild.py` 和 Android `EngineUpgrade` 的固定 15 个独占路径，包括 DSH、Node、桥、pnpm 和启动配置。共有父目录保留相同类型和权限。Python、用户 Linux 环境及原生 jniLibs 的归属不改变。

schema 1 的 rootfs 字段保持。schema 2 的 `layers.base`、`layers.engine` 分别记录 `asset/sha256/bytes/uncompressedBytes/tarBytes/tarSha256`，不伪造单包名称或单包 tar 摘要。顶层字节计数为两层合计，entries 是合并后的唯一条目数。总索引仍保留旧 ABI 的单包字段；含分层 ABI 时索引 schema 为 2，新条目保留两层及兼容元数据。

`baseId` 沿用现有算法，表达可升级基础环境的身份；归档 SHA 表达交付字节，二者用途不同。`baseCompatibility` 含基础发行版标识与 Python 可执行文件摘要，同时写入 manifest 和引擎内部 runtime.json。正常升级仍遵守现有 prepare/pending/version/done 事务及不兼容拒绝合同。

## 保留基础归档字节

缓存键覆盖 ABI、基础原包与有序 deb 摘要、最终基础树的内容/权限/链接/路径、epoch、tar 政策和压缩参数。引擎输入及主机压缩器版本不进入该键；主机版本仅记录来源。命中会校验真实压缩 SHA 和长度，并实际解压校验 tar SHA 和长度，随后复制原归档字节。损坏或不完整缓存重建。

每个 ABI 的 `build-report.json` 中，`baseCache.status` 为 `reused` 或 `rebuilt`；另有键、来源及重建原因。缓存采用现有单写者约定，不提供并发写者协调。同一内容的冷缓存重建仍可能因压缩工具版本改变而字节不同。保留并复用已验证的压缩归档，才是本波跨工具版本维持 base 字节的机制。

## 消费端

- `runtime/test-host.sh` 从 manifest 选择单包，或依次解 base、engine；未知 schema 在清理其测试 rootfs 前失败。它仍是需完整 Linux runtime 的 host smoke，不是 Android 验证。
- release CI 的检查（真实 APK 内 manifest 与一个或两个压缩归档 SHA 的比对）随 release 构建 job 一起加，本波不含。
- Android 新安装器首装读取两层；已有 rootfs 的升级只读取引擎层。旧安装器不支持新 manifest，所以不能给旧 App 单独替换 schema 2 资产。

## 验证与待测

`runtime/tests/test_runtime_consumers.py` 直接执行脚本中的消费代码，使用小型真实 gz 归档：覆盖归档顺序、host 初次及 direct 比较前的两次实际解包、旧/新索引、带空格的 shell 参数和非法模式。测试不能替代构建、签名或 R8 结果。现有 CI checks 的 unittest discover 会收集该文件。

在本机保留下面的结果，再决定默认切换：

1. 用完整输入构建一个 ABI，记录 build-report 的两层大小、压缩 SHA、tar SHA、baseId 和 baseCache。
2. 只改 bridge 输入，保留 base 缓存重建；应 reused，base 归档完整字节相同，engine 和 runtimeVersion 改变。若基础输入实际有变，不能套用此预期。
3. 记录新/旧 APK 及实际增量包大小、升级读取和解压字节数；不用小样本压缩率预测真实节省比例。
4. 用隔离安装测 schema 1 首装/升级、schema 2 首装/升级、旧环境兼容采纳、每个事务提交点中断及不兼容拒绝，确认用户 Linux 数据保留。
5. 完整 host smoke、Android/JVM、release APK 和设备验收通过前，保持 RUNTIME_LAYERS 默认 0。

源码依据：`runtime/build-runtime.sh`、`runtime/lib/rtbuild.py`、`runtime/test-host.sh`、`.github/workflows/ci.yml`、`app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/RuntimeInstaller.kt` 及同目录 `EngineUpgrade.kt`。本说明没有用轻量测试替代真实安装性能测量。
