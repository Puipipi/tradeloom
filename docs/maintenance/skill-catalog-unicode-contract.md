# skill catalog 描述截断合同（672）

基底63e255f、DSH0.2.2-rc.1。默认catalogDescriptionMaxLength=500，正常合法SKILL frontmatter描述经文件系统SkillRegistry进入agent/pre-step目录user-role消息。实际CLI/Agent的首Messages请求已经证实496a+emoji+tail在497单位裁切时产生孤立high surrogate，并非仅UI label。

保留normalizeWhitespace、trim、原三个点ellipsis、UTF-16总预算和未裁切输入。仅在确需截断时，若maxLength-3切点的左侧为high、右侧为low，退一单位再附原ellipsis；不新增依赖，不改变名称、技能发现、权限、完整skill正文或加载行为。最小允许上限3时保留前缀为空，仍只有ellipsis。

catalog source.entries和模型渲染文本共用该描述结果；不改digest/去重逻辑。未找到309处捆绑PartialArguments.textPrefix的实际消费证据，因此不改其代码或扩UI范围。

新增验证以*-live.mjs显式执行：真实CLI/Agent/provider，自有文件与本地模型协议fixture，没有真实远程模型或Android。普通先失败是相同正式断言在原版失败，不把早期观测脚本自然exit0称为通过。不会推导JSON不能编码或模型必然拒绝。会改变runtimeVersion，Android未编译，PRoot/ARM未运行，不改pins。
