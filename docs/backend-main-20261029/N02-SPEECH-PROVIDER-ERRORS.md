# N02：语音 provider 结构化失败

本切片为当前目标会话转写 consumer 增加两个受限失败事实：`model-unavailable` 与 `worker-exited`。它不从异常文本、stderr、`standby` 或 `unprepared` 推断原因。

## SDK 候选合同

隔离候选位于 [`candidates/speech-provider-errors`](../../candidates/speech-provider-errors/README.md)。核心 SDK 仅允许由 `SpeechProviderFailure` 实例产生正式 descriptor：

```ts
type SpeechProviderFailureDetails =
  | { code: 'model-unavailable' }
  | { code: 'worker-exited'; exitCode: number | null; signal: string | null }
```

`SpeechToText.describeProviderFailure(error)` 只接受该 SDK 类的实例；普通 `Error` 即使带同名 `code`/`name` 属性仍保持旧的通用失败行为。SenseVoice 在明确模型资源不可用、或 `SubprocessHandle.done` 实际返回退出结果时提供这些事实。正常 stop、cancel、dispose、HTTP 500 不记作 worker crash。API `speech/transcription-failed` 保留原 `reason`，并仅在 typed provider failure 存在时附加 `code`、`exitCode`、`signal`。

这是可重放 SDK 源码候选，不是对 pinned rep12 或产品安装包的修改/发布。候选和三包隔离编译/类型检查见仓内验证记录。

## 后端消费

目标会话接口维持 [`N02-SESSION-TRANSCRIPTION.md`](N02-SESSION-TRANSCRIPTION.md) 的绑定、取消和 dispose 语义。它在确认目标、service 和 provider 身份仍匹配后，才把 SDK 的正式 descriptor 映射为：

- `session_transcription_model_unavailable`
- `session_transcription_worker_exited`，错误对象含安全的 `providerFailure: {code, exitCode, signal}`

其他 provider 错误仍映射 `session_transcription_failed`。fetch 无响应时，SenseVoice 会在原 inference deadline 内等待真实 `handle.done`；只有观察到自然退出结果才形成 worker failure。取消/期限到达仍走原取消/超时结果。HTTP 已返回但内容表示失败时不等待或猜测 worker 退出。

## 验证与边界

[本轮原始输出和退出码](../../recovery-20261029/n02-speech-provider-errors-20261031/VALIDATION.md)分列了 backend controller 回归、原 pinned rep12 SDK 回归，以及使用隔离 patched SDK overlay 的真实 worker 生命周期测试。后者使用真实 rep12 Cordis、`SpeechToText`、SenseVoice recognizer、`LocalSubprocessRuntime` 和自建短命 Node worker/HTTP fixture；没有权重、模型推理、外部请求、真实录音或用户配置。API 字段验证调用 patched `SpeechController`，不是 HTTP/Typert wire 部署验收。

这仍是 backend/SDK 候选切片：pinned rep12、产品 Host、UI、真实模型与完整 N02 尚未更改或验收。完整 N02 还包括麦克风权限、录音采集、UI 试听/确认以及生产 Host 生命周期接线。
