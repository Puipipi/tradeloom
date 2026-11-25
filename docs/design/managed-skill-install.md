# 本机技能安装：主 isolate、原生串行事务与写入许可

## 目的和边界

`RootGate` 保活 `UiSkillAutoInstaller`。每次本机内核 ready，App 按 UI → plugin → guide 顺序维护三个内置技能。旧实现的 `installUiSkill` 虽返回 Future，函数体的 exists/read/create/flush/rename 均同步，在 Flutter 主 isolate 上逐文件执行。

生产自动入口现在调用私有 `dsh/runtime` 通道，由 `RuntimeController` 的同一个 worker 执行文件事务。这个 worker 同时承载 install/reset/activateRootfs，因此旧事务不会在原生已替换的新 root 上继续提交。原 `installUiSkill` 仍是显式独占目录的同步参考 helper，供文件/SSH 等测试使用；缺插件、未知代次、拒绝或错误均不触发生产同步 fallback。

本修改不缩短引擎 RPC、资产读取或磁盘本身的耗时，不改变 A5 的启动、PRoot/direct 选择或进程归属逻辑。配置文件同步事务和大 JSON 解码未随此补丁修改。

## 私有许可与调用合同

`RuntimeStatus.managedSkillGeneration` 是可选的正整数。原生每次新的技能写入许可使用单调代次；它不是 `runGen`，也不是一般 RPC 的授权。

- ready 绑定真实 `runGen`、token、当前 Flutter engine attachment。
- 正常同一 ready 重报保持同一许可，避免重复安装。
- stop 请求立即退休技能许可，不等 Service 收到异步 ACTION_STOP；install/reset/退出/新 run 的 phase 变化也退休。
- engine detach 退休 owner；新 attachment 退休旧 owner，并在仍 ready 时签发新的许可代次。旧 handler 不能使用新许可；旧 wire 即使到达新 handler，旧代次也不能借到新 owner。
- 许可由原生状态回传后由 Dart 捕获；不能在请求到达/执行时为旧请求补获最新代次。token 重用的 A→B→A 也不能恢复旧许可。
- 不做跨 App 进程死亡的代次持久化；旧进程的 worker、Flutter messenger 与请求都随进程结束。

Gate 在同一把短锁内分别保存实际 `onReady` 已确认的运行事实与 attachment 的写入 scope。首次 attachment 晚于 ready、或替换 attachment 发生在 ready 已确认但 `RUNNING` 尚未发布时，都从仍有效的事实签发当前 owner 的新许可，无需再次 ready 或再次 attachment。detach 仅退休该 owner；stop / retire 同时清掉运行事实和 scope，后续 attachment 不能恢复已退休运行的写权。Controller 不再分离读取 phase / token 后为 attachment 补报 ready。

锁序仍为现有 Controller monitor → Gate monitor；Gate 内没有 IO、回调或对 Controller 的反调，取消旧 owner 的队列工作在 Gate 返回后执行。attachment 不等待 `onReady` 内原有的日志文件操作。`STARTING` 阶段可先记录许可，但安装仍由 Controller 的 `RUNNING`、runGen、stopGen、resetting、token 与 scope 条件共同准入；许可不是启动完成的替代标志。

| 方法 | 输入 | 回包 |
|---|---|---|
| `installManagedSkill` | `requestId`、`expectedRoot`、`expectedToken`、`expectedGeneration`、固定 `name`、`files` | `result`、`current`、固定 `reason` |
| `cancelManagedSkill` | 精确 `requestId` | 空；取消许可，不声称回滚 |

`result` 为 `installed` / `updated` / `unchanged` / `userOwned` / `noHome`，未完成事务则为 null。`current` 在回包实际交付时重验；已经写入的事实不会因晚到退休而伪装成未发生。Dart 只发布当前 Ref/build、运行状态和许可均一致的结果。

`reason` 是 `invalid` / `stale` / `duplicate` / `cancelled` / `io` 等固定值；不含 token、文件内容、系统错误正文。缺失或异常 expectedGeneration 在 native 拒绝；旧版本没有许可也不会绕到旧 helper。输入 token 只用于私有比较，禁止输出到日志。

