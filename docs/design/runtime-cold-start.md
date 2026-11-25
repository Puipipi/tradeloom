# 本机引擎冷启动：测量、优化与架构选项

> 2026-10-27。问题：冷启动 DSH 为什么慢，能不能优化，对照 dsh-mobile 一类项目怎么做到不慢。
> 依据：模拟器（x86_64，Android 15，KVM，2 GB）上的分阶段实测，宿主机 strace / CPU profile，`kelai141/dsh-mobile-apk@64098a2`（MIT）等对照项目源码（只读）。原始数据与脚本没有入库。
> 本文是 2026-10-27 的测量快照，§5 的架构级改动在写作时只是方案。之后路线 A 以「直接启动」实现（`app/android/.../runtime/DirectLaunch.kt`），但默认关闭、需要用户手动打开：部分机型（Android 16、x86_64）上系统的 seccomp 过滤会杀掉 glibc 的加载器。本文的收益数字是当时的实测，不代表当前默认启动方式的表现。

## 0. 结论

| 问题 | 结论 |
|---|---|
| 慢在哪 | **DSH 自己的启动（Node 加载插件）在 proot 下被放大，占冷启动约三分之二。** 同一台模拟器、同一份 rootfs：proot 下 DSH 从进程起来到打印登录地址约 1.93 s，绕开 proot 直接跑同一个 Node 只要 1.07 s——proot 让这一段慢了 80%。原因不是 Node 本身，而是 DSH 启动时要做约 2.8 万次路径类系统调用（stat / open / readlink / access），每一次都要被 proot 拦下来翻译路径（§2） |
| 其余约四分之一 | App 侧的串行等待：Flutter 起来、读完设置、画出第一帧之后才去拉起引擎（约 0.5 s）；引擎就绪到 App 发出第一个请求又有约 0.25 s（Dart 侧，原因待查，§6） |
| 对照项目为什么快 | `kelai141/dsh-mobile-apk` 用 Termux 编译的 bionic Node 直接跑，**没有 proot**；另外它开机自启、常驻保活，用户打开 App 时引擎多半已经在跑。它自己的文档写着真机引擎冷启「10 s 量级」，所以「不慢」很大一部分是保活带来的观感（§4） |
| 这次做了什么 | 两项低风险优化，模拟器上「点图标 → 拿到对话列表」从 3.02 s 降到 2.46 s（-18%）：① 打开 App 时由原生层直接拉起引擎，与 Flutter 启动并行（App 侧 490 ms → 160 ms）；② `dsh web` 启动期路径缓存，DSH 启动的路径类系统调用减少约 40%，引擎段 warm -14%、cold -12%。运行时随之升到 r9（§3） |
| 试过但不采纳 | Node 编译缓存（`NODE_COMPILE_CACHE`）：模拟器上 proot 下慢 6%，不走 proot 也慢 4%；去掉 shim 的一次 exec：无差别；改 proot 参数：去掉 `-0` 能快 11%，但会破坏 apt / 文件属主，不能去（§3.4） |
| 要接近对照项目 | 只有架构级改动：DSH 主进程不再经过 proot。推荐先做「glibc 直跑」实验——Ubuntu rootfs 不变，DSH 主进程直接用 rootfs 里的 glibc 启动，工具命令仍进 proot。模拟器上 DSH 启动段比 r9 再省 35% 左右，网页模式加载、会话读写也一起变快；代价是路径映射、DNS、子进程三处要改，见 §5 |

## 1. 测量方法

一次冷启动拆成相邻的时间边界，各段相减：

| 段 | 起点 → 终点 | 数据来源 |
|---|---|---|
| 进程 | 发出启动 → App 进程 fork | `/proc/<pid>/stat` starttime（10 ms 精度） |
| App 侧 | App 进程 → proot 进程 fork | 同上 |
| exec 链 | proot → Node 进程开始 | Node `performance.timeOrigin` |
| DSH 启动 | Node 开始 → HTTP 端口监听 | 预加载探针（`--import`）挂在 `http.Server` 上 |
| 地址行 | 监听 → 打印 `dsh web: …?token=` | 同上，挂在 `process.stdout.write` |
| 就绪 → 登录 | 地址行 → App 的第一个请求（`GET /?token`） | 同上，记录每个请求到达时间 |
| 首个列表 | 登录 → `POST /api/session/list` 返回 | 同上 |

