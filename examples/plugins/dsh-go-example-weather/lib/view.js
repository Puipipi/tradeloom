// Pure projections of one forecast: the native card (dsh-go view) and the
// text the model reads. No I/O, so they run in tests and in presentationMeta.

/**
 * @typedef {{ date: string, high: number | null, low: number | null, rain: number | null, code: number | null }} Day
 * @typedef {{ city: string, region: string, language: 'zh' | 'en', days: Day[] }} Forecast
 */

const CONDITIONS = [
  // [WMO codes, 中文, English, alert]
  [[0], '晴', 'Clear', false],
  [[1], '晴间多云', 'Mostly clear', false],
  [[2], '多云', 'Partly cloudy', false],
  [[3], '阴', 'Overcast', false],
  [[45, 48], '雾', 'Fog', false],
  [[51, 53, 55], '毛毛雨', 'Drizzle', false],
  [[56, 57], '冻毛毛雨', 'Freezing drizzle', true],
  [[61], '小雨', 'Light rain', false],
  [[63], '中雨', 'Rain', false],
  [[65], '大雨', 'Heavy rain', true],
  [[66, 67], '冻雨', 'Freezing rain', true],
  [[71], '小雪', 'Light snow', false],
  [[73], '中雪', 'Snow', false],
  [[75], '大雪', 'Heavy snow', true],
  [[77], '雪粒', 'Snow grains', false],
  [[80, 81], '阵雨', 'Showers', false],
  [[82], '强阵雨', 'Violent showers', true],
  [[85, 86], '阵雪', 'Snow showers', false],
  [[95], '雷阵雨', 'Thunderstorm', true],
  [[96, 99], '雷阵雨伴冰雹', 'Thunderstorm with hail', true],
]

function condition(code) {
  const hit = CONDITIONS.find(([codes]) => codes.includes(code))
  return hit === undefined ? { zh: '—', en: '—', alert: false } : { zh: hit[1], en: hit[2], alert: hit[3] }
}

const WEEK = {
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
}

/** 今天 / 明天 / 周三 (dates are local to the city; the first one is its today). */
function dayLabel(date, index, lang) {
  if (index === 0) return lang === 'zh' ? '今天' : 'Today'
  if (index === 1) return lang === 'zh' ? '明天' : 'Tomorrow'
  const [y, m, d] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return Number.isInteger(weekday) ? WEEK[lang][weekday] : date
}

const deg = (v) => (v === null ? '—' : `${Math.round(v)}°`)
const round = (v) => (v === null ? null : Math.round(v * 10) / 10)

function dayMetric(day, index, lang) {
  const cond = condition(day.code)
  const rain = day.rain === null ? null : Math.round(day.rain)
  const caption = rain === null
    ? cond[lang]
    : lang === 'zh' ? `${cond.zh} · 降水 ${rain}%` : `${cond.en} · ${rain}% rain`
  const metric = { type: 'metric', label: dayLabel(day.date, index, lang), value: `${deg(day.high)} / ${deg(day.low)}`, caption }
  if (cond.alert || (rain !== null && rain >= 70)) metric.tone = 'warn'
  return metric
}

/**
 * The native card: up to three days as numbers side by side; longer
 * forecasts add a temperature line chart.
 * @param {Forecast} forecast
 */
export function forecastView(forecast) {
  const lang = forecast.language === 'en' ? 'en' : 'zh'
  const n = forecast.days.length
  const title = lang === 'zh'
    ? (n === 1 ? `${forecast.city} · 今天` : `${forecast.city} · 未来 ${n} 天`)
    : (n === 1 ? `${forecast.city} · Today` : `${forecast.city} · Next ${n} days`)
  const credit = lang === 'zh' ? '数据：Open-Meteo' : 'Data: Open-Meteo'

  if (n <= 3) {
    return {
      type: 'stack',
      title,
      children: [
        { type: 'row', children: forecast.days.map((day, i) => dayMetric(day, i, lang)) },
        { type: 'text', text: credit, tone: 'muted' },
      ],
    }
  }
  return {
    type: 'stack',
    title,
    children: [
      { type: 'row', children: forecast.days.slice(0, 2).map((day, i) => dayMetric(day, i, lang)) },
      {
        type: 'chart',
        kind: 'line',
        categories: forecast.days.map((day, i) => dayLabel(day.date, i, lang)),
        series: [
          { name: lang === 'zh' ? '最高' : 'High', values: forecast.days.map((d) => round(d.high)) },
          { name: lang === 'zh' ? '最低' : 'Low', values: forecast.days.map((d) => round(d.low)) },
        ],
        unit: '°C',
        caption: credit,
      },
    ],
  }
}

/**
 * What the model reads (English, one line per day).
 * @param {Forecast} forecast
 */
export function forecastText(forecast) {
  const place = forecast.region ? `${forecast.city}, ${forecast.region}` : forecast.city
  const lines = forecast.days.map((day) => {
    const cond = condition(day.code).en
    const temps = `high ${day.high === null ? '?' : Math.round(day.high)}°C, low ${day.low === null ? '?' : Math.round(day.low)}°C`
    const rain = day.rain === null ? '' : `, ${Math.round(day.rain)}% chance of rain`
    return `${day.date}: ${cond}, ${temps}${rain}`
  })
  return [`Forecast for ${place} (source: Open-Meteo):`, ...lines].join('\n')
}
