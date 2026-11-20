import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const paletteSource = fs.readFileSync(path.join(root, 'client.replica-palette.js'), 'utf8')
const nativeSource = fs.readFileSync(path.join(root, 'client.source-native.js'), 'utf8')
const sceneSource = fs.readFileSync(path.join(root, 'client.scenes.js'), 'utf8')
const replicaRoot = path.resolve(root, '../../apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/replica-ui')
const tokens = fs.readFileSync(path.join(replicaRoot, 'palette-tokens.css'), 'utf8')
const accepted = fs.readFileSync(path.join(replicaRoot, 'style.css'), 'utf8')
const official = process.env.DSH_OFFICIAL_ASAR
let officialArchive

function officialEntry(relative, expected) {
  const raw = officialArchive ??= fs.readFileSync(official)
  assert.equal(createHash('sha256').update(raw).digest('hex'), '49fd1b087190d594b15c44fe6394c6ffd591200aba76e209b5769498f83076ae')
  const header = JSON.parse(raw.subarray(16, 16 + raw.readUInt32LE(12)))
  const entry = relative.split('/').reduce((node, name) => node.files[name], header)
  const start = 8 + raw.readUInt32LE(4) + Number(entry.offset)
  const payload = raw.subarray(start, start + entry.size)
  const digest = createHash('sha256').update(payload).digest('hex')
  assert.equal(digest, expected)
  assert.equal(digest, entry.integrity.hash)
  return payload.toString('utf8')
}

function paletteDocument() {
  const nodes = []
  const doc = {
    baseURI: 'dsh-app://app/index.html', documentElement: {},
    querySelectorAll: () => nodes.filter(node => !node.removed),
    createElement(tag) {
      const handlers = new Map()
      return { tag, dataset: {}, removed: false,
        addEventListener: (name, callback) => handlers.set(name, callback),
        remove() { this.removed = true },
        loaded() { this.sheet = {}; handlers.get('load')?.() },
      }
    },
    head: { appendChild(node) { nodes.push(node); queueMicrotask(() => node.loaded()) } },
  }
  return { doc, nodes }
}

async function installPalette() {
  const { doc, nodes } = paletteDocument()
  let adapter, applied, released = 0
  const window = { document: doc, __ModuleLoader__: { load(spec) { adapter = spec.factory() } } }
  vm.runInNewContext(paletteSource, { window, URL, WeakMap, Promise })
  const ctx = { theme: { overrideTokens(_source, pairs) { applied = pairs; return () => { released++ } } } }
  const dispose = await adapter.install(ctx)
  return { applied, dispose, nodes, released: () => released }
}

function chatStyleInstaller(doc) {
  const start = nativeSource.indexOf('    const nativeChatStyles = `')
  const end = nativeSource.indexOf('    const whaleAutoBases', start)
  assert.ok(start >= 0 && end > start, 'owned native chat style entry must be installed')
  return vm.runInNewContext(nativeSource.slice(start, end) + '\n;({nativeChatStyles,installNativeChatStyles})', { document: doc })
}

test('native colors resolve to the accepted light/dark palette and release their own layer', async () => {
  const state = await installPalette()
  for (const [name, pair] of Object.entries(state.applied)) {
    assert.deepEqual(Object.keys(pair), ['light', 'dark'], name)
    for (const mode of ['light', 'dark']) {
      assert.match(pair[mode], new RegExp(`^var\\(--tl-palette-${mode}-[a-z0-9-]+\\)$`))
      assert.ok(tokens.includes(pair[mode].slice(4, -1) + ':'), name)
    }
  }
  for (const name of ['--dsw-alias-bg-module-platform', '--dsw-alias-button-info-fill', '--dsw-alias-label-on-color', '--dsw-specific-menu']) {
    assert.ok(state.applied[name], name)
  }
  state.dispose(); state.dispose()
  assert.equal(state.released(), 1)
  assert.equal(state.nodes[0].removed, true)
})

