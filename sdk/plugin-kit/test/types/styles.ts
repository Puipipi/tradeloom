import { bind, metric, row, stack, text, type ViewTextSize, type ViewTextStyle } from '../../types/index.js'

stack([
  text({ text: 'fallback', style: { size: 'display', weight: 'bold', color: '#FFFFFF', maxLines: 2 },
    spans: [{ text: 'rich', color: 'accent', weight: 'medium', mono: true, background: 'teal' }] }),
  row([metric({ label: 'Count', value: 7, style: { size: 'title', align: 'end' } })],
    { style: { card: 'outlined', gap: 'S', padding: 'L', columns: [1, 2], dividers: true } }),
  text({ text: 'bound', style: { size: bind('size'), maxLines: bind('lines') }, spans: bind('spans') }),
], { v: 2, accent: 'teal' })

// @ts-expect-error Semantic font sizes are a closed enum.
const badSize: ViewTextSize = 'huge'
// @ts-expect-error Authors cannot provide arbitrary font pixels.
const badStyle: ViewTextStyle = { fontSize: 800 }
// @ts-expect-error Plain text fallback stays required.
text({ v: 2, spans: [{ text: 'no fallback' }] })
// @ts-expect-error The supported view versions are explicit.
text({ v: 3, text: 'unknown version' })
void [badSize, badStyle]