## 有界性和排队

Dart 每次 build 捕获 Ref、bridge、resolver、loaders。一个 drain 最多有一个在执行批次和一个最新待办；运行中的不可取消 resolver/loader 需先结束才会处理最新待办，不宣称能中止底层资产 IO。新 ready 替换待办；旧 await 返回后逐步校验，既不写新 root，也不回滚新状态。

Native 全控制器最多一个 active、一个 latest pending。取消 active 后仍占用其工作槽，直到物理 IO 退出；不能通过反复取消向 Executor 堆积无界文件任务。pending 被替换时精确结束旧回调。回调只保留轻量许可记录，取消的 pending payload 不被回包闭包继续占用。主线程发起的取消/替换直接回包；worker 结果回主线程。

| 项目 | 上界/规则 |
|---|---|
| bundle 名 | dsh-go-ui / dsh-go-plugin / dsh-go-guide |
| 文件数 | 64 |
| 单文件 UTF-8 | 512 KiB |
| 总 UTF-8 | 1 MiB；超限整单拒绝 |
| main 预检 | 字符串类型、数量、UTF-16 长度上界；不编码、不读磁盘 |
| 相对路径 | 最多 512 字符，ASCII 安全段，无绝对路径、`.`、`..` 或空段 |
| requestId | 非空，最多 200 字符；owner 内唯一 |
| root/token | 各最多 4096 字符，token 不输出 |

MethodCodec 的编码/解码仍有同步成本。当前三份资产共 50 文件、375727 UTF-8 字节；这只是测量时版本的事实，不是未来资产永久大小。代码用固定预算验证，不截断文件或半份技能。

## 文件事务

1. 在 worker 内核对 expectedRoot 的 canonical 路径；不在 Android 主线程做 canonical 文件访问。
2. 严格编码 UTF-8并核总字节；确认输入 SKILL.md 的 frontmatter 有 managed marker。
3. 本机 `.dsh` 不存在时 noHome；已有 SKILL.md 不可读、UTF-8 异常、超出读取上界或没有 managed marker 时 userOwned。
4. 按原文本比较，匹配则不写。读取保持 Dart 的开头 BOM 处理；文件比较有界。
5. 所有非 SKILL.md 文件先提交，每次提交前验当前许可；临时文件 flush 后同目录 atomic move；SKILL.md 最后。
6. 取消/错误清理本次临时文件。新装未提交 SKILL.md 的半成品不会作为完整技能出现；后续正常运行可修复。

已经进入的单个文件系统操作可能完成；取消不是事务回滚，也不承诺硬磁盘超时。升级时已有 SKILL.md 的技能可能暂时看到逐文件更新，这是原实现已有的粒度。原生 rootfs 激活不能与 writer 交错，但不把这些路径校验当成对抗另一个同时恶意改 symlink 的进程的文件系统沙箱。

## 测量、测试与设备边界

桌面 Flutter test 主 isolate 使用真实资产、真实临时磁盘执行旧同步事务；首装排队事件中位约 116ms，托管升级约 80ms，所有 8 次各类样本事件都在整批完成之后。共享主机负载未隔离，不外推 Android 的帧时间/启动总收益。

新路径分别验证：真实 RuntimeBridge/MethodCodec 携带实际 bundle、受控未完成 native 回复时事件可交付；真实按钮在事务未完成时可点击；纯 Kotlin 真实文件/线程和实际 activateRootfs 串行；Android36/Flutter embedding 的真实 API 编译。这些共同支持结构上的主 isolate IO 移除，但不能替代 Android 实机性能测量。

设备验证应记录同一机型/运行版本/热冷状态，测首次、无变化、托管升级和用户接管；安装期间实际滚动/返回、stop→ready、重置/升级、Activity 旋转和 Flutter engine 重建；核 SKILL 最后、字节/mtime、结果代次及无遗留临时文件。禁止记录 token。未运行的设备路径必须保持未验证状态。