test('owned compact composer restores accepted card dimensions without changing the native factory', () => {
  const nodes = []
  const doc = { createElement() { return { dataset: {}, remove() { nodes.splice(nodes.indexOf(this), 1) } } }, head: { append(node) { nodes.push(node) } } }
  const { nativeChatStyles, installNativeChatStyles } = chatStyleInstaller(doc)
  const dispose = installNativeChatStyles()
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].dataset.tradeloomNativeChat, '1')
  const card = /\[data-composer-card\]\s*\{([^}]+)\}/.exec(nativeChatStyles)[1]
  const acceptedCard = /\.comp-box\s*\{([^}]+)\}/.exec(accepted)[1]
  for (const declaration of ['border-radius:9px', 'padding:8px 10px']) {
    assert.ok(card.includes(declaration))
    assert.ok(acceptedCard.includes(declaration))
  }
  assert.match(nativeChatStyles, /\[data-composer-seat\][\s\S]*position:sticky;bottom:0/)
  assert.match(nativeChatStyles, /--dsh-chat-content-width:calc\(100% - 16px\)/)
  for (const selector of nativeChatStyles.split('}').slice(0, -1).map(rule => rule.split('{')[0].trim())) {
    if (!selector || selector.startsWith('@media') || selector.startsWith('@container')) continue
    assert.ok(selector.startsWith('[data-source-native-root]'), selector)
    assert.ok(!selector.includes('GRgSLq_') && !selector.includes('an3WzG_'))
  }
  dispose()
  assert.equal(nodes.length, 0)
})

