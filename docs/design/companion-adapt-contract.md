# C906：伙伴适配的请求、完整替换与主线接线

基底：`2ef25c07be4c63df15349ea491da6763da1b0528`。本期承接原 C810（基底 `431bc52a647fbd587e29379e1f90ce92b409a484`），修复其把当前 alias 当成替换后映射的缺口。仍为 App-local adapter v1，复用既有舞台能力；不把它冒充 C720 市场 adapter v1。两个格式同名不代表能力相同，市场上传应先转换并拒绝无法表达的字段。

## 1. 两种模式共用数据

`companion_adapt_contract.dart` 是无 I/O、无 Flutter 依赖的纯模块。原 `companion_adapt.dart` re-export，旧调用方无需换 import。`companionAdaptInput` 返回 `{schema:"dsh-go/companion-adapt-request",v:1,target:"app-local-adapter-v1",vocabulary,probe,verifiedEffects,wanted,truncation,current?,currentDropped?,userFeedback?}`；`companionAdaptRequest` 是它的 JSON 字符串；`companionAdaptFullRequest` 只在同一字符串前加 `/companion-adapt`。

`probe.mocFile` 来自 stage 的相对路径，绝非指纹。App 保存时仍用真实 moc3 计算 SHA-256。参数最多 800 个可用记录（原请求只取 600），名称/分组最多 160 个 Unicode 标量，部件 300，表情/动作各 256；反馈 1000。有限数、正确范围和默认值是入表前提。Stage 报告原始 min/max/default，不做三位小数舍入，避免把很小但有效的范围变成零宽。`parametersComplete` 只说明参数数量是否完整，不能当语义已验证。字段被截断或排除时明确留计数；替换后尚无可用规则或 identity 证据的标准名写入 `coverageUnknown`。

Stage 新增完整 `ruleAliasVersion: 1` 与 `ruleAliases: {标准名:{ids:[物理ID,...],scale,offset}}`，取自 `model.ruleAlias`，不取当前 adapter 所在的 `model.alias`。ids 的原始顺序与重复、有限非零 scale 和有限 offset 均保留；不根据已舍入的范围重算，也不从仅有 ids 的 `linked` 猜系数。已存在规则的系数不受候选 params 的 1000 上限约束。旧舞台、未知版本或任一坏规则记录令整个快照为 null，不能把坏记录丢掉后误证该名字没有规则；空对象才证明无规则 alias。规则目标仍可能因 800 上限或保护元数据不在允许名单中，这种规则不能支持自动候选。

`linked` 始终只是当前 alias 的观察，可能包含本次将删除的旧 adapter；请求不再向它补造同名 identity。规则快照仅用于本次同模型、同 probe/evidence 的校验；模型更换或证据过期后不得复用。

`CompanionAdaptEvidence` 只接受 App 测得或明确人工复核的资源效果摘要：精确加载名到效果描述的 map。它是调用参数，不从模型回复、模型名字或 `probe` 自称 safe 的字段构造。现有 stage 不产这些测量，因此默认两个 map 都空；已加载的名称仍可供分析，但不能执行。未来测量须核对参数效果、显隐、声音、事件及副作用，不能拿一张截图或名字替代资源审查。

## 2. 输出字段与实际边界

| 字段 | 本期 App 自动适配 | 与 C720 的区别或处理 |
|---|---|---|
| adapter / moc | adapter 可省略或为 1；moc 只由 App 写盘加入 | 不接受模型捏造指纹；路径不当 hash |
| params | 标准名 → 一个 ID 或同驱 ID 列表；共同 scale/offset | C720 只有一个目标；列表不能直接发市场，不能偷偷取第一项 |
| emotions.face | 由替换后有效映射支持的标准通道平滑增量，按语义域夹值；不接受随后被眨眼覆盖的 EyeLOpen/ROpen | 不是绝对姿态；当前 linked 不能证明替换后可用，不开放任意 native 参数或虚拟 eyelid |
| expressions / motions | 精确加载名 ∩ App 验证效果名单 | 仅已加载或名称像开心、挥手不够；默认不开放 |
| zones | 只复制报告中非 default 来源的既有坐标；xFrom/xTo 成对 | 模型矩阵后、相机前；C720 无 x 区间，投影会丢失横向分离 |
| framing | 本期 AI 校验明确列入 dropped | 基底校验曾悄悄吞掉；待可见边界/相机事实与验收再开放 |
| tail | 实际存在、非保护项，且已登记或元数据明确为尾摆 | 名字仍是候选依据；不能用任意参数假装尾巴 |
| pose / toggles | AI 候选不执行 | 原生 pose 与市场 toggles 不是同义字段，禁止机械转换 |
| notes | 最多 60 Unicode 标量，一句解释 | 本地 UI 预算；C720 市场允许更长，不能反向推成 UI 容量 |

无效显式 scale/offset 会拒绝整项，不再改成默认值后执行。部分未知目标的 id 列表也整项拒绝，避免静默变成只驱一只眼；重复 ID 去重。未知顶层或嵌套字段记录 `dropped`，无效/未知版本不能升级为 v1。`zones:[]` 无法关闭基底舞台默认区，因此明确拒收而不宣称已关闭。`framing`、`pose`、`toggles` 和 native face 的自动拒收不改变素材作者原有 character.json。

完整替换的判据与实际 `StageModel.adapt` 一致。先从完整规则快照构造基线：某标准名有规则时，其全部目标都必须在有效物理名单中；有规则但目标不可用，不能回退到同名 identity。只有已知规则中确实没有该名字且存在同名可用物理参数时，才能使用 identity。再叠加本次实际接纳的 candidate.params；被丢弃的候选映射不参与证明。最后仅接纳这个有效表支持的 face。规则未知时基线为空，face 只能依赖本次显式合法 params。

