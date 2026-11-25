// dsh-go-example-readaloud: 朗读 in a reply's long-press menu reads it aloud, stops the moment you
// start talking, and shows what it is reading as a floating caption. Native plugin capabilities
// v1.2 (docs/plugins/voice.md):
//
//   audio    the clip is made here on the Host (media 'speech') and played by the app — local
//            engine or remote host alike, no URL ever leaves the Host
//   voice    the app listens while it plays; when you speak it stops the sound itself, then
//            tells this plugin (voice.speechStart)
//   micro    the caption: a small model `{text, progress}`, up to 10 updates a second
//   overlay  the app's floating caption line, fed by that micro channel
//
// The sound is a stand-in (lib/speech.js): voiced tones that follow the text's timing. A real
// read-aloud plugin calls its TTS engine in media() — on the Host, e.g. http://127.0.0.1:8765 —
// and returns the bytes.
import { createReadings } from './reading.js'

export const name = 'dsh-go-example-readaloud'

export function apply(ctx) {
  const readings = createReadings()

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.on('read', (scope, event) => {
      const key = readings.begin(scope, scope.message)
      if (!key) return { toast: event?.locale?.startsWith('zh') === false ? 'Nothing to read in this reply' : '这条回复没有可读的文字' }
      // One instance for the three: the bridge gives them one lease, the app one owner.
      return [
        { type: 'audio', op: 'play', instance: 'reading', src: 'media:speech', key },
        { type: 'voice', op: 'start', instance: 'reading' },
        { type: 'overlay', op: 'show', instance: 'reading', id: 'subtitle' },
      ]
    })

    ctx.dshGo.media('speech', (scope, { key }) => {
      const body = readings.clip(scope, key)
      if (!body) throw new Error('no such reading')
      return { body, contentType: 'audio/wav' }
    })

    ctx.dshGo.micro('caption', { data: (scope, emit) => readings.watch(scope, emit) })

    ctx.dshGo.onCapability((scope, event) => {
      // Record synchronously: the event's signal is aborted once its lease is over.
      if (event.event === 'voice.speechStart' || event.event.startsWith('audio.')) readings.end(scope)
    })
  })
}
