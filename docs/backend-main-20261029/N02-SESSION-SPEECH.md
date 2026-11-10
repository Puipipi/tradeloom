# N02 会话最终回复语音组件

本交付补充 N02 后端语音链的一部分：从一个由可信调用方明确绑定的 live Agent 消费已完成的最终回复，并用 Windows `System.Speech` 在本机合成 WAV。它不构成完整 N02 完成，也不接入 UI 播放、麦克风、权限提示或产品 Host 启动。

## 接口

```js
import { createSessionSpeechController } from '@tradeloom/dsh-business-shell/session-speech'
import { createWindowsSpeechProvider } from '@tradeloom/dsh-business-shell/windows-speech-provider'

const provider = createWindowsSpeechProvider() // Windows System.Speech；不播放声音
const speech = createSessionSpeechController({
  ctx, // 可信 Host Context
  provider,
  onAudio(audio) {
    // 把音频 DTO交给未来的受信 UI transport；本组件不提供该 transport。
  },
  onError(error) {},
})
const binding = await speech.bindAgent(trustedAgent.id)
// 明确切换目标前：await speech.stop(); 然后 bindAgent(newTrustedAgent.id)
// 服务结束：await speech.dispose(); 若此调用方拥有 provider，再 await provider.dispose()
```

`bindAgent(agentId)` 不从工具参数接受文本或 session。它要求 `ctx.agents.get(agentId)` 返回对应 live Agent，并绑定其真实 `agent.session`。结果为 `{status:'bound', sessionId, generation}`。`getCurrentTarget()` 只返回当前 `{sessionId,generation}` 或 `null`。

只有以下真实 `session/event` 序列会送入合成队列：同一 session 的 `turn/start`、一个有效 `assistant/message`，随后同 turn `turn/end` 且 `reason.kind === 'completed'`。消息必须包含非空可见 `text` block；含任一 `tool-call`/`tool-call-delta`、`interrupted` 消息、reasoning-only、空文本、失败/中断/超限终态均不合成。不会从工具参数、工具调用文本、旧 session、流式片段或 `whenIdle()` 推断最终答案。此事件 feed 是当前进程的 live 事件，不承诺 JSONL flush 或崩溃恢复。

`onAudio` 收到的冻结 DTO 形状：

```js
{
  sessionId: 'SDK session id',
  turn: 1,
  seq: 42,
  generation: 1,
  mimeType: 'audio/wav',
  format: { encoding: 'pcm', channels: 1, sampleRate: 16000,
            bitsPerSample: 16, durationSeconds: 2.5 },
  bytes: Uint8Array,
}
```

`seq` 指最终 assistant/message 的事件序号；`generation` 随显式绑定递增，供未来 UI 丢弃迟到的旧目标音频。WAV 已读入内存后，provider 删除本次合成文件。该 DTO 不是播放授权；播放、音量、用户手势和 UI 停播均未实现。文本上限为 12,000 个 JS 字符；超限最终回复不合成，并报告 `session_speech_text_too_long`，不会截断或静默跳过。

## 生命周期和错误

- `onAudio` 是非等待交付通知：controller 不等待消费者返回的 Promise；同步异常或 Promise 拒绝会通过 `onError` 报 `session_speech_delivery_failed`，队列继续处理后续结果。消费者可以从回调重入 `stop()`，不会让 pump 等待自身。
- `stop()` 调用时同步关闭当前绑定并清空尚未开始的队列，然后取消当前合成并等待本控制器持有的工作完成。重复 stop 安全。stop barrier 完成前的新 bind 由同一变更队列排在其后。
- 重绑定和 `agent/disposed` 会解除旧事件监听，旧异步合成的结果不交给 `onAudio`。队列每个绑定最多 32 条，重复 session/turn 只处理一次。
- `dispose()` 是终态；并发重复调用等待同一个清理 Promise。controller 不 dispose 外部传入的 provider。只有 provider 的所有者负责 `provider.dispose()`；它会取消并 join 自己启动的 PowerShell 子进程，再清理其精确临时目录。
- 稳定 `error.code` 包括 `session_speech_unavailable`、`session_speech_closed`、`session_speech_agent_unavailable`、`session_speech_queue_full`、`session_speech_text_too_long`、`session_speech_delivery_failed`、`session_speech_provider_invalid`、`session_speech_provider_unavailable`、`session_speech_voice_unavailable`、`session_speech_synthesis_failed`、`session_speech_invalid_wave`、`session_speech_invalid_arguments`、`session_speech_cancelled`、`session_speech_cleanup_failed` 和调用参数错误 `invalid_arguments`。回调只收到安全错误码及 session/turn/seq/generation 元数据，不包含回复正文或异常原文。
- 非 Windows、System.Speech 程序集缺失或显式指定的 voice 不存在时返回 typed unavailable，不降级到远端语音，也不安装 voice/模型。未传 voice 时使用操作系统默认 voice。实现通过无 shell 的 Windows PowerShell 子进程，以 UTF-8 JSON stdin 传合成文本和 Unicode 路径；子进程脚本参数不拼接文本，stdout 仅为固定 JSON 状态。不会播放或打开音频设备。

## 验证证据和边界

本轮修正后的 `node --test` 对新 controller 与 Windows provider 测试为 8/8；rep12 编译 SDK 的真实 Cordis Context、AgentLoop testkit 和 SDK `MockAdapter` 组合为 1/1，总计 9/9。原始 TAP/exit 保存在 [验证记录](../../recovery-20261029/n02-session-speech-20261031/VALIDATION.md)。Windows 项真实调用本机 `System.Speech` 合成固定测试句，在中文临时父目录下并发合成以验证共享目录初始化，检查 PCM WAV，取消及 dispose 正在运行的本测试子进程并等待退出，验证显式缺失 voice 的非零退出仍映射为稳定错误码；最后确认自有临时目录为空。没有播放。SDK 组合用本地 mock adapter，不连接模型或服务。

先前 [N02 ASR 评估](../../recovery-20261029/n02-speech-existing-services-20261030/ASSESSMENT.md) 的真实 SenseVoice 结果仍是单独证据；本次没有重新加载模型或运行 ASR。尚未验证生产 Host 如何选择 Agent、消费/转运音频、UI 实际播放、麦克风采集与权限、真实部署 voice、跨进程取消或完整 N02 工作流。不得把本组件称作用户语音已启用。
