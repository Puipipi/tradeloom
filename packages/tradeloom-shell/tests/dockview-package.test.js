import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const packageUrl = new URL('../package.json', import.meta.url)
const bundleUrl = new URL('../client.dockview.js', import.meta.url)

test('Dockview chunk is shipped and declared as host-provided React externals', async () => {
  const pkg = JSON.parse(await readFile(packageUrl, 'utf8'))
  for (const file of [
    'client.dockview.js',
    'vendor/dockview-entry.ts',
    'vendor/dockview.css',
    'vendor/LICENSE.dockview-react',
    'scripts/build-dockview-chunk.mjs',
  ]) assert.ok(pkg.files.includes(file), `${file} must be included in the business-shell package`)
  assert.deepEqual(pkg.dsh.client.external, [
    'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime',
  ])
  assert.equal(pkg.scripts['build:dockview'], 'node scripts/build-dockview-chunk.mjs')
  const lock = JSON.parse(await readFile(new URL('../vendor/dockview-package-lock.json', import.meta.url), 'utf8'))
  assert.equal(lock.packages['node_modules/dockview-react'].version, '8.6.0')
  assert.equal(lock.packages['node_modules/dockview'].version, '8.6.1')
  assert.equal(lock.packages['node_modules/dockview-core'].version, '8.6.1')
})

test('product Dockview chunk registers through the pinned ModuleLoader factory', async () => {
  const source = await readFile(bundleUrl, 'utf8')
  let registration
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  assert.equal(registration.id, '@tradeloom/dsh-business-shell')
  assert.equal(registration.chunk, 'client.dockview.js')
  assert.equal(typeof registration.factory, 'function')
  for (const moduleId of ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']) {
    assert.ok(source.includes(`require("${moduleId}")`), `${moduleId} must remain an external host module`)
  }
  assert.match(source, /DockviewReact/)
  assert.match(source, /dockviewCss/)
  assert.doesNotMatch(source, /ReactCurrentDispatcher/,
    'the production bundle must not include a second React implementation')
})
