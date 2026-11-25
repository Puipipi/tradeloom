# Stability promises

[中文](../stability.md)

Before you write a plugin, you should know what you can rely on and what happens when your plugin fails.

## What we promise

| Promise | In detail |
|---|---|
| No breaking changes within protocol v1 | We only add optional components, properties, places and effects. Existing meanings stay. A breaking change takes a new major version |
| Older apps don't break | Unknown places, effects and manifest fields are ignored; an unknown component draws as a grey placeholder and the rest carries on. See [Compatibility and versions](versions.md) |
| Panels don't vanish | A panel placed only where an older app can't draw it goes back to chat details |
| Limits don't quietly tighten | The limits on this page only grow. If one really must shrink, it goes in [Compatibility and versions](versions.md) |
| Checks match production | `check` and the test host run the bridge's own parser, so they report what the bridge reports |

## What we don't promise

- Exact pixels, spacing and motion. These belong to the app and may change at any time, so don't depend on a size.
- The order plugins appear in.
- That a place shows at all. The person can turn it off, and the host or app version may not have it. Check with `hasSurface(caps, …)` and plan for it being absent.

## Limits

The bridge enforces every number here.

| Place | Per plugin | Text |
|---|---|---|
| `composer.actions` capsules | 2 | 10 characters |
| `message.actions` message menu | 2 | 12 characters |
| `composer.strip` status line | 1 | 24 characters |
| `panels` | 4 | Title 16 characters |
| `composer.tools` plus panel tools | 2 (the panel shows at most 8) | 8 characters |
| `session.actions` chat actions | 2 | 12 characters |
| `turn.note` turn notes | 1 (a turn shows at most 2 plugins, a chat follows at most 8) | 16 characters each, at most 64 turns per push |

| Runtime | Limit |
|---|---|
| The `dshGo` manifest | 16 KiB |
| A view | 32 KiB, 120 nodes, 8 levels |
| A tool card | 8 KiB, 40 nodes |
| A data push | 32 KiB, 4 per second |
| Handlers and view functions | 3 seconds; slower work uses [deferred effects](actions.md), up to 60 seconds |
| Taps | 4 per second, bursts of 8, 4 at once |
| Effects per tap | 4 |

## When something goes wrong

| What happens | Result |
|---|---|
| One manifest entry is wrong | Only that entry is dropped; plugin details say "N issues" and `check` lists them |
| A handler throws or times out | The bridge catches it and records one violation; other plugins and the chat are unaffected |
| 5 violations in a row | The plugin is degraded for this run and its native part stops showing. A success resets the count; restarting the engine or re-enabling the plugin restores it |
| Data too large or malformed | That push is dropped and one violation recorded |
| No handler registered | That entry doesn't show, and an issue is recorded |

## The person stays in control

- Every place can be turned off separately in the plugin's details.
- To read the composer, clipboard or a reply, a plugin must list it in `wants`, and the app asks before the first tap.
- Links in views ask for confirmation before opening.
- The person can always see which plugin content comes from.

## What you can rely on

| Level | Includes |
|---|---|
| Stable | The `dshGo` manifest v1; the listed places and effects; views v1 and v2; the public methods of `ctx.dshGo`; public exports of `@dsh-go/plugin-kit` |
| Newer, may be adjusted | `composer.tools`, `session.actions`, `turn.note`, `placement: "plugin"`, `presentation: "sheet"`: fields won't be removed, but how the places look may still change |
| Don't rely on | The bridge's internal routes, internal files under `lib/bridge/`, undocumented fields |
