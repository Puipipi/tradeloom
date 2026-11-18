import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

test('actual global menu refresh preserves both site menus; closed/stale owners are not remounted and reopen uses a new menu', async () => {
  assert.ok(process.env.TL_WEB_AI_MAIN_SOURCE, 'explicit assembled candidate Main required')
  const bytes = await readFile(process.env.TL_WEB_AI_MAIN_SOURCE)
  const recipe = JSON.parse(await readFile(new URL('../../../apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/desktop-recipe.json', import.meta.url), 'utf8'))
  assert.deepEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, recipe.finalOverlay.postimages['lib/main.js'])
  const source = bytes.toString('utf8').replace(/\r\n/g, '\n')
  const begin = source.indexOf('var DesktopAiWebWindow = class'), end = source.indexOf('\nconst desktopPanePopoutTickets', begin)
  assert.ok(begin > 0 && end > begin)
  const allWindows = [], app = { quit() {} }
  // Electron/OS are controlled. This is its Windows application-menu overwrite
  // semantics; the actual product caller and its two real class bodies run.
  const Menu = { buildFromTemplate: template => ({ template }), setApplicationMenu(menu) { for (const window of allWindows) window.setMenu(menu) } }
  const { Site, Manager } = new Function('createAuthGenerationProjector', 'Menu', 'app', 'shell', source.slice(begin, end) + ';return { Site:DesktopAiWebWindow,Manager:DesktopAiWebWindows };')(() => ({ generation: 0 }), Menu, app, {})
  const manager = new Manager(() => 'controlled-host', () => {}, () => {})
  const newWindow = () => { const window = new EventEmitter(); window.dead = false; window.writes = 0; window.isDestroyed = () => window.dead; window.setMenu = menu => { assert.equal(window.dead, false, 'never set a closed window menu'); window.menu = menu; window.writes++ }; allWindows.push(window); return window }
  const makeSite = provider => { const owner = new EventEmitter(); owner.dead = false; owner.isDestroyed = () => owner.dead; const site = new Site(() => '', { provider }, () => {}, () => {}); site.owner = owner; site.window = newWindow(); return site }
  const siteSource = source.slice(begin, source.indexOf('var DesktopAiWebWindows = class', begin))
  const menuStart = siteSource.search(/^\t\t(?:window\.setMenu\(Menu\.buildFromTemplate|const menu = Menu\.buildFromTemplate)/m)
  const menuEnd = siteSource.indexOf('\n\t\twindow.loadURL', menuStart)
  assert.ok(menuStart > 0 && menuEnd > menuStart)
  const install = new Function('window', 'Menu', 'owner', 'app', 'shell', 'owned', siteSource.slice(menuStart, menuEnd))
  const closeStart = siteSource.indexOf('\t\twindow.once("closed", () => {')
  const closeEnd = siteSource.indexOf('\n\t\twindow.webContents.on("did-start-navigation"', closeStart)
  assert.ok(closeStart > 0 && closeEnd > closeStart)
  const attachClose = new Function('window', 'owner', 'ownerClosed', siteSource.slice(closeStart, closeEnd))
  const sites = ['deepseek', 'doubao'].map(provider => { const site = makeSite(provider); manager.windows.set(provider, site); attachClose.call(site, site.window, site.owner, () => {}); install.call(site, site.window, Menu, site.owner, app, {}, () => true); return site })
  const primary = newWindow()
  const startRefresh = source.indexOf('\tconst refreshApplicationMenu = () => {')
  const endRefresh = source.indexOf('\n\trefreshApplicationMenu();', startRefresh)
  assert.ok(startRefresh > 0 && endRefresh > startRefresh)
  assert.ok(source.indexOf('const aiWebWindows = new DesktopAiWebWindows') < startRefresh, 'manager initialization precedes the first refresh (no new TDZ)')
  const refresh = new Function('Menu', 'process', 'windowsDevToolsShortcuts', 'darwin', 'app', 'currentDesktopLocale', 'applicationItems', 'platformMenus', 'tray', 'aiWebWindows', source.slice(startRefresh, endRefresh) + ';return refreshApplicationMenu;')(Menu, { platform: 'win32' }, [{ role: 'toggleDevTools' }, { role: 'toggleDevTools', accelerator: 'F12' }], false, app, () => ({ messages: {} }), () => [], () => [], null, manager)
  const originals = sites.map(site => site.window.menu)
  refresh()
  assert.equal(sites[0].window.menu, originals[0], 'DeepSeek original menu must survive the real global caller')
  assert.equal(sites[1].window.menu, originals[1], 'Doubao original menu must survive the real global caller')
  assert.deepEqual(primary.menu.template.map(row => row.role), ['toggleDevTools', 'toggleDevTools'], 'other DSH windows keep their original global menu')
  for (const site of sites) {
    const file = site.window.menu.template.find(row => row.label === '文件'), web = site.window.menu.template.find(row => row.label === '网页')
    assert.ok(file.submenu.some(row => row.label === '上传文件到网页…')); assert.ok(web.submenu.some(row => row.label === '导出无内容站点诊断'))
    const old = site.window, owner = site.owner; old.dead = true
    const writes = old.writes
    allWindows.splice(allWindows.indexOf(old), 1)
    old.emit('closed'); assert.equal(site.window, undefined); assert.equal(site.websiteMenu, undefined)
    refresh(); assert.equal(old.writes, writes)
    site.owner = owner; site.window = newWindow(); install.call(site, site.window, Menu, site.owner, app, {}, () => true)
    const reopened = site.window.menu; assert.notEqual(reopened, originals[sites.indexOf(site)])
    refresh(); assert.equal(site.window.menu, reopened)
    owner.dead = true; refresh(); assert.notEqual(site.window.menu, reopened, 'a destroyed owner must not restore a menu')
    owner.dead = false; refresh(); assert.equal(site.window.menu, reopened)
    // The captured window/owner are not allowed to drift into another target.
    site.owner = { isDestroyed: () => false }
    refresh(); assert.notEqual(site.window.menu, reopened, 'a stale captured owner must not restore the old menu')
  }
})