例如物理参数只有 `SmileShape`，旧 adapter 为 `ParamMouthForm → SmileShape`、规则为空，新候选只有 `emotions.happy.face.ParamMouthForm=0.5`：该 face 必须进入 dropped，结果为空。checker 不从旧 linked 自动复制映射，不伪造 scale=1；若候选明确保留 `id:SmileShape, scale:-2, offset:0.3`，实际 set(0.5) 为 -0.7，add(0.5) 为 -1。若原规则本来就有非单位系数，省略旧 adapter override 后恢复的是该规则的精确系数。id 列表为单跳物理目标，不递归解析另一个标准名。

保护项名称过滤只是一道明确线索检查，不是完整语义识别器。新参数映射仍是模型提出的候选，结构检查不能识别任意隐藏在普通 ID 下的错误效果；主线仍需用真实舞台验收。没有新增测量，本补丁不宣称“所有未知模型都已安全适配”。

## 3. 提示词的关键选择

输入全部 JSON 编码；元数据、反馈和现有表都按数据处理，避免把包含换行或伪指令的名称直接拼成指令行。system 是稳定文本，主机技能从 `references/contract.txt` 读取同一份提示；`node tooling/companion/sync-adapt-skill.mjs --check` 检查逐字一致。

返回完整替换表；current 只是经同一 checker 重验的参考，不自动合并。需要保留的旧 adapter 映射必须在本次候选 params 中明确给出仍有效的目标和原系数；省略会删除该 override。仍在的规则不必复制进候选 params。正常睁眼域 0..1 不因模型最大值 2 自动乘二；`set(v)=v*s+o`，`add(d)=current+d*s`，增量不加 offset。当前 stage 的 EyeSmile 映射标尺为 0..1，但 dizzy 仍调用 -0.5；词表明确这一事实，不假装与 C720 的统一域完全一致。L/R 保留模型标记，角度方向按画面描述。

没有几何时不按人形比例造头、身体、尾巴区；没有资源效果时不从 F01 等名称猜情绪。允许只输出 notes，`companionAdapterEmpty` 会判定无可用改动；这不是适配成功，也不花额外轮次假造结果。

## 4. 主线接线与挂载

轻量模式仍用 `companionAdaptAsk`，已内部接入新请求与校验；可选 `evidence` 必须由 App 持有。同一次请求、验收使用同一份 probe/evidence 快照，模型切换或包卸载后丢弃迟到结果。写盘前保留原有主机/素材所有权检查。

完整模式由页面在独立技术会话发送 `companionAdaptFullRequest(probe, note: ..., current: ..., evidence: ...)`；不要放进陪伴聊天 backlog。收回文本后：`companionAdaptJson` → `companionAdapterCheck(..., evidence: sameSnapshot)` → 若非空，再走既有 `companionAdapterWrite` 与舞台 adapter 命令。空结果保持旧表。不要让主机直接写手机文件，也不要把主机的元数据或回复当新的白名单。页面接线、取消、超时和最多三轮调度均未在本补丁实现。

本地技能已接到三个真实入口：Flutter assets manifest、`extraSkillLoadersProvider`、Kotlin `ManagedSkillRequest.names`。继续使用现有事务安装、引擎代际与用户接管规则：删掉 managed 注释后不覆盖。远程主机只在已有明确安装操作中加载 `loadUiSkillBundle(null, companionAdaptSkillName)` 并交 `UiSkillRemoteInstaller.install(context, host, bundle)`；不能因有发消息权限就后台安装。旧主机缺技能时可选择使用轻量模式；若要在普通技术会话内联，发送同一 `companionAdaptSystem` 与同一 JSON 报告，App 仍校验，不声称技能已安装。

`UiSkillRemoteInstaller` 目前是接口，默认 provider 为 null，本补丁未实现远程安装 UI。主线若通过 relay 提示安装，不能直接复用现有 `uiSkillInstallPrompt(bundle)`：它仍固定 dsh-go-ui 的目录和三个文件，会漏掉本技能的 `references/contract.txt`。远程接线须在用户明确的安装操作中传完整 `bundle.name/files` 并验安装结果；已有 `uiSkillShellScript(bundle)` 按 bundle 通用生成 SSH 脚本，但本轮未执行远程安装。

## 5. 验证与仍需主线验收

纯 Dart：`dart tooling/companion/check-adapt-contract.dart`；请求生成/候选校验：`dart tooling/companion/adapt-dry-run.dart probe.json [candidate.json]`。跨语言替换回归：`DART_BIN=/path/to/dart node --test tooling/companion/replay-adapt-replacement.test.mjs`；它执行已钉 Stage 的真实 probeReport/fit/adapt/set/add、真实 Dart checker，再把返回 adapter 送回真实 adapt，记录 native API 参数，不模拟 Core clamp 或像素。规则范围测试中，少数明确标记的规则边界夹具直接设置 ruleAlias，其余由实际 fitParams 产生。

原公开 Haru/Wanko 的参数事实、固定官方来源、输入输出与日志在 C810-evidence.zip；原两例都是 notes-only、empty=true，不能称为两次成功适配或本轮新的 AI 实验。没有模型、Core、纹理或曲线进入补丁。C904 的 24 模型历史参数回放保持独立、更新整个 stage 的明确 SHA；读取历史 Core 表不代表本期重新运行了模型或看过截图。

Flutter 用例覆盖现有轻量请求/写盘、页面请求格式与本地技能生命周期；Kotlin 用例使用真实安装器加载全部技能资产、比较每字节、验证用户接管。本次实际运行了哪些，以精确补丁 SHA 的独立复核报告为准；不能把已编写但未执行的 Flutter 测试当通过。真实用户 API、设备 WebView/GPU、像素验收、远程安装界面均须主线另验。