test('actual rc2 input CSS bounds empty, image and multi-image drafts in small owned viewports', {
  skip: !(official && process.env.DSH_STYLE_BROWSER && process.env.DSH_STYLE_OUTPUT),
}, () => {
  // This runs the real provider CSS in a headless browser, not React or the app.
  // The fixture follows the provider's public composer attributes and its exact
  // CSS-module map; it does not read any user draft or create a model request.
  const source = officialEntry('dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', '2c3c39fddb37df9ee1168c279259aebb7cf484651a7e978ce9baaaf24d142a60')
  const { nativeChatStyles } = chatStyleInstaller({})
  function moduleMap(name) {
    const start = source.indexOf(`var ${name}=`) + `var ${name}=`.length
    const end = source.indexOf('};', start)
    return vm.runInNewContext('(' + source.slice(start, end + 1) + ')')
  }
  function moduleCSS(name) {
    const tag = source.indexOf(`@deepseek-ai/dsh-client-ui-conversation/${name}.module.css`)
    assert.ok(tag > 0)
    const declaration = [...source.slice(0, tag).matchAll(/const (css(?:\$\d+)?)=/g)].at(-1)
    const start = declaration.index + declaration[0].length
    const quote = source[start]
    assert.equal(quote, '`')
    let end = start + 1
    while (end < source.length) {
      if (source[end] === '\\') { end += 2; continue }
      if (source[end] === quote) break
      end++
    }
    return vm.runInNewContext(source.slice(start, end + 1))
  }
  const classes = { conversation: moduleMap('ConversationRoot_module_css_default'), input: moduleMap('InputBar_module_css_default') }
  const css = moduleCSS('ConversationRoot') + moduleCSS('InputBar') + nativeChatStyles
  const output = path.resolve(process.env.DSH_STYLE_OUTPUT)
  fs.mkdirSync(output, { recursive: true })
  const fixture = path.join(output, 'native-composer-layout.html')
  const script = `
    const classes=${JSON.stringify(classes)}, css=${JSON.stringify(css)};
    const cases=[];
    async function inspect(height, images) {
      const frame=document.createElement('iframe');frame.style.cssText='width:480px;height:'+height+'px;border:0';document.body.append(frame);
      const c=classes.conversation,i=classes.input;
      const image='<img width="100" height="120" style="display:block" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22120%22%3E%3Crect width=%22100%22 height=%22120%22 fill=%22blue%22/%3E%3C/svg%3E">';
      frame.srcdoc='<style>html,body{margin:0;height:100%;overflow:hidden}p{margin:0}'+css+'</style>'+
        '<div data-source-native-root data-conversation-density="compact" style="height:100%;display:flex;flex-direction:column">'+
        '<div class="'+c.body+' '+c.embeddedBody+'" data-conversation-content data-conversation-region="chat" data-content-phase="active">'+
        '<div class="'+c.scrollBody+'" data-conversation-scroll><div class="'+c.viewArea+'" data-slot="conversation.session"><div style="height:48px">Previous conversation</div></div>'+
        '<div class="'+c.composerSeat+'" data-composer-seat><div class="'+i.root+'"><div class="'+i.card+'" data-composer-card>'+
        '<div class="'+i.scroll+'"><div class="'+i.grow+'"><div class="'+i.input+'" data-composer-input><p>Draft</p>'+image.repeat(images)+'</div></div></div>'+
        '<div class="'+i.row+'"><div class="'+i.tools+'"><button class="'+i.add+'" aria-label="Add"><svg width="16" height="16"></svg></button><div class="'+i.modes+'"><button class="'+i.select+'">Model</button></div></div>'+
        '<div class="'+i.trailing+'"><span class="'+i.standardControls+'"><button class="'+i.primary+'" aria-label="Send"><svg width="16" height="16"></svg></button></span></div></div></div><div class="'+i.dock+'"><span>Context</span></div></div></div></div></div></div>';
      await new Promise(resolve=>frame.onload=resolve);
      const d=frame.contentDocument,w=frame.contentWindow;
      await Promise.all([...d.images].map(image=>image.decode().catch(()=>{})));
      // Static inline CSS is loaded at onload; geometry reads below flush layout.
      // A timer task avoids waiting on offscreen-frame animation throttling.
      await new Promise(resolve=>w.setTimeout(resolve,0));
      const composer=d.querySelector('[data-composer-seat]'),scroll=d.querySelector('.'+i.scroll),history=d.querySelector('[data-slot="conversation.session"]');
      const cr=composer.getBoundingClientRect(),hr=history.getBoundingClientRect(),computed=w.getComputedStyle(scroll);
      const primary=d.querySelector('.'+i.primary),add=d.querySelector('.'+i.add),select=d.querySelector('.'+i.select),row=d.querySelector('.'+i.row),tools=d.querySelector('.'+i.tools),modes=d.querySelector('.'+i.modes),trailing=d.querySelector('.'+i.trailing),rowStyle=w.getComputedStyle(row);
      cases.push({height,images,viewport:w.innerHeight,composerHeight:cr.height,historyVisible:Math.max(0,Math.min(hr.bottom,cr.top,w.innerHeight)-Math.max(hr.top,0)),inputHeight:scroll.clientHeight,inputContentHeight:scroll.scrollHeight,inputMaxHeight:computed.maxHeight,overflowY:computed.overflowY,primaryWidth:primary.getBoundingClientRect().width,primaryHeight:primary.getBoundingClientRect().height,addWidth:add.getBoundingClientRect().width,addHeight:add.getBoundingClientRect().height,selectHeight:select.getBoundingClientRect().height,rowMarginTop:rowStyle.marginTop,rowPadding:rowStyle.padding,rowGap:rowStyle.gap,toolsGap:w.getComputedStyle(tools).gap,modesGap:w.getComputedStyle(modes).gap,trailingGap:w.getComputedStyle(trailing).gap,standardFont:w.getComputedStyle(primary).fontSize,primaryTranslateY:new w.DOMMatrix(w.getComputedStyle(primary).transform).m42});
    }
    (async()=>{for(const height of [200,380])for(const images of [0,1,4])await inspect(height,images);document.getElementById('style-results').textContent=JSON.stringify(cases)})().catch(()=>{document.getElementById('style-results').textContent='fixture-error'});
  `
  fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><pre id="style-results"></pre><script>' + script.replaceAll('</script', '<\\/script') + '</script>')
  const profile = fs.mkdtempSync(path.join(output, 'headless-profile-'))
  const command = ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + profile, '--virtual-time-budget=4000', '--dump-dom', new URL('file:///' + fixture.replaceAll('\\', '/')).href]
  const result = spawnSync(process.env.DSH_STYLE_BROWSER, command, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  fs.writeFileSync(path.join(output, 'browser.stdout.log'), result.stdout ?? '')
  fs.writeFileSync(path.join(output, 'browser.stderr.log'), result.stderr ?? '')
  fs.writeFileSync(path.join(output, 'browser.command.json'), JSON.stringify({ executable: process.env.DSH_STYLE_BROWSER, arguments: command, exitCode: result.status, errorCode: result.error?.code ?? null }, null, 2))
  assert.ifError(result.error)
  assert.equal(result.status, 0)
  const match = /<pre id="style-results">([^<]+)<\/pre>/.exec(result.stdout)
  assert.ok(match, 'real browser layout results must be emitted')
  const cases = JSON.parse(match[1])
  assert.equal(cases.length, 6)
  fs.writeFileSync(path.join(output, 'layout-results.json'), JSON.stringify(cases, null, 2))
  for (const row of cases) {
    assert.equal(row.viewport, row.height)
    assert.ok(row.historyVisible >= 26, JSON.stringify(row))
    assert.ok(row.composerHeight < row.height - 26, JSON.stringify(row))
    assert.equal(row.overflowY, 'auto')
    assert.equal(row.primaryWidth, 26)
    assert.equal(row.primaryHeight, 26)
    assert.equal(row.addWidth, 26)
    assert.equal(row.addHeight, 26)
    assert.equal(row.selectHeight, 26)
    assert.equal(row.rowMarginTop, '8px')
    assert.equal(row.rowPadding, '0px')
    assert.equal(row.rowGap, '8px')
    assert.equal(row.toolsGap, '7px')
    assert.equal(row.modesGap, '7px')
    assert.equal(row.trailingGap, '7px')
    assert.equal(row.standardFont, '11px')
    assert.equal(row.primaryTranslateY, -2, 'legacy and current native primary both retain this transform')
    assert.ok(row.inputHeight <= Number.parseFloat(row.inputMaxHeight) + 1, JSON.stringify(row))
    if (row.images === 4 || row.images === 1 && row.height === 200) assert.ok(row.inputContentHeight > row.inputHeight, JSON.stringify(row))
  }
})

