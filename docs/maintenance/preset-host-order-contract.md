# SDK 保留 Host 的 Agent preset 顺序

Refs W17-B；无对应公开 issue 编号。基底 63e255fab5cb9d817af30b631c3643ccce8e9231。

官方 agent-preset 的 order 是可选 number。registry.list 按 order（缺省 Infinity），相等时按 id 排序；agentPresets/list 返回权威顺序及 isDefault。SDK listAgentPresets 的公开约定也是 Host 顺序，不应基于较窄的展示 DTO 再排序。

只删除 SDK 的二次 sort。保持 DTO order 为 int?：合法小数仍不表示为整数，但不再影响返回顺序；不新增协议或改变默认选择、诊断、名称等字段。Host 的小数、较大显式 order、相同 order 的 id tie-break 和省略值顺序均原样保留。

普通测试使用现有公开 DshClient/FakeDsh 测试设施锁定消费合同；真实手动 live 使用官方 WebHost、自有声明式 preset、实际 RPC 与 DshClient，不伪造 Host 排序。原 features_api_test 的两条未排序假数据改为真实 Host 顺序，原期望与其它行为保持。空 roster 普通控制不需要删除 Host 内置 preset。

不会改 runtimeVersion；Android 未编译。没有远程模型、真实账号或设备验收；live 的长驻 Host 由 finally SIGTERM 收束，不能称自行自然退出。该修改仅修客户端返回顺序，不声称 order DTO 支持所有 JavaScript number。
