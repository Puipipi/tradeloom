# 特权通道保持：设置、恢复与接入约定

W12-P1，基于公开归档 ca3c420。此项为 root、Sui、Shizuku、自连 ADB 增加显式持久化选择；虚拟屏仍要求 Android 14/API34 以上。原通道协议和设备矩阵见 [特权通道](privileged-paths.md)。所有真机项均待本机验证，不从 JVM 或源码测试推导设备成功。

## 1. 一项用户选择，几项独立事实

默认保持关闭。仅用户明确打开当前通道的保持开关后，App 才保存 keptMode。没有旧 mode/rootSelected/WSS 状态迁移；从 Sui、Shizuku 或 ADB 切到 root 不继承保持授权。保存成功只表示设置已经提交，不表示授权、传输或显示能力已经就绪。

| 操作 | 保存与失效规则 |
| --- | --- |
| 开启当前通道保持 | 先保存显式选择，成功后触发一次恢复；root 仍经管理器处理授权 |
| 关闭保持 | 先撤销旧恢复意图，再保存关闭；健康连接继续由当前选择使用 |
| 切换通道、选择 off、关闭手机操控 | 先撤销旧保持意图；保存关闭与原有任务/通道释放各按对应队列完成，保存成功才确认持久关闭；新通道保持默认关 |
| 新进程启动 | 仅有效保持、手机操控开启且达到版本门槛时恢复内存选择；初始化本身不做 IO |
| 保存失败 | 返回失败并显示 persistenceFailed；当前进程停止该恢复意图，不能声称磁盘已保存关闭 |

运行中的 root manager 请求无法撤回；关闭后不接受迟到连接发布。已经完成的权限授予也无法由取消按钮回滚。自动恢复只重建传输，不重放手机操控任务或自动授予 WSS。

## 2. 原生与 Dart 契约

方法 dsh/phone.setBackgroundKeep 的两个参数：

    {"mode": "root", "enabled": true}

mode 只允许 root、sui、shizuku、adb，且必须与当前实际选择一致。过期页面请求返回 ok=false、reasonCode=selectionChanged 及本地化 reason，不能隐式切换通道。ok=true 只表示设置保存成功。页面随后以最新状态为准，不先乐观显示已开启或已连接。

在既有 background.privileged（v=1）下增加可缺省 keep：

    {"enabled": false, "mode": "off", "phase": "disabled", "reasonCode": null}

| 字段 | 范围 | 含义 |
| --- | --- | --- |
| enabled | boolean | 当前可执行的显式保持意图 |
| mode | off/root/sui/shizuku/adb | 当前保持目标；不是推荐，保存成功另以动作结果确认 |
| phase | disabled/idle/restoring/connected/waiting/failed | 关闭、等待触发、恢复中、传输已连接、等待前提、失败 |
| reasonCode | 固定字符串或 null | 可观察失败原因；未知原因不能猜作用户拒绝 |

旧 v1 状态缺 keep 时 Dart 取 disabled/off；未知 phase 取 waiting。原有 mode/ready/reason/root/shizuku/adb 投影保持原语义。keep.connected 仅表示身份和传输通过，不升级 effectiveReady，也不证明虚拟屏或输入已实测。未获得 gate 结果时原有 ready 算法保持原状，页面不能将其翻译为「所有能力已验证」。

| 原因组 | 固定码 | 页面处理 |
| --- | --- | --- |
| 设置/选择 | persistenceFailed、selectionChanged | 保留真实当前状态，提示重试或刷新 |
| 前提 | phoneDisabled、unsupportedAndroid、serviceUnavailable、providerChanged、permissionRequired | 解释缺少的前提；不自动授权或换身份 |
| ADB | notPaired、wirelessDebuggingOff、networkUnavailable | 引导现有配对、系统无线调试或 Wi-Fi 操作 |
| 恢复 | connectFailed、restoreBusy | 显示未连接；未知网络信任或超时原因不得自行推断 |
| root | rootTimeout、rootCancelled、rootIdentityMismatch、rootDisconnected、rootStartFailed | 使用已有固定原因，不显示 su 完整输出 |

Dart 入口为 PhoneController.setBackgroundKeep；页面读取 status.background.keep。已有 supportedModes 门禁沿用，不增加同 APK 的额外能力协商。

## 3. 恢复触发与并发

