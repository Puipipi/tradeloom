const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, dialog, Menu, session } = require('electron');
const candidateRoot = path.resolve(__dirname, '../../..');
const { DesktopAiWebWindows } = require(path.join(candidateRoot, 'browser-guests.cjs'));
const { diagnoseNativeAiWebPage, NativeAiWebDiagnosticError } = require(path.join(candidateRoot, 'ai-web-diagnostics.cjs'));
const userData = path.join(candidateRoot, 'diagnostics-private-user-data-' + process.pid);
const resultPath = path.join(candidateRoot, 'patch23-diagnostics-result-' + process.pid + '.json');
app.setPath('userData', userData);
const canary = 'PATCH23_PRIVATE_CANARY_7c24';
let showCount = 0;
let focusCount = 0;
let builtMenu;
const originalBuildMenu = Menu.buildFromTemplate;
Menu.buildFromTemplate = function (template, options) { builtMenu = originalBuildMenu.call(this, template, options); return builtMenu; };
const originalShow = BrowserWindow.prototype.show;
const originalFocus = BrowserWindow.prototype.focus;
BrowserWindow.prototype.show = function () { showCount++; };
BrowserWindow.prototype.focus = function () { focusCount++; };
const results = { checks: [] };
const check = (name, ok) => { assert.ok(ok, name); results.checks.push(name); };
const wait = (promise, ms = 8000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('fixture timeout')), ms))]);
const waitFor = async (predicate, ms = 8000) => wait((async () => { while (!predicate()) await new Promise(resolve => setTimeout(resolve, 20)); })(), ms);

app.whenReady().then(async () => {
  const browserSession = session.fromPartition('persist:tradeloom-ai-web-deepseek-v1');
  await browserSession.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'chat.deepseek.com') return new Response('blocked fixture host', { status: 404 });
    return new Response(`<!doctype html><html><body>
      <article data-message-id="${canary}" data-turn-id="${canary}">${canary}</article>
      <textarea aria-label="${canary}" data-testid="chat_composer"></textarea>
      <button aria-label="${canary}">${canary}</button>
      <button id="sidebar-action" data-testid="history_search">history</button>
      <form><textarea data-testid="inside_form"></textarea><button aria-label="Send">send</button></form>
      <script>document.cookie='diagnostic_canary=${canary}; path=/'; localStorage.setItem('diagnostic_canary','${canary}');</script>
    </body></html>`, { headers: { 'content-type': 'text/html' } });
  });
  const owner = new BrowserWindow({ show: false });
  const manager = new DesktopAiWebWindows(() => undefined);
  const request = { provider: 'deepseek' };
  manager.toggle(owner, request);
  const page = BrowserWindow.getAllWindows().find(window => window !== owner);
  assert.ok(page);
  if (page.webContents.isLoading()) await wait(new Promise(resolve => {
    page.webContents.once('did-finish-load', resolve);
    page.webContents.once('did-fail-load', (_event, code) => resolve(code));
  }), 12000);
  const beforeShow = showCount;
  const beforeFocus = focusCount;
  let message;
  const oldMessage = dialog.showMessageBox;
  dialog.showMessageBox = async (_window, options) => { message = options; return { response: 0 }; };
  const menu = builtMenu;
  const item = menu?.items.find(entry => entry.label === '网页')?.submenu?.items.find(entry => entry.label === '导出无内容站点诊断');
  assert.ok(item, 'fixed Web menu export action exists');
  item.click();
  await waitFor(() => Boolean(message));
  check('menu reports exported path only', message.message === '无内容站点诊断已导出' && typeof message.detail === 'string');
  check('diagnostic action does not show/focus window', showCount === beforeShow && focusCount === beforeFocus);
  const outPath = message.detail;
  check('export is in fixed app-owned directory', outPath.startsWith(path.join(userData, 'site-diagnostics') + path.sep));
  const jsonText = await fs.readFile(outPath, 'utf8');
  check('export JSON contains no sensitive canary', !jsonText.includes(canary));
  const json = JSON.parse(jsonText);
  check('standalone textarea is reported, draft/generation unknown', json.inputPresent === true && json.candidates.some(item => item.kind === 'input' && item.testId === 'chat_composer') && json.draftState === 'unknown' && json.generationState === 'unknown');
  check('only button inside a trusted composer root is returned', json.candidates.filter(item => item.kind === 'button').length === 1 && json.candidates.find(item => item.kind === 'button').ariaLabel === 'Send');
  check('sensitive message values are only presence metadata', json.messageIdentityAttributes.some(item => item.name === 'data-message-id' && item.present === true));

  const fake = (href, run) => ({
    isDestroyed: () => false,
    getURL: () => href.value,
    get mainFrame() { return { processId: 2, routingId: 3, url: href.value }; },
    executeJavaScriptInIsolatedWorld: run,
  });
  await assert.rejects(diagnoseNativeAiWebPage(fake({ value: 'https://evil.example/' }, async () => null), 'deepseek'), error => error.code === 'unsupported-origin');
  results.checks.push('unsupported origin rejected with safe code');
  const moved = { value: 'https://chat.deepseek.com/' };
  await assert.rejects(diagnoseNativeAiWebPage(fake(moved, async () => { moved.value += 'changed'; return null; }), 'deepseek'), error => error.code === 'document-changed');
  results.checks.push('navigation during probe rejected with safe code');
  const closed = fake({ value: 'https://chat.deepseek.com/' }, async () => null);
  closed.isDestroyed = () => true;
  await assert.rejects(diagnoseNativeAiWebPage(closed, 'deepseek'), error => error.code === 'window-destroyed');
  results.checks.push('destroyed owner rejected with safe code');
  await assert.rejects(diagnoseNativeAiWebPage(fake({ value: 'https://chat.deepseek.com/' }, () => new Promise(() => {})), 'deepseek'), error => error.code === 'diagnostic-timeout');
  results.checks.push('hung page probe fails within five-second deadline');
  dialog.showMessageBox = oldMessage;
  owner.destroy();
  check('owner destruction closes its owned page', page.isDestroyed());
  results.ok = true;
  await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
  app.exit(0);
}).catch(async error => {
  results.error = error?.stack || String(error);
  await fs.writeFile(resultPath, JSON.stringify(results, null, 2));
  app.exit(1);
});









