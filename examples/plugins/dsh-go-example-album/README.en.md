# Sticker album: a chat-page Plugins sheet example

[中文](README.md)

A sticker panel on the chat page's Plugins sheet and in All features, showing four things of view v2: the gallery (`gallery`), the empty state (`emptyState`), the ring progress (`progress.shape: "ring"`) and the trend line (`metric.trend`), all in the palette the person picked in the app (`accent: "app"`). The stickers are four small pictures in the package (`assets/stickers/`); nothing goes online.

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-album
```

Needs `dsh-go-bridge` on the host. Once installed, open any conversation: the capsule row above the composer ends with **Plugins**, which opens this panel; All features has it too.

- Tap a sticker: its name goes into the composer, not sent. Long-press any: the app's picture viewer, swipe through the set; saving and sharing are the app's own actions.
- After **Clear** comes the empty state; its **Put back** button brings the samples back.
- An older app does not know the gallery or the empty state: the SDK's `adaptView` turns them into images and a notice (see the tests).

`lib/view.js` only builds bounded JSON; `lib/index.js` registers the panel and handles three actions. To check it in the repository:

```sh
node --test examples/plugins/dsh-go-example-album/test/*.test.js
node sdk/plugin-kit/bin/check.mjs examples/plugins/dsh-go-example-album --load
```

Colour corrections in the diagnostics are expected notes. See [Components](../../../docs/plugins/en/components.md) for the components and [Web panels](../../../docs/plugins/en/web-panels.md) for the sheet.
