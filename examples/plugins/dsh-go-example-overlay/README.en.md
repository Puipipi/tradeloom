# Web overlay and three-slot example

[中文](README.md)

A web-only DSH plugin: one draggable, tap-to-count button and three common long-tail slots. It declares no native `dshGo` contributions, adds no native `pets` / `bubbles` / `actions` protocol and cannot float across apps.

## Package contract

- The [manifest](package.json) uses the real `exports["./client"]`, `dsh.client.platform: "web"` and [bundle patch](cordis.patch.yml), not the native plugin SDK manifest. Its declared range is DSH 0.2.2-rc.1 up to, but excluding, 0.3; versions were not individually runtime-tested.
- The [browser source](lib/client.js) loads through the host's `window.__ModuleLoader__.load`, obtains the host's existing React via `require("react")` and registers with `ctx.slots.inject/register`. No npm dependencies, JSX, bundler, download script or extra build chain; no `npm install` is needed.
- It follows this repository's real [route probe](../../../runtime/tests/route-probe/client.js) and [bridge manifest](../../../runtime/bridge/dsh-go-bridge/package.json), not an invented loading protocol. The [engine half](lib/index.js) registers no services or actions.

| Slot | Example | In the app |
|---|---|---|
| `shell.overlay` | Drag button; tap to count, keyboard activation supported | Chat-content overlay after explicit opt-in in details |
| `sidebar.footer.action` | Sidebar footer counter button | Details → Sidebar entry, single-package page island |
| `settings.plugins.tab` | Plugin-settings tab body with a counter | Details → Plugin settings page, single-package page island |
| `plugins.detail.section` | This package's detail section, filtered by `subject.pkg.name` | Details → Plugin detail extension, single-package page island |

The example uses distinct English labels and stable, package-prefixed cell ids. Counts and position live only for the mounted component's lifetime. No files, network, clipboard or audio are used.

## Manual use (not performed for this work)

On a local engine with web pages and the bridge, the user may explicitly install:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-overlay
```

In the app's plugin details, open **In-app interface** and enable **Show overlay in the app**. This is a **local per-host preference**, not an installation default. Explicit values in the host's `ui.json` `plugins.seats` take precedence. For explicit enablement, merge the following without overwriting other keys; change `island` to `hidden` to disable:

```json
{"version":1,"plugins":{"seats":{"shell.overlay":{"dsh-go-example-overlay":"island"}}}}
```

Manual acceptance checks:

1. No overlay before opt-in. After opt-in, only this package's cells show; disabled packages must not appear alongside them.
2. Tap increments; dragging does not. Empty space passes through to chat. Drag to an edge, then rotate / open the keyboard: the overlay viewport should shrink with the native chat-content area, keeping the button inside its available area. It reads host insets via `calc(var(--dsh-go-island-top, 0px) + 16px)` / `calc(var(--dsh-go-island-bottom, 0px) + 16px)`. These variables may be `0` because native header / composer space is already reserved; do not subtract native chrome heights again.
3. Open each of the three long-tail entries from details. Verify its title, counter, selected package and cell, and the settings tab's selected state. Missing targets must fall back to the web, not report guessed success.
4. The overlay is strictly clipped between the native header and composer without covering native chrome, the drawer, right detail pane or modals. Pending approvals / unanswered questions stop it; it is absent outside chat. Disabling removes it; switching hosts keeps choices independent, with explicit `ui.json` values still taking precedence.
5. Remounting after component unmount resets local count and position. Plugin unloading / reloading leaves no listeners or elements behind. A merely hidden or cached island is not an unmounted component.

## Touch, lifecycle and limits

The root has `pointer-events: none`; only the button has `pointer-events: auto`. There is no transparent full-screen click layer. Dragging uses Pointer Events and pointer capture, handles pointer up / cancel / lost capture, and releases capture on unmount. A ResizeObserver tracks size / inset changes and disconnects on unmount. React removes component handlers, and slot injection is disposed with the Cordis context. There is no animation loop, timer or document-wide listener.

Touch pass-through uses **rectangles, not pixel transparency**. Empty pixels in a transparent image can still consume touches. Hit reports can lag fast motion, especially continuous CSS animation; this does not mean an already-started drag must be interrupted. The example only demonstrates manual dragging, not guaranteed tapping of animated targets.

The overlay belongs only to the `ChatScreen` chat-content area within `HomeShell.chat`, confined by `ClipRect` between the native header and composer without covering native chrome, the drawer, right pane or modals. Pending approvals / unanswered questions stop it. Its viewport shrinks with native keyboard layout; it never floats across apps. Attribution, route guarding and resource budgets still apply. Audio user-gesture rules remain unchanged; this example has no audio. About 200 MB for the first island and roughly 1–3 s cold opening are estimates from an Android 15 x86_64 debug emulator only, not verified on physical devices. The historical survey's “19% use overlays” does not mean “19% work unchanged”. See [web seams](../../../docs/plugins/en/web-panels.md).

**Validation status:** source, manifest and syntax checks only. The plugin was not installed or run; no app build or physical-device verification was performed. It requires the host's React / module loader and is not a standalone HTML page that can be opened directly in a browser.
