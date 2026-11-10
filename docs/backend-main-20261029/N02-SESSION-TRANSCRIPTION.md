# N02：目标会话转写后端切片

本切片把已完成的录音交给现有 SDK `speechToText` 服务，并把返回文本和实测时长交给可信调用者检查。它不会创建、发送或追加 Agent 消息，也不负责录音采集、权限弹窗、UI、Host 启动或结果确认。

## 接口

```js
import { createSessionTranscriptionController } from '@tradeloom/dsh-business-shell/session-transcription'

const transcription = createSessionTranscriptionController({ ctx: trustedHostContext })
const recordingTarget = transcription.bindAgent(trustedAgent.id) // 在开始录音时捕获
const result = await transcription.transcribe({
  binding: recordingTarget, // 提交录音时必须仍是同一目标
  audio: completedRecordingBytes,
  providerId: selectedProviderId, // 可省略，采用 speechToText 当前选择
  language: selectedLanguage,    // 可省略，采用 speechToText 当前选择
  signal: recordingAbortSignal,  // 可省略
})
// 展示/检查 result.text 后，后续显式的人类或 Host 流程再决定是否使用。
// Host 关闭时必须 await transcription.dispose()；factory 不会自行注册 ctx disposer。
await transcription.dispose()
```

`bindAgent(agentId)` 从实时 `ctx.agents.get(agentId)` 读取 Agent 与 `agent.session`，返回冻结的 `{agentId, sessionId, generation}`。调用者必须把录音开始时拿到的整个 `binding` 原样传回。若录音完成前已切换目标，旧 binding 会被拒绝，且不会解析或调用识别器；不得把旧录音自动归到新目标。

成功结果为 `{agentId, sessionId, generation, providerId, language, text, audioSeconds, inferenceSeconds}`。`text` 和两个时长来自 SDK `Transcript`；控制器不推算时长、不改写文本、不提交会话消息。录音类型/格式的进一步限制由被选中的 SDK provider 检查，本适配器不伪造另一个音频格式合同。

## Readiness、取消和生命周期

`getReadiness(providerId?)` 仅投影 SDK `speechToText.snapshot()` 的 provider phase，不暴露 `failed.message` 或下载细节。`ready`、`standby` 可交给 SDK；`unprepared`、`failed`、`checking`、`loading`、`waking`、`downloading`、`cancelling`、`cancelled` 会拒绝新转写并保留 phase。缺服务/缺 provider、无法读取或未知 phase 分别显示为 `unavailable` 或 `unknown`。不解析普通异常字符串；只有 SDK 提供的正式 typed failure descriptor 才附加模型不可用或 worker 退出信息，细节见 [N02 typed provider failure](N02-SPEECH-PROVIDER-ERRORS.md)。

- `cancel()` 会立即 abort 当前 SDK 调用并让调用者收到 `session_transcription_cancelled`；返回值是 `idle` 或 `cancelling`。如果 provider 忽略 abort，内部任务仍记录为 in-flight，第二次转写返回 `session_transcription_busy`，直到原 Promise 实际 settle。这里不声称 worker 已被停止。
- 重新 `bindAgent()` 会立刻使旧 binding 失效并 abort 旧调用。旧 provider 未 settle 时不把结果交给新目标，且仍占用唯一 in-flight 槽位。
- Agent/session 对象变化、转写期间 `speechToText` service 或解析出的 provider 被更换，会拒绝结果。服务以 Cordis `cordis.original` 身份核对，不只比较同名 providerId。
- `dispose()` 是终态；它 abort 当前调用并 join 实际 provider Promise，重复调用共享同一清理 Promise。忽略 abort 的 provider 若永不 settle，dispose 会继续等待而不会假称完成。

主要稳定错误码：`session_transcription_unavailable`、`session_transcription_closed`、`session_transcription_invalid_arguments`、`session_transcription_agent_unavailable`、`session_transcription_target_changed`、`session_transcription_service_unavailable`、`session_transcription_service_changed`、`session_transcription_provider_unavailable`、`session_transcription_language_unsupported`、`session_transcription_readiness_unknown`、`session_transcription_not_ready`、`session_transcription_busy`、`session_transcription_cancelled`、`session_transcription_failed`、`session_transcription_result_invalid`、`session_transcription_model_unavailable`、`session_transcription_worker_exited`。后两个只来自正式 SDK typed failure；不把普通 `Error.code`、错误文本或一般 `failed` phase当作依据。

`session_transcription_model_unavailable` 与 `session_transcription_worker_exited` 是 [N02 typed provider failure 扩展](N02-SPEECH-PROVIDER-ERRORS.md)提供的新增结构化映射；只有配套的三包六文件 SDK patch 才会产生对应 descriptor。未打该补丁的原 rep12 仍兼容此 consumer，但失败保持 `session_transcription_failed`。

## 验证与边界

[原始定向验证](../../recovery-20261029/n02-session-transcription-20261031/VALIDATION.md)保留了早期 12/12 基线。typed failure 候选后的当前回归是控制器+原 rep12 consumer 14/14（13 个控制器用例+1 个原 SDK consumer），另有 patched SDK overlay 4/4 的 [后续验证](../../recovery-20261029/n02-speech-provider-errors-20261031/VALIDATION.md)。SDK overlay 用真实 rep12 Cordis `Context`、`SpeechToText`、SenseVoice recognizer、`LocalSubprocessRuntime` 和自建 Node worker fixture；它验证结构化模型/worker失败与兼容错误分支，不加载模型或进行推理。

本切片未集成真实 SenseVoice权重/推理或云 provider、麦克风采集、Windows/系统录音权限、实际 UI 预览/确认、Agent 目标的生产 Host producer 或 Host 生命周期挂载。结构化 provider failure 是独立 SDK 源码候选，并未应用到 pinned rep12 或产品安装；完整部署和 N02 仍未完成。