App 侧还用 inotify 给 `dsh.log` 的每次追加打时间戳，确认 Kotlin 从读到地址行到发出 RUNNING 只用约 10 ms。

两种冷：**warm**（页缓存在，最常见的「打开 App」）和 **cold**（`drop_caches` 后，接近开机后第一次）。每组 3–5 次取中位数。模拟器是 KVM 加速的 x86_64，单核速度接近桌面；真机 ARM 的绝对值会大得多，**比例**更有参考价值（§6）。

被测对象：模拟器上已装的 App（0.9.0，x86_64）+ 把 rootfs 换成 r8 的差异文件（DSH 0.2.1-rc.2、Node 24.22.1、dsh-go-bridge 0.4.0）。DSH 主目录几乎是空的（一个对话，没有第三方插件）。

## 2. 实测与大头

### 2.1 端到端（App 级，warm，同一次开机内轮流跑，中位数）

「提前启动」在测的时候用 `am start-foreground-service` 与 `am start` 同时发出来模拟（与 §3.1 的代码时序一致）；「路径缓存」用与 r9 相同的 shim 和 `boot-cache.mjs`。

| 段 | 现状 | 提前启动 | 提前启动 + 路径缓存 |
|---|---|---|---|
| 点图标 → App 进程 | 20 ms | 20 ms | 15 ms |
| App 进程 → proot 起来（Flutter 初始化、读设置、首帧、拉服务、准备 guest 文件） | **490 ms** | 160 ms | 180 ms |
| proot → Node 进程（env → sh → shim → node 的 exec 链） | 20 ms | 28 ms | 61 ms |
| Node 引导到 DSH 入口 | 70 ms | 54 ms | 52 ms |
| **DSH 加载插件 → HTTP 监听** | **2,017 ms** | 2,020 ms | 1,796 ms |
| 监听 → 打印地址行 | 88 ms | 85 ms | 88 ms |
| 地址行 → App 第一个请求（Kotlin 侧只占约 10 ms） | **265 ms** | 247 ms | 247 ms |
| 登录 → 第一次 `session/list` 返回 | 24 ms | 24 ms | 23 ms |
| **合计：点图标 → 对话列表** | **3,016 ms** | 2,638 ms | **2,462 ms** |

样本：现状 3 次（3,191 / 3,016 / 2,999），另一次开机 2 次（3,197 / 3,026）；提前启动 2 + 2 次；提前启动 + 路径缓存 2 次。模拟器在 App 渲染时会随机崩溃（gfxstream 的 GL 上下文问题，与本项目无关），所以 App 级样本偏少，引擎段另用 §2.2 的多样本数据。

### 2.2 只看引擎（proot 起 → 地址行，不开 App UI，中位数）

| 跑法 | warm | cold（drop_caches） | 次数 |
|---|---|---|---|
| 现状（r8 启动命令） | 1,925 ms | 2,270 ms | 6 / 4 |
| **+ 启动期路径缓存（r9）** | **1,662 ms（-14%）** | **2,000 ms（-12%）** | 6 / 4 |
| 不经 proot（同一个 Node、同一份 rootfs，用 rootfs 的 ld.so 直接起） | 1,072 ms（-44%） | 1,349 ms（-41%） | 5 / 4 |

warm 现状在另一次开机里是 1,987 ms（10 次），量级一致。

### 2.3 为什么是 proot × DSH 启动

宿主机（bwrap，不经 proot）上 strace 一次 `dsh web` 启动到地址行：

| 系统调用 | 次数 | 其中失败 |
|---|---|---|
| statx | 17,598 | 5,168（ENOENT） |
| openat | 4,211 | 466 |
| readlink | 3,601 | 3,587（EINVAL，不是链接） |
| access | 2,722 | 1,600 |
| 合计（路径类） | 约 28,100 | |

proot 在 seccomp 模式下只拦带路径的系统调用，但这些恰好是 DSH 启动的主体。按「不走 proot 1.07 s / 走 proot 1.93 s」折算，每次被拦的调用在模拟器上约 30 µs；ARM 手机上 ptrace 往返更贵。

调用从哪来（用户态 fs 调用按调用方归类，Node 内部的模块解析另计）：

