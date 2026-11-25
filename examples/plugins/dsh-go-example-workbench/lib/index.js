import { workbenchView } from './view.js'

export const name = 'dsh-go-example-workbench'
export const initialForm = Object.freeze({ name: 'Ada', notes: '', amount: 12.5, count: 2, enabled: true, level: 40, range: [20, 80], category: 'personal', mode: 'focused', tags: ['design'], date: '2026-10-27', time: '09:30', rating: 3 })
const clone = (value) => JSON.parse(JSON.stringify(value))
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const text = (value, min, max) => typeof value === 'string' && [...value.trim()].length >= min && [...value].length <= max
const validDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number), date = new Date(Date.UTC(y, m - 1, d))
  return y >= 1900 && y <= 2100 && date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d
}

function valid(key, value) {
  switch (key) {
    case 'name': return text(value, 2, 80)
    case 'notes': return text(value, 0, 500)
    case 'amount': return finite(value, 0, 10000)
    case 'count': return Number.isInteger(value) && finite(value, 1, 20)
    case 'enabled': return typeof value === 'boolean'
    case 'level': return finite(value, 0, 100)
    case 'range': return Array.isArray(value) && value.length === 2 && value.every((n) => finite(n, 0, 100)) && value[0] <= value[1]
    case 'category': return ['personal', 'team'].includes(value)
    case 'mode': return ['focused', 'relaxed'].includes(value)
    case 'tags': return Array.isArray(value) && value.length <= 3 && new Set(value).size === value.length && value.every((v) => ['design', 'writing', 'code'].includes(v))
    case 'date': return validDate(value)
    case 'time': return typeof value === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)
    case 'rating': return Number.isInteger(value) && finite(value, 0, 5)
    default: return false
  }
}

export function apply(ctx) {
  let state = { form: clone(initialForm), saves: 0 }
  const listeners = new Set()
  const publish = () => { for (const emit of listeners) emit(clone(state)) }
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('workbench', {
      view: workbenchView,
      data: (_scope, emit) => { emit(clone(state)); listeners.add(emit); return () => listeners.delete(emit) },
      actions: {
        change: (_scope, event) => {
          const { bind, value } = event.value ?? {}
          const key = typeof bind === 'string' && bind.startsWith('data.form.') ? bind.slice(10) : ''
          if (!['enabled', 'level'].includes(key) || !valid(key, value)) throw new TypeError('Invalid changed field')
          state = { ...state, form: { ...state.form, [key]: value } }
          publish()
          return { patch: { form: { [key]: value } } }
        },
        save: (_scope, event) => {
          const values = event.value?.values
          if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Missing form values')
          const next = {}
          for (const key of Object.keys(initialForm)) {
            const value = values[`data.form.${key}`]
            if (!valid(key, value)) throw new TypeError(`Invalid field ${key}`)
            next[key] = key === 'name' ? value.trim() : clone(value)
          }
          if (Object.keys(values).length !== Object.keys(initialForm).length) throw new TypeError('Unexpected form values')
          state = { form: next, saves: state.saves + 1 }
          publish()
          return [{ type: 'patch', data: clone(state) }, { type: 'toast', text: event.locale?.startsWith('en') ? 'Saved' : '已保存' }]
        },
      },
    })
  })
}
