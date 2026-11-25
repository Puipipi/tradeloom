# Remote 自动选路与网络详情

本次对照 [ds-harness-remote `0aacfcfe`](https://github.com/liguobao/ds-harness-remote/tree/0aacfcfe85cbd1ad43545115a05e52dd146f7587)（2026-10-31），重点核对 Android 的 `src/lib/network-route.ts`、`src/services/network-route.ts` 与共享 WebRTC transport。改动随 App 1.0.4 发布；1.0.3 使用旧的默认关闭行为。

## 行为

- 自动尝试 LAN / P2P，然后 TURN，最后 Relay；移除用户可见的 P2P 开关。旧的 `remote_direct_p2p=false` 也迁移到自动策略，避免升级后仍停留在中继。
- Wi-Fi / Ethernet 保留 LAN 优先；确认蜂窝网络时跳过 LAN。VPN-only、短暂断网或未知信息不据此拆掉健康连接。确认 Wi-Fi 与蜂窝切换时重新协商 ICE。
- LAN/P2P 共用第一轮 ICE 探测，由候选优先级和实际连通性选路；该轮移除 TURN 配置，并过滤双方 SDP / trickle 的 relay 候选。不能仅去掉本端 TURN URL 后声称 TURN 不会抢先。
- TURN 阶段使用 relay-only ICE；阶段失败时创建新的授权连接，最终路径再做 Noise 握手。授权撤销或主机身份错误直接终止，不作为换路径的理由。
- 失败路径按 Host 冷却 45 秒；网络偏好变化后重新尝试。每个 RTC 阶段默认 8 秒，服务器更大预算最多 15 秒；ICE 凭据请求最多 5 秒。App 首次连接总等待预算为 45 秒，成功不额外等待。

## 网络信息

点击已连接主机旁或顶部连接卡的 LAN / P2P / TURN / Relay 标签打开详情。显示最近观测时间、实际路径、连接耗时、RTT 与回落原因；缺少观测时显示未测量。

刷新只按需读取现有 WebRTC stats，不新增后台 ping 或周期采样。RTT 是 ICE 候选对的往返时间，不等于一次应用 RPC 的耗时；Relay 暂不伪造 RTT。日志和诊断导出只包含受限字段，不包含 SDP、候选地址或凭据。断线、重连或连接替换后丢弃旧测量。

## 验证边界

- 纯 Dart 协议包：198 通过，4 个 live 环境门禁跳过；覆盖真实状态机、两阶段回落、候选过滤、短期冷却、授权失败、分块和主机密钥检查。
- App UI / 交互 / 截图：51 通过，包括中英文、四路径分离、最近观测时间、安全错误、未知值与迟到测量。
- 最新上游自部署 Server + 已发布 Host 0.6.0 / Harness 0.2.1-rc.5：4 项 live 测试通过，Relay 节点 4 次 attach、4 次 pong、143 个转发帧。仅本机隔离账号，不使用用户的在线 Host。
- App Remote 扩展回归：263 通过，7 个测试门禁跳过；最后定向 13 项通过，覆盖升级迁移、网络提示、重连竞态与日志原因白名单；Dart analyze 无问题。
- API 35 x86_64 原生 WebRTC：P2P 实连成功，ICE RTT 为 2 ms；分配节点的 Relay 实连成功。每条路径均完成 20 次往返、120 KiB 请求分块重组（收到 Host 的预期输入长度校验错误）、38,328 B 响应。
- 在专用模拟器中，按 App UID 阻断 IPv4 / IPv6 的 TCP / UDP 直连，仅放行测试 Server / Relay 端口：首次直连探测超时后自动回落 Relay，连接耗时 13,542 ms，后续传输全部成功。双栈规则均记录到实际拒绝计数，测试结束已移除。
- 原生 fixture 为客户端分配模拟器可达的 Relay 地址，为 Host 分配宿主机回环地址；WebRTC 信令转发和 Relay 节点是测试补丁，不代表公开自部署 Server 默认提供这些能力。只阻断 IPv4 或 UDP 不能充当直连彻底不可达的证据。

真实公网 NAT、实际 TURN 服务、移动网络和 OEM 真机另需验收。本机模拟器成功不能代替这些结果，也不证明所有网络下 P2P 都比 Relay 更快。