| 调用方 | 调用 | 次数 |
|---|---|---|
| `@deepseek-ai/dsh-app-boot` `packageDirFromAnchor` | `existsSync`，逐级探 `node_modules/<pkg>/package.json` | 1,560 |
| 同上 `canonicalPath` / `wrappedFilename` | `realpathSync`（JS 实现，每次逐段 lstat，无缓存） | 1,651 |
| 同上 `realModuleDirectory` | `realpathSync.native`（glibc realpath，逐段 readlink） | 541 |
| 同上 `getDshRuntimeVersion` / `readPackageManifest` / `readManifest` | 同一批 package.json 反复读 | 1,074 |
| Node ESM / CJS 解析器 | stat 探测、realpath（有缓存） | 其余 |

也就是说，DSH 的插件加载器在启动时把只读的 `/opt/dsh` 包树反复规范化、反复探测，宿主机上全部文件系统调用加起来不到 0.3 s，在 proot 下被放大成秒级。

### 2.4 排除掉的方向

- **网络**：启动到地址行之间没有任何 `connect()`（宿主 strace），断网与联网启动时间相同。
- **exec 链**：proot → env → sh → shim → node 合计 15–25 ms。
- **seccomp 加速**：已生效（`PROOT_NO_SECCOMP=1` 反而慢 13%）。注意不能设 `PROOT_NO_SECCOMP=0`，变量存在就会关掉加速。

## 3. 这次做的优化

### 3.1 打开 App 即拉起引擎（Kotlin）

`MainActivity.onCreate` 开头调用 `runtime/LaunchStart.kt`：按 RootGate 的同一套条件（「打开 App 时自动启动」开着、运行环境已安装且空闲、失败卡片没有在等用户）直接 `RuntimeController.start(...)`，参数与 Dart 侧 `runtime_state.dart start()` 完全一致（不带 env，模式不变，phoneStorage / visualReplies 读同一份 shared_preferences）。每个进程只做一次。之后 RootGate 自己的 start() 发现引擎已在启动，什么也不改。

和原来的唯一行为差别：没填密钥、也没选「稍后设置」的人打开 App 时，引擎会在填密钥页面后台启动——这与首次安装后的流程（`_afterRuntime` 先起引擎再进密钥页）一致。

### 3.2 `dsh web` 启动期路径缓存（运行时 r9）

`runtime/boot/boot-cache.mjs`，装在 `/opt/dsh-go/boot-cache.mjs`，由 `/usr/local/bin/dsh` shim 只在 `dsh web` 时 `--import` 预加载（安全模式、`dsh plugin` 等命令不加载；`DSH_GO_BOOT_CACHE=0` 可关）。

- 只管三个只读目录：`/opt/dsh/`、`/opt/node/`、`/opt/dsh-go/`。DSH 运行期间没人写它们（运行时升级只在 DSH 停着时替换），App 写的 `/opt/dsh-app/` 不在内。Direct 启动时没有 proot 的路径映射，这三个目录取 Direct preload 给出的物理 rootfs 前缀。
- 只接管四个调用：`realpathSync`、`realpathSync.native`、`existsSync`，以及 utf8 读 `package.json`。路径按「每个路径分量 lstat 一次」缓存，缺失的目录也记住，所以同一个包树只摸一遍。
- 结果与 node:fs 逐项一致：符号链接（包括路径中间的目录链接，如 pnpm 的 `.pnpm` 链接）只在目标落在这三个目录内、且原 native 与 JS realpath 给出同一结果时才跟随，每个链接只核一次；其他形状（含 `.` / `..` 分量或相对路径、指向三个目录之外、悬空或循环链接、尾部斜杠、非字符串参数、非 utf8 编码）一律交回 node:fs。错误码与报错路径也按 node:fs 的规矩构造（JS realpath 报第一个缺失分量 / lstat，native 报原路径 / realpath）。
- DSH 打印地址行（或 120 s 兜底）时自动卸下，之后全部直通 node:fs；启动期间被别的模块拿走的函数引用同样直通。
- 预加载自身出错只会让 DSH 退回不缓存的启动，不会挡住启动。

单元测试 `runtime/tests/boot-cache.test.mjs`（14 项）逐形状对比 node:fs、检查缓存命中、卸载与只对 `web` 生效，以及 Direct 的物理前缀。

