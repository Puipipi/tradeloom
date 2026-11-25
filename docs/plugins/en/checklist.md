# Checklist

Go through it before sharing a plugin. ⚙️ marks what `check` verifies.

## Run it

```sh
node sdk/plugin-kit/bin/check.mjs <plugin dir> --lang en          # manifest + static views
node sdk/plugin-kit/bin/check.mjs <plugin dir> --load --lang en   # also loads the host half: registrations and the views it draws
```

No `error` lines means done. `--json` for machines.

## Manifest

| | Item | |
|---|---|---|
| ⬜ | `dshGo.v` is `1`; `contributes` exists | ⚙️ |
| ⬜ | Every id unique within the plugin (across slots too) | ⚙️ |
| ⬜ | Capsules ≤ 10, menu items ≤ 12, strip ≤ 24, panel titles ≤ 16, plugin name ≤ 24 characters, **in Chinese and English** | ⚙️ |
| ⬜ | Plus panel tools 2, chat actions 2, turn note 1 at most | ⚙️ |
| ⬜ | Plus panel tools ≤ 8 characters and chat actions ≤ 12, in every language | ⚙️ |
| ⬜ | If you use a newer place, it still makes sense when the app lacks it (`hasSurface`) | |
| ⬜ | Per slot: capsules 2, menu 2, strip 1, panels 4 | ⚙️ |
| ⬜ | `wants` only what you read; `draft` / `clipboard` for capsules and plus panel tools, `message` for menu items | ⚙️ |
| ⬜ | Static `effect`s only insert / command / open / link / toast / copy | ⚙️ |
| ⬜ | The strip's `panel` names one of your panels | ⚙️ |
| ⬜ | Static view files inside the package, ≤ 32 KiB | ⚙️ |
| ⬜ | `engines.dsh` declares the DSH versions you support | ⚙️ |

## Host half

| | Item | |
|---|---|---|
| ⬜ | `ctx.inject(['dshGo'], …)`, not `'dshGo?'`; `dshGo` not in the top-level `inject` | ⚙️ `--load` |
| ⬜ | Every capsule / menu item without a static `effect` has an `on(id)` | ⚙️ `--load` |
| ⬜ | Every panel has a `panel(id)` or a static view | ⚙️ `--load` |
| ⬜ | No registrations for ids the manifest does not declare | ⚙️ `--load` |
| ⬜ | Handlers answer within 3 s; model calls and network use a deferred result and honour `signal` | |
| ⬜ | Data functions return a cancel function and stop emitting after it | |
| ⬜ | `emit` sends the whole data, ≤ 32 KiB | |
| ⬜ | No side effects without a tap | |

## Views

| | Item | |
|---|---|---|
| ⬜ | Match the view root version: omitted `v` / `v: 1` uses v1; set `v: 2` for the added [components](components.md) and bounded [styles](styles.md). Keep manifest `dshGo.v` at `1`; use `caps` / `adaptView` for older apps | ⚙️ |
| ⬜ | Tool cards ≤ 8 KiB, ≤ 40 components, ≤ 6 levels; panels ≤ 32 KiB, ≤ 120, ≤ 8 | ⚙️ |
| ⬜ | Tool cards without bindings (no data model) and without buttons (not tappable in phase 0) | ⚙️ |
| ⬜ | `presentationMeta` wrapped in `toolCard()`: never throws, never returns `undefined` / `NaN` | |
| ⬜ | Images only from `assets` or small `data:` | ⚙️ |
| ⬜ | Looked at in light and dark, and with large system text | |

## Privacy and safety

| | Item |
|---|---|
| ⬜ | No keys, tokens or cookies collected or sent; none shown in views |
| ⬜ | Draft, clipboard and message text used for that one tap only, not stored (unless storing is the feature, like "Save note") |
| ⬜ | Network data credited (e.g. "Data: Open-Meteo" on the card) |
| ⬜ | `link` only https, and only where people expect to go |
| ⬜ | No views imitating the app's approval, sign-in or payment UI |

## Copy

| | Item |
|---|---|
| ⬜ | Short and confident; no "click here", "experimental", "beta" |
| ⬜ | Human error messages, no exceptions or class names |
| ⬜ | Chinese and English both present |
