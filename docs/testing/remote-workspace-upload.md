# Review verdict

**结论**：Merge with conditions（源码和可用自动验证已完成；界面截图与真机验证未完成）。

**模式**：Review；**对象**：[远程传输](<../../packages/dsh_remote/lib/src/carrier/tunnel_carrier.dart>)、[客户端接口](<../../packages/dsh_client/lib/src/workspace_upload.dart>)、原生聊天上传和抽屉主机详情的本次工作区改动。

**初始验证基线**：`f769193edbb57f7e1c9f8320e5f3989ac6ddbe84` + 功能改动；**PR 基线**：`28d43f8950138b716b32f291549ddcc6aedca5df`（提交时的最新 main）。**信任级别**：trusted-local。仅移植本次功能到隔离分支，原工作区其他未提交修改不属于本次范围，未回退或夹带。

## Findings

None found in reviewed scope。五轴核对：

- A 行为：上传固定在一条认证连接，按 Host 协商的大小顺序确认分块（最多 64 KiB）；校验提交路径和长度，失败不发送问题，不自动重放变更。上传返回工作区路径，不伪造附件 receipt；文本模型拒绝图片时复用同一 prompt ID，改为上传文件路径。
- B 契约：只使用实时 `workspace.upload.v1`；不放宽 Harness endpoint 白名单。本机/SSH 保留原附件上传；中英文输入与指南已生成同步。
- C 安全：校验 basename、确认偏移和 `./name` 返回路径，不记录上传数据；失败 best-effort abort。是否可写、同名文件发布及路径/版本限制仍由 Host 决定。
- D 流程：限定修改范围，按维护者要求提交分支和内部 PR；不合并、发布或安装，依赖锁与生成配置最终无差异。
- E 范围：复用现有网络详情，图标和主机切换分开；不引入轮询或新的网络测量链路。用户要求取消的额外 20 MiB 限制及其专属 UI 校验已撤除。

## Clarifying questions

无待确认问题。用户明确选择取消 App 额外 20 MB 上传限制，不是隐藏文件大小文本。

## Validation record

下表记录初始验证基线上的实际结果；隔离分支重验结果另外记录在 PR 正文，不将两者混为同一次执行。环境是 ARM64，原生 Dart 3.13.5；`dart` 使用 `/root/dev/dart313/dart-sdk/bin/dart`。

| 检查 | 结果 | 覆盖 / 障碍 |
|---|---|---|
| 客户端 `dart analyze` | exit 0 | 无问题 |
| 客户端 `dart test` | exit 0，484 通过 / 27 跳过 | 跳过项缺少 live fixture、运行时或外部快照 |
| 远程包 `dart analyze` | exit 0 | 无问题 |
| 远程包全量测试，见下方实际命令 | exit 0，306 通过 / 4 跳过 | 含 105 个 workspace upload 协议回归；4 项需真实服务凭据 |
| App `dart analyze` | exit 0 | 整个 App，无问题；不是 widget 运行结果 |
| `python3 app/tool/l10n_merge.py --check` | exit 0 | 49 parts，5486 keys |
| `python3 app/tool/guide_sync.py --check` | exit 0 | 26 files |
| `git diff --check` | exit 0 | 无空白错误 |
| 依赖锁、l10n 配置差异检查 | exit 0 | 最终没有依赖升级或配置变化 |
| Flutter widget / golden、APK、真实远程上传 | 未运行 | 测试引擎为 x86_64，主机 ARM64；没有本次构建的 APK 或真实 Host 验证环境 |

远程包为避免 `dart test` 自动重解算依赖，直接执行缓存测试入口；不是跳过测试：

```bash
# cwd: packages/dsh_remote
/root/dev/dart313/dart-sdk/bin/dart \
  --packages=.dart_tool/package_config.json \
  /root/.pub-cache/hosted/pub.dev/test-1.33.0/bin/test.dart
```

本机官方 Flutter tooling 能通过原生 Dart 源码入口运行，但 SDK 自带 formatter 是 x86_64。l10n 由官方 `gen-l10n` 生成，临时关闭其 formatter 后使用原生 `dart format` 格式化生成结果，随后恢复原配置；没有手改生成代码。

## Coverage and residual risk

- 上游依据：[ds-harness-remote 0.6.2 / 479b943 协议](<https://github.com/liguobao/ds-harness-remote/blob/479b94341c0d0de63846f21d0fcca26997d158d1/docs/protocol.md#L1529-L1648>) 和 [Host 实现](<https://github.com/liguobao/ds-harness-remote/blob/479b94341c0d0de63846f21d0fcca26997d158d1/packages/plugin/src/workspace-upload.ts>)，MIT；来源已补入[第三方声明](<../../THIRD_PARTY_NOTICES.md#L120-L148>)。
- App 沿用普通附件单文件 200 MiB 和单消息总预算；远程传输层只保留协议绝对上限 1 GiB。Relay/TURN、未知路径或旧插件通常仍被 Host 限到 20 MiB，不能通过改 App 绕过。
- 协议回归覆盖大于 20 MiB 的声明能进入 Host open、Host 拒绝前不读取文件数据；拒绝保留原错误码。另覆盖畸形确认、危险文件名、同名改名、超时、连接退休、失败清理及真实 Noise 通道的精确 RPC 参数。
- 初始本机阶段没有运行原生 UI 测试；随后 [CI 41691203233](<https://github.com/ccch1mneyyy/dsh-Go/actions/runs/41691203233>) 实际执行全部 Flutter 分片。其他检查通过，Flutter 1 有 6 个失败：3 个新测试把 Tooltip 当作 label 查询、1 个旧几何测试取到了拆分后的图标而非主机控件组、2 张网络详情 golden。已按 Flutter 3.47 的 tooltip 语义和控件组边界修正断言，保留原点击/尺寸/间距要求，不删除或跳过测试。
- 提交超时可能已经落盘；abort 成功也不代表已提交文件被删除。没有宣称可恢复跨连接上传或隔离恶意本地主机进程。

## CI follow-up

- 浅色和深色网络详情基线取自上述 CI 的 `golden-failures-1`（artifact `13257104145`），不是手工绘图。替换前逐一核对 artifact master 与仓库原图字节一致，并人工查看实际渲染：只有新增主机/方式/状态所需的内容和弹层高度变化，没有溢出或遮挡。
- 核验上游协议后，按 open 返回的整数 `chunkBytes`（1–65536）切片，不再把当前默认 65536 当作固定 v1 约束。新增 32 KiB / 1 byte 正向及非法值回归；隔离分支 `dart analyze && dart test` 再验为 313 通过、4 项凭据环境跳过。
- 修复后的完整远程 CI 结果以 PR 最新提交的检查为准；不能把首轮失败写成通过。本机仍未构建 APK 或执行真实远程 Host 上传。

## Merge Conditions

1. 在匹配架构的 Flutter 环境运行上传、抽屉详情等相关 widget 测试，并审核更新抽屉/网络详情 golden。
2. 构建 APK 后真机验证图标与切换区域互不干扰、主机切换/断线，以及 LAN/P2P 大于 20 MiB 上传和 Relay/TURN 的 Host 拒绝路径。