### 3.3 启动分段日志

`RuntimeController` 在引擎就绪时多写一行 `[dsh-app] startup: app … ms, prepare … ms, dsh … ms`（`runtime/StartupTimeline.kt`）：App 进程起来到发起启动、Kotlin 准备 guest 文件、proot 进程到监听。真机的诊断包里就能直接读出各段，不用再接线测量。

### 3.4 试过、没留下的

都在同一台模拟器上测，引擎段 warm 中位数，现状 1,987 ms：

| 尝试 | 结果 | 结论 |
|---|---|---|
| `NODE_COMPILE_CACHE`（Node 24 模块编译缓存，对照项目开着） | proot 下 2,109 ms（+6%）；不经 proot 1,113 vs 1,072 ms（+4%） | 不留。每个模块多一次缓存文件的打开和读取，在 proot 下要被拦；V8 本来就懒编译，省下的不够付这笔。ARM 真机上编译更慢，可能翻盘，列入 §6 |
| 启动命令直接 exec node，跳过 `/usr/local/bin/dsh` shim | 1,998 ms（±0） | 不留。exec 链总共 15–25 ms；而且 App 的 Kotlin 侧靠 `/usr/local/bin/dsh web` 这个字符串插入 --patch、切安全模式，改它牵动 5 个文件 |
| 关 seccomp（`PROOT_NO_SECCOMP=1`） | 2,236 ms（+13%） | 证明加速已经生效，保持现状 |
| 去掉 `-0`（假 root） | 1,765 ms（-11%） | 不能去：apt / dpkg / 属主都依赖它 |
| 去掉 `--link2symlink` | 1,956 ms（-1%） | 收益可忽略，pnpm / dpkg 的硬链接还要靠它 |
| 只按整条路径缓存（不按分量） | 1,859 ms（-6%） | 被现在按分量缓存的版本取代（-14%） |
| 模块解析结果缓存（`module.registerHooks` resolve 钩子） | 命中率 18%，系统调用只少约 700 次 | 不留：同一个包从不同目录引用时缓存键不同，收益小、钩子本身有开销 |


## 4. 对照项目对比

| 项目 | 本机引擎 | 启动链路 | 冷启动相关的做法 |
|---|---|---|---|
| **kelai141/dsh-mobile-apk**（MIT；运行时快照内各组件另有 GPL/LGPL/MPL/Apache 等许可） | 有 | Termux 快照（`usr/` + `home/`）解压到 `files/`，`ProcessBuilder(files/usr/bin/node --expose-internals …/dsh web)` 直接起 bionic Node；exec 被拒（Android 15+/16）时退到 `/system/bin/linker64 <node>`，子进程靠 `LD_PRELOAD` termux-exec 改道 linker64；targetSdk 34 | `NODE_COMPILE_CACHE` 放在 `home/.dsh/.node-compile-cache`；`UV_THREADPOOL_SIZE=min(8, cores)`；按内存给 `--max-old-space-size`；启动前置步骤逐项计时；开机自启（BootReceiver）+ 前台服务 + 看门狗常驻；对 DSH 打了一批启动期补丁（合并启动期重复 compose 等）。其贡献文档自述现场「引擎冷启 10 s 量级」（`docs/contrib/kelai141/2026-10-23-locale-follow-system-487.md`） |
| saya-ch/dsh-mobile（Apache-2.0） | 无 | 手机连电脑上的 DSH | 不涉及本地冷启动 |
| hongshuxifan321/dsh-mobile-app（MIT） | 无 | 远程客户端 | 同上 |

差别归结为两点：

1. **不经 proot。** 这是 DSH 启动段唯一的结构性差别，我们的实测把它量化成「同机 1.93 s → 1.07 s」。
2. **引擎常驻。** 他们开机即起、常驻保活，用户「打开 App」时大多数时候引擎已经在跑，看到的只是 WebView 加载。我们的引擎也用前台服务保活，但开机不自启。是否开机自启是产品取舍（耗电、厂商后台策略），不在本次范围，列在 §6。

编译缓存他们开着，但在我们的实测里没有收益（§3.4）。他们的 bionic 路线连带换掉了整个用户态（没有 Ubuntu / apt，工具来自 Termux 包），这是比「去掉 proot」大得多的产品变化。

