# 语音输入：本机语音模型

> 2026-10-28。调研基于 main `2e37d13`（§1 的行号指它），实现 rebase 到 main `722ae3f`（含生图 App 端和 S6 的语音「更换」）；本机构建的运行时 `r11-direct-r4-dsh0.2.1-rc.2`（`runtime/out/*`），以及 DSH 0.2.1-rc.2 安装包（`~/.dsh-runtime/npm/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`，只读）。
>
> 标记：**〔源码〕** 读过源码；**〔实测〕** 本机跑过；**〔推断〕** 没有实测。外部资料按附录 A 标 **V**（官方页面或源码已抓取）、**S**（只看到搜索摘要）、**U**（未核实），日期均为 2026-10-28。

**结论**：手机上的语音输入改用 DSH 自带的语音套件。它在引擎里用 sherpa-onnx 跑 SenseVoiceSmall INT8，模型约 241 MB，下载一次后离线可用。当前链路依赖 Android `SpeechRecognizer`，无 GMS 的国产 ROM 上不能用，再怎么调也解决不了（§1）。

套件已经打进我们的运行时，接口齐全，启用时热生效（§2）。真正的障碍有两个，这次一并解决：

- **原生界面没有下载入口**：这次补上了设置、首启自动下载、进度通知和失败重试（§4）。
- **官方的两个模型下载源在国内都不通**：hf-mirror.com 对这些文件一律 308 跳回 huggingface.co，本机实测下载失败。改为 App 先从 ModelScope 下载**字节一致**的文件，放进引擎的模型缓存。官方插件下载前会按大小和 SHA-256 检查缓存，命中就直接用。ModelScope 失败时再交回官方下载（§2.3）。

实测（x86_64 本机，2 线程）：

| 项目 | 结果 |
|---|---|
| 工作进程常驻内存 | 约 360–396 MB |
| 10 s 音频推理 | 0.26–0.49 s |
| 30 s 中英混说推理 | 0.72–1.2 s，带标点 |
| 冷加载 | 1–4.6 s |

手机上的数字是按公开 RTF 推算的，需要用 vivo 真机确认（§3、§6）。

**反对它最有力的理由**：要占 241 MB 存储和约 400 MB 内存，还要引擎在线。系统识别能用的手机（有 GMS）其实用不着它。所以「自动」模式只在模型就绪时才优先用模型，否则仍走系统识别（§4.3）。

## 目录

