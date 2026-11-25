# Focus dashboard: view-v2 styles

[中文](README.md)

A small dashboard with copy and guide actions, demonstrating semantic sizes and weights, italic / underline / strike, alignment, ellipsis, rich spans, an accent, highlights, card variants, spacing, proportional columns and dividers. Its numbers are fixed sample data; it does not inspect conversations or collect statistics over the network.

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-styles
```

The host needs `dsh-go-bridge`. Open “Weekly focus” in All features or the conversation's plugin page. The view root uses `v: 2`; the manifest still uses `dshGo.v: 1`. Old apps ignore styles and spans, but every text node keeps a plain-text fallback and the actions remain usable.

`lib/view.js` produces bounded JSON with data bindings. `lib/index.js` registers the panel, emits its initial data and handles buttons. The guide button returns an invoke link effect to the WCAG page, retaining the app's domain confirmation. URLs in spans never execute directly.

From this repository:

```sh
node --test examples/plugins/dsh-go-example-styles/test/*.test.js
node sdk/plugin-kit/bin/check.mjs examples/plugins/dsh-go-example-styles --load
```

Colour-correction notes are expected: the app generates light and dark colours and enforces at least 4.5:1 text contrast. See [Styles](../../../docs/plugins/en/styles.md). The separate interaction example covers the new inputs and forms.
