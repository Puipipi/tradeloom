# Slots

Beyond tool cards, a plugin can appear in four native places in dsh-go. The places are declared by the `dshGo` manifest in `package.json`; the content comes from the host half (the plugin's Node code in the engine) through `ctx.dshGo`. Spec: `docs/design/native-plugins-protocol.md`.

| Slot (surface) | Native place | Entry fields | Per plugin | Text limit | Tap |
|---|---|---|---|---|---|
| `composer.actions` | The capsule row above the composer, shared with the person's ui.json capsules | `id`, `label`, `icon?`, `effect?` | 2 | `label` 10 | `effect` → the app runs it; otherwise invoke `on(id)` |
| `message.actions` | A reply's long-press menu, grouped per plugin under its `title` | same | 2 | `label` 12 | same |
| `composer.strip` | One line above the composer; steps aside while replying; plugins take turns | `id`, `icon?`, `text?`, `panel?` | 1 | `text` 24 | `panel` → opens it; otherwise invoke `on(id)` |
| `panels` | Chat details › Plugins, All features, the chat panel | `id`, `title`, `icon?`, `placement?`, `view?` | 4 | `title` 16 | Buttons, rows, options in the view → invoke |

Tool cards (`presentationMeta`) take no slot and need no manifest: see the [Quick start](quickstart.md).

## The manifest

```jsonc
// package.json
"dshGo": {
  "v": 1,
  "title": { "zh": "快捷", "en": "Quick" },
  "icon": "bolt",
  "wants": ["clipboard", "message"],
  "contributes": {
    "composer.actions": [
      { "id": "summarize", "label": { "zh": "总结", "en": "Summarize" }, "icon": "summary",
        "effect": { "type": "insert", "text": "Summarize the chat above in three points." } },
      { "id": "translate", "label": { "zh": "译成英文", "en": "To English" }, "icon": "translate" }
    ],
    "message.actions": [{ "id": "copy-md", "label": { "zh": "复制为 Markdown", "en": "Copy as MD" }, "icon": "document" }],
    "composer.strip":   [{ "id": "today", "icon": "chart", "panel": "usage" }],
    "panels":           [{ "id": "usage", "title": { "zh": "用量", "en": "Usage" }, "icon": "chart", "placement": ["session.tab", "features"] }]
  }
}
```

| Field | Required | Rule |
|---|---|---|
| `v` | yes | `1` |
| `minApp` | no | `"x.y.z"`. On older apps the native part is not shown |
| `title` | no | Display name, ≤ 24 characters; defaults to the package name |
| `icon` | no | An icon name (below); unknown names draw a generic icon |
| `wants` | no | What taps carry: `draft` (composer text) and `clipboard` — `composer.actions` and `composer.tools` only; `message` (the long-pressed reply's text) — `message.actions` only. The app asks the person once before the first tap |
| `assets` | no | Image directory (relative to the package) for the `image` component |
| `contributes` | yes | Slot name → array |

- Text fields (`title`, `label`, `text`) take a string or `{ "zh": "…", "en": "…" }`, picked by the app's language: exact tag → language → `en` → `zh` → first.
- `id`: `^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$`, **unique across all slots of a plugin**.
- The whole `dshGo` is ≤ 16 KiB.
- A wrong entry drops only that entry; the plugin details page ("Native UI") and `check` list the problems.

Icons (162, the same in the manifest and in views): bolt star sparkle heart flag bookmark pin bell clock alarm calendar todo note document folder search code terminal globe chart lightbulb book puzzle robot chat mail translate image camera mic link summary wrench bug travel school home play refresh archive team wallet palette coin money speaker read copy quote share edit write save paste add remove delete clear fork regenerate reply select-text qr download downloads external info warning check done success error question pending running tip list table panel sidebar menu more expand collapse file folder-open workspace storage pdf zip slides article text diff gallery audio music video video-file play-video pause stop replay generate-image generate-video diagram plugin bot agent skill model tool workflow goal plan job automation command trajectory web web-search browser history time today timezone schedule repeat reminder user account group chats mention invite announcement reaction poll notification send community forum feedback wechat qq telegram discord phone computer cloud server power restart retry theme color text-size pet featured badge favorite settings

## The host half: `ctx.dshGo`

```js
export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {          // runs only on hosts with the dsh-go bridge
    ctx.dshGo.on('translate', (scope, event) => ({ insert: `Translate into English:\n\n${scope.clipboard}` }))
    ctx.dshGo.strip('today', (scope, emit, caps) => watch(() => emit({ text: label(caps.locale) })))
    ctx.dshGo.panel('usage', {
      view: (scope, caps) => usageView(scope, caps),
      data: (scope, emit, caps) => watch(() => emit(usageData(scope))),
      actions: { copy: (scope, event) => ({ copy: summary(), toast: 'Copied' }) },
    })
  })
}
```

**Write `['dshGo']`, never `['dshGo?']`**, and keep `dshGo` out of the plugin's top-level `inject`: the first never runs, the second stops the whole plugin on hosts without the bridge.

| Method | For |
|---|---|
| `on(id, handler)` | Taps on capsules, menu items, the strip. `handler(scope, event)` returns effects; slow work returns a deferred result ([Actions and effects](actions.md)) |
| `strip(id, dataFn)` | Strip content: `dataFn(scope, emit, caps)` calls `emit({ text, icon?, tone? })` and returns a cancel function |
| `panel(id, { view, data?, actions? })` | A panel: `view` is a view or `(scope, caps) => view`; `data(scope, emit, caps)` pushes data; `actions` handle taps in the view |
| `turnNote(id, dataFn)` | Turn notes: `dataFn(scope, emit, caps)` calls `emit({ [turn]: { text, tone? } })` and returns a cancel function. See [Newer places](#newer-places) |
| `refresh(id, scope?)` | A panel's view structure changed: the app fetches it again. Strips and turn notes have no view; just keep calling `emit` |

**Callback arguments**

| Name | Content |
|---|---|
| `scope` | `{ sessionId?, turnId?, messageId?, callId? }`; taps add `draft` / `clipboard` / `message` (declared in `wants`, allowed by the person, right slot) |
| `caps` | View functions: `{ protocol, app, locale, surfaces, components }` — what the app draws, its language. Data functions: `{ protocol, locale }`, to localize pushed text |
| `event` | `{ surface, id, action?, value?, locale }`. Panel taps: `action` is the view's action id, `value` its `args`; `options` → `{ value }` / `{ values }`, `confirm` → `{ confirmed }` |
| `emit(data)` | Always the **whole** data (an object or `null`). The bridge diffs, throttles to 4 Hz, caps at 32 KiB. `null` in data means missing |

The bridge contains throws, 3 s timeouts and malformed returns and counts a violation; five in a row degrade the plugin to the web version until it reloads.

## Which slot

| You want | Use |
|---|---|
| A fixed sentence into the composer | `composer.actions` + a static `effect`, no host code |
| To transform the clipboard or the draft | `composer.actions` + `wants` + `on(id)` |
| To act on one reply: copy, archive, send elsewhere | `message.actions` + `wants: ["message"]` |
| A number always in sight: usage, balance, context | `composer.strip` + `strip(id)`, opening a `panel` |
| A page: charts, details, lists, buttons | `panels` + `panel(id)` |
| A tool result as a card | A tool card; no slot |

## Where panels go

| `placement` | Place | `scope` |
|---|---|---|
| `session.tab` (default) | Chat details › Plugins | with `sessionId` |
| `features` | All features | empty |
| `chat.panel` | The chat page's Plugins sheet: the last capsule above the composer opens it, native panels first by plugin name, the web plugins' chat-page parts after them (see [Web panels](web-panels.md#the-chat-pages-plugins-sheet)) | with `sessionId` |

| `plugin` | The plugin's detail page, below its settings and switches. Needs a newer app; an older app shows a panel placed only here in chat details | empty |

**How it opens:** with `"presentation": "sheet"`, the strip, `open: "panel:<id>"` and `composer.tools` open it as a sheet without leaving the page. The default pushes a page. Older apps ignore the field and push a page.

A panel may sit in several places; tell them apart by `scope.sessionId` (both `session.tab` and `chat.panel` carry one). The Plugins capsule shows only while the conversation has something for the sheet, outside the eight capsules.

## Newer places

These need a newer app. Check with `hasSurface(caps, 'composer.tools')`. Where the app lacks one it doesn't show, and everything else carries on.

| Slot | Place | Entry fields | Per plugin | Text | Tap |
|---|---|---|---|---|---|
| `composer.tools` | The composer's plus panel, on the attachment tiles' grid | `id`, `label`, `icon?`, `effect?`, `panel?`, `requires?` | 2 (the panel shows at most 8) | `label` 8 | `panel` or `effect` runs in the app; with neither, invoke `on(id)`. Write `panel` or `effect`, not both |
| `session.actions` | An action row in the side panel's Info, with the plugin's name on the right | `id`, `label`, `icon?`, `effect?`, `requires?` | 2 | `label` 12 | As capsules; `scope` has `sessionId` |
| `turn.note` | The end of each turn's footnote | `id` | 1 (a turn shows at most 2 plugins) | 16 each | Not tappable; tapping the footnote still opens the trajectory |

```jsonc
"contributes": {
  "panels": [{ "id": "stickers", "title": "Stickers", "placement": ["chat.panel"], "presentation": "sheet" }],
  "composer.tools": [{ "id": "open-stickers", "label": "Stickers", "icon": "image", "panel": "stickers" }],
  "session.actions": [{ "id": "export", "label": "Export notes", "icon": "archive" }],
  "turn.note": [{ "id": "cost" }]
}
```

**Turn notes** come from `turnNote(id, dataFn)` in the host half. There is one subscription per chat, and each push carries every turn to show in it, keyed by turn number:

```js
ctx.dshGo.turnNote('cost', (scope, emit) => watchCosts(scope.sessionId, (costs) =>
  emit(Object.fromEntries(costs.map((c) => [c.turn, { text: `¥${c.yuan.toFixed(2)}` }])))))
```

- At most 64 turns per push, keeping the newest; text over 16 characters is cut; malformed entries are dropped.
- When the footnote doesn't fit, the note goes first: duration, steps and cost come before it.
- `tone` sets the color of that note, for each plugin separately; without it the note matches the footnote.
- A plugin that doesn't declare `turn.note` creates no subscription. A chat follows the first 8 plugins with turn notes switched on; later ones don't show.
- Older bridges have no `turnNote`, and calling it there stops every registration after it. To stay compatible, check first: `if (typeof ctx.dshGo.turnNote === 'function')`.

## Static panels

No host code needed: give a view file in the manifest, `{ "id": "help", "title": "Help", "view": "./views/help.json" }`. Strict JSON, ≤ 32 KiB, the [component](components.md) format. A `panel(id)` registration wins over the file.
