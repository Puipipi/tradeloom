# Quick start: a native tool card for your plugin

Five minutes. You need a DSH plugin that registers a tool with `defineTool`. Afterwards the tool shows as a native card in the dsh-go app; the DSH web UI keeps its generic card.

A complete, runnable example: [`examples/plugins/dsh-go-example-weather`](../../../examples/plugins/dsh-go-example-weather/).

## 1. Write a view function

A pure function from the tool's value to a component tree. No I/O.

```js
// lib/view.js
export function weatherView(value) {
  return {
    type: 'stack',
    title: `${value.city} · next 3 days`,              // the collapsed tool row shows this
    children: [
      { type: 'row', children: value.days.map((d) => ({
        type: 'metric', label: d.label, value: `${d.high}° / ${d.low}°`, caption: d.text,
      })) },
      { type: 'text', text: 'Data: Open-Meteo', tone: 'muted' },
    ],
  }
}
```

Components and their fields: [Components](components.md).

## 2. Return it from `presentationMeta`

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolCard } from './tool-card.js'          // or toolCard from @dsh-go/plugin-kit
import { weatherView } from './view.js'

ctx.tools.register(defineTool({
  name: 'weather_forecast',
  // …parameters and execute as before
  output: {
    schema,
    render: (args, value) => [{ type: 'text', text: summary(value) }],   // what the model reads
    presentationMeta: toolCard((args, value) => weatherView(value)),    // what the app draws
  },
}))
```

`toolCard()` puts the view under `{ "dsh-go/view": view }` and guards against three things that **fail the whole tool call**:

| DSH rule | What `toolCard()` does |
|---|---|
| `presentationMeta` throws → the call fails | Catches it and returns `{}` (no card) |
| Not lossless JSON (`undefined`, `NaN`, `Infinity`, `-0`, `Date`, `Map`) → the call fails | Round-trips through JSON: `undefined` fields go, non-finite numbers become `null` |
| View over 8 KiB | Returns `{}`. Cards are written into the conversation log, so they stay small |

Without the SDK, copy these twelve lines:

```js
// lib/tool-card.js
export function toolCard(build, maxBytes = 8 * 1024) {
  return (args, value) => {
    try {
      const text = JSON.stringify(build(args, value))
      if (text === undefined || Buffer.byteLength(text, 'utf8') > maxBytes) return {}
      return { 'dsh-go/view': JSON.parse(text) }
    } catch {
      return {}
    }
  }
}
```

## 3. Check it

```sh
node sdk/plugin-kit/bin/check.mjs card.json --lang en     # one view; { "dsh-go/view": … } files get tool-card limits
node sdk/plugin-kit/bin/check.mjs . --load --lang en      # plugin dir: package.json, manifest, and loads your code
```

In unit tests, check the view function's output directly:

```js
import { checkView } from '@dsh-go/plugin-kit/check'
const result = checkView(weatherView(sample), { budget: 'toolCard', lang: 'en' })
assert.deepEqual(result.issues, [])
```

The output matches the app's plugin details page, with paths, e.g. `error view.children[0].children[2].value: Expected a string or number`.

## 4. Install and look

```sh
dsh plugin --profile web add /absolute/path/to/your-plugin
```

On the on-device engine run it in the app's Terminal; on a remote host, on the host. Then have the model call the tool.

## No card?

| You see | Why |
|---|---|
| The usual name + arguments row | `presentationMeta` returned `{}`: the view function threw, the view is over 8 KiB, or the call failed (failed calls have no card) |
| The whole call failed, mentioning `presentationMeta` | No `toolCard()`, and an `undefined` field or `NaN` got through |
| A grey "Can’t display this section" line inside the card | One child is wrong; the rest still draws. Run check for the path |
| Only "Plugin view has an error" | The root is broken: not an object, or a misspelled `type` |
| No card in old chats | Only calls made after installing have cards; `presentationMeta` does not run on old records |

## Next

- Native places beyond cards (capsules, reply menu, strip, panels): [Slots](slots.md)
- What cannot be customized, and why: [Design rules](design-rules.md)
- Before sharing: [Checklist](checklist.md)
