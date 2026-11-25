# 桌宠动作验收入口

`app/lib/dev/pet_actions_probe_main.dart` 是独立 debug 入口，用本机回环 HTTP/WebSocket 服务代替 Host 和语音模型，供 Android 模拟器执行真实浮窗动作。正式 `main.dart` 不引用它；入口拒绝非 debug 模式，没有修改正式逻辑或原生代码。

## 真实链路和替换边界

| 场景 | 真实执行 | 受控替换 |
|---|---|---|
| 问一句，原会话 / 新会话 | `PET_PROBE ask` 打开原生输入条 → 点击发送 → `dsh/pet_overlay` → `PetOverlayActions` → `ChatController.waitForSync/send` → `DshClient` → HTTP RPC；同步快照由真实 mux 接收 | `FakeDsh` 提供隔离 Host、空会话快照；会话 provider 固定候选，创建仍调用 `session/create` |
| 允许本次 / 拒绝 / 简单问题 | 控制接口只将 waterfall 写入真实 WebSocket；`DshClient` 解析 → `ChatAlertsController` 创建 token → `PetOverlayBridge` 推原生气泡 → 点击 → `answerFromPet` → `$events/result` | 复用 `FakeAlertSource` 提供会话列表与精确的工具调用文本；测试 reducer 固定宠物展示状态，token 仍来自真实 tracker |
| 语音回填 | 原生按住说话，收到 WAV 后调用真实 `transcribe` 动作；前台回退仍使用 `PetVoiceDialog` 与 `VoiceInputController`；均发送实际 `speech/transcribe` HTTP 请求 | 本地模型固定返回 `probe voice words`。前台回退的录音桥提供一秒 PCM16 WAV，原生浮窗录音器不替换 |

语音验证只证明录音/回退接口、请求协议、文本回填以及“回填不自动发送”，不证明真实识别模型效果。前台回退使用合成 WAV，不能用它声称硬件麦克风已验收。通知弹出由测试 channel 隔离，以免触发其他系统通知；桌宠的 MethodChannel 没有 mock 成功返回。每个 `native-result` 都是实际 Dart handler 的结果。

所有模型/会话业务请求只访问进程内 `127.0.0.1` 服务，无真实账号、外部 Host、模型下载或付费调用。Dart 偏好使用进程内测试值。`pet_probe_support.dart` 从已有三个测试辅助文件复制纯 Dart 夹具并标注来源，使 Android 的 package URI 不需要越过 `lib/`；不导入 `flutter_test` 或 `WidgetTestBinding`，也无桌面专用 API。测试 binding 只用于单独的 smoke 测试。

## 本地 smoke

在 `app/` 运行：

```bash
TZ=Asia/Shanghai flutter test --no-pub tool/pet_actions_probe_smoke_test.dart
flutter analyze --no-pub lib/dev/pet_actions_probe_main.dart tool/pet_actions_probe_smoke_test.dart
python3 -m py_compile tool/pet_actions_probe.py
```

smoke 直接调用真实 Dart actions，核对 HTTP prompt、创建会话、两种审批结果、问题答案与语音回填不提交 prompt。它不经过 Android MethodChannel，不能当作原生端到端结果。原生结果必须由下一步的 UI 脚本取得。

入口交接时：本地 smoke 1/1 通过，三个 Dart 文件定向 analyze 无问题，Python 语法检查与 `git diff --check` 通过。尚未构建此入口或执行 Android UI 脚本；模拟器结果应由实际运行后的 JSON 与日志补充，不能把本段 smoke 结果改写成模拟器通过。

## 模拟器执行

由负责构建与模拟器的人串行执行；本文件与脚本不会自行构建、安装或启动模拟器。目标必须是 Android 35 x86_64：

```bash
# 仓库根目录；现有构建任务结束后才执行。
tooling/build-apk.sh --debug -f x64 -t lib/dev/pet_actions_probe_main.dart

# 只对明确指定的模拟器安装。下例假设它已经启动。
adb -s emulator-5556 install -r app/build/app/outputs/flutter-apk/app-x64-debug.apk
adb -s emulator-5556 shell appops set io.github.ccch1mneyyy.dsh_app SYSTEM_ALERT_WINDOW allow
adb -s emulator-5556 shell pm grant io.github.ccch1mneyyy.dsh_app android.permission.RECORD_AUDIO
adb -s emulator-5556 shell am force-stop io.github.ccch1mneyyy.dsh_app
adb -s emulator-5556 shell monkey -p io.github.ccch1mneyyy.dsh_app -c android.intent.category.LAUNCHER 1

python3 app/tool/pet_actions_probe.py --serial emulator-5556 --output /tmp/pet-actions-probe-result.json
```

