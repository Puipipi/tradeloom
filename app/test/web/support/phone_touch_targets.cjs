// Opt-in real Chromium regression, not the Node frame model.
// Requires an existing Playwright install and an explicit browser executable:
// node phone_touch_targets.cjs <chromium> <baseline.css> <candidate.css> <baseline.js> <candidate.js> <output-dir>
// Loads only this local fixture into fresh contexts; no account/profile/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const [executablePath, baselinePath, candidatePath, baselineJsPath, candidateJsPath, outputPath] = process.argv.slice(2);
assert(executablePath && baselinePath && candidatePath && baselineJsPath && candidateJsPath && outputPath, 'Six paths are required');
const fixture = fs.readFileSync(path.join(__dirname, 'phone_touch_targets.html'), 'utf8');
const sources = {
  baseline: fs.readFileSync(baselinePath, 'utf8'),
  candidate: fs.readFileSync(candidatePath, 'utf8'),
  baselineJs: fs.readFileSync(baselineJsPath, 'utf8'),
  candidateJs: fs.readFileSync(candidateJsPath, 'utf8'),
};
// The negative control moves this same default stylesheet after author styles.
const firstLayer = 'document.head.insertBefore(defaults, document.head.firstChild);';
assert.equal(sources.candidateJs.split(firstLayer).length, 2, 'one product insertion point for the ablation');
sources.lateDefaultJs = sources.candidateJs.replace(firstLayer, 'document.head.appendChild(defaults);');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const report = {
  sources: { ...Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, sha256(value)])), fixture: sha256(fixture) },
  scenarios: [],
  observations: [],
};
fs.mkdirSync(outputPath, { recursive: true });

function readGeometry() {
  const rect = el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    coarse: matchMedia('(pointer: coarse)').matches,
    fine: matchMedia('(pointer: fine)').matches,
    touchPoints: navigator.maxTouchPoints,
    viewportWidth: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    defaultSheets: document.querySelectorAll('#dsh-app-phone-layers').length,
    controls: Array.from(document.querySelectorAll('[data-measure]'), el => ({
      id: el.id, ...rect(el), display: getComputedStyle(el).display,
      floor: el.hasAttribute('data-floor'), hidden: el.hasAttribute('data-hidden'),
      unchanged: el.hasAttribute('data-unchanged'), expectedDisplay: el.dataset.display || null,
      rectCount: el.getClientRects().length,
    })),
    wrap: rect(document.querySelector('#wrap')),
  };
}

async function measure(browser, scenario, version) {
  const context = await browser.newContext({
    viewport: { width: scenario.width || 390, height: 844 }, hasTouch: scenario.coarse,
  });
  try {
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(fixture);
    await page.evaluate(({ layout, off }) => {
      if (layout === null) document.documentElement.removeAttribute('data-dsh-app-layout');
      else document.documentElement.setAttribute('data-dsh-app-layout', layout || 'drawer');
      if (off) document.querySelector(off).setAttribute('data-dsh-adapt', 'off');
    }, scenario);
    if (!scenario.noInjection) {
      await page.addStyleTag({ content: sources[version === 'baseline' ? 'baseline' : 'candidate'] });
      const script = sources[version === 'baseline' ? 'baselineJs' : version === 'candidate' ? 'candidateJs' : 'lateDefaultJs'];
      // WebViewPage injects CSS then this complete product script on load.
      await page.addScriptTag({ content: script });
      await page.addScriptTag({ content: script });
    }
    await page.addStyleTag({ content: '@layer lazy-plugin { .late-none { display:none; } .late-flex { display:flex; } }' });
    const measured = await page.evaluate(readGeometry);
    report.pendingMeasurement = { scenario: scenario.name, version, ...measured };
    assert.equal(measured.coarse, scenario.coarse, `${scenario.name}: actual coarse media`);
    assert.equal(measured.fine, !scenario.coarse, `${scenario.name}: actual fine media`);
    assert.equal(measured.defaultSheets, !scenario.noInjection && version !== 'baseline' ? 1 : 0, 'one prelude after repeated injection');
    // Measure real hit testing at the newly reserved edge, not CSS text.
    if (scenario.name === 'coarse' && version === 'candidate') {
      for (const id of ['icon', 'inline-span', 'inline-anchor', 'checkbox']) {
        const target = page.locator(`#${id}`);
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        await page.touchscreen.tap(box.x + box.width - 2, box.y + box.height / 2);
        assert.equal(await page.evaluate(() => window.clicked.at(-1)), id, `${id}: enlarged edge receives touch`);
      }
      await page.evaluate(() => scrollTo(0, 0));
    }
    const observation = { scenario: scenario.name, version, phases: [] };
    report.observations.push(observation);
    async function unchanged(phase) {
      const current = await page.evaluate(readGeometry);
      observation.phases.push({ phase, measurement: current });
      assert.deepEqual(current, measured, `${scenario.name}/${version}/${phase}: actual media and geometry stay unchanged`);
    }
    await unchanged('after-interaction');
    if (['coarse', 'fine', 'coarse-desktop'].includes(scenario.name)) {
      // Full-page capture can itself change Chromium touch emulation. Keep the
      // actual viewport and check media/geometry after each raw viewport PNG.
      if (scenario.name !== 'coarse-desktop') {
        await page.screenshot({ path: path.join(outputPath, `${scenario.name}-${version}.png`) });
        await unchanged('after-top-capture');
      }
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await page.screenshot({ path: path.join(outputPath, `${scenario.name}-${version}-bottom.png`) });
      await page.evaluate(() => scrollTo(0, 0));
      await unchanged('after-bottom-capture');
    }
    return measured;
  } finally {
    await context.close();
  }
}

