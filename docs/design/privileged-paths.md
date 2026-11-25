# 手机特权通道：Shizuku、Sui、root 与自配对 ADB

> 第十二波，2026-11-01；R1/R2/R3 已进入公开基底 ca3c420，本文补充 W12-P1 的显式保持设置。原生接口与 Dart 状态约定见 [特权通道保持](privileged-keep.md)。**所有下列设备矩阵均尚未实测**；源码核验、JVM 测试及 Android API 编译不等于设备验收。

## 1. 面向谁，解决什么

不打扰模式需要有权限创建可信、独立焦点虚拟屏并注入输入的进程。自动恢复无障碍需要 App 持有 `WRITE_SECURE_SETTINGS`，可通过同类特权通道进行一次性授予。两项用途共享底层能力，但前者有 Android 14 的虚拟屏门槛，后者不要求先启用虚拟屏。

| 通道 | 适用用户 | 需要什么 | 本次边界 |
| --- | --- | --- | --- |
| off | 暂不使用不打扰模式 | 无特权启动 | 关闭后台通道；不自动改选推荐项 |
| shizuku | 使用 Shizuku App 的用户；兼容旧客户端 | 共享 API 存活并获用户授权 | 按接口可用性判断，不仅检查 App 包名 |
| sui | 装有 Sui 模块的 Magisk / KernelSU 用户 | Sui 已向本 App 提供共享 Shizuku API，且授权允许 | 不要求安装 Shizuku App；来源必须实际为 Sui |
| root | 有 Magisk / KernelSU / APatch，愿意明确授予本 App root 的用户 | 用户主动准备，或明确开启「保持 root 通道」；服务 probe 验证 uid=0 和协议版本 | 默认不自动 su；仅显式保持开启后，恢复事件可重新请求管理器 |
| adb | 不使用上述方案，能够开启无线调试的用户 | 自配对无线 ADB、有效配对材料和可连接的 adbd | 继续已有配对与发现流程；同样启动现有特权服务 |

Sui 和 Shizuku 共用现有 `ShizukuStarter` / Binder UserService。root 和 ADB 都启动 `PrivilegedDisplayMain`，用同一套 Bundle/Frames 请求及 `PrivilegedDisplayCore`，没有另造一套操控语义。root 使用私有标准输入/输出管道，stderr 持续消费并丢弃，不把 manager 原始诊断作为 App 提示。

## 2. 推荐只是提示，选择才改变状态

`recommendedMode` 的顺序由纯逻辑 `PrivilegedPathPolicy` 决定：

1. 当前已经就绪的选择。
2. 已存活且已授权的共享 API，名称取实际来源 sui / shizuku。
3. 用户明确准备过或按有效保持设置恢复、仍连接的 root。
4. 已配对且无线调试未明确关闭的 ADB。
5. 存活但仍需授权的共享 API。
6. off。

不满足后台屏 Android 门槛时推荐 off。未知 root 不探测、不推荐。推荐计算不执行命令、不请求权限、不改变选择；页面不能在刷新、build、恢复前台或收到状态事件后自动执行推荐项。

`setBackgroundMode` 表示用户明确选择；切换通道前释放旧任务、断开旧通道、清空旧 gate 结果。失效时保留实际选择与原因，不偷偷改用主屏、ADB 或另一种特权身份。用户原先的主动交接行为继续由既有任务流程管理。

### 共享接口来源与“两个选项”

既有 ShizukuProvider 13.1.5 在 Activity 之前完成 Sui 初始化。本次沿用该入口，状态读取仅观察 `Sui.isSui()`、Binder 存活和权限，不在读页时请求授权或绑定 UserService。

Sui 初始化成功时来源为 sui；否则有 Shizuku App 或存活 Binder 时为 shizuku；两者都没有则为 null。`appInstalled` 只表示 Shizuku APK，兼容字段 `installed` 表示 APK / Sui / Binder 任一可用线索。`running` 和 `granted` 仍分别取 Binder 存活及授权事实。

