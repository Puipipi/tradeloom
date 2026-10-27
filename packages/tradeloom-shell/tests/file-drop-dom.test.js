import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const nodeRequire = createRequire(import.meta.url)
const runtimeRoot = process.env.TRADELOOM_DSH_TEST_RUNTIME
const reactLibrary = process.env.TRADELOOM_REACT_LIBRARY
const reactDomLibrary = process.env.TRADELOOM_REACT_SERVER_LIBRARY
const domModule = process.env.TRADELOOM_DOM_MODULE
const runtimeAvailable = Boolean(runtimeRoot && reactLibrary && reactDomLibrary && domModule)

const sceneChunkUrl = new URL('../client.scenes.js', import.meta.url)
const sceneChunkSource = await readFile(sceneChunkUrl, 'utf8')
let nativeDropEvents
let JSDOM
let React
let createRoot
let act
if (runtimeAvailable) {
  const nativeDropEventsPath = `${runtimeRoot}/packages/client/ui-attachment/lib/types/client/drop-events.js`.replaceAll('\\', '/')
  nativeDropEvents = await import(pathToFileURL(nativeDropEventsPath).href)
  ;({ JSDOM } = nodeRequire(domModule))
  React = nodeRequire(reactLibrary)
  const reactDomRequire = createRequire(reactDomLibrary)
  ;({ createRoot } = reactDomRequire('react-dom/client'))
  act = React.act ?? reactDomRequire('react-dom/test-utils').act
}

const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'File', 'MutationObserver']

function installWindowGlobals(window) {
  const previous = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const name of globals) {
    const value = name === 'window' ? window : window[name]
    if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  }
}

async function mountChat(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://desktop.local/', pretendToBeVisual: true,
  })
  const restoreGlobals = installWindowGlobals(dom.window)
  let registration
  // The chunk registers itself on the provided window object.
  Object.defineProperty(dom.window, '__ModuleLoader__', {
    configurable: true,
    value: { load(value) { registration = value } },
  })
  runInNewContext(sceneChunkSource, { window: dom.window, File: dom.window.File, setTimeout, clearTimeout })
  const exports = registration.factory(name => {
    if (name === 'react') return React
    throw new Error(`Unexpected scene chunk dependency: ${name}`)
  })

  const rootNode = dom.window.document.getElementById('root')
  const root = createRoot(rootNode)
  const exportCalls = []
  const draftCallbackFiles = []
  const nativeAttachmentFiles = []
  const nativeAttachmentState = { dragDepth: { current: 0 }, active: false }
  const cleanNativeDropEvents = nativeDropEvents.installDocumentDropEvents(
    true,
    files => { nativeAttachmentFiles.push(...files) },
    nativeAttachmentState.dragDepth,
    active => { nativeAttachmentState.active = active },
  )
  const props = {
    renderSlot(name) { assert.equal(name, 'conversation.header'); return null },
    renderFactorySlot() {
      return React.createElement('div', { 'data-testid': 'native-composer-slot' },
        React.createElement('textarea', { 'data-testid': 'composer-input', 'aria-label': '诊断输入' }),
        React.createElement('button', { type: 'button', 'data-testid': 'send-button', onClick: () => { dom.window.__sent = true } }, '发送'))
    },
    requestFileExport(kind, id, callback) {
      exportCalls.push({ kind, id })
      callback({ ok: true, file: new dom.window.File(['fixture bytes'], 'diagnostic.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) })
      return true
    },
    onAddFiles(files) {
      draftCallbackFiles.push(...files)
      return true
    },
  }
  await act(async () => { root.render(React.createElement(exports.SceneChatPanel, props)) })
  const child = dom.window.document.querySelector('[data-testid="composer-input"]')
  assert.ok(child, 'the SceneChatPanel is rendered through React DOM with an interactive native slot child')

  t.after(async () => {
    await act(async () => { root.unmount() })
    cleanNativeDropEvents()
    dom.window.close()
    restoreGlobals()
  })
  return { dom, child, exportCalls, draftCallbackFiles, nativeAttachmentFiles, nativeAttachmentState }
}

function dragEvent(window, type, { types, payload = '', files = [], items = [] }) {
  const dataTransfer = {
    types: [...types],
    dropEffect: 'none',
    files: [...files],
    items: [...items],
    getData(mime) { return mime === 'application/x-tradeloom-file' ? payload : '' },
  }
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { configurable: true, value: dataTransfer })
  return event
}

async function dispatchSequence(fixture, payload) {
  const { dom, child } = fixture
  const eventResults = []
  await act(async () => {
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = dragEvent(dom.window, type, payload)
      child.dispatchEvent(event)
      eventResults.push({ type, defaultPrevented: event.defaultPrevented })
    }
  })
  return eventResults
}