## 5. 架构级方案（写作时的方案）

### 5.1 收益有多大（数据）

同一台模拟器、同一份 r8 rootfs、同一个 DSH 主目录，`dsh web` 从进程开始到地址行（warm，中位数）：

| 跑法 | 耗时 | 相对现状 |
|---|---|---|
| 现状：proot（seccomp 开） | 1.93 s | — |
| 现状 + 启动期路径缓存（r9） | 1.66 s | -14% |
| 不经 proot：rootfs 的 ld.so 直接起同一个 Node | 1.07 s | -44% |
| 宿主桌面 x86 不经 proot（参照） | 0.88 s | |

去掉 proot 之后 DSH 启动段剩下的就是 Node 自己的模块加载和插件组合，这一块对照项目同样要付。真机上 ptrace 往返比 KVM 模拟器贵，proot 占比只会更高，所以 -44% 是下限估计；但 ARM 上 Node 本身也慢，**绝对值必须真机量**。

不止启动：引擎运行期间的每一次文件访问也经 proot，网页模式下 DSH 给 WebView 发几百个前端文件、读写会话 jsonl、插件热加载都在其中。去掉 proot 对这些一并有效（未测，列入 §6）。

### 5.2 三条路线

| | A. glibc 直跑（推荐先做实验） | B. Termux bionic（对照项目路线） | C. 留在 proot，继续削调用 |
|---|---|---|---|
| 做法 | Ubuntu rootfs 不变。DSH 主进程不进 proot：安装时把 `/opt/node/bin/node` 的 ELF 解释器改成 rootfs 内 ld.so 的绝对路径（patchelf 一类，RPATH 指向 rootfs 的 lib），App 直接 exec。agent 的 bash / git / python / apt 仍在 proot 里跑 | 换掉整个用户态：Termux 编译的 node、bash、git、python；DSH 装在 Termux 前缀下 | 给上游 dsh-app-boot 提缓存 realpath / 包目录的 PR；本地缓存扩到插件目录（按 mtime 校验） |
| DSH 启动段 | 约 -44%（模拟器实测，真机预计更多） | 同量级（同样不经 ptrace） | 再省 10–20%（估） |
| 用户可见变化 | 无（agent 看到的路径、工具不变，前提是 5.3 的路径映射做好） | 大：不再是 Ubuntu，没有 apt；AGENTS.md、教学技能、用户习惯都要改 | 无 |
| 工作量 | 中：2–3 人周（含实验与回退） | 大：4–6 人周起，外加长期维护一套快照 | 小：几天 |
| 主要风险 | 路径映射、DNS、子进程（5.3） | 原生扩展（node-pty、koffi、sqlite）要 bionic 版；多许可证分发；Android 15+/16 的 exec 限制要靠 linker64 绕 | 收益天花板低；依赖上游接受 |

推荐顺序：C 的上游 PR 随时可做；A 做成可开关的实验运行时，真机量过再决定；B 不建议——它的收益 A 也能拿到，代价却是换掉整个产品承诺的环境。