旧请求 shizuku 在当前实际来源为 Sui 时归一为 sui。显式请求 sui、但实际来源不是 Sui，会返回来源不匹配。页面列两个名称用于说明用户环境，不能承诺可同时强行切换两套 Binder；同时装有 Shizuku App 与 Sui 时，要显示实际来源。

## 3. 状态协议与旧客户端

原 `background` 字段保留：mode、ready、reason、androidOk、shizuku、adb；新增 root 和 privileged。（自检结果字段 trustedDisplay、inject、selfCheckWarning 已随选通道时的自动自检一起删除。）新客户端以 `background.privileged` 的 v=1 块为五通道权威状态。

| 实际选择 | 旧 background.mode | 旧 background.ready | 新 privileged.mode |
| --- | --- | --- | --- |
| off | off | false | off |
| shizuku | shizuku | 实际 ready | shizuku |
| sui | shizuku | 实际 ready | sui |
| root | off | false | root |
| adb | adb | 实际 ready | adb |

root 实际就绪、真实 reason 为 null 时，旧 reason 才提示使用新版界面管理或关闭手机操控；实际失效时保留 root 断线、超时或 gate 失败的真实原因。旧 mode=off、ready=false 投影不变。这样既不让旧客户端误把 root 当成可操作能力，也不遮蔽仍读取旧 reason 的后端任务失败信息。该规则由约定004的补充007明确。Sui 对旧客户端仍是共享 Shizuku API。

| privileged 字段 | 类型 | 含义 |
| --- | --- | --- |
| v | integer 1 | 协议版本 |
| mode | 五模式之一 | 当前选择；可来自本次明确操作或已保存的保持选择，不是推荐 |
| ready / reason | boolean / string或null | 当前尝试后台屏的可用性与本地化原因 |
| supportedModes | string[] | 实现认识的模式；不代表用户授权或设备能力已验证 |
| recommendedMode | 五模式之一 | 只读建议 |
| grantPath | granted / shizuku / shizukuPermission / sui / suiPermission / root / adb / setup | 自动恢复无障碍页面下一步动作 |
| rootSelected | boolean | 明确准备过 root，或从有效的保持 root 设置恢复；尚未切换/关闭 |
| keep | object，可缺省 | 显式保持意图、恢复阶段和固定原因；缺省为关闭，connected 不证明显示/输入就绪 |

### 准入

后台屏的准入只有三条：模式不是 off、Android ≥ 14、所选通道已连接且已授权（Shizuku/Sui 在运行并已授权，root/自连 ADB 已连上）。此外只有真实的瞬时占用（槽位已满、正在切换通道、手动自检正在借用通道、息屏中断收尾、保持恢复进行中）会让一次调用拿不到后台屏。`ready` 与 `parallelism.effectiveLimit` 都只按这些算（`BackgroundPolicy.unready` / `capacity`）。

- **选通道就是连接**：选择通道只连接它，不再自动跑显示/输入自检，也没有自检提示；真失败在任务真正建屏、注入时由那一步带固定错误码返回。设置页上已选通道的「重新检查此通道」向通道发一次 OP_PROBE，不通就丢弃并重连一次，结果如实显示。手动「手机自检」面板仍走 OP_SELF_CHECK_PROBE 的输入探针。
- **后台屏以屏上实际为准**：读屏永远返回后台屏最上面实际的应用（回复里带它的包名和 uid）；不是当初打开的应用时，结果里写明现在是哪个应用、打开的应用去了哪（还在后台屏下面 / 去了主屏 / 已退出），屏上没有应用时如实说没有。之后的动作发给读到的那个应用，按它自己的读写规则走。动作只在「屏上已换了应用而模型还没读到」时拒这一次（`foregroundChanged`，附现在的包名），重新读屏即可继续。读不到 uid 等证据时只比包名，不拒绝；没有「一次不符就永久锁住」的状态。
- **握手不要求可选字段**：App 与特权服务是同一个 APK，PROBE 只看 `ok`（及 mux 能力决定 1 或 3 个槽位）。版本不一致只会来自 App 升级后仍在跑的旧特权进程：连接时 revision 不符即拒绝并换掉它（Shizuku 以 remove 方式解绑旧 UserService 后重绑一次；root / 自连 ADB 每次连接都用当前 APK 新起 app_process，旧进程随 App 进程退出时的 stdin EOF 结束）。
- **释放没确认就断开**：任务、设置自检、手机自检释放后台屏时，服务没确认就断开该通道。虚拟屏属于创建它的特权进程，进程结束由系统回收；下次使用重新连接（root 仍须用户操作或已开启「保持 root 通道」）。不存在「清理待定」锁，也不持久化资源记录；旧版本留下的 `phone-background-resources` 记录在启动时删除。
- 不变的安全边界：特权进程只接受本 App uid 的调用（Shizuku Binder 校验调用方 uid，root 校验 uid=0 与 revision，ADB 走本 App 自己配对的连接），owner scope 隔离各任务的屏。

