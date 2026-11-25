# Review verdict

**结论**：Merge with conditions（源码修复已完成；发布前仍需真机跨网验收）。
**模式**：Review；**对象**：本轮 Remote 连接释放、IPv6、连接详情和精简历史改动。
**首轮基线**：本地 `f769193edbb57f7e1c9f8320e5f3989ac6ddbe84` + 本轮工作树。
**提交集成基线**：先在 `origin/main` 的 `62241f40e15a256c17e066c3900226c585df82bc` 集成，随后保留主线新的测试隔离修复，快进到 `ccdcb20479a823b84123bcfbc88702fd6fd08ae3`。仅移植本轮选定 hunk，在独立工作树重新生成和验证；没有合入整个旧分支，也没有覆盖主线新增的账号 restore/refresh owner fence、HTTP 迟到请求取消和响应解码修复。
**信任级别**：trusted-local。开始时工作树已有大量其他修改；未回滚他人改动。本轮源码修复后，用户明确要求提交并合入 main，故在隔离工作树中准备专属提交；无 APK 发布。

## 实现与边界

- WebRTC：原生 close 抛错仍执行 dispose；并发释放复用同一个 Future；迟到 DataChannel 主动关闭，不再继续生成或应用 offer；传输层 fail/abort 不重复关闭 peer，同步 close 抛错也不跳过 Control 清理。保留异步 teardown，不能让失效的原生调用堵住 Relay 回退。
- IPv6：按地址字节识别 HTTP 自托管的 loopback、ULA `fc00::/7` 和 link-local `fe80::/10`；公网仍要求 HTTPS。修正展开回环及整个 link-local 范围的 LAN/P2P 分类。没有把“地址允许”写成“链路必定可达”，也没有强制 IPv4。
- 连接详情：展示实际所选 ICE pair 的手机/主机 IP 版本及 UDP/TCP，保留路径、耗时、RTT、回落原因。无地址或 mDNS 隐藏时保持未知；多个提名候选无明确选择时不猜；断线清除，Relay 不借用旧 ICE 信息。不存储或展示原始 IP、SDP、凭据。
- 精简历史：默认关闭，设置在远程主机页。仅支持 `remote.history.compact.v1` 的 Host 收到加密 `remote.history.configure`；严格验证 `{compact:boolean}` 回显，配置成功前不公开 session 或打开业务流。旧 Host 不收到该 RPC，不在客户端删事件或改 seq。
- 设置变化仅影响新 DshClient：切换主机后再连回，或重启 App 生效。相同 client 的自动重连固定首次实际协商模式；最初 full 后获得能力仍配置 false，compact 后失去能力返回不可重试的 `HISTORY_MODE_CHANGED`，要求重新选择主机，避免历史缓存混用。不重放有副作用的调用。