function verify(scenario, old, current) {
  if (scenario.name !== 'coarse' && scenario.name !== 'coarse-desktop') {
    const { defaultSheets: oldSheets, ...originalGeometry } = old;
    const { defaultSheets: newSheets, ...currentGeometry } = current;
    assert.deepEqual(currentGeometry, originalGeometry, `${scenario.name}: exact baseline geometry/display`);
    return { unchanged: current.controls.length };
  }
  const before = new Map(old.controls.map(control => [control.id, control]));
  let negative = 0;
  let floored = 0;
  for (const control of current.controls) {
    const original = before.get(control.id);
    if (control.floor) {
      assert(original.width < 44 || original.height < 44, `${control.id}: baseline must expose a small target`);
      negative++;
      assert(control.width >= 44 && control.height >= 44, `${control.id}: 44px floor; actual ${control.width}×${control.height}`);
      floored++;
    }
    if (control.hidden) {
      assert.equal(control.rectCount, 0, `${control.id}: stays hidden`);
      assert.equal(original.rectCount, 0, `${control.id}: originally hidden`);
    }
    if (control.unchanged) {
      for (const key of ['width', 'height', 'display', 'rectCount']) {
        assert.equal(control[key], original[key], `${control.id}: preserves ${key}`);
      }
    }
    if (control.expectedDisplay) assert.equal(control.display, control.expectedDisplay, `${control.id}: author layout`);
  }
  const buttons = current.controls.filter(control => control.id.startsWith('wrap-'));
  for (let i = 0; i < buttons.length; i++) {
    const a = buttons[i];
    assert(a.x >= current.wrap.x && a.x + a.width <= current.wrap.x + current.wrap.width, `${a.id}: fits wrapper`);
    for (const b of buttons.slice(i + 1)) {
      assert(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'wrapped controls do not overlap');
    }
  }
  assert.equal(current.scrollWidth, current.viewportWidth, 'no document horizontal overflow');
  return { baselineSmall: negative, candidateFloored: floored };
}

(async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  report.chromium = browser.version();
  try {
    const scenarios = [
      { name: 'coarse', coarse: true },
      { name: 'fine', coarse: false },
      { name: 'coarse-desktop', coarse: true, width: 1100, layout: 'desktop' },
      { name: 'off-no-injection', coarse: true, layout: null, noInjection: true },
      { name: 'no-layout-attribute', coarse: true, layout: null },
      { name: 'root-opt-out', coarse: true, off: 'html' },
      { name: 'main-opt-out', coarse: true, off: '#main' },
      { name: 'ancestor-opt-out', coarse: true, off: '#frame' },
    ];
    for (const scenario of scenarios) {
      const result = { ...scenario };
      report.scenarios.push(result);
      try {
        result.baseline = await measure(browser, scenario, 'baseline');
        if (scenario.name === 'coarse') {
          result.withoutFirstLayer = await measure(browser, scenario, 'without-first-layer');
          const controls = new Map(result.withoutFirstLayer.controls.map(control => [control.id, control]));
          assert(controls.get('layered-none').rectCount > 0, 'negative control: late default layer reveals author-hidden control');
          assert.equal(controls.get('layered-flex').display, 'inline-block', 'negative control: late default layer replaces author flex');
        }
        result.candidate = await measure(browser, scenario, 'candidate');
        result.verification = verify(scenario, result.baseline, result.candidate);
        delete report.pendingMeasurement;
        console.log(JSON.stringify({ name: scenario.name, ...result.verification }));
      } catch (error) {
        result.error = error.stack || String(error);
        console.error(`${scenario.name}: ${result.error}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => {
  report.error = error.stack || String(error);
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.writeFileSync(path.join(outputPath, 'geometry.json'), JSON.stringify(report, null, 2));
});
