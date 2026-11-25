// Input JSON on stdin: {baseUrl,cookie,executablePath,screenshot}. Never logs auth.
// Uses a fresh desktop Chromium context. This is not Android WebView timing.
const { chromium } = require('playwright');
const fs = require('node:fs');

(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const base = new URL(input.baseUrl);
  if (base.hostname !== '127.0.0.1') throw new Error('host fixture must use loopback');
  const browser = await chromium.launch({ executablePath: input.executablePath, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    // All resources for the local first screen come from this engine. Tests do
    // not make model requests or send the synthetic profile to external sites.
    await context.route('**/*', (route) => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
    const at = input.cookie.indexOf('=');
    await context.addCookies([{ name: input.cookie.slice(0, at), value: input.cookie.slice(at + 1), url: base.origin }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      const observe = () => {
        const element = document.getElementById('root');
        if (element?.childElementCount && element.innerText.trim()) {
          performance.mark('dsh-first-root-text');
          observer.disconnect();
        }
      };
      const observer = new MutationObserver(observe);
      observer.observe(document, { subtree: true, childList: true, characterData: true });
    });
    await page.goto(base.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0 &&
      performance.getEntriesByName('dsh-first-root-text').length > 0, undefined, { timeout: 30_000 });
    const result = await page.evaluate(() => ({
      paints: performance.getEntriesByType('paint').map(({ name, startTime, duration }) => ({ name, startTime, duration })),
      firstRootTextMs: performance.getEntriesByName('dsh-first-root-text')[0].startTime,
      navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
      rootTextSample: document.getElementById('root').innerText.slice(0, 300),
      resourceCount: performance.getEntriesByType('resource').length,
    }));
    if (input.screenshot) await page.screenshot({ path: input.screenshot, fullPage: false });
    console.log(JSON.stringify({ chromium: await browser.version(), scope: 'fresh Linux Chromium 390x844 context; navigation-relative PaintTiming', ...result, pageErrors: errors }));
    await context.close();
  } finally { await browser.close(); }
})().catch((error) => { console.error(String(error)); process.exitCode = 1; });
