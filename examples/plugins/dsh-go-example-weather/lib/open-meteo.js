// Open-Meteo client: city name -> daily forecast. No API key. Data CC BY 4.0
// (https://open-meteo.com/en/license); the card credits the source.

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const TIMEOUT_MS = 12000

/** Clamp the requested day count to what the card shows well (1–7). */
export function clampDays(days) {
  if (!Number.isInteger(days)) return 3
  return Math.min(7, Math.max(1, days))
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

async function getJson(url, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const res = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!res.ok) throw new Error(`Open-Meteo answered HTTP ${res.status}`)
  return res.json()
}

/**
 * Look up a city and fetch its daily forecast.
 * @param {{ city: string, days?: number, language?: 'zh' | 'en' }} args
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<import('./view.js').Forecast>}
 */
export async function fetchForecast(args, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const language = args.language === 'en' ? 'en' : 'zh'
  const city = String(args.city ?? '').trim()
  if (city === '') throw new Error('city is empty')
  const days = clampDays(args.days)

  const geo = await getJson(
    `${GEOCODE}?${new URLSearchParams({ name: city, count: '1', language, format: 'json' })}`,
    fetchImpl,
    options.signal,
  )
  const place = Array.isArray(geo?.results) ? geo.results[0] : undefined
  if (place === undefined) throw new Error(`No city named "${city}" was found. Try the English or local name.`)

  const data = await getJson(
    `${FORECAST}?${new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
      forecast_days: String(days),
    })}`,
    fetchImpl,
    options.signal,
  )
  const daily = data?.daily ?? {}
  const dates = Array.isArray(daily.time) ? daily.time.slice(0, days) : []
  if (dates.length === 0) throw new Error('Open-Meteo returned no forecast days')

  return {
    city: String(place.name ?? city),
    region: String(place.admin1 ?? place.country ?? ''),
    language,
    days: dates.map((date, i) => ({
      date: String(date),
      high: finite(daily.temperature_2m_max?.[i]),
      low: finite(daily.temperature_2m_min?.[i]),
      rain: finite(daily.precipitation_probability_max?.[i]),
      code: finite(daily.weather_code?.[i]),
    })),
  }
}
