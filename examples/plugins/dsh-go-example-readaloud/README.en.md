# dsh-go-example-readaloud

English | [中文](README.md)

A dsh-go native plugin example for the four v1.2 capabilities: tap "Read aloud" in a reply's long-press menu and the app reads the reply out; start talking and it stops; a floating caption follows along.

| Capability | Here |
|---|---|
| `audio` | `media('speech')` turns the reply into a WAV on the Host; the app fetches and plays it |
| `voice` | The app listens while it plays; when you speak it stops the sound first, then sends `voice.speechStart` to the plugin |
| `micro` | `micro('caption')` pushes "read up to here" and the progress every 100 ms |
| `overlay` | The caption floats under the chat header, following the `caption` channel |

The sound is a **stand-in**: no TTS involved — `lib/speech.js` synthesizes soft tones in the rhythm of the text (one per character), so it works right after install with no network or keys. A real TTS only changes `media()`: ask your engine on the Host (e.g. `http://127.0.0.1:8765`) and return its audio bytes.

The first time it reads, the app asks once whether the plugin may hear you speak, then Android asks for the microphone; the plugin's "Hear you speak" switch in its settings changes it later.

## Install

Shows only on hosts with the dsh-go bridge (the on-device engine has it). Needs DSH 0.2.1-rc.2 or later and a dsh-go with v1.2.

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-readaloud
```

On-device engine: put the folder into the device environment (e.g. `/root/.dsh/dsh-go/plugins/`) and run it in the app's Terminal. Remove: `dsh plugin --profile web remove dsh-go-example-readaloud`.

## How it is made

| File | Role |
|---|---|
| `package.json` `dshGo` | `capabilities`, a menu item that requires `audio`, one each of `media` / `micro` / `overlays`, `wants: ["message"]` |
| `lib/index.js` | `on('read')` returns three effects on one `instance`; `media`, `micro`, `onCapability` |
| `lib/reading.js` | One reading per chat: the text, when its sound started, the caption's clock (running only while someone watches and the sound plays) |
| `lib/speech.js` | Text → clauses and a timeline → captions; timeline → WAV |

Tests: `npm test` (the `@dsh-go/plugin-kit` test host). Check: `npm run check -- --load`.

Protocol: [`docs/plugins/voice.md`](../../../docs/plugins/en/voice.md). MIT © DSH-TUI (ccch1mneyyy).