1. [现状为什么用不了](#1-现状为什么用不了)
2. [官方语音套件核实](#2-官方语音套件核实)
3. [实测：资源占用与发热](#3-实测资源占用与发热)
4. [实现](#4-实现)
5. [备选方案（简）](#5-备选方案简)
6. [需要 vivo 真机确认](#6-需要-vivo-真机确认)
7. [风险与后续](#7-风险与后续)
8. [需要 owner 定的事](#8-需要-owner-定的事)
- [附录 A：外部资料](#附录-a外部资料)

---

## 1. 现状为什么用不了

App 一直用的就是群友推荐的 `android.speech.SpeechRecognizer`（`VoicePlugin.kt:174`）。它只是一个客户端接口，背后要有一个系统里登记过、并且允许第三方调用的识别服务。

| 失败点 | 说明 | 依据 |
|---|---|---|
| 「可用」不等于能用 | `isRecognitionAvailable()` 只查有没有实现 `RecognitionService` 的服务，不管能否绑定、能否使用。华为的 `FakeRecognitionService`、vivo 的 Copilot 服务都会让它返回 true | AOSP `SpeechRecognizer.java`（附录 A1，V） |
| vivo 的服务不给第三方用 | OriginOS（Android 16）默认识别服务是 `com.vivo.ai.copilot/.framework.wakeup.CopilotRecognitionService`，平台签名，locales 为空，调用直接 `ERROR_CLIENT`。`settings put` 改默认服务会被静默忽略 | 附录 A3（V，单份用户报告） |
| 小米、华为 | 小米：`com.miui.voiceassist` 绑定失败，或小爱没权限时报错误码 9。华为：绑定 `FakeRecognitionService` 时抛 `SecurityException`。OPPO 新版 ColorOS：查不到 | 附录 A4–A6（V） |
| 没有默认服务 | Android 10/11 在应用进程里 bind，默认服务为空或 bind 失败都回 `ERROR_CLIENT`。12 起走 system_server，指定的组件解析不到时回的是 **10（`ERROR_TOO_MANY_REQUESTS`）**，这个码有误导性 | 附录 A1、A2（V） |
| 端上识别 | `createOnDeviceSpeechRecognizer` 和 `isOnDeviceRecognitionAvailable` 自 API 31 起才有，要 ROM 配了 `config_defaultOnDeviceSpeechRecognitionService`，国产机没有。我们 `targetSdk = 28`，包可见性（API 30+ 才需要 `<queries>`）不是问题 | 附录 A1（V）；`app/android/app/build.gradle.kts:44` |
| 自动换路几乎落空 | 自动模式下，先查到有识别服务就走系统识别。出错后改走引擎，但引擎转写要先在网页插件页启用语音套件、准备模型，App 里没有入口，所以换路后只能提示「去配置」 | `voice_controller.dart:132,222-223,322`（main `2e37d13`） |
| 记不住「不可靠」 | 不可靠标记要求 `Settings.Secure.voice_recognition_service` 有值。没有默认服务的 ROM 上它为 null，每次点都先撞一次系统识别 | `VoicePolicy.kt:17-24` |
| 服务侧权限错误不换路 | 错误码 9 被当成用户没给权限。但 App 在开始前已经确认拿到了麦克风权限，所以这里的 9 是服务自己的问题（小米的情况） | `voice_bridge.dart:70`、`VoicePolicy.kt:45`（main） |
| engine 模式的门槛 | `VoiceMode.engine` 走官方 `speech/catalog`、`speech/transcribe`（`speech_api.dart`），只在官方语音套件启用后才有，**和 `dsh-voice-scribe` 无关**。`dsh-voice-scribe` 是第三方插件，App 只给它做了设置页（`plugin_inventory_page.dart:384`），输入框的麦克风从不调用它。它是否把自己注册进官方 speech 服务，没有源码可查（U） | `speech_api.dart:107-135`；`voice_scribe_settings.dart:1-3` |

**SpeechRecognizer 仍值得保留的场景**：有 GMS 的手机（Google 服务能用），以及厂商服务碰巧对第三方开放的机型。保留它作为「系统」模式，和「自动」模式下模型没准备好时的选择。

## 2. 官方语音套件核实

### 2.1 包在不在运行时里

| 问题 | 结论 | 依据 |
|---|---|---|
| 依赖锁里有没有 | 有。`@deepseek-ai/dsh-experimental-voice-input-bundle` 带四个包：`speech-to-text`、`speech-to-text-sensevoice`（依赖 `sherpa-onnx-node` 1.13.8）、`api-speech-to-text`、`client-ui-voice-input` | `runtime/locks/dsh-0.2.1-rc.2/package-lock.json:540,2351,2433,9016-9042` |
| 构建时有没有被裁掉 | 没有。裁剪只去掉文档、`*.d.ts`、`*.map`、其他平台的预编译库和 musl 库（`rtbuild.py:718-745`）。arm64 构建报告里 sherpa 的 ELF 都在：`libonnxruntime.so` 34.6 MB、`libsherpa-onnx-c-api.so` 4.6 MB、`sherpa-onnx.node` 0.8 MB，64 KiB 对齐 | `runtime/out/arm64-v8a/build-report.json`〔实测〕 |
| 解开的 x86_64 rootfs | 五个语音包和 `sherpa-onnx-linux-x64` 都在 `/opt/dsh/node_modules` 下 | 〔实测〕 |
| 默认开没开 | 没开。插件管理里是可选 bundle（`optional: true`，`enabled: false`）。`pluginManager/setBundleEnabled` 打开后 `application: "applied"`，约 0.26 s 热生效，不用重启 | 〔实测〕 |
| proot 下能否加载 | arm64 上没有实测证据，参考项目也写着「还没在 proot arm64 上验证」 | 需要真机（§6） |
| 直接启动下能否加载 | x86_64 上 `sherpa-onnx.node` 加载成功（实测日志未入库）。直跑只放行打包时审计过的 `.node`（审计 D3），sherpa 在清单里。`DirectLaunch.kt:72` 已把 `sherpa-onnx-linux-$arch` 加进库路径。agents.md 里的「A5 R2 blocked (B3 native addon)」在 R3 已通过 | x86_64〔实测〕；arm64 需要真机 |
| rc4 有没有变化 | rc2→rc4 语音相关的包**没有源码变化**。rc4→alpha2 改了网页端的语音界面（`client-ui-voice-input` 的 6 个文件），`voice-input-bundle` 的清单也有变动，识别器本身没动 | `031-R2-ENGINE.../source-delta-inventory.json` |

### 2.2 接口

| 方法 | 用途 | 依据 |
|---|---|---|
| `speech/catalog`、`speech/follow`（流） | 列出识别器和准备状态：`unprepared` / `downloading`（含 `completedBytes`、`totalBytes`）/ `checking` / `loading` / `standby` / `ready` / `failed`（含 `download.reason`）/ `cancelled` | `dsh-experimental-speech-to-text/lib/types/types.d.ts` |
| `speech/prepare {providerId, options?}` | 启动或加入引擎侧的准备任务，立即返回。依次做检查、下载、校验、加载 | 同上；`api-speech-to-text/lib/index.js` |
| `speech/cancelPreparation`、`speech/configure {patch}` | 取消准备；设置默认识别器和语言 | 同上 |
| `speech/transcribe` | 整段 16 kHz WAV，返回最终文字（不流式） | `speech_api.dart` |
| 删除 | **没有接口**。App 的做法：先关掉 bundle 让引擎放手，再删除 rootfs 里的模型目录 | §4 |

### 2.3 模型下载：来源、体积、位置、校验

| 项目 | 结论 | 依据 |
|---|---|---|
| 文件 | `model.int8.onnx` 239,233,841 B；`tokens.txt` 315,894 B；`silero_vad.onnx` 1,807,522 B。合计 241,357,257 B（约 241 MB），修订和 SHA-256 都写死在锁文件里 | `sensevoice/runtime/assets.json` |
| 位置 | `$DSH_HOME/speech-to-text/sensevoice/models/{sensevoice-onnx,silero}/`。手机上对应 `filesDir/runtime/rootfs/root/.dsh/...` | `sensevoice/lib/index.js:209-216`；bundle `cordis.patch.yml` |
| 校验 | 先比大小，再对整个文件算 SHA-256。每次启用 bundle（也就是每次引擎启动）都会把 239 MB 全量哈希一遍（本机 0.2 s） | `index.js:186-199,337-338` |
| 断点 | 官方下载的临时文件名是 `.<uuid>.part`，失败后**整文件重下**。已经校验通过的文件会复用 | `index.js:258-316` |
| 超时 | 下载没有停滞检测，只有准备阶段的总时限 `prepareTimeoutMs`，默认 1 小时 | `index.js:902` |
| 默认来源 | `huggingface.co` 和 `hf-mirror.com`，并发 HEAD 后选先应答的那个。**本机（国内出口，上海移动）实测：hf-mirror 对这些文件全部 308 跳到 huggingface.co，最终落到 `us.aws.cdn.hf.co`，卡在 5.6 MB 几分钟后失败：`network (UND_ERR_SOCKET)`** | `index.js:893`；〔实测〕 |
| 国内镜像 | ModelScope 上 `pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue`（修订 `73eca476`）和 `pengzhendong/silero-vad` 的 `v4/`（修订 `370539c7`），三个文件大小和 SHA-256 与锁文件**完全一致**，支持 Range。本机 30.8 s 下完 239 MB | 附录 A8（V，API 核对哈希）；〔实测〕 |
| 官方插件能否换成 ModelScope | 不能直接换：`modelOrigins` 只接受 HF 兼容的源站（`^https?://host/?$`），ModelScope 的路径格式不同 | `index.js:893` |
| 和第三方插件的关系 | 见 §1 最后一行：engine 模式只走官方 speech 服务 | — |

**办法：App 先把文件放进引擎的缓存。** App 按锁文件从 ModelScope 下载，支持断点续传（`*.dsh-go.part` + Range），在后台 isolate 里边下边算 SHA-256，校验通过后改成最终文件名。然后打开 bundle 并调用 `speech/prepare`。插件发现文件已在、哈希一致，就跳过下载，直接校验和加载。

本机全链路实测：预置文件后 `speech/prepare`，约 0.9 s 走完 model 步骤（只算哈希），校验约 0.7 s，加载约 4.6 s，然后 `ready`。

镜像是按 SHA-256 对应的。锁里出现 App 不认识的哈希时，比如 rc4 以后换了模型，就不走镜像，交给官方下载。

## 3. 实测：资源占用与发热

本机测试：x86_64 rootfs（与 App 打包的同一份），bwrap 里运行 `dsh web`。机器是 Ryzen 7 7745HX，`threads = 2`。音频用 ModelScope 上 SenseVoice 自带的 `zh.wav` 和 `en.wav` 拼成 10 s、30 s 两段。

| 项目 | 实测（x86_64） | 手机估算〔推断〕 |
|---|---|---|
| 首次加载（`load` 步骤，冷页缓存） | 4.6 s | 5–15 s |
| 冷唤醒（standby → 首次转写，10 s 音频） | 总 1.31 s，工作进程 CPU 1.66 s | 3–8 s |
| 工作进程常驻内存（加载后） | 360 MB；转写 30 s 后 392–396 MB | 同量级（模型权重决定） |
| 10 s 音频 | 推理 0.26–0.49 s，CPU 0.58–0.96 s | RK3588 的 A76 单线程 RTF 0.099（附录 A9），双线程约 0.6–1.5 s |
| 30 s 中英混说 | 推理 0.72–1.2 s，CPU 1.6–2.4 s | 约 2–4 s |
| 每次引擎启动的校验 | 239 MB 的 SHA-256，0.2 s | 1 s 左右（有 ARMv8 加密指令时） |
| 识别效果 | 「开饭时间早上9点至下午5点。The tribal chieftain called for the boy and presented him with 50 pieces of gold.」，带标点。片段从中间截断的地方有错字 | — |

**发热和卡顿从哪来**：

- 只在推理时吃 CPU，每次几秒，跑在引擎进程里，不占 UI 线程。
- 空闲的工作进程不耗 CPU，但占着约 400 MB 内存。这会增加系统回收引擎进程的概率。

**手机上的配置**（通过覆盖层下发，不改官方包）：

| 项目 | 取值 | 理由 |
|---|---|---|
| `idleTimeoutMs` | 90 s（默认 300 s） | 冷唤醒在手机上估计 3–8 s。一段对话里的几次口述，间隔大多在 1–2 分钟以内，90 s 能覆盖，又能在 1.5 分钟后释放约 400 MB |
| `threads` | 2（不变） | 本机 RTF 0.03–0.05，没有数据说明需要改。多开线程只会更热 |

实现方式：`SpeechGuest.kt` 每次启动引擎时写 `/opt/dsh-app/speech.patch.yml`，用 `--patch` 传给 `dsh web`。这和消息搜索、登录桥接两个覆盖层的做法相同。

- **整块替换**：patch 会整块替换这一项的 `config`，所以要带上 bundle 原来的 `dataRoot`。
- **bundle 关着时**：这条 patch 匹配不到条目，只记一条告警后跳过（`cordis-plugin-include/lib/index.js:50`）。
- **本机实测**：工作进程拿到了 `"idleTimeoutMs":15000`，空闲后被回收；bundle 开关两次，引擎都正常。

## 4. 实现

### 4.1 流程

```
引导里选了语音（onboarding_wants_voice=true，大小已展示）  或  设置 › 语音输入 › 下载
        │（记下 voice_model_wanted=true，被杀后下次引擎就绪接着下）
        ▼
本机引擎就绪 → 读 rootfs 里的锁文件 → 查剩余空间（缺的字节 + 100 MB）
        ▼
ModelScope 下载到模型缓存（Range 续传、30 s 停滞超时、SHA-256、原子改名）── 失败 ─┐
        ▼                                                              │
setBundleEnabled(true) → speech/prepare → 每 0.7 s 读一次状态                 ←┘ 官方下载兜底（60 s 无进展即取消）
        ▼
ready → configure(providerId=sensevoice-local) → 「语音输入已就绪」
```

| 模块 | 文件 |
|---|---|
| 锁文件解析、镜像表、磁盘状态 | `app/lib/voice/voice_model_assets.dart` |
| 续传下载（后台 isolate） | `app/lib/voice/voice_model_download.dart` |
| 状态机（下载、取消、删除、续传、首启） | `app/lib/state/voice_model_state.dart` |
| 设置页的模型卡片 | `app/lib/ui/settings/voice_settings_page.dart` |
| 轻提示、通知文案、前后台切换 | `app/lib/ui/notify/voice_model_host.dart`（挂在 `home_shell.dart`） |
| speech 接口补全 | `packages/dsh_client/lib/src/speech_api.dart` |
| 通知进度行、覆盖层 | `DshService.kt`、`RuntimePlugin.kt`（`voiceModelLine`）、`SpeechGuest.kt`、`DshProcess.kt`、`RuntimeController.kt` |

### 4.2 交互

| 场景 | 行为 |
|---|---|
| 引导里选了语音 | 看作已同意下载（选的时候已经看到大小），不限 Wi-Fi。开始时轻提示「语音模型开始下载 · 约 241 MB」 |
| 下载中 | 语音设置页显示进度条、百分比和「108 MB / 241 MB」。引擎的常驻通知换成「正在下载语音模型 44%」，带进度条，App 在后台也看得到。通知行最多每 0.5 秒换一次（中间来的只留最新一条，到点再发），和上一条一样就不发：下载每 0.25 秒报一次进度，Android 一个 App 每秒超过 5 条就丢 |
| 完成 | 轻提示「语音输入已就绪」。App 在后台时，通知行显示同一句，回到前台后恢复原样 |
| 失败 | 底部提示「语音模型下载失败：网络连接失败」，带「重试」按钮，8 秒后自己消失。设置页一直显示原因和「重试」。失败后不会自己重试，不会循环 |
| 被杀或重启 | 下次引擎就绪时接着下，轻提示「继续下载语音模型 · 还剩约 X MB」。已完成的文件和 `.dsh-go.part` 都会保留 |
| 手动下载（设置页的下载、继续下载、重试、重新下载，以及失败提示的「重试」） | 在计费网络（移动数据，没有 Wi-Fi 或以太网）上先弹窗「用移动数据下载？语音模型约 X MB」，确认后才下。所有手动入口走同一个确认（`downloadVoiceModel`）。半途的下载显示「继续下载」，弹窗里是剩余大小 |
| 就绪后 | 「重新下载」和「删除」两个等宽按钮，放不下（窄屏、大字号）时上下排列、依旧等宽。删除前要确认，删除时先停下文件下载（等它报告已停，最多 10 秒；之前取消过、还没报告已停的旧下载一并等，新下载完成不代替旧的）、关 bundle，再删文件。10 秒内没报告已停就什么都不动、不删，提示「下载还在停止，请稍后再删」，等到超时不算已停。引擎没确认关掉 bundle（报错或不是 `applied`）也不删，提示「没能删除语音模型，请重试」 |
| 重新下载 | 新文件先下到 `speech-to-text/sensevoice/dsh-go-staging`（和模型同一个文件系统），每个文件按引擎锁文件核对大小和 SHA-256，全部到齐才逐个改名替换原文件；引擎不用关 bundle，语音输入全程可用。中途取消或失败，原模型原样保留，失败提示的「重试」再来一次重新下载。staging 里的临时副本也算「可能还在写」：要等所有下载（包括之前取消过、还没报告已停的）都报告已停才删；没停下就留着，这时删除照上一行不放行，再点重新下载也先等它们停（最多 10 秒，等不到就提示失败、什么都不动）。磁盘要放得下第二份。有文件没有镜像时只能由引擎下进自己的缓存，这时照旧先删后下 |
| 空间不足 | 下载前就拦下：「存储空间不足，还需要约 X MB」 |

文案没有「实验」字样。中英两套都在 `app/lib/l10n/parts/voice_{zh,en}.arb`。

### 4.3 识别方式与回退

| 模式 | 行为 |
|---|---|
| 自动（默认） | 当前主机是本机引擎、且模型显示「已就绪」时，**直接用模型**，不再先去撞系统识别。录音前还会再向引擎确认一次；引擎说没准备好，就照旧走系统服务。模型没就绪时，系统服务照常立刻启动，不等引擎的探测。系统服务出错后（包括服务自己报的 9）改用模型重录一次。两边都不能用时提示「系统识别用不了，可以在语音设置里下载语音模型」，附 S6 的「更换」按钮（打开语音设置，里面有识别方式和模型）。远程主机照旧：模型在手机的引擎里，对远程主机不算数（`chat_screen.dart` 的 `modelReady`） |
| 语音模型（原「引擎」） | 只用引擎的模型。没有模型时提示「请先在语音设置里下载语音模型」 |
| 系统 | 只用 `SpeechRecognizer`，保留给有 GMS 的手机 |

### 4.4 测试

| 测试文件 | 覆盖内容 |
|---|---|
| `test/voice/voice_model_download_test.dart` | 本地 HTTP 服务器上测：续传、无 Range 时重下、校验失败、换镜像、停滞超时、取消、isolate |
| `test/voice/voice_model_assets_test.dart` | rc2 锁文件、未知哈希、拒绝异常路径、磁盘状态 |
| `test/voice/voice_model_state_test.dart` | 首启下载、镜像失败转官方、空间不足、取消、删除、被杀续传、等引擎、已就绪、官方失败映射、官方停滞、无 bundle、改默认识别器、通知 |
| `test/settings/voice_model_card_test.dart` | 四种状态的明暗 golden 和英文 golden；320、390 dp 在 1×、2× 字号下量对称：左右内边距相等、按钮等宽、点按区 ≥ 48、进度条与按钮同宽；计费确认；删除确认 |
| `test/chat/voice_model_route_test.dart` | 自动模式优先用模型、服务侧报 9 也换路、提示带「更换」 |
| `SpeechGuestTest.kt` | 覆盖层的位置、内容、写入 |
| `references_api_test.dart` | 新增的 speech 字段和参数 |
| 调整的既有测试 | `composer_voice_test`：模型就绪时模型优先，没有模型时系统优先、且不探测引擎。`voice_continuation_test`：服务侧报 9 会换路，文案改了。`voice_fallback_test`：开始时模型未就绪，换路时已就绪 |

## 5. 备选方案（简）

| 方案 | 中文效果 | 流式 | 体积 | 许可 | 结论 |
|---|---|---|---|---|---|
| **DSH 套件：SenseVoice-Small INT8**（本方案） | AISHELL-1 CER 2.96，WenetSpeech net 7.84（附录 A10） | 否，整段识别 | 241 MB 下载；原生库已在运行时里 | 运行库 Apache-2.0 + MIT；权重 FunASR 协议，可商用，须署名（A11） | 采用 |
| App 内嵌 sherpa-onnx + 流式模型（如 X-ASR zh-en 134 MB、paraformer 双语 226 MB） | 有流式出字 | 是 | APK 多约 20 MB（arm64 原生库）+ 模型 | 同上 | 以后要边说边出字再考虑，要另做一套引擎外的推理（V2） |
| Vosk small-cn | SpeechIO-02 23.5（较差），无标点 | 是 | 42 MB | Apache-2.0 | 不采用 |
| whisper.cpp tiny/base | AISHELL 远差于 SenseVoice，繁简不定，静音处会编句子 | 否 | 32–60 MB | MIT | 不采用 |
| 云端：硅基流动 SenseVoiceSmall | 同模型 | 否 | — | 免费，OpenAI 兼容 | 可作「用户已配 Key」的选项（V2） |
| 云端：百炼 Paraformer、qwen3-asr-flash | — | 是 | — | ¥0.00022–0.00033/s，用 DashScope Key | 同上 |
| 云端：豆包流式 2.0 | — | 是 | — | ¥1/h | Key 要另外申请，**方舟 Key 用不了** |
| 云端：讯飞、腾讯 | — | 是 | — | 有免费额度 | Key 要另外申请 |

云端那几行的出处是附录 A12–A15。按 media-generation 的设计，Key 存在主机插件里，App 拿不到，所以云端识别只能做成主机侧的 speech provider。

## 6. 需要 vivo 真机确认

| # | 确认什么 | 怎么做 |
|---|---|---|
| 1 | 现状证据 | `adb shell settings get secure voice_recognition_service`；`adb shell pm query-services -a android.speech.RecognitionService`。对照 §1 的 vivo 报告 |
| 2 | proot 下 sherpa 能加载 | 设置 › 语音输入 › 下载，等到「已就绪」，然后在输入框说一句 |
| 3 | 直接启动下也能 | 开发者开关切到直接启动，重启引擎，重复 #2 |
| 4 | 国内网络下的下载 | 移动数据和 Wi-Fi 各走一遍。确认弹窗、进度、通知栏进度条，以及 ModelScope 的速度 |
| 5 | 内存和发热 | 加载后 `adb shell dumpsys meminfo` 看引擎进程树。连续口述 10 次，看机身温度，记 10 s / 30 s 的出字耗时和冷唤醒耗时 |
| 6 | 被杀续传 | 下载到一半时在多任务里划掉 App，重开后应接着下 |
| 7 | vivo 后台 | 后台下载期间会不会被「后台高耗电」限制断网（以前踩过） |
| 8 | 引导 | 引导里选语音以后，引擎就绪即开始下载 |

## 7. 风险与后续

- **第三方镜像**：ModelScope 上是个人账号（pengzhendong，k2/WeNet 的贡献者）的副本。有 SHA-256 兜着，内容不会错；但仓库可能被删或改。备选是我们自己托管（§8 D2）。
- **官方兜底在国内多半也不通**：失败的话 60 s 后放弃，给出原因和「重试」。
- **每次启动都哈希 239 MB**：这是官方插件的行为，App 改不了。可以向上游提建议：按大小和修改时间缓存校验结果。
- **删除没有官方接口**：App 是先关 bundle 再删目录。如果用户在网页插件页又打开 bundle，插件会显示「未准备」，这是正常的。
- **Gradle 的网络**：本机 Gradle 的 JVM 不读沙箱的 `HTTPS_PROXY`，直连 dl.google.com 会 TLS 握手失败，`--offline` 又缺 kotlin-stdlib 2.4.0。这轮的做法是把代理通过 `-Dhttps.proxyHost/Port` 传给 Gradle，Kotlin 单测 441/0 通过。
- **V2**：流式出字（App 内嵌 sherpa-onnx 流式模型，或主机侧的云端 provider），按住说话，以及 `dsh-voice-scribe` 接入官方 speech 服务。

## 8. 需要 owner 定的事

| # | 事项 | 推荐 | 反对的理由 |
|---|---|---|---|
| D1 | 下载源用 ModelScope 的个人副本，官方 HF 只做兜底 | 采用：国内实测 7–8 MB/s，哈希一致 | 依赖第三方账号长期在线 |
| D2 | 要不要自己托管一份（国内对象存储，HF 兼容路径） | 暂不：等 ModelScope 出问题再做。FunASR 协议允许再分发，要署名 | 要花钱，还要维护 |
| D3 | 「自动」在模型就绪时优先用模型（不再优先系统识别） | 采用 | 有 GMS 的手机上，Google 识别是流式、出字更快，模型就绪后反而用不上了。真在意的人可以选「系统」 |

## 附录 A：外部资料

- A1 AOSP `SpeechRecognizer.java`（android11/12/14-release）、`SpeechRecognitionManagerServiceImpl.java`（android14）；developer.android.com SpeechRecognizer 参考页与 package-visibility 页（V）。https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/core/java/android/speech/SpeechRecognizer.java ；https://developer.android.com/reference/android/speech/SpeechRecognizer
- A2 同上，`RecognitionService.java:182-201`（V）。
- A3 vivo OriginOS：https://github.com/OpenMinis/OpenMinis/issues/431（V，单份报告）。
- A4 华为：https://github.com/csdcorp/speech_to_text/issues/402 、#471、#652（V）。
- A5 小米：https://github.com/react-native-voice/voice/issues/236 ；https://github.com/jamsch/expo-speech-recognition/issues/138（V）。
- A6 国产机汇总（2019）：https://www.jianshu.com/p/a46c0bd8f961（V）。
- A7 hf-mirror 308 → huggingface.co：本机 `curl -I` 实测，不同 UA 结果相同（2026-10-28）。
- A8 ModelScope 文件列表 API（含 SHA-256）：https://www.modelscope.cn/api/v1/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/repo/files ；…/pengzhendong/silero-vad/repo/files（V）。
- A9 sherpa-onnx SenseVoice 预训练模型页（RK3588 RTF）：https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html（V）。
- A10 SenseVoice 论文：https://arxiv.org/html/2407.04051（V）。
- A11 FunASR MODEL_LICENSE：https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE ；SenseVoice README 里关于可商用的澄清：https://github.com/FunAudioLLM/SenseVoice（V）。
- A12 硅基流动：https://docs.siliconflow.cn/docs/api/audio-transcriptions-post ；https://siliconflow.cn/pricing（V）。
- A13 百炼：https://help.aliyun.com/zh/model-studio/real-time-speech-recognition ；…/qwen3-asr-flash ；…/obtain-temporary-authentication-token（V）。
- A14 豆包语音：https://docs.volcengine.com/docs/6561/1354869 ；…/1359370（V）。
- A15 讯飞：https://www.xfyun.cn/doc/asr/voicedictation/API.html ；腾讯：https://cloud.tencent.com/document/product/1093/35799（V）。
- 端上候选（Vosk、whisper.cpp、X-ASR、流式 paraformer）：https://alphacephei.com/vosk/models ；https://huggingface.co/ggerganov/whisper.cpp ；https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models（V）。