脚本先只读验证专用模拟器的输入设备，再通过 `adb forward` 读取 `fixture=dsh-pet-actions-probe-v1` 并要求计数为零，才会操作浮窗；普通 App 或旧测试结果不能冒充入口。完整流程只支持本轮专用的 `emulator-5556`、Android 35 x86_64、720×1280 竖屏，拒绝真机及其他设备映射。它在已有模拟器上启用桌宠与“一直显示”、回到 Home，然后通过 UIAutomator 的控件文本/描述与边界定位点击，不以伪造 RPC 替代原生点击。普通输入和发送仍用 `adb input tap`；语音通过原生麦克风按钮长按；Android 若转入前台回退，等待真实对话框流程返回浮窗。

原生审批/问题按钮仍保留 600 ms 防误触时间和 `PromptInputPolicy`：拒绝遮挡、虚拟设备或无障碍注入的点击。`adb input tap` 的 `deviceId <= 0` 会被拒绝，因此这三次按钮点击专用 `sendevent /dev/input/event2`，经模拟器的 `virtio_input_multi_touch_1` 硬件输入入口进入 Android。脚本使用 MT slot 0、finger 类型、正 tracking ID、X/Y 与压力，再释放 tracking ID；shell 的退出/信号处理会执行释放，避免失败后残留按下状态。该设备没有 `BTN_TOUCH`，脚本不发送这个按键。屏幕坐标按 InputReader 的 32768 值轴范围映射为 0..32767。生产 guard 没有改动；遮挡、注入保护或动作过期仍应导致验收失败。

可在其他人操作模拟器时做纯只读预检：

```bash
python3 app/tool/pet_actions_probe.py --serial emulator-5556 --check-hardware
```

它只读取 `getprop`、`wm size`、`getevent -lp`、`dumpsys input`，输出设备信息及中心点 `(360,640)` → `(16384,16384)` 的 down/up 事件计划，标记 `sent: false`；不转发端口、不广播、不抓取 UI、不发送事件，也不要求 dev 入口已经启动。预检要求 `event2` 名称与轴范围、正 Android device ID、主屏 DIRECT 绑定、旋转 0、无活动触点。2026-10-31 只读检查确认此映射的 Android device ID 为 12；重连后该 ID 可变化，所以脚本验证正值而不固定为 12。设备映射变化时应重新核实夹具，不能放宽正式 guard。

硬件适配交接时只执行了只读预检、坐标/事件计划与非法输入的离线检查，没有发送硬件触摸。需要负责模拟器的人运行完整脚本，依据实际 `$events/result` 及 `native-result` 判断是否通过，不能把预检输出当原生验收结果。

成功记录要求：3 次 prompt（原会话、新会话、手动发送语音草稿），3 次 `$events/result`（`allowed-once`、`rejected`、Blue），1 次 `speech/transcribe`，以及 3 个原生 answer 的 `handled` 结果；语音回填到原生 EditText 后、手动点击发送前 prompt 计数必须不变。录音权限未授予、UI 定位失败、浮窗没出现或回填没返回都会失败并保存当前记录，不会降级为直接调用 Dart。

结果 JSON 明确区分 `nativeUi` 与 `recognitionModel`，并在 `hardwareTaps` 记录三次审批/问题点击的设备、屏幕坐标与原始坐标。失败时另存 `adb logcat -d` 中的 `[pet-actions-probe]`、`DshPet`，以及当前 UI dump。每次重跑先 force-stop 再启动入口，避免累积计数；不要在测试失败后将累积记录当新一轮通过。完成后安装/启动普通 App 构建即可退出此入口。

## 手动诊断

入口页面显示每个动作和 RPC。控制接口监听设备回环 `38080`（脚本转发到电脑 `38081`）：

```text
GET  /state      当前计数、native-action/native-result、RPC 与语音元数据
POST /approval   新建审批 waterfall，不代替用户作决定
POST /question   新建只有 Blue/Red 的简单问题，不提交答案
```

`/state` 的 `lastRequest` 带 tracker 生成的 token；`speech` 记录仅保留字节数、provider 和固定响应，不保留录音 base64。控制接口没有“成功”或“发送”捷径，所有验收动作必须从原生 UI 进入。当前入口用于本轮受控验证，不包含断网/重连/并发失效的全套验收；这些仍由正式单元测试和单独的运行测试覆盖。