`background.root` 是缓存和已建进程的状态：checked 表示是否主动检查过；available 为 null/boolean，表示最近主动 probe 是否确认成功；connected 表示现有连接存活；starting 表示主动启动等待；reasonCode 为固定有限码。available 不是 manager 安装检测，也不是永久授权事实；已断线时即使保留上次 available=true，也不能显示 connected。

Dart 保留原 `PhoneBackgroundMode` 三值，避免旧页面 exhaustive switch 破坏；新增 `PhonePrivilegedMode`、`PhonePrivilegedStatus`。页面使用 `effectiveMode/effectiveReady/effectiveReason/supportedModes`。新块缺失或版本不支持时回退旧三模式，未知模式不误认 ready；不得把缺少能力的旧原生当成可执行 root/sui 专用动作。`phone_state.dart` 在发送新动作前检查 supportedModes。

## 4. 首次 su、队列取消与已接纳边界

root 的执行入口是用户明确调用 setBackgroundMode(root)、prepareRoot()，或先明确开启「保持 root 通道」后由恢复事件调用。默认保持关闭；旧 mode、rootSelected、WSS 权限均不迁移成保持授权。RootStarter 构造、status、只读 connect、页面读取和推荐计算不执行 su。恢复只以 OP_PROBE 核对 uid=0 和协议版本，不自动执行显示/输入 gate；真实任务仍沿原有流程处理显示与输入。

root 命令固定为三个 argv：su、-c、一个完整 command 字符串。共享 `PrivilegedCommands` 仅使用 OS ApplicationInfo 提供的 APK 路径构造安全引用的 classpath，Main 类与可执行程序固定；授予通过已连接 root 进程的既有权限 RPC，包名和权限固定，userId来自 App UID。没有用户/网络任意命令入口。

PhonePlugin 在主线程收到总开关关闭、切换通道或关闭保持时先撤销相应意图代际，再由独立控制队列保存设置；控制与状态读取不排在阻塞的恢复 IO 后。旧 Flutter engine detach 使旧 UI 动作失效，只取消该动作尚未发布的 root 启动，保留健康手动连接及有效保持恢复。RootStarter 在短 guard 内检查 mayStart 并建立启动代际，等待和发布连接前再次核对；阻塞启动/读写不占 guard。发布成功后的关闭保持只禁止以后恢复，不断开健康连接；切换通道或关闭手机操控仍按原有断开规则处理。

短 guard 内允许启动只是启动接纳点，连接成功的线性化点是同一 guard 内最后一次 mayStart 校验与 ready 发布。取消仅清理失效 pending；迟到失败只清理自己捕获的 channel，不能全局关闭之后建立的新连接。**不承诺撤回 manager 已收到的授权请求，也不承诺撤销已经完成的权限授予。** 多次轮询不能被解释成再次授权；保持恢复不会重放任务或授予动作。

App策略上限是启动30秒、单次协议操作30秒。授予权限复用已连接 root 进程，也沿用协议操作30秒预算（含排队），不再另起独立su进程及其原10秒等待；超时会退役共享root连接。这些数值不是上游授权倒计时。失败使相应连接失效；保持关闭时后续root尝试由用户重新触发，保持开启时由后续恢复事件尝试。stderr不用于猜测“拒绝授权”；未知失败统一为固定原因。

