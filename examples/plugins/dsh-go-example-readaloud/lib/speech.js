// A reply as something to listen to, without any speech service: the text cut into clauses with
// a timeline (about 110 ms a character, a pause after each clause), and a WAV of soft voiced
// tones that follows it — one per character, its pitch moving with the text. A stand-in for TTS:
// a real plugin asks its own engine on the Host for the clip and keeps the same timeline idea.

const RATE = 16000
const CHAR_MS = 110
const WORD_MS = 260
const PAUSE_MS = 240
export const MAX_CHARS = 120

/** The reply as plain text: no code blocks, no dsh-ui cards, no Markdown marks. */
export function plainText(markdown) {
  if (typeof markdown !== 'string') return ''
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const CLAUSE = /[^，。！？；：,.!?;:]+[，。！？；：,.!?;:]*/g
const isCjk = (ch) => /[　-鿿가-힯＀-￯]/.test(ch)

/**
 * The first [MAX_CHARS] characters as clauses on a timeline:
 * `{ clauses: [{ text, start, end, marks: [ms at which each character is reached] }], duration }`.
 */
export function plan(text) {
  const chars = [...text]
  const cut = chars.length > MAX_CHARS ? `${chars.slice(0, MAX_CHARS).join('').trimEnd()}…` : text
  const clauses = []
  let t = 0
  for (const match of cut.matchAll(CLAUSE)) {
    const clause = match[0].trim()
    if (!clause) continue
    const marks = []
    const start = t
    for (const ch of clause) {
      marks.push(t)
      if (isCjk(ch)) t += CHAR_MS
      else if (/\s/.test(ch)) t += WORD_MS / 2
      else if (/[A-Za-z0-9]/.test(ch)) t += WORD_MS / 5
      else t += 20
    }
    t += PAUSE_MS
    clauses.push({ text: clause, start, end: t, marks })
  }
  return { clauses, duration: t }
}

/** What the caption says at [ms]: the clause so far, and how far along the whole reply is. */
export function captionAt(p, ms) {
  if (p.clauses.length === 0) return undefined
  const clause = p.clauses.find((c) => ms < c.end) ?? p.clauses[p.clauses.length - 1]
  const shown = clause.marks.filter((m) => m <= ms).length
  const text = [...clause.text].slice(0, Math.max(1, shown)).join('')
  return { text, progress: Math.min(1, Math.max(0, Math.round((ms / p.duration) * 100) / 100)) }
}

/** The timeline as 16 kHz mono PCM16 WAV: a voiced tone per character, silence between clauses. */
export function synthesize(p) {
  const total = Math.ceil((p.duration / 1000) * RATE)
  const pcm = new Float32Array(total)
  for (const clause of p.clauses) {
    const chars = [...clause.text]
    clause.marks.forEach((at, i) => {
      const ch = chars[i]
      if (!/[\p{L}\p{N}]/u.test(ch)) return
      const next = clause.marks[i + 1] ?? clause.end - PAUSE_MS
      const len = Math.max(40, next - at - 25)
      const f0 = 150 + ((ch.codePointAt(0) * 37) % 90) // 150–240 Hz: a speaking voice's range
      const from = Math.floor((at / 1000) * RATE)
      const n = Math.floor((len / 1000) * RATE)
      for (let k = 0; k < n && from + k < total; k++) {
        const s = k / RATE
        const env = Math.min(1, k / (0.012 * RATE)) * Math.min(1, (n - k) / (0.03 * RATE))
        const glide = f0 * (1 - 0.08 * (k / n))
        const w = 2 * Math.PI * glide * s
        pcm[from + k] += env * (0.5 * Math.sin(w) + 0.25 * Math.sin(2 * w) + 0.12 * Math.sin(3 * w))
      }
    })
  }
  const body = Buffer.alloc(44 + total * 2)
  body.write('RIFF', 0)
  body.writeUInt32LE(36 + total * 2, 4)
  body.write('WAVE', 8)
  body.write('fmt ', 12)
  body.writeUInt32LE(16, 16)
  body.writeUInt16LE(1, 20)
  body.writeUInt16LE(1, 22)
  body.writeUInt32LE(RATE, 24)
  body.writeUInt32LE(RATE * 2, 28)
  body.writeUInt16LE(2, 32)
  body.writeUInt16LE(16, 34)
  body.write('data', 36)
  body.writeUInt32LE(total * 2, 40)
  for (let i = 0; i < total; i++) body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i] * 0.45)) * 32767), 44 + i * 2)
  return body
}
