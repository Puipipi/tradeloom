# From an empty directory to the market: a native tool-card plugin

[中文](../from-zero.md)

Build an installable DSH plugin from an empty directory. It counts Unicode code points, UTF-8 bytes and lines, displays a native card in dsh-go, and keeps an ordinary tool result for the model and the DSH web client. The example does not make network requests, write files or read the clipboard. Its output contains counts only.

The sequence is: write the bundle, test and check its view, install it on a host, inspect the release tarball, publish your package, then verify the market index. Each step has an observable result.

## 1. Prepare the development environment

The example targets **DSH and dsh-tools 0.2.1-rc.4** and needs Node 22.19 or later (this guide was verified on Node 24). DSH Go now ships 0.2.2-rc.1 (which needs Node 24.9 or later), and the repository's example plugins run their tests on it.

`engines.dsh` and the dsh-tools dependencies name a **tested version range**, the same as the example plugins in this repository: `">=0.2.1-rc.2 <0.3.0-0"`. DSH compares versions with semver when it installs a plugin, so a single exact version gets the plugin refused as soon as the engine moves on (rc.2 → rc.4, say) even if not a line changed. The lower bound is the oldest version you tested; the upper bound stops before the next minor version, because a 0.x minor may break things. To support a version outside the range, run the same tests on it first, then widen the range.

You need an installed `dsh` CLI and a complete dsh-go development checkout containing `sdk/plugin-kit/`. The SDK is distributed with the repository and is not published to npm. The name `@dsh-go/plugin-kit` in examples is not an instruction to install a public npm package. This guide invokes the checker from the checkout; the plugin itself uses DSH's `dsh-tools` at runtime.

```sh
node --version
npm --version
pnpm --version
dsh --version

# Replace this with your complete dsh-go development checkout.
DSHGO_DEV_ROOT=/absolute/path/to/dsh-go
mkdir -p dsh-text-metrics-demo/lib dsh-text-metrics-demo/test
cd dsh-text-metrics-demo
```

## 2. Write the complete plugin

Put these seven files in the new directory. `dsh.bundle.patch` in `package.json` declares the installation layer, and `cordis.patch.yml` mounts the package entry point. There is no `dshGo` manifest: **a tool-result card does not need the native bridge manifest**.

`render` produces ordinary text for the model; `presentationMeta` supplies the app card. The card uses fixed components and concrete values, with no tool-card data bindings or buttons. `toolCard` converts the view to plain JSON and falls back to a normal result without a card if construction fails or the view exceeds 8 KiB.

The input limit counts UTF-16 code units. Output code points are not grapheme clusters, so combining characters and emoji can differ from a visual character count. CRLF is one line break; empty text has zero lines. Tests make these definitions explicit.

### package.json

<!-- file: package.json -->
```json
{
  "name": "dsh-text-metrics-demo",
  "version": "0.1.0",
  "private": true,
  "description": "A DSH tool with a bilingual native text-metrics card.",
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "scripts": { "test": "node --test test/*.test.js" },
  "engines": { "node": ">=22.19", "dsh": ">=0.2.1-rc.2 <0.3.0-0" },
  "peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.2.1-rc.2 <0.3.0-0" },
  "devDependencies": { "@deepseek-ai/dsh-tools": ">=0.2.1-rc.2 <0.3.0-0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### cordis.patch.yml

<!-- file: cordis.patch.yml -->
```yaml
- insert:
    - id: text-metrics-demo
      name: dsh-text-metrics-demo
```

### lib/measure.js

<!-- file: lib/measure.js -->
```js
export function measure(text) {
  if (typeof text !== 'string' || text.length > 8000) {
    throw new TypeError('text must be a string of at most 8000 UTF-16 code units')
  }
  return {
    codePoints: [...text].length,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    lines: text === '' ? 0 : text.split(/\r\n|\r|\n/).length,
  }
}
```

### lib/view.js

<!-- file: lib/view.js -->
```js
export function metricsView(value) {
  const en = value.language === 'en'
  return {
    type: 'stack',
    title: en ? 'Text metrics' : '文本统计',
    children: [
      { type: 'metric', label: en ? 'Code points' : '码点', value: value.codePoints },
      { type: 'metric', label: en ? 'UTF-8 bytes' : 'UTF-8 字节', value: value.utf8Bytes },
      { type: 'metric', label: en ? 'Lines' : '行', value: value.lines },
      { type: 'text', text: en ? 'Code points are not grapheme clusters.' : '码点数不等于肉眼看到的字形数。', tone: 'muted' },
    ],
  }
}

