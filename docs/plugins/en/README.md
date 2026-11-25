# Writing native plugins for dsh-go

Create, validate, install and publish a plugin from an empty directory: [From zero to the market](from-zero.md).

**Not sure where to start?** Read [Choose a path](choose-path.md): an existing plugin, an existing web interface, or writing for dsh-go from scratch. For what you can rely on, read the [stability promises](stability.md).

[中文](../README.md)

The dsh-go app can show a DSH plugin's content with native UI: tool results as cards, capsules above the composer, items in a reply's menu, a status strip and panels. The plugin stays an ordinary DSH plugin (an npm package whose logic runs in the engine); it only hands the app a **declaration** and some **JSON views**. The app draws them with its own components and never runs plugin code.

| You want | You write | Read |
|---|---|---|
| A tool's result as a native card | A view in the tool's `presentationMeta` — 5 minutes | [Quick start](quickstart.md) |
| To see what is native already | Commands, skills, settings forms, dsh-ui cards — no app code | [Native for free](native-for-free.md) |
| Capsules, reply menu items, a strip, panels | The `dshGo` manifest in `package.json` + `ctx.dshGo` | [Slots](slots.md) |
| Plus panel tools, chat actions, turn notes | The same manifest, newer places | [Slot reference](slots.md#newer-places) |
| What a view can hold | v1 / v2 components, bindings, limits | [Components](components.md) |
| Native inputs and forms | v2 inputs, structured content, two-way binding, bounded formulas | [Inputs and forms](inputs.md) |
| What a tap can do | 8 effects, the 3 s window, deferred results | [Actions and effects](actions.md) |
| Read aloud, stop on speech, live and floating captions | `capabilities` + `media` / `micro` / `overlays` (v1.2, optional) | [Sound and captions](voice.md) |
| Which hosts, how to install | On-device / SSH / relay; install by path | [Hosts, install, fallbacks](hosts.md) |
| Publish to npm, the index, the official market | Three layers and four independent states | [Publishing and listing](market.md) |
| What you cannot customize, and why | Bounded styles, font files, dimensions, links | [Design rules](design-rules.md) |
| What a plugin can and cannot do | One table: capabilities, the two overlays, fallbacks, future items | [Capability boundaries](capabilities.md) |
| Old and new apps alike | `caps`, `adaptView` | [Compatibility](versions.md) |
| Before you share it | Go through the list | [Checklist](checklist.md) |

## Tools

[Local native preview](preview.md) renders view JSON and a data snapshot through the App's Flutter renderer, with light/dark viewport PNGs and diagnostics.

| Part | Where | For |
|---|---|---|
| `@dsh-go/plugin-kit` | [`sdk/plugin-kit/`](../../../sdk/plugin-kit/) | Types, component builders, `toolCard()`, `caps` helpers, a test host, the `check` command. Zero runtime dependencies |
| Example plugins | [`examples/plugins/`](../../../examples/plugins/) | Weather (tool card), usage (strip + panel), quick (capsules + reply menu + a deferred result), read-aloud (sound + stop on speech + captions). MIT |
| The `dsh-go-plugin` skill | Installed by the app into the on-device engine's `$DSH_HOME/skills/` | Lets your own agent write a small local plugin and check it |

## In one picture

```
plugin (a DSH plugin, runs in the engine)
 ├─ tool presentationMeta → { "dsh-go/view": view }     ── conversation log ──▶ app: tool card (any host)
 ├─ package.json "dshGo": capsules, menu, strip, panels ─┐
 └─ ctx.dshGo: views, data, tap handlers                 ├─ dsh-go bridge ──▶ app: native slots (on-device engine)
                                                         ─┘
```

Specs: [`docs/design/native-plugins-protocol.md`](../../design/native-plugins-protocol.md) (protocol), [`docs/design/native-plugins-views.md`](../../design/native-plugins-views.md) (views).
