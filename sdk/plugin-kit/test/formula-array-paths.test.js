import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateFormula } from '../lib/formula.js'
import { checkView } from '../lib/view-check.js'

// JSON arrays expose indexes in the App's data path language, not JavaScript
// object properties. Objects may still have their own field named `length`.
const cases = [
  { name: 'nonempty array length is missing', source: 'data.rows.length', data: { rows: [2, 3] }, value: null },
  { name: 'empty array length is missing', source: 'data.rows.length', data: { rows: [] }, value: null },
  { name: 'nested array length is missing', source: 'data.rows[0].length', data: { rows: [[2, 3]] }, value: null },
  { name: 'root array length is missing', source: 'data.length', data: [2, 3], value: null },
  { name: 'array numeric index remains readable', source: 'data.rows[0]', data: { rows: [2, 3] }, value: 2 },
  { name: 'nested array numeric index remains readable', source: 'data.rows[0][1]', data: { rows: [[2, 3]] }, value: 3 },
  { name: 'root array numeric index remains readable', source: 'data[0]', data: [2, 3], value: 2 },
  { name: 'object length field remains readable', source: 'data.rows.length', data: { rows: { length: 2 } }, value: 2 },
  { name: 'object length decimal text remains readable', source: 'data.rows.length', data: { rows: { length: '2.5' } }, value: 2.5 },
  { name: 'object numeric key remains readable', source: 'data.rows[0]', data: { rows: { 0: 2 } }, value: 2 },
]

for (const entry of cases) {
  test(entry.name, () => {
    const view = { v: 2, type: 'metric', label: 'Count', value: { '=': entry.source } }
    const checked = checkView(view, { data: entry.data, lang: 'zh' })
    // Ignore unrelated theme notes; the formula's own value location must
    // match the App's existing missing-value diagnostic.
    const formulaPaths = checked.issues.filter(issue => issue.path === 'view.value').map(issue => issue.path)
    assert.deepEqual({ value: evaluateFormula(entry.source, entry.data), formulaPaths }, {
      value: entry.value,
      formulaPaths: entry.value === null ? ['view.value'] : [],
    })
    assert.equal(checked.fatal, false)
  })
}
