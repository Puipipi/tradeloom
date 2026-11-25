# 端上流式识别后端

仅提供服务与 provider，界面、自动发消息和通话控制器由调用方接入。

## 接入

- `streamingAsrModelProvider`：`download/cancel/delete/refresh`，状态含下载字节进度、校验、就绪及错误。
- `streamingAsrManifestProvider`：可换下载源（`hosts`），固定 SHA256 仍生效。
- `streamingAsrProvider`：取得 `StreamingAsr`，先订阅 `events`，`await start(model)`，把 `Uint8List` PCM16LE 交给 `feed`。
- `streamingPcmCaptureProvider`：订阅 `frames`，再 `await start(StreamingPcmSource.call/dictation)`。
  它只打开 PCM 旁路，权限申请和原有录音的启停仍由调用方管理；不另抢麦克风。
- 正常收尾：结束原生录音和 PCM 旁路，再 `await asr.stop()`，等待 final。
  取消则 `await pcm.stop()` 后 `await asr.stop(finalize: false)`。模型删除会先停 PCM 与识别器，再等待下载写入结束。
- `StreamingAsrPartial` 是当前段的完整假设文本；`StreamingAsrFinal` 后模型 stream 重置，继续处理下一句。
  endpoint 的「已有输出后静音」为 1.0 秒，最长段 110 秒。推理和模型加载均在长期 Dart isolate。

`dsh/voice` 新增 `streamingPcm` 方法：`{source: call|dictation, pcmSession: int}` 开启；
`{pcmSession: int}` 停止对应旁路。`dsh/voice/events` 原 EventChannel 发送
`{type: pcm, bytes: Uint8List(640), rate: 16000, source, pcmSession}`。
`voicePlatformEvents` 共享一个原生订阅，避免通话 PCM 与旧听写桥互相覆盖。
默认不发送 PCM；停用、mute、旧捕获退役后的排队帧会被丢弃。
WavRecorder 的 48/44.1 kHz 回退来源连续分帧并重采样到 16 kHz / 20 ms。

## 模型与许可

采用题面指定 `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`，只安装三个 int8 ONNX 和 tokens。
[HF 模型卡](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20)
与[原模型卡](https://huggingface.co/pfluo/k2fsa-zipformer-chinese-english-mixed)均声明 Apache-2.0。
[sherpa 官方文档](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html#csukuangfj-sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20-bilingual-chinese-english)
说明来自内部训练数据集。原卡里的 WenetSpeech 是评测集；未据此推断为训练来源，也没有选用官方注明 WenetSpeech 训练的中文模型。
这些结论依据发布者声明，未独立审计未公开的内部数据集。
许可全文随 APK 的 `assets/licenses/streaming-asr-model-APACHE-2.0.txt` 提供。

四个文件（三个 int8 ONNX 和 tokens，共 198,270,793 bytes）按固定版本 `98590b7` 从 Hugging Face 逐个下载，
连不上时换 hf-mirror.com（国内常常只有它能到）；每个文件可续传，落地时按固定 SHA256 校验一次（在 isolate 里算），
校验过再改名，之后判断「装好了没」只看文件和大小。不下官方 511 MB 的整包，也就不用解压。

## 一份 ORT

精确固定 `sherpa_onnx: 1.13.4` 和四个 `sherpa_onnx_android_*: 1.13.4`，它们带的 ORT 是 1.27.0，配合 A 的 ORT Android 1.27.0（只打包一份 `libonnxruntime.so`，两边导出的符号一致）。原来的 1.23.2 在骁龙 8 Elite（SM8850/8845）+ Android 16 上会走 CPU 不支持的 SME 指令，进通话就 SIGILL 闪退（microsoft/onnxruntime#27884，1.24.4 修复）。
实际比较官方 pub 包和 Maven AAR，两种应用 ABI 的 `libonnxruntime.so` 完全相同：

| ABI | SHA256 |
|---|---|
| arm64-v8a | `e40f09d07dc53726b8bfbf48a7907673b8f86718a057655a62790a39874a7302` |
| x86_64 | `972c17c056eaae946a415d9efdd8018b729639974df075e495f0092441478fb7` |

因此 Gradle `pickFirsts` 对相同库去重，每个应用 ABI 只打入一份 ORT，JNI 与 Dart FFI 共用。
不能单独升级任一 pin：旧 sherpa 1.12.20 依赖 ELF 符号版本 `VERS_1.17.1`，实测不能直接用新 ORT；
smart-turn 的 IR10 又不能用 ORT1.17.1。升级时必须重新核对实际 `.so` 与模型推理。

## 验证入口

`flutter test test/voice/streaming_asr_test.dart test/speech/streaming_asr_download_test.dart`。
真实模型集成测试 `test/voice/streaming_asr_integration_test.dart` 使用
`DSH_ASR_MODEL_DIR` 指向模型目录（另放 `test_wavs/1.wav`）；缺少时跳过。
Android JVM 测试为 `StreamingPcmTest`，覆盖旁路生命周期、字节序、分帧与重采样。
APK 必须另查仅有一份目标 ABI 的 `libonnxruntime.so`，在真机验证麦克风、mute、连续两句与取消后重开。
