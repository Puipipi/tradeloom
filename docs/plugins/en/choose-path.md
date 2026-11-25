# Choose a path

[中文](../choose-path.md)

There are three ways into dsh-go. Start from what you have, take the cheapest path that is enough, and add to it later.

| You have | Take | You write | What the app shows |
|---|---|---|---|
| A DSH plugin with commands, skills, settings | [Nothing to change](#1-nothing-to-change) | Nothing | Slash menu, native settings form |
| A plugin with tools, and you want better results | [Tool cards](#2-tool-cards) | The tool's `presentationMeta` | Tool results as native cards, on every host |
| Buttons, panels or status on the chat page in mind | [Native plugin](#3-native-plugin) | `dshGo` in `package.json` + `ctx.dshGo` | Capsules, menus, status line, panels and more |
| An existing DSH web interface | [Web plugin](#4-plugins-with-a-web-interface) | Reuse subject to slot and host support, or move piece by piece to native | Web island, opt-in in-app overlay or "Open in web" |

## 1. Nothing to change

Commands, skills, Config schemas and `dsh-ui` cards already show natively. See [What's native without writing app code](native-for-free.md).

## 2. Tool cards

Your tool returns a view and the app draws it as a card. It takes about 5 minutes and travels with the transcript, so relay hosts show it too. See the [quickstart](quickstart.md).

Tool cards are read-only for now: buttons in them don't act.

## 3. Native plugin

Your logic runs in the engine as usual, and the app never executes plugin code. You declare places and send JSON views; the app draws them with its own components and sends taps back to you.

1. Follow [From zero to the market](from-zero.md) once.
2. Pick places from the [slot reference](slots.md):

| You want | Place |
|---|---|
| One tap to fill the composer or process the clipboard | `composer.actions` capsules |
| A tool that's handy but not constant: stickers, templates, pickers | `composer.tools` in the plus panel |
| To act on one reply | `message.actions` message menu |
| To act on a whole chat: export, archive | `session.actions` chat actions |
| One number always in view | `composer.strip` status line |
| A number per turn: cost, hit rate | `turn.note` turn notes |
| A page of information or a form | `panels` |
| Your plugin's own status page | A panel with `placement: "plugin"` |

3. Check with `check` and the [preview](preview.md), and go through the [checklist](checklist.md) before publishing.
4. To see what you can rely on and what may change, read the [stability promises](stability.md).

## 4. Plugins with a web interface

The app seats each slot you register in this order: native adapter → web island → "Open in web". Unchanged reuse depends on the slot, component implementation, host bridge and resource budget; not every web plugin is guaranteed to work. Slots the app has no place for are listed in the plugin's details. `shell.overlay` requires explicit per-package opt-in in plugin details; `sidebar.footer.action`, `settings.plugins.tab` and `plugins.detail.section` can also open as single-package page islands from there. See [Web panels](web-panels.md).

**Moving pieces to native is usually lighter:** about 200 MB for the first island and roughly 1–3 s for its first opening are estimates from an Android 15 x86_64 debug emulator only, not verified on physical devices or guaranteed per island/device. Islands also have an on-screen count limit. Native places need no extra WebView and match the app.

Overlays stay in the chat-content area of `ChatScreen` within `HomeShell.chat`, clipped by `ClipRect` between the native header and composer without covering native chrome, the drawer, right pane or modals. Pending approvals / unanswered questions stop them, and their viewport shrinks with native keyboard layout. They cannot float across apps. Touch pass-through uses rectangles, not pixel transparency; hit regions can lag fast movement. This work reuses web seams: it adds no native `pets` / `bubbles` / `actions` protocol and does not enable gesture-free audio playback.

`dshGo` and `ctx.dshGo` only affect the app, so DSH Web keeps your web interface and the two don't interfere. A rough map:

| Web slot | Becomes |
|---|---|
| `conversation.input.dock`, `conversation.composer.dock` | `composer.strip` or a panel with `placement: "chat.panel"` |
| `conversation.input.left`, `conversation.input.right` | `composer.tools` or `composer.actions` |
| `conversation.session.header.actions` | `session.actions` |
| `conversation.chat.turnTail` | `turn.note` |
| `conversation.chat.assistant-actions` | `message.actions` |
| `tool.call.toolview` | A tool card with `presentationMeta` |
| `sidebar.right.pane.tab` | A panel with `placement: "session.tab"` |
| `main` + `sidebar.panellist` | A panel with `placement: "features"` |
| `plugins.detail.section` | A panel with `placement: "plugin"` |
| `settings.section` | A Config schema (becomes a native form by itself) |

Move only the pieces you care about; the rest stays on the web.

**Not possible:** custom drawing and animation, replacing official UI, or running your code in the app. Those needs stay on web islands; [Design rules](design-rules.md) explains why.

## Where it works

| | Tool cards | Native places | Web islands |
|---|---|---|---|
| The phone's own engine | ✅ | ✅ | ✅ |
| SSH host | ✅ | ❌ the bridge can't be installed there yet | ✅ |
| Relay host | ✅ | ❌ | ❌ |

See [Hosts, installing and fallbacks](hosts.md).
