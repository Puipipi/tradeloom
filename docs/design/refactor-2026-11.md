# dsh-go 重构方案（2026-11）

> 2026-11-10 起草。基线 `main` = `1c5b220093295f8d069f6bfb06d8b4fc97b9e9c2`。
> 依据是同日的只读审查（四路读码 + 抽查）。审查没有跑测试、测速、真机，所以下面的行号和计数是「审查时的数」，各包开工先复核，对不上以代码为准。
> 分工：App 侧（Dart / Flutter）与运行时、桥、Android 原生、CI 分成两组并行推进，文件集合互不相交。

## 1. 目标

| 目标 | 现在 | 做完后怎么判断 |
|---|---|---|
| 聊天流式不拖整页 | 列表 watch 整份聊天状态，每 32ms 所有已建行重建 | 流式期间已完成的行重建次数为 0（有测试守着） |
| 依赖方向单向 | 836 个文件里 347 个成环，state / plugins / ui_config / links 反向 import ui | 非 ui 目录不再 import `ui/`，有测试守着；最大环明显变小 |
| 运行时可分层更新 | 改一行桥也要整包下载、整包解压 | 只换引擎层的版本：增量补丁小、升级只解引擎层 |
| 桥有版本协商、错误形状统一 | 无 `/version`，错误响应 5 种形状 | App 能分清「旧桥」和「路由不存在」，错误一种信封 |
| 补丁可维护 | 123 个补丁，顺序靠文件名排序，无上游跟踪 | 有显式顺序文件和上游状态表 |
| 省电、日志不漏密 | 唤醒锁无超时常持；落盘日志只遮 `token=` | 只在有回合运行时持锁；Kotlin 侧打码规则与 Dart 侧一致 |

## 2. 原则

1. **行为不变优先。** 重构包不改用户可见行为。必须改的（例如超长工具输出截断）单独成提交、单独说明。
2. **小步、可单独回退。** 一个提交一件事；纯搬文件和改逻辑不混在一个提交。
3. **先有守卫再动。** 每个包先加能失败的测试或度量（重建计数、import 方向、协议向量），再改实现。
4. **不夹带。** 不顺手格式化、不升级依赖、不改无关文件。
5. **只防真实可达的情况。** 不加走不到的判空和兜底，不为假设的将来加接口和开关。
6. **安全相关做成选项。** 会限制用户的安全措施默认关（owner 既定）；纯工程的健壮性修复照做。
7. **未经真机验证的如实写。** 原生层、PRoot、更新安装相关改动，桌面和 CI 的结果不能替代真机。

## 3. 避让清单（现在别碰）

别的线正在改这些文件，重构这一期不动它们；有建议写进报告。

- `feat/roleplay`（酒馆，56 个提交，未推送）改到的既有文件：
  `app/lib/ui/chat/render/markdown_body.dart`、`app/lib/ui/companion/companion_page.dart`、`app/lib/ui/companion/companion_stage.dart`、`app/lib/companion/companion_server.dart`、`app/lib/ui/bots/bot_chat_kit.dart`、`app/lib/ui/shell/home_shell.dart`、`app/lib/ui/shell/sessions_drawer.dart`、`app/lib/ui/shell/system_entry_host.dart`、`app/lib/ui/settings/interface_page.dart`、`app/lib/ui/web/mode_home.dart`、`app/lib/ui/theme/app_icons.dart`、`app/lib/ui/wallpaper/wallpaper_backdrop.dart`、`app/lib/state/wallpaper_state.dart`、`app/lib/links/page_links.dart`、`app/pubspec.yaml`、`.github/workflows/ci.yml`、l10n 合并产物。
- `app/lib/ui/tavern/**`、`packages/dsh_tavern/**`：酒馆线（独立分支）。
- `app/ios/**`、`app/ohos/**`、`runtime/ohos/**`：`feat/ios-foundation`（长期分支，和 main 分叉很大，重构合入后由那条线自己跟）。
- l10n：新增文案只改 `app/lib/l10n/parts/*.arb`（中英同步），再跑 `l10n_merge.py`；不手改生成物。

