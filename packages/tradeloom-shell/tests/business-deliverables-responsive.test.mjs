import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const files = {
  css: new URL('../../../workbench/static/workbench/styles.css', import.meta.url),
  template: new URL('../../../workbench/templates/workbench/artifacts.html', import.meta.url),
  script: new URL('../../../workbench/static/workbench/intake.js', import.meta.url),
}

test('deliverables keeps its file list and preview visible with independent scroll at narrow and wide panel widths', async () => {
  const { css, template, script } = await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, 'utf8')]))
    .then(Object.fromEntries)
  assert.match(css, /data-business-browser-mode="deliverables"[\s\S]*?grid-template-columns: minmax\(220px, 0\.32fr\) minmax\(0, 0\.68fr\)/)
  assert.match(css, /@container \(max-width: 640px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)[\s\S]*?grid-template-rows: minmax\(130px, 0\.8fr\) minmax\(180px, 1\.2fr\)/)
  assert.match(css, /\.file-list-scroll,[\s\S]*?\.file-preview-source,[\s\S]*?\.file-preview-reader\s*\{[^}]*overflow: auto/)
  assert.match(template, /deliverables-split-scroll1/)
  assert.match(script, /sourcePreview\.parentNode !== filePreviewHost[\s\S]*?filePreviewHost\.append\(sourcePreview\)/)
  assert.match(script, /!browserMode && sourcePreview\.parentNode !== sourcePreviewParent[\s\S]*?sourcePreviewParent\.insertBefore/)
})
