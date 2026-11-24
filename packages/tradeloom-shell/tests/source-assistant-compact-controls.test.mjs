import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/', import.meta.url)
const [bridgeCss, panelCss, interactions] = await Promise.all([
  readFile(new URL('business-bridge.css', root), 'utf8'),
  readFile(new URL('panel-interactions.css', root), 'utf8'),
  readFile(new URL('panel-interactions.js', root), 'utf8'),
])

test('empty assistant overflow takes no header width', () => {
  assert.match(bridgeCss, /\.business-assistant-tabs-scroll:empty\s*\{\s*display:\s*none;/)
})

test('compact assistant headers forward native controls through the existing panel menu', () => {
  assert.match(bridgeCss, /@container\s*\(max-width:\s*340px\)[\s\S]*?\.business-native-placement[\s\S]*?\.business-native-skills[\s\S]*?\.pi-fullscreen\s*\{\s*display:\s*none;/)
  const start = interactions.indexOf('function openMenu(')
  const end = interactions.indexOf('\n  function setFullscreenButton(', start)
  const openMenu = interactions.slice(start, end)
  assert.match(openMenu, /const skillsButton = panel\?\.querySelector\?\.\('\.panel-controls \.business-native-skills'\)/)
  assert.match(openMenu, /if \(skillsButton && getComputedStyle\(skillsButton\)\.display === 'none'\)[\s\S]*?disabled: skillsButton\.disabled,[\s\S]*?forwardButton: skillsButton/)
  assert.match(openMenu, /fullscreenButton && getComputedStyle\(fullscreenButton\)\.display === 'none'[\s\S]*?forwardButton: fullscreenButton/)
  assert.match(interactions, /\['独立窗口', '独立窗口操作暂不可用。'\]/)
})