## 5. 失败时用户看到什么

| 事实/码 | 当前中文方向 | 页面下一步 |
| --- | --- | --- |
| 没有Shizuku App、Sui或活接口 | 未发现可用接口 | 检查安装/启动所选方案 |
| Sui来源但Binder未存活 | Sui接口当前不可用 | 检查模块/服务后重试 |
| Sui存活未授权 | 未授权Sui | 用户主动点击后由Sui自己的授权机制处理 |
| 显式sui与实际来源不符 | 当前接口并非由Sui提供 | 检查Sui并重启App，不假装切换Binder |
| root未检查/starting | 尚未检查 / 正在等待root授权 | 未检查时显示主动准备入口；等待时避免重复自动请求 |
| rootStartFailed | root未能启动，请检查root管理器与授权 | 不根据未知stderr判“用户拒绝” |
| rootIdentityMismatch | root进程身份或协议不匹配 | 不接受uid非0或旧协议服务 |
| rootTimeout | root授权或通信超时 | 明确用户重试；不自动重放动作 |
| rootCancelled | root启动已取消 | 保持当前用户选择结果 |
| rootDisconnected | root通道已断开 | 保持开启时等待恢复事件，否则再次主动选择/准备 |
| rootGrantFailed | 未能授予自动恢复所需权限 | 检查管理器授权，再主动授予并核验实际权限 |
| Android<14 | Android版本要求 | 不假装ready，不改用主屏完成后台操作 |
| 已排队动作过期 | 通道选择已取消 | 忽略旧结果，刷新当前状态 |

页面采用现有中英文词条与组件。原生根错误在values/values-zh的i18n_strings.xml，新增页面词条在phone_background_{zh,en}.arb；本文不要求页面直出未经约束的su原文。

## 6. 独立准备 root 与自动恢复无障碍

`prepareRoot()` 只建立root通道并标rootSelected，不开启虚拟屏、不把现有mode改成root，也不替换已经选择的Sui/ADB模式。因此可以在API26–33上单独用于权限准备；后台屏的API34门槛不应隐藏这个独立用途。API26是当前App最低版本和所用Java Process限时API的门槛，不能据此承诺每个旧系统的root方案都可用。

用户流程：主动“申请root授权” → 检查root.connected → 主动“通过root授予” → 已连接的 root 进程执行固定的授予 RPC（App 所属 userId）→ App通过checkSelfPermission确认WSS → 页面显示已授予。rootSelected为true但连接断开时grantPath为setup，不悄悄换成Sui/ADB。无已建root连接时授予方法返回失败，不隐式start。

App所属userId来自Process.myUid()/100000，不使用前台用户“current”，也不默认0。个人用户、次用户、工作资料要分别核验授予目标。固定permission为android.permission.WRITE_SECURE_SETTINGS，包名为io.github.ccch1mneyyy.dsh_app。

原`a11yKeeper.path`保持旧词汇；新页面读privileged.grantPath。PhonePlugin对明确root选择的原grantSecureSettings方法接线，避免修改PhoneControl；执行后核验真实permission。A11yKeeper原有恢复策略继续运行：只有手机操控总开关打开且持有所需权限时才检查恢复；不能把“root通道存活”当成“无障碍已连接”。

Sui与Shizuku共享同一starter。选择sui后，旧兼容授予路径仍可能以shizuku命名；当前由`PrivilegedPathPolicy.sharesGrantChannel`按同一API家族判断共享，授予后不把当前不打扰模式正在用的UserService当成临时连接解绑。没有后台共享连接时，既有临时授予连接仍按原流程关闭。

现有PhoneControl的待授权共享API回调在用户允许后会继续授予；它不经过新增root动作队列门禁。该请求已由用户先前授予动作接纳，不能把关闭按钮写成保证撤销所有已弹出授权。若本机未来要改变这项回调语义，应单独在PhoneControl/a11y既有流程整合，本波不借文档偷偷改变它。

