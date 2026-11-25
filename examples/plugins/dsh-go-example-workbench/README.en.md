# Workbench: a view-v2 example

A native settings panel with no runtime dependencies. It demonstrates F1 styles, all 24 F2 components, local arithmetic, form submission, throttled changes and existing `patch` effects. Data is kept in plugin memory and resets on reload. It makes no network requests and needs no file permissions.

```sh
dsh plugin --profile web add /path/to/dsh-go-example-workbench
```

Open Workbench from All features, the conversation's Plugins tab, or its chat panel. The reminder toggle and intensity slider sync through `onChange`; other fields submit with Save settings. The total reacts locally to unit price and count. Preview contains cards, avatar, tabs, folds, pages, timeline and highlighted code.

If `caps.components` lacks `textField` or `form`, the example returns a read-only v1 summary. The host validates every value again, trims the name, updates subscriptions and returns a patch.

```sh
node examples/plugins/dsh-go-example-workbench/test/workbench.test.js
node sdk/plugin-kit/bin/check.mjs examples/plugins/dsh-go-example-workbench --load
```

The app needs F1 and F2. The example's JavaScript does not require the SDK package. See [Inputs and forms](../../../docs/plugins/en/inputs.md) for the public contract.
