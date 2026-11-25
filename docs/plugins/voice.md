# 声音与字幕（v1.2）

[English](en/voice.md)

给朗读这类插件的四样能力：放一段声音，用户一开口就停，字幕每秒更新十次，字幕浮在界面上。全部可选：不声明就什么都不发生，老插件、老 App 都不受影响。完整示例：[`dsh-go-example-readaloud`](../../examples/plugins/dsh-go-example-readaloud/)。规格：[协议 §11](../design/native-plugins-protocol.md#11-可选能力v12)。

| 能力 | 你得到 | 你做 | App 做 |
|---|---|---|---|
| `audio` | 一段声音：播、暂停、继续、停，播完有事件 | 在主机上生成音频字节（比如问主机上的 TTS） | 从桥接取回、在手机上播 |
| `voice` | 用户开口 / 说完的事件 | 什么都不用做 | 在手机上听；一开口**先自己停掉声音**，再告诉你 |
| `micro` | 一条小数据通道，最快每秒 10 次 | 推 `{ text, progress }` | 画成一行字幕 |
| `overlay` | 一行悬浮字幕 | 指定它跟哪条 `micro` 通道 | 浮在对话顶栏下，带关闭键 |

## 一次朗读怎么走

```
用户在回复上长按 → 朗读
 ├─ invoke on('read') ──▶ 你返回 [audio.play, voice.start, overlay.show]（同一个 instance）
 ├─ App GET 媒体路由 ──▶ 你的 media('speech') 生成整段音频
 ├─ App 播放，同时听麦克风，字幕订阅 micro('caption') ──▶ 你每 100 ms 推一次字幕
 ├─ 用户开口 → App 立刻停播 → cap.event voice.speechStart ──▶ 你的 onCapability
 └─ 声音结束（播完 / 停 / 开口）→ App 自动停止聆听、关字幕 → 终态事件 ──▶ onCapability
```

手机从不直接访问你给的地址。主机上的 `127.0.0.1:8765` 由你在 `media` 里去取，App 只认桥接的同源媒体路由，所以本机引擎和远程主机一样能播。

## 清单

```jsonc
"dshGo": {
  "v": 1,
  "title": { "zh": "朗读", "en": "Read aloud" },
  "wants": ["message"],
  "capabilities": ["audio", "voice", "micro", "overlay"],
  "contributes": {
    "message.actions": [{ "id": "read", "label": { "zh": "朗读", "en": "Read aloud" }, "icon": "play", "requires": ["audio"] }],
    "media":    [{ "id": "speech" }],
    "micro":    [{ "id": "caption" }],
    "overlays": [{ "id": "subtitle", "channel": "caption" }]
  }
}
```

| 字段 | 规则 |
|---|---|
| `capabilities` | 用到哪几样写哪几样 |
| `requires` | 写在要用声音的按钮上：App 不支持时按钮不出现，而不是点了没反应 |
| `media` / `micro` / `overlays` | 各最多 2 个，id 和其他贡献一起不重复 |
| `overlays[].channel` / `text` | 字幕跟哪条 `micro`；`text` 是还没数据时的静态文字（≤ 240 字），二选一或都写 |
| 面板 `micro` | 面板视图下多一行字幕，跟这条通道 |

## 宿主半侧

```js
ctx.inject(['dshGo'], (ctx) => {
  ctx.dshGo.on('read', (scope) => [
    { type: 'audio', op: 'play', instance: 'reading', src: 'media:speech', key: remember(scope.message) },
    { type: 'voice', op: 'start', instance: 'reading' },
    { type: 'overlay', op: 'show', instance: 'reading', id: 'subtitle' },
  ])
  ctx.dshGo.media('speech', async (scope, { key, signal }) => ({
    body: await tts(textOf(key), { signal }),   // Buffer，≤ 16 MiB
    contentType: 'audio/mpeg',
  }))
  ctx.dshGo.micro('caption', { data: (scope, emit) => follow(scope, emit) })   // 返回取消函数
  ctx.dshGo.onCapability((scope, { event, reason }) => { if (event === 'voice.speechStart') stopFollowing(scope) })
})
```

- `on('read')` 要在 3 秒内返回：先把要读的文字存好、给一个 `key`，**慢的 TTS 放进 `media`**（它有 30 秒）。
- `media` 只回完整的一段（`audio/mpeg` `audio/wav` `audio/ogg` `audio/mp4` `audio/aac`），不支持流式。`signal` 在停播、断线、超时时触发，记得传给 TTS 请求。
- `micro` 的数据只能是 `{ text?, progress? }`：`text` ≤ 240 字，`progress` 0–1。推得再快，App 也最多每秒收 10 次（只要最新那份）；没人看时数据函数会被取消，别留定时器。
- `onCapability` 的返回值不会执行；它的 `signal` 在会话结束后中止，要记的东西同步记。

## 效果

| 效果 | 说明 |
|---|---|
| `audio` `play` / `pause` / `resume` / `stop` | `play` 带 `src: "media:<id>"` 和可选 `key`；其余三个只带 `instance` |
| `voice` `start` / `stop` | 只检测开口，App 不会把声音或文字给你 |
| `overlay` `show` / `hide` | `id` 是你的 overlay |

同一次返回里同一 `instance` 的效果属于一个会话。只有点按的直接返回能用这些效果（静态 `effect` 和延后结果都不行）。

## 事件

| `event` | 什么时候 |
|---|---|
| `audio.ended` / `audio.stopped` / `audio.error` | 播完 / 被停 / 出错 |
| `voice.speechStart` | 用户开口；**声音已经停了**，不会再有 `audio.stopped` |
| `voice.speechEnd` | 说完 |
| `voice.stopped` / `voice.error` | 不再听 / 出错（`reason: "declined"` 用户不同意，`"permission"` 系统没给录音权限） |
| `overlay.closed` | 字幕关了（`reason: "user"` 是用户点了 ×） |

## App 替用户守着的

| 项 | 怎么做 |
|---|---|
| 麦克风 | 每个插件第一次要听时 App 问一次，记住答案；插件设置里有「听你开口」开关。之后才是系统录音权限。听的时候对话顶栏下有 App 的指示条（写着你的插件名），用户点「停止」就全停 |
| 只在前台 | 退到后台、锁屏、换对话、换主机都立刻停，不会自动恢复 |
| 一次一个 | 全 App 同时只有一个声音会话，新的点按换下旧的 |
| 跟着声音走 | 声音结束后 App 自动停止聆听（等用户说完）、关掉字幕 |
| 语音输入优先 | 用户按输入框的语音输入时，你的聆听和朗读先停 |

## 回声

外放朗读时，麦克风会听到朗读声。App 用系统的通话录音通道和回声消除（设备有的话），朗读时把开口门槛调高、开头 0.4 秒不算。这只能降低误判：外放很响、设备没有回声消除时，朗读可能被自己的声音打断，小声说话也可能听不出来。戴耳机最稳。

## 测

```js
import { createTestHost } from '@dsh-go/plugin-kit/testing'
const h = createTestHost({ dir, caps: { features: ['audio', 'voice', 'micro', 'overlay'] } })
apply(h.ctx)
const { effects } = await h.invoke('read', { context: { message: '你好。' }, scope: { sessionId: 's1' } })
const clip = await h.media('speech', { sessionId: 's1' }, { key: effects[0].key })
const feed = h.subscribeMicro('caption', { sessionId: 's1' })     // feed.data / feed.history
await h.capabilityEvent({ sessionId: 's1' }, { instance: 'reading', event: 'voice.speechStart', seq: 1 })
```

测试宿主直接调你的回调，不模拟租约、鉴权和 10 Hz 节流；这些由桥接负责。`check --load` 按最新的 App（全部能力）检查。

## 在哪能用

本机引擎可用。SSH 主机要等桥接能装上（见[主机覆盖](hosts.md)）；中转主机没有这些能力，带 `requires` 的按钮不会出现。