export function toolCard(build) {
  return (args, value) => {
    try {
      const json = JSON.stringify(build(args, value))
      if (json === undefined || Buffer.byteLength(json, 'utf8') > 8 * 1024) return {}
      return { 'dsh-go/view': JSON.parse(json) }
    } catch {
      return {}
    }
  }
}
```

### lib/index.js

<!-- file: lib/index.js -->
```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import { measure } from './measure.js'
import { metricsView, toolCard } from './view.js'

export const name = 'text-metrics-demo'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'text_metrics',
    description: 'Count Unicode code points, UTF-8 bytes and lines in text. Does not store or send the text.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text, at most 8000 UTF-16 code units.' },
      language: { type: 'string', enum: ['zh', 'en'], description: 'Card language. Default zh.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          codePoints: { type: 'integer', required: true },
          utf8Bytes: { type: 'integer', required: true },
          lines: { type: 'integer', required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.codePoints} code points; ${value.utf8Bytes} UTF-8 bytes; ${value.lines} lines.`,
      }],
      presentationMeta: toolCard((_args, value) => metricsView(value)),
    },
    isConcurrencySafe: () => true,
    execute: (args) => ({ ...measure(args.text), language: args.language === 'en' ? 'en' : 'zh' }),
  }))
}
```

### test/metrics.test.js

<!-- file: test/metrics.test.js -->
```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'
import { measure } from '../lib/measure.js'
import { metricsView, toolCard } from '../lib/view.js'

test('Unicode code points, UTF-8 bytes and CRLF are counted explicitly', () => {
  assert.deepEqual(measure('你好\nA'), { codePoints: 4, utf8Bytes: 8, lines: 2 })
  assert.deepEqual(measure('A😀\r\n中'), { codePoints: 5, utf8Bytes: 10, lines: 2 })
  assert.deepEqual(measure('e\u0301'), { codePoints: 2, utf8Bytes: 3, lines: 1 })
})

test('empty text and input bounds have defined behavior', () => {
  assert.deepEqual(measure(''), { codePoints: 0, utf8Bytes: 0, lines: 0 })
  assert.equal(measure('😀'.repeat(4000)).codePoints, 4000)
  assert.throws(() => measure('😀'.repeat(4001)), TypeError)
  assert.throws(() => measure(null), TypeError)
})

test('real defineTool output validates and carries both model text and a card', async () => {
  const registered = []
  apply({ tools: { register: definition => registered.push(definition) } })
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'text_metrics')
  for (const language of ['zh', 'en']) {
    const args = { text: '你好\nA', language }
    const value = await tool.execute(args)
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [])
    const meta = tool.output.presentationMeta(args, value)
    assert.deepEqual(meta['dsh-go/view'], metricsView(value))
    assert.ok(Buffer.byteLength(JSON.stringify(meta['dsh-go/view']), 'utf8') < 8192)
    assert.equal(tool.output.render(args, value)[0].type, 'text')
    assert.ok(!JSON.stringify(meta).includes(args.text))
  }
})

test('a broken or oversized card does not fail the tool result', () => {
  assert.deepEqual(toolCard(() => { throw new Error('broken view') })({}, {}), {})
  assert.deepEqual(toolCard(() => undefined)({}, {}), {})
  assert.deepEqual(toolCard(() => ({ text: 'x'.repeat(8192) }))({}, {}), {})
})
```

### README.md

<!-- file: README.md -->
```markdown
# Text metrics / 文本统计

The `text_metrics` tool counts Unicode code points, UTF-8 bytes and lines.
It does not store the input or make network requests. dsh-go shows a native
card; the DSH web client keeps the ordinary text result.

`text_metrics` 统计码点、UTF-8 字节和行数，不保存输入、不发网络请求。
码点不是字形；空文本为0行。输入上限8000个UTF-16码元。

Development baseline: DSH and dsh-tools 0.2.1-rc.4, Node 22.19+. Supports DSH >=0.2.1-rc.2 <0.3.0-0.
Run `npm install --ignore-scripts` and `npm test` before installing this local bundle.
This tutorial package is private; choose a unique name and a license before publishing.
```

## 3. Test and check the native view

Run inside the plugin directory:

```sh
npm install --ignore-scripts
npm test
node "$DSHGO_DEV_ROOT/sdk/plugin-kit/bin/check.mjs" . --load
```

The tests use the real `@deepseek-ai/dsh-tools` definition and output validator. Their `ctx.tools.register` is a collector, so this step is not a complete host boot. Expect four passing tests and `text_metrics` in the checker's registered tools. “No dshGo manifest: only zero-cost extensions such as tool cards (presentationMeta)” is expected for this example.

Export a deterministic result as JSON for the checker and preview:

```sh
node --input-type=module > card.json <<'JS'
import { measure } from './lib/measure.js'
import { metricsView, toolCard } from './lib/view.js'
const args = { text: '你好\nA', language: 'en' }
const value = { ...measure(args.text), language: args.language }
console.log(JSON.stringify(toolCard((_args, v) => metricsView(v))(args, value), null, 2))
JS
node "$DSHGO_DEV_ROOT/sdk/plugin-kit/bin/check.mjs" card.json --lang en
```

Expect four code points, eight UTF-8 bytes and two lines, with no view issues. Check both Chinese and English labels; title length in one language does not establish that the other fits.

### Optional: render images with the app's native components

When the checkout's app has its Flutter dependencies, generated localization and fonts in place, you can render the card with the app's own renderer (see [Preview view JSON locally](preview.md)):

```sh
node "$DSHGO_DEV_ROOT/sdk/plugin-kit/bin/preview.mjs" card.json \
  --out preview-320-2x --width 320 --height 900 --scale 2 \
  --theme both --lang en --flutter /absolute/path/to/flutter/bin/flutter
```

Use a new output directory. Inspect `light.png`, `dark.png` and their JSON diagnostics, then run again into another new directory with `--scale 1.3 --lang zh`. Images cover the first viewport only; a positive `remainingScrollExtent` means more content below. The preview connects to no host and runs no actions.

## 4. Install on the host you actually use

```sh
# Still inside the plugin directory. The path belongs to the engine's machine.
DSH_TUTORIAL_PLUGIN_DIR="$PWD"
dsh plugin --profile web add "$DSH_TUTORIAL_PLUGIN_DIR"
dsh --profile web --dump-config
```

`--dump-config` confirms that the bundle layer composes; it does not prove that the JavaScript entry point loaded. Check loading in the running `web` profile as well, or start it with `dsh web`. Ask the model to call `text_metrics` with two lines, “你好” and “A”. The ordinary result and the native card should both appear.

| Host | Where to install and check |
|---|---|
| On-device engine | Use the app's local terminal and keep the directory inside that environment |
| SSH host | Use the remote terminal; a development-computer path is not automatically copied there |
| Relay host | Install on the machine running DSH; tool cards travel with existing tool records and this example needs no additional REST tunnel |

This release links a local directory, so removing it breaks the entry point. After editing `lib/`, follow [local reloading](local-development.md). Restarting the on-device engine interrupts current work. Uninstalling and reinstalling is not a guarantee that an already loaded module is invalidated. Existing conversation records do not recompute presentation metadata; make a new tool call.

## 5. Inspect the package you will distribute

```sh
npm pack --dry-run --json --ignore-scripts
npm pack --ignore-scripts
```

Check that the tarball contains `package.json`, `cordis.patch.yml`, `lib/index.js`, `lib/measure.js`, `lib/view.js` and the README. It must load without paths back to the development checkout. Account configuration, temporary host state and test data do not belong in the release. Development `node_modules` are not bundled; peer declarations constrain dependencies that share the host's instances.

Install the actual tarball in an empty test home so a directory link cannot hide missing files:

```sh
DSH_TUTORIAL_HOME="$(mktemp -d)/dsh-home"
DSH_HOME="$DSH_TUTORIAL_HOME" dsh plugin --profile web add "$PWD/dsh-text-metrics-demo-0.1.0.tgz"
DSH_HOME="$DSH_TUTORIAL_HOME" dsh web --no-open
```

After renaming the package, use the tarball filename reported by `npm pack`.

This separate configuration directory does not inherit your existing model setup. Check boot and loading first; configure a model there if you want to invoke the tool through a model. Stop the test process when finished. The plain JavaScript example needs no install-time build. If you later switch to TypeScript, generate the entry points before packing and inspect the actual tarball. Git source installation has separate build-script permission rules; an npm-package test does not establish that path works.

## 6. Publish your own version

The exercise uses `private:true` to prevent accidental publication. Before a real release, replace the following values and repeat steps 3–5:

| Location | Required preparation |
|---|---|
| `package.json.name` | Choose a unique name you own, such as `@your-scope/dsh-text-metrics`, replacing the example scope |
| `name` in `cordis.patch.yml` | Match the package name exactly |
| Patch `id`, module `export const name`, tool `name` | Use your own prefix so derivative packages do not compete for the same row or tool; update test expectations |
| `version`, `engines.dsh`, peer ranges | `engines.dsh` and the peer name the version range actually tested (lower bound: the oldest tested; upper bound: before the next minor); a published name/version pair cannot be reused |
| `repository` | Point to the package's real public GitHub repository; use the correct `directory` for a monorepo package |
| `keywords` | Include `dsh-plugin` and `dsh-bundle` when applicable to aid discovery |
| README, license, `files` | Explain installation, purpose, data flow and compatibility; choose a license and supply a matching LICENSE and metadata |
| `private` | Remove only after the rest of the release preparation is complete |

These package and repository fields are examples to merge into your complete manifest, not a replacement for the entire file:

```json
{
  "name": "@your-scope/dsh-text-metrics",
  "repository": { "type": "git", "url": "git+https://github.com/your-account/your-repo.git" },
  "keywords": ["dsh-plugin", "dsh-bundle"]
}
```

A scoped package name starts with `@` and must be quoted in YAML. For example, after renaming:

```yaml
- insert:
    - id: your-prefix-text-metrics
      name: "@your-scope/dsh-text-metrics"
```

An offline `npm publish --dry-run --offline` checks local packaging; it does not validate account rights, name availability or market acceptance.

In your own npm account, verify the target registry, package name and visibility, then rehearse:

```sh
npm publish --dry-run --access public --ignore-scripts
```

A dry run publishes nothing. Once the file list looks right, publish for real and complete npm's login and 2FA flow:

```sh
npm publish --access public --ignore-scripts
npm view @your-scope/dsh-text-metrics name version repository dist.integrity --json
```

The example has no `prepare` or `prepublishOnly` build scripts, so these commands explicitly disable scripts. If later versions require them, complete the build and tests before following the appropriate release process. Uploading a source repository alone does not publish an installable npm package. Refer to [npm's publication documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/) for account operations and command options.

## 7. Verify the market index dsh-go actually consumes

> Submission and listing in the official market (dsh-go-market) are covered in [Publishing and listing](market.md). This section is about the default discovery index only.

The app currently reads dshfind's **format-1 index** at `https://api.dshfind.com/market/dsh-index.json`. Website discovery and inclusion in this index have different requirements.

Add the `dsh-plugin` topic to your own public GitHub repository and check the npm package's `repository` backlink. dshfind processes discoveries on a subsequent refresh; this is not a fixed delivery-time guarantee. Its discovery code also recognizes npm's `dsh-plugin` and `dsh-bundle` keywords.

Inclusion rules (as of October 2026): a recognized plugin, no risk flag, a bundle, a published npm package, a matching repository backlink, and a valid package name and exact version. Built-in `@deepseek-ai/*` packages are excluded. Installation checks runtime compatibility separately; the risk flag comes from the market and cannot be set by the author.

Look up the exact package name:

```sh
DSH_PLUGIN_PACKAGE_NAME=@your-scope/dsh-text-metrics node --input-type=module <<'JS'
const response = await fetch('https://api.dshfind.com/market/dsh-index.json')
if (!response.ok) throw new Error(`index HTTP ${response.status}`)
const index = await response.json()
const entry = index.plugins?.find(p => p.name === process.env.DSH_PLUGIN_PACKAGE_NAME)
console.log(entry ? JSON.stringify(entry, null, 2) : 'Not in this index yet')
JS
```

Finally search for the package in the app, verify version, source and target host, install it and make a fresh tool call. A website page, an npm release, an index entry and a working app installation are four separate states; confirm each one. If the package stays unlisted, contact dshfind through its feedback channel with the public repository URL, the exact npm version and the index result. No listing request to dsh-go is needed.

## 8. Troubleshooting

| Symptom | Check first |
|---|---|
| Installed but not mounted | `dsh.bundle.patch`, the patch in the tarball, and its `name` matching the package |
| Version rejected by the CLI | `dsh --version` against `engines.dsh`; test the target version before changing the range |
| `--load` passes but the real host fails | Actual profile, module resolution, peers and logs; a test collector is not a complete host |
| Tool succeeds without a card | Metadata of a new call; view exceptions or size limits correctly fall back to `{}` |
| One part of the card is a placeholder | Run the checker for the precise JSON path, fix that node and make another call |
| Code changes have no effect | Files actually loaded by the engine and module reload behavior |
| Website lists it but the app does not | npm backlink, bundle, exact version, format-1 index result and current app filters |

## References

Compare the implementation with this repository's [quick start](quickstart.md), [host support](hosts.md), [checklist](checklist.md), the SDK and the [weather example](../../../examples/plugins/dsh-go-example-weather/).

Bundle/profile behavior is documented in the [official DSH publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md). Market requirements come from [dshfind's discovery documentation](https://github.com/hikariming/dshfind/blob/3ee8543f3ec60792cae0523d4a149cba0d68770c/README.zh-CN.md) and its [index generator](https://github.com/hikariming/dshfind/blob/3ee8543f3ec60792cae0523d4a149cba0d68770c/scripts/lib/dsh-index.mjs).
