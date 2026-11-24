import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/', import.meta.url)
const [bridge, css] = await Promise.all([
  readFile(new URL('business-bridge.js', root), 'utf8'),
  readFile(new URL('business-bridge.css', root), 'utf8'),
])

test('active assistant tab text yields space to its fixed-size close button', () => {
  assert.match(css, /\.panel-header:has\(\.business-assistant-tab-row\) \.panel-identity\s*\{\s*flex:\s*1 1 0;\s*min-width:\s*0;/)
  assert.match(css, /\.business-assistant-tab-current\s*\{[^}]*flex:\s*0 1 8em;[^}]*min-width:\s*24px/)
  assert.match(css, /\.business-assistant-tab-current > button\[role="tab"\]\s*\{\s*flex:\s*1 1 0;\s*min-width:\s*0;\s*max-width:\s*none;/)
  assert.match(css, /\.business-assistant-tab-close\s*\{[^}]*flex:\s*0 0 24px !important;[^}]*min-width:\s*24px !important;[^}]*width:\s*24px;/)
  assert.match(css, /@container\s*\(max-width:\s*220px\)[\s\S]*?\.business-assistant-tabs > button\[data-assistant-fixed\]\s*\{\s*max-width:\s*2\.5em;\s*padding-inline:\s*2px;\s*\}[\s\S]*?\.business-assistant-tab-current > button\[role="tab"\]\s*\{\s*padding-inline:\s*2px;/)
  const start = bridge.indexOf('function renderAssistantTabBar(')
  const end = bridge.indexOf('\n  async function selectAssistantTab(', start)
  const render = bridge.slice(start, end)
  assert.match(render, /close\.addEventListener\('click',[\s\S]*?closeAssistantTab\(record, tab\.roleId\)/)
})
