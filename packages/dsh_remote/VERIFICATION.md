# P2P 验证记录

> 下文保留 1.0.3 的历史验收。后续默认自动选路、分阶段 TURN 回落及网络详情的改动与验证见 [Remote 自动选路记录](../../docs/testing/remote-auto-network.md)。

本轮完成 Android 35 x86_64 模拟器上的真实 P2P、关闭直连时的 Relay，以及两种 ABI 的依赖增量 APK 对照。没有进行真机、跨公网 NAT 或真实 TURN 验证；也未宣称最终发行物的原生许可证审计已完成。

## 验证范围

实现基础为 `ef2d69b1` 与 `3b2d9918`。App 的「直连优先（P2P）」默认关闭；开启后才在后续连接尝试直连。纯 Dart 协议层通过平台接口使用 WebRTC，App 适配器固定依赖 `flutter_webrtc 1.6.3`，Android SDK 为 `io.github.webrtc-sdk:android:150.7871.04`。

本轮原生验证使用独立 probe 入口 `app/lib/dev/remote_p2p_probe_main.dart`，连接本机自建上游 Server（`7e387df`，仅测试时补齐 WebRTC 信令转发）与打包的 Host 插件 `0.6.0`，Host 运行在 `dsh web 0.2.1-rc.5` 并使用原生 `@roamhq/wrtc`。Server 未配置 STUN/TURN，模拟器通过 `10.0.2.2` 访问宿主机。日志中的 `p2p` 是实际选路结果，不代表已覆盖公网穿透。

| 检查 | 实际结果 |
|---|---|
| `dsh_remote` 测试 | 191 通过，4 个 live 测试因未设置环境而跳过；包含分块、ICE、选路、超时、迟到 peer 清理与新连接/新 Noise 的 Relay 回落 |
| `dsh_remote` analyze | 无问题 |
| App 定向测试 | 10 通过：直连偏好默认关闭、设置与后端接线、连接路径展示及许可证登记；定向 analyze 无问题 |
| Android 原生 P2P | Android 35 x86_64；连接 1,932 ms；客户端最终 `transport=p2p`，Host 记录已认证通道 `P2P` |
| Android Relay-only | 同一模拟器，关闭直连；连接 1,173 ms；客户端最终 `transport=relay`，Host 记录已认证通道 `Relay` |
| TURN | 配置、过滤与候选选路有单测；没有真实 TURN 服务或流量验证 |

两条真实链路均执行以下检查：

1. 读取会话列表，返回空列表（该隔离 Host 未创建会话）。
2. 发送 120 KiB 搜索请求，收到 Host 对 500 字符搜索上限的预期校验错误。错误说明大请求已到达并重组后进入业务校验；不表示超限搜索成功。
3. 接收 `settings/describe` 的 38,328 字节响应。P2P 在此覆盖超过 8 KiB 的 DataChannel `RTCH` 分块传输。
4. 完成 20 次往返，结束时仍保持对应的 P2P / Relay 路径。

本轮没有用模拟网络栈代替上述两条原生链路。ICE 超时、协商失败后新建 Relay/Noise、真实 TURN、真机及 WAN/NAT 的证据边界仍不同：前两项由单测覆盖，其余没有本轮实连结果。Relay-only 成功不能写成原生运行时故障回落已经实测。

## APK 依赖增量

相同 baseline 源码快照、相同 release 构建配置，分别比较不带 WebRTC 依赖与加入本次 WebRTC 依赖的产物；两边使用构建号 `10300400`。这是依赖 A/B 测量，不是本轮所有功能整合后的发行 APK，也不包含最终完整 Linux runtime 体积。不得将表中绝对大小作为正式安装包大小。

| ABI | baseline / B | 加 WebRTC / B | 增量 / B | 增量 / MiB |
|---|---:|---:|---:|---:|
| arm64-v8a | 29,021,417 | 46,288,191 | 17,266,774 | 16.467 |
| x86_64 | 29,295,716 | 46,562,493 | 17,266,777 | 16.467 |

SHA-256：

```text
aea299f9fda7012f8a5c1f6fe9dbb9b89a08f3e2eca4ab1045fbefd7230b676c  baseline-arm64.apk
bd8513e90836dfef898ed40f62c454c454d958c4737f1ebb909a718529edc248  webrtc-arm64.apk
e98f95f1800dc1b37e2283ec0c24f551f034b6420fc5d01bea2b1d89e7674070  baseline-x64.apk
1f5cc729d5ba679331bcd0d3f0cf7dfbd5a6ae21d538a18bc833f17927c9c745  webrtc-x64.apk
a57d2391f73566511eb004a954a1847638f2c0bfff102c2b23c8b2e20129ed10  p2p-probe-x64.apk
```

直连开关不会移除 APK 已打包的原生依赖，默认关闭仍承担此体积增量。

## 原始记录与发行前边界

本次验收的本地归档保存 `p2p-e2e-final.log`、`p2p-apksize.json`、`p2p-apksize-ab.log`，以及测试与 analyze 日志。这些是本机记录，不随 Git 分发；上面的关键结果与以下摘要记录本次证据，不包含隔离账号的凭据。

```text
c2e93b36ec0210d6502500f1baec48642e556a011b25e73710976e90e708bce4  p2p-e2e-final.log
3d33dd1d7b08cc94b2c5d6dec47269f61204078c8156ff050d5e350915cb68af  p2p-apksize.json
```

上述 P2P 记录仅整理已完成的构建/测试证据，没有重跑构建或操作模拟器。2026-10-31 的许可证补齐将官方 `v150.7871.04` 标签的完整 788,358 B / 30 章节许可汇编原样打包，并通过 `LicenseRegistry` 的 `WebRTC` 条目展示；BSD/PATENTS 与 flutter_webrtc NOTICE 保留。已比较同标签官方 AAR 与实际 Maven AAR：所有 ABI 原生库字节一致，唯一内容差异为 Java class major version 降级。5 项许可定向测试通过，包括完整 asset 加载、SHA-256、章节和原有条目。

来源、精确摘要、核验边界及最终 APK 校验命令见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md#完整上游通知的随包收录2026-10-31)。这关闭了完整上游通知未随包收录的缺口，不宣称完成实际链接组件的独立 GN 依赖图审计；最终发行 APK 的 asset 摘要和许可页访问仍由发行构建验收，并单独记录结果。
