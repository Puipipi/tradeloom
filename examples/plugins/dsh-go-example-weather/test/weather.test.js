import { realDshTools, registeredTools } from './dsh-tools.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchForecast } from '../lib/open-meteo.js'
import { forecastText, forecastView } from '../lib/view.js'

const GEO = { results: [{ name: '杭州', admin1: '浙江', country: '中国', latitude: 30.29, longitude: 120.16 }] }
const DAILY = {
  daily: {
    time: ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'],
    weather_code: [2, 61, 95, 3, 0, 80, 1],
    temperature_2m_max: [23.4, 20.1, 19.6, 21, 24.2, 22.8, 23],
    temperature_2m_min: [15.2, 14.8, 13.9, 13, 14.1, 15.5, 16.2],
    precipitation_probability_max: [10, 65, 85, 20, 0, 55, 5],
  },
}

/** fetch stand-in: geocoding answer, then the forecast cut to the requested day count. */
function fakeFetch(calls = []) {
  return async (url) => {
    calls.push(String(url))
    const u = new URL(url)
    if (u.hostname.startsWith('geocoding')) return Response.json(GEO)
    const days = Number(u.searchParams.get('forecast_days'))
    const daily = Object.fromEntries(Object.entries(DAILY.daily).map(([k, v]) => [k, v.slice(0, days)]))
    return Response.json({ daily })
  }
}

const isLosslessJson = (v) => JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v)

test('three days: one metric per day, credit line', async () => {
  const forecast = await fetchForecast({ city: '杭州', days: 3 }, { fetch: fakeFetch() })
  const view = forecastView(forecast)
  assert.equal(view.type, 'stack')
  assert.equal(view.title, '杭州 · 未来 3 天')
  const [row, credit] = view.children
  assert.deepEqual(row.children.map((m) => m.label), ['今天', '明天', '周二'])
  assert.equal(row.children[0].value, '23° / 15°')
  assert.equal(row.children[0].caption, '多云 · 降水 10%')
  assert.equal(row.children[0].tone, undefined)
  assert.equal(row.children[2].tone, 'warn', 'thunderstorm is flagged')
  assert.deepEqual(credit, { type: 'text', text: '数据：Open-Meteo', tone: 'muted' })
})

test('a week: two metrics and a temperature line', async () => {
  const forecast = await fetchForecast({ city: '杭州', days: 7, language: 'en' }, { fetch: fakeFetch() })
  const view = forecastView(forecast)
  assert.equal(view.title, '杭州 · Next 7 days')
  const [row, chart] = view.children
  assert.equal(row.children.length, 2)
  assert.equal(chart.kind, 'line')
  assert.deepEqual(chart.categories, ['Today', 'Tomorrow', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  assert.deepEqual(chart.series[0].values, [23.4, 20.1, 19.6, 21, 24.2, 22.8, 23])
  assert.equal(chart.caption, 'Data: Open-Meteo')
})

test('days are clamped to 1–7 and missing values stay null', async () => {
  const calls = []
  const forecast = await fetchForecast({ city: 'x', days: 30 }, { fetch: fakeFetch(calls) })
  assert.equal(forecast.days.length, 7)
  assert.match(calls[1], /forecast_days=7/)
  const gap = forecastView({ city: 'x', region: '', language: 'zh', days: [{ date: '2026-10-25', high: null, low: null, rain: null, code: null }] })
  assert.equal(gap.title, 'x · 今天')
  assert.equal(gap.children[0].children[0].value, '— / —')
  assert.ok(isLosslessJson(gap))
})

test('unknown city and HTTP errors reach the model as plain errors', async () => {
  await assert.rejects(
    fetchForecast({ city: 'nowhere' }, { fetch: async () => Response.json({}) }),
    /No city named "nowhere"/,
  )
  await assert.rejects(
    fetchForecast({ city: 'x' }, { fetch: async () => new Response('', { status: 503 }) }),
    /HTTP 503/,
  )
})

test('model text is one line per day', async () => {
  const forecast = await fetchForecast({ city: '杭州', days: 2 }, { fetch: fakeFetch() })
  assert.equal(
    forecastText(forecast),
    'Forecast for 杭州, 浙江 (source: Open-Meteo):\n' +
      '2026-10-25: Partly cloudy, high 23°C, low 15°C, 10% chance of rain\n' +
      '2026-10-26: Light rain, high 20°C, low 15°C, 65% chance of rain',
  )
})

test(`tool definition (${realDshTools ? 'real dsh-tools' : 'stub'}): card in presentationMeta, under 8 KiB`, async () => {
  const tool = (await registeredTools()).get('weather_forecast')
  assert.ok(tool, 'weather_forecast registered')
  const saved = globalThis.fetch
  globalThis.fetch = fakeFetch()
  try {
    const args = { city: '杭州', days: 7 }
    const value = await tool.execute(args, { signal: new AbortController().signal })
    if (realDshTools) {
      const { validateJsonSchemaValue } = await import(realDshTools)
      assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [])
    }
    const content = tool.output.render(args, value)
    assert.equal(content[0].type, 'text')
    const meta = tool.output.presentationMeta(args, value)
    assert.deepEqual(Object.keys(meta), ['dsh-go/view'])
    assert.ok(isLosslessJson(meta))
    assert.ok(Buffer.byteLength(JSON.stringify(meta)) < 8 * 1024)
  } finally {
    globalThis.fetch = saved
  }
})

test('a broken view never fails the tool call', async () => {
  const tool = (await registeredTools()).get('weather_forecast')
  // A value presentationMeta cannot project (days missing) -> no card, no throw.
  assert.deepEqual(tool.output.presentationMeta({}, { city: 'x' }), {})
})
