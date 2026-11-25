# Capability boundaries

One page for "what a plugin can and cannot do". Details live in the other pages; this is the table and the edges.

## Can

| Capability | What to write | Read |
|---|---|---|
| A tool result as a native card | a view in the tool's `presentationMeta` (any host) | [Quick start](quickstart.md) |
| Native slots: capsules, reply menu, strip, panels, composer tools, session actions, turn note | `dshGo` in `package.json` + `ctx.dshGo` | [Slots](slots.md) |
| Commands, skills, settings forms and dsh-ui cards shown natively | no app code needed | [Native for free](native-for-free.md) |
| A web UI, and a web island inside chat content (`shell.overlay`) | client entry + slot registration | [Web panels](web-panels.md) |
| Picking files/images (NA v1.3, optional) | `capabilities: ["files"]` + `pickFile`/`pickImage` | [Picking files](files.md) |
| Read-aloud, stop on speech, captions (v1.2, optional) | `media`/`micro`/`overlays` + `caps` | [Sound and captions](voice.md) |
| Constrained views: v1/v2 components, two-way binding, bounded formulas | JSON views | [Components](components.md), [Inputs](inputs.md) |
| Eight effects on tap | `effect` | [Actions and effects](actions.md) |

## Cannot

| Cannot | Why |
|---|---|
| Control pets or the companion room | the protocol has no pets/bubbles surface; the `pets` field in the internal design draft is **not implemented** |
| Float over other apps | `shell.overlay` is a web island inside chat content, not a system overlay |
| Send system notifications | there is no notification API |
| Show approval cards or change permissions | approvals belong to the engine; plugins cannot answer or skip them |
| Install/uninstall plugins, switch hosts, change conversation semantics | no such API |
| Run in the background or trigger itself | it is called on user taps and host events; a timer or stream your code starts during a call can keep running after the call returns (the readaloud example ticks while it reads), but there is no background service and no API to wake the plugin on its own |
| Change the app theme, icons or overall UI | only constrained styles and plugin seat declarations |
| Execute plugin code in the app process | the app draws declarations and JSON views only; code runs in the engine |

## Two kinds of overlay

| Name | What it is | What it is not |
|---|---|---|
| `overlay` in `capabilities` | a caption/floating line drawn by the app (v1.2) | not a web page, not a system overlay, not a pet |
| `shell.overlay` web island | a web page inside chat content, constrained by its container | not a cross-app overlay; it cannot cover other apps |

## Capability dependencies and degradation

- Native slots appear only on hosts with the dsh-go bridge: the on-device engine has it; remote hosts usually don't (SSH/relay get tool cards only).
- Newer slots and capabilities depend on app and bridge versions; use `caps` instead of assuming.
- Older apps ignore unknown keys; a panel that only lists a newer position falls back to `session.tab` rather than disappearing.

## Future (not implemented — do not rely on it)

`pets`/`bubbles`/`actions` manifest fields, plugin-controlled pets, system notifications, background residency, cross-app overlays.
