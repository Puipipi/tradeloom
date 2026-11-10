# O08 本地审核节点后端切片

此切片让已保存工作流中的 `review` 节点通过 SDK `ctx.userQuestions.ask` 请求用户决策，并把精确选项和结果保存在原 workflow run journal。它复用现有混合 DAG 的本地节点调度；审核不创建 SDK child、ToolRun 或 artifact，也不调用模型。

## 行为与投影

- 审核节点需要当前 Host context 提供 `userQuestions.ask`。缺少服务时，prepare/submit 返回 `review_unavailable`，不会创建 run 或请求问答。
- 提交后、真正调用问答前，服务先持久化唯一 review request，再复核定义与绑定。若其间上下文变更，节点以 `review_context_stale` 失败并结算下游阻断，不留下无终态的 running run，也不向问答服务发请求。
- 问题包含工作流要求和经过验证的直接上游文本；选项固定为“批准”和“拒绝”。只有本次请求的 question ID 与精确单选结果有效。`custom` 附言不授予批准；custom-only、错 ID、多选或附加自定义文本记录为 `deferred`，需要显式恢复后发起新问题。
- 批准产生 `reviewStatus: "approved"`、`status: "done"`、`attempt: 0` 的审核回执；拒绝产生 `reviewStatus: "rejected"` 和 `review_rejected`，下游节点按既有规则阻断。审核节点的 child、nativeRun、toolCall 和 artifact 字段保持空值。
- 取消或恢复请求中断审核时，已完成的 agent 不重跑。若 answerer 忽略 AbortSignal，服务仍等待原 promise 结束；其迟到答案不能覆盖已持久化的中断/终态。服务重开后，waiting/deferred 审核必须经显式 resume，生成新的 question ID。
- UI run 投影把审核标为 `executionSource: "dsh-user-questions"`，分别显示 pending/deferred/approved/rejected/interrupted/unavailable；不会把审核回执映射成 subagent 或 artifact 证据。

稳定错误映射：`review_unavailable` 为 HTTP 503；`review_answer_invalid`、`review_context_stale`、`review_rejected`、`review_request_stale` 和 `resume_confirmation_required` 为 HTTP 409。native tools 层保留这些服务错误码，UI safe 映射不再将其折叠为通用 `native_workflow_unavailable`。

## 定向证据

- [服务审核测试输出](../../recovery-20261029/o08-native-review-nodes-20261031/raw/workflow-native-service-review-final.txt)：19/19 通过，0 skip。覆盖发问前和回包后定义/绑定变更、审批、拒绝与下游阻断、无效答案、NO_PROVIDER 后持久恢复、取消时忽略 signal 的 answerer、终态保护和 interrupted 显式恢复。新增发问前变更用例的[修复前红测](../../recovery-20261029/o08-native-review-nodes-20261031/raw/preask-before-fix.txt)保留 exit 1，最终用例通过。
- [UI 审核测试输出](../../recovery-20261029/o08-native-review-nodes-20261031/raw/workflow-native-ui-review.txt)：2/2 通过，0 skip。覆盖缺少问答服务时 503 且无 run/child，以及 deferred→rejected 投影与下游跳过。
- [rep12 SDK 问答链输出](../../recovery-20261029/o08-native-review-nodes-20261031/raw/rep12-mixed-review.txt)：使用显式 `TRADELOOM_O08_SCENARIO=mixed-review`、`TRADELOOM_O08_SDK_FAMILY=rep12` 和 `TRADELOOM_DSH_RUNTIME_ROOT=...\releases\rep12` 运行 `node testing/o08_sdk_native_workflow_acceptance.mjs`，未加额外 loader 参数。真实 rep12 Context、Commands、AgentLoop、ToolRuntime、Session、child 和 `UserQuestionService.ask`/scoped request waterfall；1 个真实 child start/end，1 次 native agent attempt，审核 attempt 为 0。模型与答题 provider 均为本地确定性 fixture；没有真人点击。

rep12 结果证明 SDK 问答服务与 workflow backend 在隔离组合中的接口可用，不证明生产 Host 已注入 `userQuestions`、Electron GUI 或真实用户操作。role、workspace、连接授权仍由 acceptance fixture 提供；外部模型、生产部署和 O08 整体验收不在本证据范围内。
