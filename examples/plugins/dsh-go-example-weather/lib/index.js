// dsh-go-example-weather: one tool, `weather_forecast`. The model reads the
// text from `render`; the dsh-go app draws `presentationMeta`'s
// "dsh-go/view" as a native card. Nothing else is needed: no bridge, no
// manifest, and it works on every host (the card is stored with the tool
// result in the conversation log).
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fetchForecast } from './open-meteo.js'
import { forecastText, forecastView } from './view.js'

export const name = 'dsh-go-example-weather'
export const inject = ['tools']

const nullableNumber = { oneOf: [{ type: 'number' }, { type: 'null' }] }

/** Limit for a tool card: it is written into the conversation log. */
const CARD_MAX_BYTES = 8 * 1024

/**
 * Wrap a view builder for `presentationMeta`. DSH fails the whole tool call
 * when presentationMeta throws or returns anything that is not lossless JSON
 * (undefined, NaN, Infinity, -0), so: catch, round-trip through JSON, cap the
 * size, and fall back to no card. Same as `toolCard()` in @dsh-go/plugin-kit.
 */
function toolCard(build) {
  return (args, value) => {
    try {
      const text = JSON.stringify(build(args, value))
      if (text === undefined || Buffer.byteLength(text, 'utf8') > CARD_MAX_BYTES) return {}
      return { 'dsh-go/view': JSON.parse(text) }
    } catch {
      return {}
    }
  }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'weather_forecast',
    description:
      'Daily weather forecast for a city: conditions, high/low temperature and chance of rain, 1-7 days. ' +
      'Use it when the user asks about the weather. The user sees the result as a card, so do not repeat every number.',
    parameters: {
      city: { type: 'string', required: true, description: 'City name, e.g. "Tokyo" or "杭州".' },
      days: { type: 'integer', description: 'How many days, 1-7. Default 3.' },
      language: { type: 'string', enum: ['zh', 'en'], description: "Language of the user's message. Default zh." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          city: { type: 'string', required: true },
          region: { type: 'string', required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
          days: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                high: { ...nullableNumber, required: true },
                low: { ...nullableNumber, required: true },
                rain: { ...nullableNumber, required: true },
                code: { ...nullableNumber, required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: forecastText(value) }],
      presentationMeta: toolCard((_args, value) => forecastView(value)),
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => fetchForecast(args, { signal: exec.signal }),
  }))
}