## 7. 关闭、恢复与会话生命周期

- 选择 off：先使保持意图过期；保存关闭与原有任务/显示/通道释放各按对应队列完成，成功保存才可称持久关闭。mode=off、rootSelected=false，清空 gate 缓存。
- 切换为另一通道：清除旧保持选择，按原有流程清旧任务/连接；新通道默认不保持，用户须单独开启。
- 手机操控总开关关闭：先撤销保持与旧 UI 意图；保存关闭与既有任务/通道释放各按对应队列完成，成功保存才可称持久关闭。WSS 已授予的系统权限不主动撤销；A11yKeeper 依据总开关停止恢复。
- 熄屏（`BackgroundControl.interrupt`）：停止任务、释放虚拟屏；Shizuku/Sui与ADB连接断开，下个任务自行重连；root的空闲进程保留，下个任务直接复用（`PrivilegedPathPolicy.closesOnInterrupt`），否则一次熄屏就要用户重新选择root。
- 服务死亡、任务中断：沿用原有停止/资源释放路径；未开启保持时 root 只读连接、不静默重新 su。开启保持后可按恢复事件重新请求同一身份，但不恢复旧任务或自动切换身份。
- engine detach：旧 UI 队列动作失效；仅取消其失效 pending，保留健康的手动 root 连接及有效保持恢复。已进入管理器的授权无法撤回。
- App/进程重启：只有有效的显式保持设置可恢复 mode/rootSelected，并触发传输恢复。没有保存保持时仍从 off 开始；系统 WSS 权限与通道连接分别记录。

root/ADB入口先准备Looper再创建ActivityThread systemContext，之后进入既有服务。root使用原systemContext分支，shell身份才切换com.android.shell上下文。该源码结构已核对，但反射API、SELinux及厂商服务行为仍需真机验收。

## 8. 本机 UI 与 a11y 接入清单

本波不修改`phone/a11y/`、`phone/PhoneControl.kt`、`app/lib/ui/chat/`。页面按以下顺序接入，没有重做组件（保持开关见[特权通道保持](privileged-keep.md)第 7 节）：

1. 通道控件读取supportedModes与effectiveMode；名称区分Sui/Root；旧三值页面继续使用旧enum，不在原exhaustive switch塞入未知值。新块不存在时只显示三种旧能力。
2. 建议以文字提示展示recommendedMode；点击才调用setPrivilegedMode。程序化刷新、构建或状态同步触发的回调不得发选择或准备动作；用户主动点选控件产生的onChanged可以调用选择方法。
3. Sui授权按钮调用requestPrivilegedPermission，携带实际provider期望；同时存在Shizuku/Sui时说明当前接口来源，不能提供“强制切Binder”的虚假效果。
4. 独立自动恢复页增加显式prepareRoot入口；不要受不打扰模式androidOk=false而全部隐藏。成功准备只显示可授予，下一次明确授予仍调用原grantSecureSettings。
5. 新自动恢复动作读privileged.grantPath；已granted显示真实权限状态；root断线时提示重新准备，不把旧a11yKeeper.path里的shizuku/adb提示当成可以偷偷换通道的依据。
6. 总开关off和通道off沿用已有动作，允许等待中的旧结果以取消结束；页面以最后一次状态为准，过期返回不得重新勾选root。
7. 页面文案区分“尚未检查”“正在等待”“已连接”“后台屏验证失败”“已授予WSS”“无障碍已连接”。这六项没有相互推出关系。
8. 现有A11yKeeper的恢复与退避不改；本机验证有permission+总开关开时恢复、总开关关时不恢复，勿以root服务存活代替恢复验收。

本机接入后的页面（`dnd_mode_page.dart`、`a11y_restore_sheet.dart`，golden 见 `test/phone/dnd_mode_golden_test.dart`）：