## 4. 分工总表

| 包 | 分组 | 分支 / 目录 | 独占的文件 | 何时开 |
|---|---|---|---|---|
| A 聊天流式性能 | 甲组 | `refactor/chat-stream-perf` | `app/lib/ui/chat/**`（避让清单除外）、`app/lib/state/chat_state.dart`、`app/lib/state/session_modes.dart`、`packages/dsh_client/lib/src/transcript.dart` | 第一期 |
| B 依赖方向 + 插件状态拆分 | 甲组 | `refactor/import-direction` | `app/lib/state/**`（A 的三个文件除外）、`app/lib/plugins/**`、`app/lib/ui_config/**`、`app/lib/links/**`（`page_links.dart` 除外）、`docs/architecture.md` | 第一期 |
| P 运行时 / 桥 / 原生 / CI | 乙组 | 待定 | `runtime/**`（ohos 除外）、`app/android/**`、`tooling/**`、`packages/dsh_client/lib/src/dsh_go_api.dart`、`.github/workflows/**`（交补丁，本机合入时处理和酒馆线的冲突） | 第一期 |
| C 前端一致性 | 甲组 | 待定 | `app/lib/ui/common/**`、`app/lib/ui/theme/**` 及各页面的调用点 | 第二期（B 合入后） |
| D 持久化层 + 离线快照 + 日志落盘 | 甲组 | 待定 | `app/lib/state/**` 的存取部分 | 第二期（B 合入后） |
| E 聊天控制器 / 聊天页拆分 | 甲组 | 待定 | `chat_state.dart`、`chat_screen.dart` | 第二期（A 合入后） |
| F 会话状态按主机取键 | 甲组 | 待定 | `chat_state.dart`、`sessions_state.dart`、`hosts_state.dart` | 第三期（E 之后） |
| G 流式正文增量预处理、伙伴小屋页拆分 | 甲组 | 待定 | `markdown_body.dart`、`companion_page.dart` | 第三期（酒馆合入后） |

同一时刻一个文件只有一个写手。第一期三条线的文件集合互不相交；A、B 有一处要注意：B 清理 state → ui 的反向依赖时，如果那条边经过 A 的文件，B 不动，只记进报告。

## 5. 第一期

### A. 聊天流式性能（甲组）

**目标**：流式输出时只有正在写的那一行重建；带排队消息、工具参数流式时不再全量重算行。

| # | 改什么 | 审查时的位置 | 做法 |
|---|---|---|---|
| A0 | 守卫 | — | 先加测试：流式 N 个增量期间，统计已完成行的 build 次数和 `deriveRows` 调用次数（现状会很大），作为后面每步的验收 |
| A1 | 列表只盯行结构 | `chat_list.dart:646`、`:717-738` | 列表 `select` 行结构；流式文本单独走 notifier 喂最后一行 |
| A2 | 排队消息让行缓存失效 | `chat_state.dart:85`、`:1176-1208`；`chat_rows_cache.dart:33`、`:74-82` | `PendingPrompt` 值相等，或缓存放置结果；`_reuseTail` 支持尾部草稿工具项 |
| A3 | 半截 JSON 每次解码抛异常 | `tool_view.dart:92` | 流式中的工具参数不反复 `jsonDecode` |
| A4 | 已完成回复每次重算纯文本 | `assistant_message.dart:210`、`dsh_ui_model.dart:1390` | `dshUiPlainText` 改到点按时再算，或按消息缓存 |
| A5 | 按 token 的全量扫描 | `session_modes.dart:57`、`media/media_paths.dart:14` | 两个 provider 改盯 `turns`，不盯 `items` |
| A6 | 流式代码块整块重高亮 | `render/code_block.dart:253-285` | 流式中降频，或闭合后再高亮 |
| A7 | 模糊组没传 `grouped` | `widgets/activity_strip.dart:218`、`dock/dock_stack.dart:242` | 补上 |
| A8 | transcript 全量重建 | `transcript.dart:279`、`:546-555` | `_ToolBuilder` 缓存未变项；与显示无关的事件不清缓存。`packages/dsh_client` 是共享层，单独提交，靠现有的 full-build oracle 测试守着 |
| A9 | 缓存不随会话释放 | `turn_summary.dart:273`、`:534` | 会话 dispose 时清 |
| A10（可选，单独提交） | 超长工具输出一次排版 | `widgets/tool_row.dart:553` | 截断 + 「查看全部」。这是可见变化，要新文案，做之前先在报告里给方案 |