App 插件 attach、Activity 返回前台、新手机操控任务开始前，以及所选通道相关的 Binder/网络等可用性事件触发合并恢复。其他通道的变化仍通知页面，不触发当前通道恢复；注销后的旧 ADB 网络回调不唤起后来选择的 root。没有新增周期轮询或两秒恢复定时器。缓存 Flutter engine 不会在每次前台都重新 attach，因此前台有独立入口。

明确缺服务、权限、配对或 Wi-Fi 时为 waiting，不加连接失败退避。真正连接异常为 failed；仅在下一实际事件到来且距失败至少 5 秒时重查，不安排定时唤醒。间隔内被抑制的事件不承诺在第 5 秒自动补发，后续前台、新任务或有效事件可继续检查。

一次实际恢复占用单一工作槽，其他事件共用该结果；关闭后重开产生新代际，旧结果不能覆盖或吞掉新选择。控制设置、取消与读取状态不排在阻塞的 root/ADB IO 队列后。keeper 的短锁只管状态，探活、关闭连接和持久化 IO 不在其中。

root 在最终 guard 校验 mayStart 后发布 ready，这才是连接成功的线性化点。关闭保持只取消仍不再需要的 pending；已发布且健康的连接不被误关。清理使用实际捕获的 channel 身份，旧失败不关闭新连接。Shizuku 同标签解绑及 ADB manager 的旧操作真正收敛前不开放新启动槽，不能仅凭 Future.cancel 推断底层 IO 已停止。只有恢复实际被旧 busy 槽拒绝时才登记一次可用通知；旧操作成功发布可复用连接或清理结束后，在锁外交付该通知。自己的连接失败不登记这类通知，不借清理完成绕过退避自我重试。

旧 Flutter detach 只使旧 UI 意图失效，保留健康手动 root 连接及仍有效的保持恢复；这不授予没有保持设置的自动 su 权限。手机操控任务仍受原有任务代际、取消与时间预算约束，不恢复已结束任务。原 root 30 秒、Shizuku bind 等待 15 秒以及 libadb 配置的 8 秒范围各不相同；不能把后者写作覆盖 OPEN/PROBE 的总截止。

## 4. 各通道恢复

| 通道 | 自动恢复前提与动作 | 不作出的推断 |
| --- | --- | --- |
| root | 明确保持 root；固定 su/app_process 参数；OP_PROBE 核对 uid=0 和 revision | 管理器是否弹窗、是否允许由管理器决定；不自动 gate 或 grant |
| Sui | 当前实际来源为 Sui、有效 Binder、已有授权后重绑 UserService | Sui.isSui 只是初始化来源，不证明 Binder 活着；不能保证同进程任意 Sui 热重启会重新交付 Binder |
| Shizuku | 当前来源匹配、服务可用、已有授权后重绑 | 不自动 requestPermission；API 的权限缓存不证明实时撤权通知一定到达 |
| ADB | 复用原配对身份、发现、TLS、固定 app_process 与 PROBE 流程 | 本地 paired 标志、系统设置值、端口出现均不证明真实连接成功 |

自动恢复不会调用 OP_GATE、创建虚拟屏、执行点按或 releaseAll。实际用户验证及原有任务流程仍可按其用途执行显示与输入操作。

## 5. 开机与系统限制

BOOT_COMPLETED 与自身安装包更新只排一个 Job，不启动 Activity、Flutter engine 或前台常驻服务。使用原有凭据加密存储，不添加 LOCKED_BOOT_COMPLETED。开机路径直接取得 BackgroundControl，并调用一次 A11yKeeper.check；不为此构造会启动两秒 tick 的 PhoneControl。

ADB 的 Job 只要求 Wi-Fi transport；root/Sui/Shizuku 不要求网络。没有额外 INTERNET/VALIDATED 要求，也不以截止时间绕过网络约束。Job 的 NetworkRequest 是调度前提，不意味着 libadb 的 socket 已绑定到 JobParameters.network；VPN、多网络下的真实路由仍需设备测量。

Job 只是保持恢复的观察者。onStopJob 不取消可能已被前台或任务共用的恢复，也不重排（返回 false）。停止以后 Android 不再保证该进程或唤醒状态存续；后续完成不是承诺。停止后的旧线程迟到调用 jobFinished 会被系统当作过期回调忽略。关闭保持/通道和手机操控仍由代际使恢复失效。