- **不打扰模式**：有通道在用时顶部一张「正在使用：X」卡，就绪写「可以用了」，root 等待时写原生原因；其余失败在卡下用一条警示写 `effectiveReason` 原文。卡上的「关闭」在等待 root 时也可点，用来取消。下面「通道」卡按 `supportedModes` 列出 off 以外的通道，每行是名称、适用人群一行和状态词（使用中 / 未就绪 / 等待授权 / 可以用 / 待授权 / 未运行 / 未安装 / 未检测到 / 由 Sui 提供 / 尚未检查 / 未连接 / 已配对 / 未配对），`recommendedMode` 只是标题后的淡色「建议」标签。
- **点行只展开**该通道的检查项和下一步，选择只发生在展开后的「用 X 开启 / 改用 X」按钮；root 的按钮先过一次中档风险提醒（`phone.root`），再调用 `setPrivilegedMode(root)`。在用但未就绪的通道默认展开，全部就绪时全部收起，常见情况一眼看完。provider 为 Sui 时 Shizuku 行写「由 Sui 提供」并指向 Sui，没有自己的开启按钮。
- 旧原生（无 v1 块）只列 Shizuku 与自连 ADB，不出现 Sui / root、不出现建议。
- **自动恢复无障碍**按 grantPath 写出路径（通过 Shizuku / Sui / root / 自连 ADB 授予，或先授权 Shizuku / Sui），root 路径附「通过已授权的 root 连接，只授予这一项权限」；无路径时在「配置…」下另给「申请 root 授权」（`prepareRoot`，同一提醒，不看 Android 14 门槛）；root 已选但断开时只给重新申请，不换别的路径。

具体页面验收：保持关闭时，只开设置页/搜索/前后台切换无root提示；点prepare一次才产生一次启动尝试；API33仍能独立准备；API34+选择root后连上即可用后台屏；prepare不改变原mode；来源改变的旧Sui按钮不授权错误来源；按off后等待中的旧结果不复活勾选；旧原生侧不发送prepareRoot；新原生root投影旧字段off/false，但断线/超时后的任务错误保留实际原因；Sui授WSS后当前共享后台服务不被解绑。

## 9. 真机矩阵与逐步可观察验收

下表全部状态为**未执行**。每条记录设备型号、ROM/Android/API、App版本及补丁hash、manager/Sui版本、用户userId；保留状态Map、固定reasonCode、permission检查和资源结果，不记录密钥、输入内容或su完整输出。

| 编号 | 环境 | 必须单独确认 | 当前结果 |
| --- | --- | --- | --- |
| D1 | Sui on Magisk，仅模块、未装Shizuku App，API34+ | appInstalled=false仍识别provider=sui；拒绝/允许授权；UserService与gate；WSS共享连接不解绑 | 未执行 |
| D2 | Sui on KernelSU，仅模块，API34+ | 同D1；记录Root Profile/模块状态，不把安装推导成Binder存活 | 未执行 |
| D3 | Magisk su，无共享API，API34+ | 首次显式su、uid0/revision、私有帧、虚拟屏/输入、grant实际permission | 未执行 |
| D4 | KernelSU su，无共享API，API34+ | 同D3；默认root profile与受限uid/profile分别记录，非uid0不得接受 | 未执行 |
| D5 | APatch su，无共享API，API34+ | 同D3；二进制管道无PTY污染、断线退出、所测APatch精确版本 | 未执行 |
| D6 | 仅Shizuku App，无Sui/root，API34+ | provider=shizuku、旧请求/新请求兼容、授权与UserService、原ADB流程不受影响 | 未执行 |
| D7 | 仅无线ADB，无共享API/root，API34+ | 配对/重连/服务启动、公共classpath命令、gate和WSS；root状态仍unchecked | 未执行 |
| D8 | 任一已支持root方案，API26–33 | 后台屏被版本门槛拒绝，但prepareRoot+WSS可独立尝试；不宣称所有该范围设备都兼容 | 未执行 |
| D9 | Android16/API36、任一可用通道 | ADB无线调试状态未知时不伪造关闭；各实际API/ROM gate结果 | 未执行 |
| D10 | Shizuku App与Sui均存在，API34+ | actual provider=sui时旧shizuku归一sui；明确sui来源匹配、不能强制切另一Binder | 未执行 |
| D11 | 工作资料/副用户中的本App | grant命中App所属userId，主用户权限不被误当成功；目标用户的恢复策略生效 | 未执行 |

