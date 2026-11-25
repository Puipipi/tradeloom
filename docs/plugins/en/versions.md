# Compatibility and versions

## Three versions

| Version | Where | Who | Now |
|---|---|---|---|
| Protocol `v` | `dshGo.v` | Major version, bumped only for breaking changes | `1` |
| View format `v` | The view root's `v` (optional) | Style and component language, separate from NA | `1` and `2`; omitted means `1` |
| `minApp` | `dshGo.minApp` | You, when you need something only newer apps have | unset |

Also declare the DSH versions you support in `package.json` `engines.dsh` (DSH checks it on install).

## How v1 evolves

Within v1 things are only **added**: components, properties, slots, effects, optional fields. Older apps meeting something new:

| Unknown | Older app |
|---|---|
| Component | A grey placeholder line; the rest draws |
| Component property | Ignored |
| Slot | Ignored |
| Effect | Dropped; other effects run |
| Manifest field | Ignored |

Breaking NA changes require a new protocol major. View v2 is an explicitly selected rendering branch that preserves v1 and its existing meanings.

## View v2: explicitly enable styles

Set `v: 2` on the root for [Styles](styles.md). Existing plugins with no version or `v: 1` retain the original rendering. Unknown versions produce a diagnostic and use v1. NA envelopes and manifests still use `v: 1`; do not change those to 2.

Old apps ignore new style / accent / spans properties and continue to draw text / value. A text node using spans must therefore retain its required text fallback. Unknown components become local placeholders as before: do not use a component unknown to old apps as the root or leave a tree containing only unknown components. Choose components using `caps.components` or prepare fallbacks with `adaptView`.

The later `emptyState` and `gallery` follow the same rule: an older app draws a placeholder, and `adaptView` turns them into a `callout` with its button and `image`s in a `grid` (or stacked). `progress.shape: "ring"` and `metric.trend` are properties an older app ignores, drawing the bar and the figure as before; it draws `accent: "app"` in the default blue.

Existing v1 golden baselines are unchanged. V2 light, dark, narrow-screen and enlarged-text cases have separate goldens. Old fields in stored tool cards retain their meanings.

## Newer places

`composer.tools`, `session.actions`, `turn.note`, panel `placement: "plugin"` and `presentation: "sheet"` were added within protocol v1 and change no existing meaning. The app lists what it can draw in `caps.surfaces`; view functions check with `hasSurface(caps, …)`.

| Combination | Result |
|---|---|
| New bridge + old app | The old app ignores these keys. A panel placed only in `plugin` falls back to `session.tab` and doesn't vanish; `presentation` is ignored and it pushes a page |
| Old bridge + new app | The keys are absent, which is not an error; a manifest using a new place gets one `unknown-surface` issue from the old bridge |

The turn note limit was tightened once: a chat follows the first 8 plugins with turn notes switched on, and the ninth and later ones no longer show. Before that there was no such limit, and a later plugin could show when earlier ones left one of a turn's 2 places free.

## NA v1.3: selected files

Adds the optional `files` capability, direct-tap effects `pickFile` / `pickImage`, optional invoke field `userGesture`, and bounded bridge uploads with one-shot read handles. The protocol major version stays `1`; NA minor revisions and view versions evolve separately.

Both sides must negotiate `files` in `hello` / `welcome`. Older apps omit it: manifest items requiring it are hidden, undeclared or unnegotiated selection effects are ignored without a violation. Older bridges omit it from `welcome`, so newer apps keep it off. Panels use `caps.features` to show explanatory text while retaining ordinary content. Existing plugins, effects, views and their budgets keep their semantics. See [Selecting files and images](files.md).

## v1.2: optional capabilities

Sound, speech detection, the small caption channel and the floating caption ([Sound and captions](voice.md)) are optional capabilities within v1, negotiated rather than versioned:

| Case | Result |
|---|---|
| The plugin declares no `capabilities` | Exactly v1.1 |
| The app lacks a capability (an older app, a relay host, no microphone) | Buttons with `requires` don't show; such effects are dropped (one issue, not a violation) |
| The bridge is older than the app | No `features` in `welcome`: the app turns none of this on |

A view function's `caps.features` lists what the app asked for in this request, if you want to add a caption only when it can be shown.

## Degrading by capability

The second argument of a view function, `caps`, says what the app can draw:

```js
import { hasComponent, adaptView, localize } from '@dsh-go/plugin-kit'

view: (scope, caps) => {
  const v = buildView(scope)
  return adaptView(v, caps)          // newer components become older ones; buttons and images go
}
```

| Helper | For |
|---|---|
| `hasComponent(caps, 'table')` | Does the app know this component |
| `hasSurface(caps, 'composer.strip')` | Does the app show this slot |
| `appAtLeast(caps, '0.10.0')` | App version |
| `localize(caps, { zh, en })` | Text in the app's language |
| `adaptView(view, caps, fallbacks?)` | Degrade a whole view |

Tool cards have no `caps` (they are stored in the log and future apps must draw them), so keep cards to the steadiest components: `stack` `row` `text` `metric` `chart` `compare` `steps` `callout`.

## Tool cards stay drawable

Cards live in the conversation log; a chat opened a year later must still draw. The app only adds to `meta["dsh-go/view"]`, never removes, and draws old formats forever. On your side:

- When you change a card's structure, keep what old fields meant;
- Don't put expiring things in a card (temporary links, time-limited image URLs).

## DSH versions

| DSH | Status |
|---|---|
| 0.2.2-rc.1 | The engine DSH Go ships: the slot catalog (109 slots) and the web island recipes are checked against it |
| 0.2.1-rc.4 | Development baseline: the slot catalog (103 slots) and the web island recipes are checked against it |
| 0.2.1-rc.2 | Verified (tool card path, plugin install, bridge) |
| Other 0.2.x | Declare in `engines.dsh`; `presentationMeta` exists since 0.2.0 |

If the official `@dsh-std/ui` settles a panel format, we move to it; the renderer and this format stay.