协议依据：[上游 §17](https://github.com/liguobao/ds-harness-remote/blob/479b94341c0d0de63846f21d0fcca26997d158d1/docs/protocol.md#17-capability)。Host 缩减历史工具参数和输出，不改变正文、实时流、审批或主机原始记录；不保证减少 Host 读历史成本。此轮未复制或修改 Host 的压缩算法。

## Findings

本轮范围内无未解决的阻断代码发现。独立复核提出并已修复：

1. 仅固定用户偏好仍会在 Host 能力增减时切换实际模式，混用原有 transcript 缓存；现固定首次有效模式并补能力变化测试。
2. 缺少 transport 选择信息时任取旧 nominated pair 会误报 IP/协议/延迟；现优先权威选择标识，仅允许唯一成功提名作为兼容回退，多候选保持未知。

A 行为：失败、迟到、重连、缓存模式和选中候选均覆盖。B 契约：外层 RPC、能力协商、严格回显、中英文和指南生成一致。C 安全：公网 HTTPS 限制、凭据与 IP 不外泄、无生产配置修改。D 协作：分离写域，Lead 复核差异；未创建 PR。E 范围：未夹带其他工作树清理，所选 pair 判定集中到同一私有入口。

## Clarifying questions

- **Q1**：截图中的 coturn 486 是否由客户端造成仍未定位。当前本机诊断对应 local/connected，不是该次远程连接；没有同一时间段的 allocation 来源、数量及释放记录。代码回归不能证明线上 TURN allocation 已释放，也不能把异步 teardown 本身定为泄漏。
- **Q2**：追加运行已有抽屉 IdentityBar 测试时，10 项通过、3 项在 320dp 的 1.0/1.5/2.0 字号语义标签断言失败（找不到“网络详情”）。失败发生在打开详情之前；本轮未修改其抽屉实现或测试。未独立还原前置工作树验证起因，因此不宣称已确定为既有缺陷，也未覆盖他人的修改来修它。

## Validation record（首轮旧工作区）

环境：Linux arm64，Dart 3.13.5，配套的 Flutter arm64 工具/测试引擎。本次 widget 测试实际运行，不是因架构跳过。缺失的 Noto CJK 测试字体从 [官方仓库](https://github.com/notofonts/noto-cjk) 下载到临时目录，通过 `DSH_TEST_FONT_DIR` 使用，未安装到系统。

所有最终记录基于上述本地 Head + 未提交工作树。Dart 首次测试自动改变了原本干净的依赖锁文件；已仅恢复该生成差异，并以 `PUB_HOSTED_URL=https://pub.flutter-io.cn dart pub get --enforce-lockfile` 成功恢复原锁定依赖，再完整重跑 Remote 的分析和 384 项测试通过。未保留依赖升级或镜像改动。

| 检查 | 结果 | 覆盖 / 障碍 |
|---|---|---|
| Remote 包 `dart analyze` | exit 0，无问题 | 完整包 |
| Remote 包 `dart test --concurrency 2 --reporter expanded` | exit 0，384 通过、4 跳过 | live 4 项缺少远程测试环境配置；未使用生产凭据 |
| App 聚焦 4 文件测试 | exit 0，37 项通过 | 原生 peer 清理、连接详情、精简偏好、relay backend |
| App `flutter analyze --no-pub` | exit 0，无问题 | 初轮两条 info 修复后全项目复跑通过 |
| 额外抽屉测试 | exit 1，10 通过、3 失败 | 见 Q2，不能写成全绿 |
| l10n merge/check | exit 0，49 parts / 5494 keys | 修改 ARB 输入后生成，非手改产物 |
| guide sync/check | exit 0，26 文件 | 中英文指南和内置副本同步 |
| `git diff --check` | exit 0 | 无空白错误 |

最终 App 命令（从 app 目录，以当前架构的 Flutter 工具入口调用）：

```sh
flutter test --no-pub --concurrency 2 \
  test/remote/webrtc_peer_cleanup_test.dart \
  test/remote/remote_network_details_test.dart \
  test/remote/compact_history_setting_test.dart \
  test/remote/relay_backend_test.dart
flutter analyze --no-pub
```

中途失败记录未隐藏：首次 Flutter 配置因缺字体未进入测试体；首次 l10n 生成在仓库根目录执行失败，改到 app 目录成功；指南生成因导航注解/标签校验失败，修正输入后通过；新增设置使旧测试依赖的启动开关移出懒加载视口，改为滚动到目标后验证；收紧候选选择后，原来没有成功状态却断言路径已确认的夹具失败，现分别断言“仅提名未知”和“唯一 succeeded 可分类”。装配阶段未接上 peerNetwork snapshot 时，相关回归也曾失败，接好后通过。首次恢复依赖锁文件时相对路径与工作目录不匹配，随后的 enforce-lockfile 拒绝了不匹配锁文件；纠正工作目录、恢复原锁后成功。所有修正后均复跑对应检查。

## Coverage and residual risk

- 已审：本轮 Dart 包与 Flutter 原生客户端变更、生产者到 UI/诊断消费者、中英文输入/生成物、上游协议和新增测试。
- 未审：开始时存在的其他修改、全部 App 测试、运行时/插件的其他功能。
- 未运行：新 APK 构建/安装、真实 WAN IPv6、真实 TURN 分配释放/配额压力测试、上游 Host 精简历史的跨设备联测。MethodChannel mock 不替代原生 libwebrtc/coturn 验收。
- 原生 close 永久卡住仍可能阻止其后 dispose 完成；此轮没有真机证据证明该状况发生，也未以任意超时并发调用原生 dispose。
- 改动尚在源码，当前已安装 App 不会自动获得这些功能；未重启引擎、修改 TURN quota、启用监控定时器或更改系统设置。

## 最新 main 隔离集成验证

集成仅携带本轮 47 个明确路径（含生成的中英文文案、指南副本及远程页截图），不携带原工作区的图片画廊、桌宠、手机操控、上传或仓库首页等其他改动。主线已有上传协商说明和测试钩子保留，不采用旧版本覆盖。

- Remote 完整 `dart analyze`：exit 0；完整测试 **457 通过、4 项 live 跳过**，包括主线新增的 restore、refresh owner、迟到 HTTP、响应解码回归。
- App 从主线原锁文件恢复依赖（`PUB_HOSTED_URL=https://pub.dev`，`--enforce-lockfile`），未升级依赖。首次使用不同镜像时 enforce 拒绝，换回锁文件来源后成功；Remote 包按其原镜像锁文件恢复。
- 新开关改变页面布局，定向重新生成 12 张相关远程页截图；已人工检查浅色登录页和深色 LAN 已连接页，未修改其他页面基线。
- 首次在 `62241f4` 扩展运行 Remote 全目录和设置索引：284 通过、7 跳过、22 失败。一项为本轮新增设置组导致的页脚相邻标题断言，已把仍然严格的 24dp 间距断言改为实际相邻的“远程传输”；其余单独取证，未直接重画无关金图来求绿。
- 独立干净 `62241f4` 基线：指定的 16 个旧页面 golden 中 1 通过、15 失败，和集成中的 15 项完全相同；SSH 保存确认测试 0 通过、5 失败，均在读取既有主机列表前 `No element`，和集成完全一致。随后保留主线 `ccdcb20` 的 prefs 测试隔离修复，再做最终验证。
- 干净 `62241f4` 的 no-dsh 子集同样 exit 1（0 通过、1 失败）：临时 HOME/PATH 未阻止探测找到手机已经安装的 `dsh`，实际为 dshTimeout 而非预期 dshNotFound。与以上 15 个 golden 和 5 个 SSH fixture 问题合计，集成剩余 21 个失败均已在干净主线复现。
- 最终验证不改无关金图、不添加 skip 或放宽断言：选择全部 Remote 非 golden 文件（仅通过 runner 排除本手机已安装 dsh 导致的 no-dsh 单项）、设置索引，以及本轮改变的 12 张页面 golden 做独立对比；未覆盖项与失败基线如实保留。
- 最新 `ccdcb20` 集成结果：Remote 非 golden 文件与设置索引 **279 通过、7 项 live 跳过，exit 0**（no-dsh 单项按上述环境证据在 runner 选择中排除）；5 个 SSH 保存确认测试在保留主线 prefs 修复后全部通过。本轮 12 张页面 golden 独立对比 **12 通过、exit 0**。
- 最新集成全项目 `flutter analyze --no-pub`：**exit 0，无问题**。生成物检查通过（49 parts / 5512 keys、26 份指南），三个依赖锁文件与主线无差异，专属暂存区无空白错误。尚未运行远端 CI 或真实 TURN/IPv6 跨网验收。

## Merge Conditions

1. 发布前在真实手机与支持精简能力的 Host 上验证 LAN/P2P IPv6、TURN/Relay 回退、反复断连后的 allocation 释放。
2. 验证精简与完整历史切换需新 client，审批和实时流保持原样，并验证 Host 升降级的模式边界。
3. 对 Q2 的抽屉语义测试补独立基线取证或单独修复；不得把相关全套测试声称为全绿。