下面是9类共用验收步骤，按各环境与真实通道的适用范围记录；11个环境不构成99个全部适用的格子。不适用项注明原因，所有适用项当前也仍未执行。不能只截“已root”页面：

| 步骤 | 操作 | 可观察验收 |
| --- | --- | --- |
| V1 冷启动/只读 | 保持关闭，撤销或清楚记录既有授权，冷启App并反复读取状态 | 没有首次 su、没有权限请求、没有自动选择建议；root 为 unchecked/null |
| V2 明确选择 | 保持关闭，点击通道/授权或 prepareRoot；分别允许、拒绝、超过等待上限 | 只调用所选身份，由 Sui/管理器处理授权；固定失败原因、不猜 stderr，不自动重试 |
| V3 协议 | root验证probe；API34+选择后台模式 | uid0与revision同时成立才接root；连上即ready；真不支持时任务报具体错误码，无主屏替代 |
| V4 独立授予 | mode=off或保留其它mode时prepareRoot，再点授予；共享API也走一次 | mode不被prepare改变；actual WSS permission确认；共享Sui服务不被误解绑 |
| V5 正常任务 | 启动一个普通、非敏感应用的后台任务，结束/主动交接 | 显示与任务owner匹配，正常结束释放资源，前台操作不受意外抢占 |
| V6 失效 | 分别撤权、杀服务、锁屏；再在保持开/关下启动新任务 | 关闭保持时 root 不隐式 su；开启时仅按恢复事件请求同一身份，不重放旧任务。锁屏资源按实际 task/driver 路径记录，不断言每次都断开 root |
| V7 队列取消 | 阻塞 IO 队列后点 root，再点 off/关闭总开关；另测启动已接纳后取消 | 撤销意图后不迟到发布；不宣称撤回管理器请求。原预算与阻塞范围见保持约定，尚未收敛时继续占单一槽，不假定 OPEN/PROBE 有总截止 |
| V8 自动恢复 | 获 WSS 后模拟无障碍断开，分别切总开关与保持设置，再重启 App | 无障碍按既有退避与总开关恢复；仅明确保持 root 才允许自动 su。已 grant、保持设置、传输连接、显示能力分别记录 |
| V9 多用户/兼容 | 在个人及工作资料重复授予；旧/新Dart状态夹具对读 | permission目标正确；root旧投影off/false且仅就绪时显示兼容提示，失效时任务结果保留实际原因；Sui旧投影shizuku；旧原生无新动作 |

## 10. 验证证据与发布边界

以下为 R1/R2/R3 的历史交付记录；当前 P1 基于 ca3c420，使用其独立补丁与精确哈希复核。R1提供共享API来源纯函数测试及上游初始化证据；R2提供固定命令、纯状态/代际、实际JVM管道子进程与Android API adapter编译；R3提供原生选择/队列策略、Dart兼容解析与状态接线测试。每个交付包独立以dbfe2a3归档根应用，组合顺序R1→R2→R3，本文文档补丁可独立应用。不得把合成git基准误称原始提交历史。

复核报告中的PASS_SCOPED只覆盖其精确补丁hash与列明测试。上面的D1–D11、虚拟屏/输入/权限真机结果及本机页面接入均尚未完成。发布前按目标设备实际记录执行；没有设备结果时保留“未在真机核实”，不把文档矩阵勾成已通过。

源码入口：`BackgroundControl.kt`、`PrivilegedPathPolicy.kt`、`PrivilegedActionGate.kt`、`PhonePlugin.kt`、`RootStarter.kt`、`RootStatus.kt`、`RootProcess.kt`、`PrivilegedCommands.kt`、`ShizukuStarter.kt`、`SecureSettingsGrant.kt`；Dart为`app/lib/phone/phone_channel.dart`与`app/lib/state/phone_state.dart`。既有手机操控总规则见`docs/research/phone-control.md`。
