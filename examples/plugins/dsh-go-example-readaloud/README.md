# dsh-go-example-readaloud

[English](README.en.md) | 中文

一个 dsh-go 原生插件示例，演示 v1.2 的四样能力：助手消息长按菜单里点「朗读」，App 把这条回复读出来；你一开口它就停；读到哪里，悬浮字幕跟到哪里。

| 能力 | 在这里 |
|---|---|
| `audio` | `media('speech')` 在主机上把回复生成一段 WAV，App 取回去播 |
| `voice` | App 一边播一边听；你开口时 App 先停播，再发 `voice.speechStart` 给插件 |
| `micro` | `micro('caption')` 每 100 ms 推一次「读到这里」的字幕和进度 |
| `overlay` | 字幕浮在对话顶栏下，跟着 `caption` 通道 |

声音是**占位的**：不连任何 TTS，`lib/speech.js` 按文字的节奏合成一串柔和的音（每个字一个音），所以装上就能试，不需要网络或密钥。换成真的 TTS 只改 `media()`：在主机上请求你的引擎（例如 `http://127.0.0.1:8765`），把音频字节原样返回。

第一次朗读时，App 会先问一次能不能听你开口，再走系统的录音权限；之后在插件设置里的「听你开口」开关可以改。

## 安装

只在装了 dsh-go 桥接的主机上显示（手机本机引擎自带）。需要 DSH 0.2.1-rc.2 及以上、支持 v1.2 的 dsh-go。

```sh
dsh plugin --profile web add /绝对路径/dsh-go-example-readaloud
```

手机本机引擎：把文件夹放进本机环境（例如 `/root/.dsh/dsh-go/plugins/`），在 App 的「终端」里执行。卸载：`dsh plugin --profile web remove dsh-go-example-readaloud`。

## 怎么做的

| 文件 | 作用 |
|---|---|
| `package.json` 的 `dshGo` | `capabilities`、一个要求 `audio` 的菜单项、`media` / `micro` / `overlays` 各一个、`wants: ["message"]` |
| `lib/index.js` | `on('read')` 返回同一 `instance` 的三个效果；`media`、`micro`、`onCapability` |
| `lib/reading.js` | 每个对话一次朗读：要读的文字、声音何时开始、字幕的计时（只在有人看、声音在播时才跑） |
| `lib/speech.js` | 文字 → 分句和时间线 → 字幕；时间线 → WAV |

测试：`npm test`（用 `@dsh-go/plugin-kit` 的测试宿主）。自查：`npm run check -- --load`。

协议见 [`docs/plugins/voice.md`](../../../docs/plugins/voice.md)。MIT © DSH-TUI (ccch1mneyyy)。