### 5.3 路线 A 的风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| 路径两套 | DSH 在 proot 外，看到的是 `/data/user/0/<包名>/files/runtime/rootfs/root/...`；工具在 proot 里，看到 `/root/...`。会话 cwd、工作区路径、`@` 文件引用、工具输出里的路径都会对不上 | proot 里加同名绑定（`-b <rootfs>/root:<rootfs>/root`），让长路径在 guest 里也成立，DSH 一侧统一用长路径；或者给 DSH 的 subprocess 插件做双向路径改写。前者简单但 agent 会看到长路径，AGENTS.md 要改写；需要先做原型比较 |
| DNS | glibc 的 getaddrinfo 读 `/etc/resolv.conf`，Android 根目录没有这个文件，直跑时解析会失败 | 预加载里把 `dns.lookup` 换成 c-ares（`dns.Resolver`，服务器取 App 已写好的 rootfs `etc/resolv.conf`），HTTPS 证书用 Node 自带的 CA |
| 子进程 | DSH 自己会起：pnpm（插件安装）、node-pty 终端（`/bin/bash`）、ripgrep（文件搜索）、git（工作区变更）、`process.execPath` 子 node | node 改解释器后 `process.execPath` 照常可用；bash / git / python 一律经 proot 启动（给 DSH 一个 SHELL 包装脚本：`libproot.so … /bin/bash "$@"`）；ripgrep 这类 glibc 工具同样改解释器直跑 |
| exec 限制 | 直跑 rootfs 里的 ELF 依赖 targetSdk 28（`app_data_file` 可执行）；现在已是 28，proot 也靠它 | 保持 28。若将来必须升 targetSdk，A、B、proot 三条路都要改走 linker64 / jniLibs，届时一并处理 |
| 手机操控 relay | relay 与 App 通过 127.0.0.1 端口通信，和 proot 无关；PhoneGuest 写进 rootfs 的 overlay 文件按长路径引用即可 | 回归 PhoneGuest / relay 全套测试 |
| 插件兼容 | 插件装在 `~/.dsh/profiles/web/node_modules`（pnpm 布局，符号链接），在 proot 外按真实路径解析 | pnpm 的硬链接在 Android 应用目录里不可用，会退化成复制（proot 下现在靠 `--link2symlink`）；需验证 pnpm 的回退与磁盘占用 |
| 安全模式 / LKG / 崩溃分类 | 进程管理从「杀 proot」变成「杀 node」 | `DshProcess` 的 stop / killStrays 分两种进程；`CrashClassifier` 加 glibc 直跑的退出特征 |

### 5.4 迁移步骤（若推进 A）

1. **原型**（2–3 天）：r9 rootfs 不动，加一个开发者开关，让 `DshProcess` 用「改解释器的 node」直跑 `dsh web`，工具仍走 proot。在模拟器和真机上跑本文 §1 的同一套测量，外加网页模式首屏、发一轮带工具调用的对话。
2. **路径方案定稿**：同名绑定 vs 双向改写，比较 agent 体验与改动量。
3. **补齐**：DNS 预加载、SHELL 包装、pnpm 回退、进程管理、崩溃分类；全套运行时测试（`test-host.sh` 增加直跑一节）。
4. **灰度**：内测通道默认开，保留「用兼容方式启动」开关（回到 proot），一个版本周期无回归再转正。用户数据不迁移（DSH 主目录位置不变），回退只是换启动方式。

## 6. 需要真机验证

模拟器是 KVM 上的 x86_64，单核接近桌面，ptrace 往返也便宜；下面这些只能在 ARM 真机上定论。新包装上后，引擎每次就绪会在运行日志里写一行 `[dsh-app] startup: app … ms, prepare … ms, dsh … ms`（§3.3），诊断包里直接可读。

1. **端到端分段**：同一台手机，各 5 次：warm（划掉 App 再开）与 cold（重启手机后第一次打开）；对比 0.9.3（r8、无提前启动）与新包（r9 + 提前启动）。
2. **提前启动在厂商系统上的表现**：Activity 创建时 `startForegroundService` 在 vivo 等机型上有无拦截、通知是否正常、有无 ANR。
3. **地址行 → 第一个请求的约 250 ms**：Kotlin 侧只占 10 ms，其余在 Dart 侧（事件通道 → Riverpod 重建 → `DshClient.connect`），需要 profile 包加时间线定位。当前代码里引擎一变成 RUNNING，技能自动安装（`ui_skill.dart`，同步文件读写在 UI isolate 上）就会同时开工，是嫌疑之一；0.9.0 没有这段代码也有 250 ms，所以不是唯一原因。
4. **填了密钥的用户**：`connection_state.dart` 在发布连接前先 await `_pushKey`（一次 RPC，DSH 在 proot 里写凭据文件），对话列表要等它。模拟器上没填密钥，没量到。
5. **主目录变大以后**：模拟器的 DSH 主目录几乎是空的。装了第三方插件、几百个对话之后启动时间怎么涨；路径缓存目前只覆盖 `/opt` 下的只读树，插件目录（`~/.dsh/profiles/*/node_modules`，pnpm 布局）不在内。
6. **编译缓存**：模拟器上无收益，ARM 上编译更贵，值得在真机上补一次 A/B。
7. **路线 A 原型**：真机上 DSH 启动段与网页模式首屏能省多少，再决定是否推进。
8. **是否开机自启**：对照项目「不慢」的观感很大一部分来自开机自启 + 常驻。我们开机不自启；要不要加（耗电、厂商后台策略），是产品决定。