**不做**：`markdown_body.dart`（避让）；拆 `chat_screen.dart` / `ChatController`（E 包）；JSON 挪到 isolate、丢弃原始 `stream` 数据（先确认导出不依赖它，留给 E 包评估）。

**验收**：A0 的计数测试通过（已完成行重建 0 次；有排队消息时 `deriveRows` 不随增量调用）；`app/test/chat`、`app/test/state` 与基线相比没有新失败；`packages/dsh_client` 的测试全过；`flutter analyze` 无新增；golden 不应变化，变了就停下说明。

### B. 依赖方向 + 插件状态拆分（甲组）

**目标**：非 ui 目录不再 import `ui/`；`plugins_state.dart` 按现成的缝拆开；架构文档跟上。

| # | 改什么 | 做法 |
|---|---|---|
| B0 | 文档 | 把本方案提交为 `docs/design/refactor-2026-11.md`；`docs/architecture.md` 的目录一节补上 `lib` 下现有的顶层目录 |
| B1 | 守卫 | 加一个测试（`app/test/arch/`），扫描 import：`state/`、`plugins/`、`ui_config/`、`links/`、`remote/`、`runtime/` 等非 ui 目录 import `ui/` 即失败。现存的边放进白名单，白名单只许变短 |
| B2 | 下沉类型 | 把被借用的纯类型和纯函数（审查点到的有 `generate_header`、`web_target`、`isPluginForm` 等）移到非 ui 位置；旧位置留一行 `export`，ui 侧的调用点不用改。每移一组，白名单删掉对应的边 |
| B3 | 拆 `plugins_state.dart` | 审查时的四段缝：市场（约 35 行起）、已装（526）、失败分类（1016）、安装任务（1322）。纯搬文件，`plugins_state.dart` 保留，外部 import 不变。**已完成（#967）**：四段搬到 `app/lib/state/plugins/`，用的是 `part` 而不是 `export`——四段之间互相用到对方的私有成员，拆成独立的库就得把这些成员公开，那已经不是纯搬移了 |
| B4 | 度量 | 报告里给出前后的最大环规模和各目录 → ui 的边数（脚本放 `app/tool/`） |

**不做**：A 的文件；避让清单；改任何行为；动 provider 的键或生命周期（F 包）；统一持久化（D 包）。

**验收**：B1 的测试通过且白名单比开工时短；`flutter analyze` 无新增；受影响目录的测试与基线相比没有新失败；B3 的提交 `git diff --stat` 之外用 `git diff -M` 能看出是搬移。

### P. 运行时 / 桥 / 原生 / CI（乙组）

这里是摘要。编号从 5000 起。