test('SceneChatPanel DOM bubbling: custom MIME requests one export and invokes its injected draft callback without sending', { skip: !runtimeAvailable && 'requires explicit desktop11 React, ReactDOM, and jsdom runtime paths' }, async t => {
  const fixture = await mountChat(t)
  const events = await dispatchSequence(fixture, {
    types: ['application/x-tradeloom-file'],
    payload: JSON.stringify({ kind: 'source', id: 'source-17' }),
  })

  assert.deepEqual(fixture.exportCalls, [{ kind: 'source', id: 'source-17' }], 'one valid bubbled drop requests one verified file export')
  assert.equal(fixture.draftCallbackFiles.length, 1)
  assert.equal(fixture.draftCallbackFiles[0].name, 'diagnostic.xlsx')
  assert.equal(fixture.draftCallbackFiles[0].size, 'fixture bytes'.length)
  assert.equal(fixture.dom.window.__sent, undefined, 'adding the File to the scoped draft does not send the conversation')
  assert.ok(events.every(event => event.defaultPrevented), 'the wrapper accepts the custom MIME drag sequence')
  assert.deepEqual(fixture.nativeAttachmentFiles, [], 'the actual native document listener does not treat custom MIME as a Files drop')
  assert.deepEqual(fixture.nativeAttachmentState.dragDepth, { current: 0 })
  assert.equal(fixture.nativeAttachmentState.active, false)
  assert.match(fixture.dom.window.document.querySelector('[role="status"]')?.textContent ?? '', /加入附件草稿/)
})

test('SceneChatPanel DOM bubbling: unknown MIME and malformed custom payload do not request export', { skip: !runtimeAvailable && 'requires explicit desktop11 React, ReactDOM, and jsdom runtime paths' }, async t => {
  const fixture = await mountChat(t)
  const ordinary = await dispatchSequence(fixture, { types: ['text/plain'], payload: 'source-17' })
  assert.deepEqual(ordinary.map(event => event.defaultPrevented), [false, false, false], 'unrelated drags remain unclaimed')
  assert.deepEqual(fixture.exportCalls, [])

  const invalid = await dispatchSequence(fixture, {
    types: ['application/x-tradeloom-file'],
    payload: JSON.stringify({ kind: 'source', id: 'source-17', url: 'https://invalid.example/file' }),
  })
  assert.deepEqual(invalid.map(event => event.defaultPrevented), [true, true, true], 'the wrapper recognizes the MIME but consumes the invalid drop')
  assert.deepEqual(fixture.exportCalls, [], 'extra payload keys fail validation before export')
  assert.deepEqual(fixture.draftCallbackFiles, [])
  assert.equal(fixture.dom.window.__sent, undefined)
  assert.match(fixture.dom.window.document.querySelector('[role="alert"]')?.textContent ?? '', /文件引用无效/)
})

test('native attachment DOM listener positive control: Files reaches native add callback while SceneChatPanel ignores it', { skip: !runtimeAvailable && 'requires explicit desktop11 React, ReactDOM, and jsdom runtime paths' }, async t => {
  const fixture = await mountChat(t)
  const file = new fixture.dom.window.File(['native file bytes'], 'ordinary.txt', { type: 'text/plain' })
  const events = await dispatchSequence(fixture, { types: ['Files'], files: [file] })

  assert.deepEqual(fixture.nativeAttachmentFiles, [file], 'the actual native installDocumentDropEvents handler receives the browser File')
  assert.deepEqual(fixture.exportCalls, [], 'the shell custom-MIME wrapper does not request a business export for Files')
  assert.deepEqual(fixture.draftCallbackFiles, [], 'the injected shell draft callback is not used for an ordinary Files drop')
  assert.ok(events.every(event => event.defaultPrevented), 'the native document listener claims the Files drag sequence')
  assert.deepEqual(fixture.nativeAttachmentState.dragDepth, { current: 0 }, 'native drop cleanup resets the drag counter')
  assert.equal(fixture.nativeAttachmentState.active, false)
  assert.equal(fixture.dom.window.__sent, undefined)
})