test('short pane slash menu exposes rows when the provider cap uses the outer frame', {
  skip: !(process.env.DSH_MENU_FIXTURE_ASAR && process.env.DSH_STYLE_BROWSER && process.env.DSH_STYLE_OUTPUT),
}, () => {
  // The accepted isolated F8 archive pins the provider CSS; the shell adapter
  // is read from this source tree so the test covers the real placement logic.
  const raw = fs.readFileSync(process.env.DSH_MENU_FIXTURE_ASAR)
  assert.equal(createHash('sha256').update(raw).digest('hex'), '08991a8f346c1ca35d3a7f0c4dd7c5174afedee892afa90793763e15894d1d5b')
  const header = JSON.parse(raw.subarray(16, 16 + raw.readUInt32LE(12)))
  function entry(relative) {
    const item = relative.split('/').reduce((node, name) => node.files[name], header)
    const start = 8 + raw.readUInt32LE(4) + Number(item.offset)
    const payload = raw.subarray(start, start + item.size)
    assert.equal(createHash('sha256').update(payload).digest('hex'), item.integrity.hash, relative)
    return payload.toString('utf8')
  }
  function moduleMap(source, name) {
    const prefix = 'var ' + name + '='
    const start = source.indexOf(prefix) + prefix.length
    const end = source.indexOf('};', start)
    assert.ok(start >= prefix.length && end > start, name)
    return vm.runInNewContext('(' + source.slice(start, end + 1) + ')')
  }
  function moduleCSS(source, packageName, name) {
    const tag = '@deepseek-ai/' + packageName + '/' + name + '.module.css'
    const tagAt = source.indexOf(tag)
    assert.ok(tagAt > 0, tag)
    const declaration = [...source.slice(0, tagAt).matchAll(/const (css(?:\$[0-9]+)?)=/g)].at(-1)
    assert.ok(declaration, tag)
    let start = declaration.index + declaration[0].length
    const quote = source[start]
    assert.equal(quote, String.fromCharCode(96))
    let end = start + 1
    while (end < source.length) {
      if (source[end] === '\\') { end += 2; continue }
      if (source[end] === quote) break
      end++
    }
    return vm.runInNewContext(source.slice(start, end + 1))
  }
  const conversation = entry('dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
  const trigger = entry('dsh/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js')
  const classes = {
    conversation: moduleMap(conversation, 'ConversationRoot_module_css_default'),
    input: moduleMap(conversation, 'InputBar_module_css_default'),
    menu: moduleMap(trigger, 'MenuView_module_css_default'),
  }
  const css = moduleCSS(conversation, 'dsh-client-ui-conversation', 'ConversationRoot')
    + moduleCSS(conversation, 'dsh-client-ui-conversation', 'InputBar')
    + moduleCSS(trigger, 'dsh-client-ui-input-trigger', 'MenuView')
  const adapterStart = sceneSource.indexOf('    function installShortPaneTriggerOverlays(root)')
  const adapterEnd = sceneSource.indexOf('\n    function SceneChatPanel', adapterStart)
  assert.ok(adapterStart >= 0 && adapterEnd > adapterStart, 'native menu adapter must remain extractable')
  const adapter = sceneSource.slice(adapterStart, adapterEnd).trim()
  const { nativeChatStyles } = chatStyleInstaller({})
  const output = path.resolve(process.env.DSH_STYLE_OUTPUT)
  fs.mkdirSync(output, { recursive: true })
  const fixture = path.join(output, 'native-trigger-menu-layout.html')
  const script = String.raw`
    const c=__CLASSES__,css=__CSS__;
    document.head.insertAdjacentHTML('beforeend','<style>'+css+'</style>');
    __ADAPTER__
    const root=document.getElementById('root');
    root.innerHTML='<div class="'+c.conversation.body+' '+c.conversation.embeddedBody+'" data-conversation-content data-content-phase="active">'+
      '<div class="'+c.conversation.scrollBody+'" data-conversation-scroll><div class="'+c.conversation.viewArea+'" data-slot="conversation.session"><div style="height:48px">History</div></div>'+
      '<div class="'+c.conversation.composerSeat+'" data-composer-seat><div class="'+c.input.root+'"><div class="'+c.input.card+'" data-composer-card>'+
      '<div class="'+c.input.overlayAnchor+'" data-composer-overlay></div><div class="'+c.input.scroll+'"><div class="'+c.input.grow+'"><div class="'+c.input.input+'" data-composer-input><p>/</p></div></div></div>'+
      '<div class="'+c.input.row+'"><div class="'+c.input.tools+'"><button class="'+c.input.add+'">+</button></div><div class="'+c.input.trailing+'"><button class="'+c.input.primary+'">↑</button></div></div></div><div class="'+c.input.dock+'">Context</div></div></div></div>';
    const menu=document.createElement('div');menu.className=c.menu.menu;menu.setAttribute('data-trigger-menu','');menu.style.maxHeight='71px';
    menu.innerHTML='<div class="'+c.menu.viewport+'" role="listbox"><div class="'+c.menu.groupTitle+'">添加</div>'+
      Array.from({length:8},(_,i)=>'<button class="'+c.menu.item+'" role="option"><span class="'+c.menu.itemName+'">Command '+i+'</span></button>').join('')+'</div>';
    root.querySelector('[data-composer-overlay]').append(menu);
    const dispose=installShortPaneTriggerOverlays(root);
    setTimeout(()=>{const r=menu.getBoundingClientRect(),pane=root.getBoundingClientRect(),seat=root.querySelector('[data-composer-seat]').getBoundingClientRect(),card=root.querySelector('[data-composer-card]').getBoundingClientRect(),anchor=root.querySelector('[data-composer-input]').getBoundingClientRect(),v=menu.querySelector('[role="listbox"]'),items=[...menu.querySelectorAll('[role="option"]')],first=items[0].getBoundingClientRect();
      const rowsVisible=items.filter(item=>{const row=item.getBoundingClientRect();return row.height>0&&row.top>=r.top&&row.bottom<=r.bottom}).length;
      let pickedIndex=-1;
      const onPick=index=>{pickedIndex=index};
      items.forEach((item,index)=>item.addEventListener('mousedown',event=>{event.preventDefault();onPick(index)}));
      const hit=document.elementFromPoint(first.left+first.width/2,first.top+first.height/2);
      const hitOption=hit?.closest('[role="option"]');
      const pointerOptionIndex=hitOption?items.indexOf(hitOption):-1;
      const pointerEvent=new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:first.left+first.width/2,clientY:first.top+first.height/2});
      hit?.dispatchEvent(pointerEvent);
      const pointerSelectedIndex=pickedIndex;
      v.scrollTop=first.height;
      document.getElementById('menu-result').textContent=JSON.stringify({viewport:innerHeight,paneTop:pane.top,paneBottom:pane.bottom,seatTop:seat.top,seatBottom:seat.bottom,cardTop:card.top,cardBottom:card.bottom,anchorTop:anchor.top,anchorBottom:anchor.bottom,menuHeight:r.height,top:r.top,bottom:r.bottom,max:menu.style.maxHeight,rowsVisible,firstRowHeight:first.height,pointerOptionIndex,pointerSelectedIndex,pointerDefaultPrevented:pointerEvent.defaultPrevented,scrollHeight:v.scrollHeight,clientHeight:v.clientHeight,scrollTop:v.scrollTop,overflow:getComputedStyle(v).overflowY,optionCount:items.length});
    },250);
  `.replace('__CLASSES__', JSON.stringify(classes)).replace('__CSS__', JSON.stringify(css + nativeChatStyles)).replace('__ADAPTER__', adapter)
  fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}#menu-result{position:absolute;top:0;left:0}</style><pre id="menu-result"></pre><div id="root" data-source-native-root data-conversation-density="compact" style="height:100%;display:flex;flex-direction:column;container-type:size"></div><script>' + script.replaceAll('</script', '<\\/script') + '</script>')
  const profile = fs.mkdtempSync(path.join(output, 'menu-headless-profile-'))
  const command = ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--user-data-dir=' + profile, '--window-size=1177,461', '--virtual-time-budget=4000', '--dump-dom', new URL('file:///' + fixture.replaceAll('\\', '/')).href]
  const result = spawnSync(process.env.DSH_STYLE_BROWSER, command, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  fs.writeFileSync(path.join(output, 'native-trigger-menu.stdout.log'), result.stdout ?? '')
  fs.writeFileSync(path.join(output, 'native-trigger-menu.stderr.log'), result.stderr ?? '')
  assert.ifError(result.error)
  assert.equal(result.status, 0)
  const match = /<pre id="menu-result">([^<]+)<\/pre>/.exec(result.stdout)
  assert.ok(match, 'real headless menu geometry must be emitted')
  const metrics = JSON.parse(match[1])
  fs.writeFileSync(path.join(output, 'native-trigger-menu.metrics.json'), JSON.stringify(metrics, null, 2))
  assert.equal(metrics.viewport, 363)
  assert.ok(metrics.top >= metrics.paneTop, JSON.stringify(metrics))
  assert.ok(metrics.bottom <= metrics.paneBottom, JSON.stringify(metrics))
  assert.ok(metrics.menuHeight >= 100, JSON.stringify(metrics))
  assert.ok(metrics.rowsVisible >= 2, JSON.stringify(metrics))
  assert.equal(metrics.pointerOptionIndex, 0, JSON.stringify(metrics))
  assert.equal(metrics.pointerSelectedIndex, 0, JSON.stringify(metrics))
  assert.equal(metrics.pointerDefaultPrevented, true, JSON.stringify(metrics))
  assert.ok(metrics.scrollHeight > metrics.clientHeight, JSON.stringify(metrics))
  assert.ok(metrics.scrollTop > 0, JSON.stringify(metrics))
  assert.equal(metrics.overflow, 'auto')
  assert.equal(metrics.optionCount, 8)
})

test('rc2 public conversation DOM actually consumes every native selector used by the adapter', { skip: !official }, () => {
  const source = officialEntry('dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', '2c3c39fddb37df9ee1168c279259aebb7cf484651a7e978ce9baaaf24d142a60')
  assert.ok(source.includes('slots.registerFactory({name:`conversation.content`'))
  const { nativeChatStyles } = chatStyleInstaller({})
  for (const name of new Set(nativeChatStyles.match(/data-[a-z-]+/g))) {
    if (name === 'data-source-native-root' || name === 'data-conversation-density') continue
    assert.ok(source.includes(`"${name}"`), name)
  }
  assert.match(nativeSource, /h\('div',\{'data-source-native-root':'','data-conversation-density':'compact'/)
  assert.ok(!source.includes('data-conversation-density'), 'the old compact attribute alone is insufficient')
})

test('rc2 real theme validation accepts the adapter pairs and its real presenter applies both schemes to body', { skip: !official }, async () => {
  const theme = officialEntry('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js', '6bf9c4c2c5b5e9bdd91dd0974c0a7e6d809945938626b4031cd29d28bff188df')
  const layout = officialEntry('dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js', '814486863a32f73e7184a66312ec2d7f5884766000af21f60891a0c01b592630')
  const start = theme.indexOf('function validateOverrides('), end = theme.indexOf('const SVG_NS=', start)
  const validate = vm.runInNewContext(theme.slice(start, end) + ';validateOverrides')
  const { applied, dispose } = await installPalette()
  const pairs = validate('tradeloom-replica-palette:test', applied)
  const classStart = layout.indexOf('var ThemePresenter=class'), classEnd = layout.indexOf(';const inject=', classStart)
  const values = new Map(), attrs = new Map()
  const element = { style: { setProperty: (k, v) => values.set(k, v), removeProperty: k => values.delete(k) }, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k) }
  const Presenter = vm.runInNewContext(layout.slice(classStart, classEnd) + ';ThemePresenter', {
    document: { body: element, documentElement: element, createElement: () => ({ isConnected: false, remove() {} }), head: { append() {} } },
    getComputedStyle: () => ({ backgroundColor: '#000000' }), DARK_ATTRIBUTE: 'data-ds-dark-theme', THEME_SOURCE_ATTRIBUTE: 'data-ds-theme-source', FONT_SIZE_VARIABLES: {}, FONT_FAMILY_VARIABLES: {},
  })
  const presenter = new Presenter()
  for (const mode of ['dark', 'light']) {
    presenter.apply({ preference: mode, active: { colorScheme: mode, tokens: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v[mode]])) }, fontSizes: {}, fontFamilies: {} })
    assert.equal(values.get('--dsw-specific-input-major'), `var(--tl-palette-${mode}-input)`)
    assert.equal(values.get('--dsw-alias-button-info-fill'), `var(--tl-palette-${mode}-accent)`)
  }
  presenter.dispose(); dispose()
  assert.equal(values.size, 0)
})