| # | 改什么 | 要点 |
|---|---|---|
| P1 | 运行时分层资产 | 先交设计文档，再分步实现：打包器产出「基础系统」和「引擎层」两个资产和对应 manifest 契约；安装器升级时只解引擎层；发版工具和增量补丁适配。基础层要做到同输入字节不变，增量补丁才小。设备上已有的「精确引擎路径」事务升级不能倒退 |
| P2 | 桥契约 | 版本与能力协商（旧桥、新 App 和反过来都要有定义好的行为）；错误响应统一成一种信封并保留现有稳定错误码；资产路由校验和读取用同一个真实路径 |
| P3 | 补丁治理 | 显式的顺序文件代替按文件名排序；补丁头加上游状态；一张上游状态表。不改补丁语义，pins 由本机重录 |
| P4 | 唤醒锁 | 只在有回合运行时持有；给出「有回合在跑」的信号来源设计 |
| P5 | 落盘日志打码 | Kotlin 侧与 Dart 侧 `redact` 规则一致，共用一份测试向量 |
| P6 | 手机操控健壮性 | 包名为空时的黑名单判断；关总开关不排在慢操作后面；ADB 私钥用 Keystore 包裹做成选项（默认关） |
| P7 | CI | main 上构建一次 release APK 验混淆规则；runtime job 缓存打过补丁的 DSH 前缀；手动触发的 golden 更新工作流 |
| P8 | 冷启动 | token 之后多余的端口轮询 |
| P9 | targetSdk 升级清单 | 只写文档：W^X 执行方案、缺的 manifest 项、每项的验证方式 |
| P10 | 被杀后的恢复 | 评估并给方案；开机自启做成选项（默认关） |
| 兜底 | 查 bug 修 bug | 运行时、桥、原生范围内按角度轮换 |

乙组的补丁由本机按批合入：只合复核通过的精确字节、全量 CI、合入后做一遍精简。原生层的改动一律标「未真机」。

## 6. 第二期、第三期（第一期合入后再开，届时按当时的代码重写题面）

- **C 前端一致性**：提示条统一入口（裸 `SnackBar` 129 处）、加载小环组件（转圈 103 处、线宽 5 种）、带 `danger` 参数的确认弹窗助手（手拼 70 处）、命中区扩到 48（视觉不动）、字号 15 收进 `AppType`、触觉封装、聊天图片的读屏标签。打开预测性返回（manifest 一行，targetSdk 28 下是否生效要真机试）。
- **D 持久化层**：一个 `PrefsStore` + 通用的持久化 Notifier，收拢 170 处 `SharedPreferences.getInstance()` 和 119 个零散 key，带版本迁移；会话列表和最近消息落只读快照（离线可读）；被吞的异常进日志，日志落盘，留「上次崩溃」。`connection_state.dart:117` 发布连接前等 `_pushKey` 的串行等待在这里一起看。
- **E 拆上帝类**：`ChatController`（1636 行）按职责拆成几个协作对象；`_ChatScreenState` 里的建会话和发送编排移出 widget；评估 JSON 解析挪到 isolate、原始 `stream` 数据算完时间后丢弃。
- **F 按主机取键**：会话 provider 的键带上主机和连接代，删掉手工的 `identical()` 守卫和 epoch 计数。
- **G**：流式正文预处理按已定稿前缀做增量（等酒馆合入）；伙伴小屋页的会话逻辑抽成 Notifier（等酒馆合入）。
- **以后再议**：路由表（深链和 push 共用）、运行时功能开关、统一错误类型。

## 7. 合入流程

1. 各线在自己的分支或工作目录里交付；不推送、不开 PR。
2. 主线读 diff、跑受影响的测试，把结论和要 owner 定的事攒成一批汇报。
3. owner 点头后开 PR；CI（Linux）全绿再合。golden 只认 CI 的渲染。
4. 一个包合入后，后续包以新的 main 为基底；清掉本包的工作树和分支。

## 8. 风险

| 风险 | 应对 |
|---|---|
| 和酒馆、iOS 分支冲突 | 避让清单；涉及的包排到第三期 |
| 性能改动没有真机数据 | A0 的计数测试给出结构性证据；帧率要真机或 profile 模式测，合入前如实标注 |
| 共享层（`dsh_client`、桥）回归 | 单独提交；oracle 测试和协议向量；检查另一端调用方 |
| 运行时分层影响升级路径 | 先设计后实现；事务升级的现有测试不许删；模拟器走一遍升级路径后才发版 |
| Pro 线的代跑成本 | 回件只回文本、优先 CI、同类请求合并 |
