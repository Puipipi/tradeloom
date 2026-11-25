# Sound and captions (v1.2)

[中文](../voice.md)

Four capabilities for a read-aloud kind of plugin: play a clip, stop the moment the person speaks, a caption updated ten times a second, and that caption floating over the app. All optional: without a declaration nothing happens, and older plugins and apps are unaffected. Full example: [`dsh-go-example-readaloud`](../../../examples/plugins/dsh-go-example-readaloud/). Spec: [protocol §11](../../design/native-plugins-protocol.md#11-可选能力v12).

| Capability | You get | You do | The app does |
|---|---|---|---|
| `audio` | A clip: play, pause, resume, stop, an event when it ends | Make the audio bytes on the Host (ask a TTS engine there, say) | Fetches them through the bridge, plays them on the phone |
| `voice` | Events when the person starts / stops speaking | Nothing | Listens on the phone; on speech it **stops the clip itself first**, then tells you |
| `micro` | A small data channel, up to 10 updates a second | Push `{ text, progress }` | Draws it as a caption line |
| `overlay` | One floating caption line | Name the `micro` channel it follows | Floats it under the chat header, with a close key |

## One reading, step by step

```
Long-press a reply → Read aloud
 ├─ invoke on('read') ──▶ you return [audio.play, voice.start, overlay.show] (one instance)
 ├─ the app GETs the media route ──▶ your media('speech') makes the whole clip
 ├─ the app plays it, listens, and subscribes to micro('caption') ──▶ you push a caption every 100 ms
 ├─ the person speaks → the app stops the sound → cap.event voice.speechStart ──▶ your onCapability
 └─ the clip is over (ended / stopped / interrupted) → the app stops listening, closes the caption → terminal events ──▶ onCapability
```

The phone never opens an address you give it. `127.0.0.1:8765` on the Host is yours to fetch inside `media`; the app only reads the bridge's own media route, so the local engine and a remote host work the same way.

## Manifest

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

| Field | Rule |
|---|---|
| `capabilities` | The ones you use |
| `requires` | On the button that needs sound: an app without it doesn't show the button, rather than showing one that does nothing |
| `media` / `micro` / `overlays` | Up to 2 each; ids unique with the other contributions |
| `overlays[].channel` / `text` | The `micro` channel it follows; `text` is shown until there is data (≤ 240 characters). One or both |
| A panel's `micro` | A caption line under the panel's view, from that channel |

## Host half

```js
ctx.inject(['dshGo'], (ctx) => {
  ctx.dshGo.on('read', (scope) => [
    { type: 'audio', op: 'play', instance: 'reading', src: 'media:speech', key: remember(scope.message) },
    { type: 'voice', op: 'start', instance: 'reading' },
    { type: 'overlay', op: 'show', instance: 'reading', id: 'subtitle' },
  ])
  ctx.dshGo.media('speech', async (scope, { key, signal }) => ({
    body: await tts(textOf(key), { signal }),   // a Buffer, ≤ 16 MiB
    contentType: 'audio/mpeg',
  }))
  ctx.dshGo.micro('caption', { data: (scope, emit) => follow(scope, emit) })   // returns its cancel
  ctx.dshGo.onCapability((scope, { event, reason }) => { if (event === 'voice.speechStart') stopFollowing(scope) })
})
```

- `on('read')` has 3 seconds: store the text, hand out a `key`, and **do the slow TTS in `media`** (it has 30 s).
- `media` returns one whole clip (`audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/mp4`, `audio/aac`); no streaming. Its `signal` fires on stop, disconnect or timeout: pass it to the TTS request.
- `micro` data is `{ text?, progress? }` only: `text` ≤ 240 characters, `progress` 0–1. However fast you push, the app gets at most 10 a second (the newest); with nobody watching your data function is cancelled — keep no timers.
- `onCapability`'s return value never runs; its `signal` aborts when the session ends, so record what you need synchronously.

## Effects

| Effect | Notes |
|---|---|
| `audio` `play` / `pause` / `resume` / `stop` | `play` takes `src: "media:<id>"` and an optional `key`; the others only `instance` |
| `voice` `start` / `stop` | Speech activity only; the app never gives you sound or words |
| `overlay` `show` / `hide` | `id` is your overlay |

Effects with the same `instance` in one answer form one session. Only a tap's immediate answer may use them (not a static `effect`, not a deferred result).

## Events

| `event` | When |
|---|---|
| `audio.ended` / `audio.stopped` / `audio.error` | Played to the end / stopped / failed |
| `voice.speechStart` | The person spoke; **the sound has already stopped** — no `audio.stopped` follows |
| `voice.speechEnd` | They finished |
| `voice.stopped` / `voice.error` | No longer listening / failed (`reason: "declined"`: the person said no; `"permission"`: no microphone permission) |
| `overlay.closed` | The caption closed (`reason: "user"`: the person tapped ×) |

## What the app guards for the person

| Item | How |
|---|---|
| Microphone | The first time a plugin wants to listen the app asks once and remembers; the plugin's settings have a "Hear you speak" switch. The system's microphone permission comes after. While listening, the app's own indicator sits under the chat header, with your plugin's name; its Stop ends everything |
| Foreground only | Leaving the app, locking the phone, another chat or host: stopped at once, never resumed by itself |
| One at a time | One sound session in the whole app; a new tap replaces the old |
| With the sound | When the clip is over the app stops listening (once the person has finished talking) and closes the caption |
| Dictation first | When the person taps the composer's voice input, your listening and reading stop first |

## Echo

Reading out loud through the speaker, the microphone hears the reading. The app uses the system's voice-call capture path and echo canceller (where the phone has one), raises the bar for speech while it plays and ignores the first 0.4 s. That lowers false stops but doesn't rule them out: loud speaker playback on a phone without echo cancellation can interrupt itself, and quiet speech can be missed. Headphones are the most reliable.

## Testing

```js
import { createTestHost } from '@dsh-go/plugin-kit/testing'
const h = createTestHost({ dir, caps: { features: ['audio', 'voice', 'micro', 'overlay'] } })
apply(h.ctx)
const { effects } = await h.invoke('read', { context: { message: 'Hello.' }, scope: { sessionId: 's1' } })
const clip = await h.media('speech', { sessionId: 's1' }, { key: effects[0].key })
const feed = h.subscribeMicro('caption', { sessionId: 's1' })     // feed.data / feed.history
await h.capabilityEvent({ sessionId: 's1' }, { instance: 'reading', event: 'voice.speechStart', seq: 1 })
```

The test host calls your callbacks directly; leases, authentication and the 10 Hz pacing are the bridge's. `check --load` checks as the newest app (every capability on offer).

## Where it works

On the local engine. SSH hosts once the bridge can be installed there (see [hosts](hosts.md)); relay hosts have none of this, and buttons with `requires` don't show.
