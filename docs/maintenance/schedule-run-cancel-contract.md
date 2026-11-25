# 639：手动 schedule.run 的投递前取消

先行约定与实现边界，基底 d935432d18cd83c951a87823b791b66c18426a64 / DSH 0.2.2-rc.1。

现行官方 run/request signal 文档承诺进入事务后、投递前检查取消。runNow入口已有检查，但随后await recoverOutstandingExecution/resolveTarget，返回后没有再查就调用send；send第一项实际业务动作是同步agent.followup(message)。正常调用在目标恢复期间取消，原版仍新增本次投递及history，已由真实Host公开入口复现。

最小变化：await resolveTarget(task)之后、send之前再次signal?.throwIfAborted()。保持原reason身份。不增加新的signal参数、消息协议、timer或订阅。

边界：
- 只防止本次手动run在已观察取消后开始新的send。已有task不删除，定时计划不改变。
- recoverOutstandingExecution可能恢复早先已经持久化的投递，不因本次取消撤销。
- new/new_once目标解析可能已预留身份、创建会话、关联workspace或命名；不承诺完全零写入，不自动删除这些准备结果。
- send同步followup之后属于已开始投递；随后signal取消不要求回滚已经入队的消息/持久历史。
- 不变更ADD3无actor Remote create/edit行为，不变更工具独立授权。

真实证据：先Host打印ready，再SessionController.create普通会话、sessions.flush、remoteCreate未来任务、run正常成功（normal-run.log）；随后相同路径只增加公开schedule/resolve-agent异步hook gate，在gate内abort，原版仍history1（cancel-red.log）。没有直接调用ScheduleRuntime私有方法。

测试只在preload推进明确来自dsh-go-deletion.mjs的20ms锁重试delay，其他timer透传；不改变实际锁操作、signal、投递或结果。最初在插件activation期间直接agents.create的探针遇到锁冲突，保留为PREPARATION材料，不是有效取消红，不作为故障根因。

验收：实际Host已有session目标的取消→同reason拒绝/history0，后续正常run仍成功/history1且重复run仍pending；task计划保持。新target的准备副作用、真实SSH/Android/外部模型均不作已验证声明。新增runtime diff将影响runtimeVersion；pins由正式构建环境按既定流程录制，不在此任务修改。
