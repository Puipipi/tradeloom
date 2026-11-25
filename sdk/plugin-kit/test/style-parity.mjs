// One JSON batch for the Dart/JS diagnostic parity test. No expected results
// are generated or committed: both live parsers consume the same inputs.
import { readFileSync } from 'node:fs'
import { checkView } from '../lib/view-check.js'
import { readableColor } from '../lib/style-check.js'

const cases = JSON.parse(readFileSync(new URL('./parity/style-inputs.json', import.meta.url), 'utf8'))
const results = cases.map(c => {
  const parsed = checkView(c.view, { budget: c.budget, data: c.data })
  return { name: c.name, fatal: parsed.fatal, title: parsed.title,
    issues: parsed.issues.map(({ path, message }) => ({ path, message })) }
})
let seed = 0x125678
const colors = []
for (let i = 0; i < 256; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) & 0xffffff
  const background = (seed * 31 + i * 997) & 0xffffff
  colors.push({ input: seed, background, corrected: readableColor(seed, background) })
}
process.stdout.write(JSON.stringify({ cases: results, colors }))