强行停止 App、设备未解锁、系统/厂商后台限制、管理器尚未启动都可能阻止恢复。以下官方文档解释调度边界：[广播例外](https://developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions)、[JobScheduler](https://developer.android.com/reference/android/app/job/JobScheduler)、[Android 15 已停止状态](https://developer.android.com/about/versions/15/behavior-changes-all#stopped-state)。

## 6. WSS 与无线调试：Android 11–17

用户明确开启保持 ADB、本地已有配对身份、开发者总开关开启、观察到 Wi-Fi 且实际已授 WRITE_SECURE_SETTINGS 时，允许尝试写固定 Global 键 adb_wifi_enabled=1。每次显式保持选择/进程恢复最多消耗一次写入机会；等 Wi-Fi 时不消耗，也不因前台、网络重复回调或任务开始重新补额。系统回写 0 时不循环强写。没有 WSS 时仍可尝试连接已经开启的无线调试，不自动 su 授予。

下面绑定各版首发 AOSP 标签。11–13 的机制核查不降低本 App 后台屏 API34 门槛；后续 QPR 与 OEM 未由此证明。WSS 不是 MANAGE_DEBUGGING，不能代用户确认可信网络、创建配对或读取系统配对名单/端口。17 的 reconnect flag 与 Wi-Fi 2.0 也不证明当前 libadb 3.1.1 的真机兼容性。

| Android / API | 核验标签与 commit | WSS和观察链 | 网络与启用结果 |
|---|---|---|---|
| 11 / 30 | `android-11.0.0_r1`；`34a1b9c951c38537ab96b69bc308f6e0884823f5` | [Global写权限 L1283](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-11.0.0_r1/packages/SettingsProvider/src/com/android/providers/settings/SettingsProvider.java#1283)；[observer L196](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-11.0.0_r1/services/core/java/com/android/server/adb/AdbService.java#196) | [启用分支 L988](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-11.0.0_r1/services/core/java/com/android/server/adb/AdbDebuggingManager.java#988)；缺当前Wi-Fi或未信任则回写0；可信网络后才开启TLS。 |
| 12 / 31 | `android-12.0.0_r1`；`cebf5c06997b64f4e47a1611edb5f97044509d76` | [Global写权限 L1428](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-12.0.0_r1/packages/SettingsProvider/src/com/android/providers/settings/SettingsProvider.java#1428)；[observer L196](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-12.0.0_r1/services/core/java/com/android/server/adb/AdbService.java#196) | [启用分支 L987](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-12.0.0_r1/services/core/java/com/android/server/adb/AdbDebuggingManager.java#987)；缺当前Wi-Fi或未信任则回写0；可信网络后才开启TLS。 |
| 13 / 33 | `android-13.0.0_r1`；`0d3ff311e6e80dee7fe88a2a2cfa272ce231c3c6` | [Global写权限 L1452](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r1/packages/SettingsProvider/src/com/android/providers/settings/SettingsProvider.java#1452)；[observer L199](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r1/services/core/java/com/android/server/adb/AdbService.java#199) | [启用分支 L1025](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-13.0.0_r1/services/core/java/com/android/server/adb/AdbDebuggingManager.java#1025)；缺当前Wi-Fi或未信任则回写0；可信网络后才开启TLS。 |
| 14 / 34 | `android-14.0.0_r1`；`299fe6f5d6fc6f1af7c3411dcf4e5efdf7217368` | [Global写权限 L1472](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/packages/SettingsProvider/src/com/android/providers/settings/SettingsProvider.java#1472)；[observer L199](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/services/core/java/com/android/server/adb/AdbService.java#199) | [启用分支 L1052](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/services/core/java/com/android/server/adb/AdbDebuggingManager.java#1052)；缺当前Wi-Fi或未信任则回写0；可信网络后才开启TLS。 |
| 15 / 35 | `android-15.0.0_r1`；`4e43ad12e1b211f15152e9c5b16b0fe88e6b93f3` | [Global写权限 L1518](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-15.0.0_r1/packages/SettingsProvider/src/com/android/providers/settings/SettingsProvider.java#1518)；[observer L199](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-15.0.0_r1/services/core/java/com/android/server/adb/AdbService.java#199) | [启用分支 L1067](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-15.0.0_r1/services/core/java/com/android/server/adb/AdbDebuggingManager.java#1067)；缺当前Wi-Fi或未信任则回写0；可信网络后才开启TLS。 |
| 16 / 36 | `android-16.0.0_r1`；`99b01a65cc4c104933788b3143285ab6bae65827` | [Global写权限 L1557](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/packages/SettingsProvider/src/com/android/providers/settings/SettingsProvider.java#1557)；[observer L186](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/services/core/java/com/android/server/adb/AdbService.java#186) | [启用分支 L1049](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/services/core/java/com/android/server/adb/AdbDebuggingManager.java#1049)；缺当前Wi-Fi或未信任则回写0；可信网络后才开启TLS。 |
| 17 / 37 | `android-17.0.0_r1`；`94b4c163b7dfe5ce3607f7bb8456f9573f7de57d` | [Global写权限 L1658](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-17.0.0_r1/packages/SettingsProvider/src/com/android/providers/settings/SettingsProvider.java#1658)；[observer L175](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-17.0.0_r1/services/core/java/com/android/server/adb/AdbService.java#175) | [启用分支 L932](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-17.0.0_r1/services/core/java/com/android/server/adb/AdbDebuggingManager.java#932)；reconnect flag 开启时保留enabled并监测网络；未知／不可信网络不等于TLS已就绪。 |

写入成功或读回 1 不等于 TLS/PROBE 成功。11–16 无 Wi-Fi/网络未信任可回写 0；17 开启相关 reconnect flag 时可保留 enabled 而等待可信网络。首次配对、网络确认、系统 forget/授权过期仍走系统流程。App 不改开发者总开关、USB 调试、信任表或授权有效期。原 API>=36 无线调试状态为 null 的行为保留，null 不翻译成关闭。

## 7. 本机页面接入与真机验收

不打扰模式页（`dnd_mode_page.dart`）在「正在使用：X」卡里、紧接其下加一行「保持 X 通道」开关，只对正在使用的通道显示；旧原生（无 privileged 块）不显示。开关值只来自 native keep.enabled，只有点开关才调用 setBackgroundKeep；build、refresh、状态事件都不写设置。关闭或已连接时，开关下写这条通道的保持含义（root：DSH Go 会自己再向 root 管理器申请，管理器决定；Shizuku/Sui：只用已有授权；ADB：只用已有配对，有 WSS 时试一次打开无线调试），文字不截断。开启且未连接时改写进度：restoring、waiting（按 serviceUnavailable/providerChanged、permissionRequired、networkUnavailable、notPaired 分别说明，其余为通用等待）、failed。保存失败显示原生返回的原因。root 已连接时，root 面板的说明按是否保持分两种；「使用条件」里「重启后重新激活」一条在保持开启时不显示。截图见 `test/phone/dnd_mode_golden_test.dart` 的 dnd_keep_*。

| 场景 | 必须观察的结果 |
| --- | --- |
| 默认关闭、只读页、前后台、任务 | 不自动 su、授权或写无线调试设置 |
| root 保持开启，杀 App/重新启动/重启手机 | 只请求所选管理器；真实 probe 后才报 connected；不自动创建显示或点按 |
| root 等待中关闭保持/换模式/关闭总开关 | 控制及时返回，旧意图不迟到发布；后续手动或新保持连接不被旧清理关闭 |
| 健康连接后仅关闭保持、Flutter detach | 已发布的健康连接按约定保留；无新的自动授权 |
| Sui/Shizuku 重启、撤权、来源变化 | 使用真实 Binder/授权/来源结果；失败留在所选身份，无自动权限弹窗 |
| ADB 开机无 Wi-Fi 后再连接、已信任/新网络 | 记录设置写入次数、系统确认、mDNS/TLS/PROBE；不能用 paired/设置值代替 |
| 撤销 WSS、系统 forget、授权过期、关闭开发者选项 | 不补授权、不静默配对、不反复强写设置 |
| onStopJob、强行停止、后台限制、VPN/多网络 | 记录真实调度、路由和进程存续；不填造持续恢复保证 |
| 新任务/已结束任务、显示/输入能力 | 只恢复当前新任务所需传输，旧任务不重放；显示/input 结果单独记录 |

以上真机行均为未执行。仓库内的验证是 JVM 测试（`PrivilegedKeepStateTest`：保持意图、代际、保存失败、退避）与 Flutter 测试（`privileged_keep_test.dart`：协议解析与页面动作不写设置）；它们不证明 Android 服务、OEM 或 root 管理器的实际行为。
