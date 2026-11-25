# Opening web plugin panels

Web plugins that register `sidebar.panellist` + `main` remain available in **All features › Plugins**.

Chat details now provides another entry: when the current host has no visible conversation-specific plugin tabs (`sidebar.right.pane.tab`), its **Plugins** tab shows `main` panels. A single panel opens directly; several panels appear as a list first. Existing conversation-specific tabs retain priority, with global panels still available in All features.

Global panels keep their root scope and receive no current `sessionId`. The existing planner still chooses a native panel, web island or **Open in web** entry within each slot. This entry grants native panels no additional invoke permissions. An empty plan produces no tab.

The panel name comes from its `main` label, then the same plugin and cell in `sidebar.panellist`, then the plugin name. Give sidebar entries short, clear names that no other panel uses: the app finds the panel by that name in DSH Web's sidebar, and when two go by it, it doesn't guess and offers **Open in DSH Web** instead. The same goes for a plugin's settings section (`settings.section`).

## Conversation views

A plugin that registers a View of a conversation in DSH Web (`conversation.view`, another way to look at it beside Chat and Trajectory) shows in the app under that conversation's Chat details › **Plugins** tab, with the conversation's plugin tabs: tabs first, then views. A single one opens directly; several appear as a list first.

- Its name is the registered `label`. The app finds the view by that name in DSH Web's View tab row (or under **More conversation views**), then checks by the view's id that it opened that one, so give it a short name of its own: when another view goes by the same name, the app doesn't guess and offers **Open in DSH Web** instead.
- A page island, only on this phone's own engine, with the bridge's occupancy table, the route guard on and room in the budget; it shows the loading skeleton first, and not on screen within 12 s, it becomes **Open in web**, into this conversation.
- The app picks the View only inside the island and leaves the View the person chose in DSH Web as it was: the island writes their choice back once it shows, and again on the way out.
- The official Chat and Trajectory do not show here.

## The chat page's Plugins sheet

The last capsule above the chat page's composer, **Plugins** (a puzzle icon), opens the conversation's plugin sheet. It shows only while the sheet has something, outside the eight capsules, and steps aside with the row while a reply is generating.

To hide this app-owned entry, add `pluginCapsule` to the existing `hide` array in `$DSH_HOME/dsh-go/ui.json`, for example `{"version":1,"hide":["pluginCapsule"]}`. Remove it, or restore that setting to its default in the app, to show the entry again. This does not disable plugins, hide their own composer actions, or remove panels from All features / Chat details. The `plugins.seats` map configures plugin slots; `chat.panel` and `dsh-go.panel` do not name this built-in capsule.

The sheet holds the native panels first (`placement: "chat.panel"`, by plugin name), then the web plugins' chat-page parts: the third-party entries of these seven slots — `conversation.session.header.actions`, `conversation.session.header.utilities`, `conversation.input.dock`, `conversation.input.left`, `conversation.input.right`, `conversation.input.overlay`, `conversation.composer.dock`. They share **one** panel island, stacked in page order, with the official entries masked; a line above it says whose they are.

- The island is made when the sheet opens and goes 30 s after it closes, so the chat page stays light.
- It is made only when every part could be an island on its own (this phone's engine, the bridge's occupancy, the route guard), none was set to `web` or hidden in `ui.json`, and the budget has room; otherwise, or when it is not on screen within 8 s, or the page cannot find the slots, it is one **Open in web** row.
- Entries inside the island carry no marks of their own, so the app cannot hide one plugin's; a `ui.json` setting on any of them sends the whole part to the web.

## Plugin details: Web parts

The **In-app interface** card in plugin details provides web-seam controls and entries. Its overlay switch is **Chat overlay**:

| Web slot | Behavior in plugin details |
|---|---|
| `shell.overlay` | Explicit per-package enable / disable for the in-app overlay; hidden by default |
| `sidebar.footer.action` | A page island showing this plugin's selected sidebar footer button / entry |
| `settings.plugins.tab` | A page island for this plugin's selected plugin-settings tab |
| `plugins.detail.section` | A page island for this plugin's detail section |

Each of the last three shows only the selected package and cell, not all third-party plugins, and does not move web buttons into the native drawer. A settings tab must have a verifiable selected state; a detail section must be locatable under its package. Missing targets, ambiguous labels or failed openings still offer **Open in web**, not a guessed success. Register a stable, unique `id` and a short, clear `label`.

Other unseated places (such as message-level parts) remain listed individually with web entries. Conversation views and chat-page parts have the entries above. A host without the occupancy table shows one row saying the plugin has a web part.

## In-app web overlays (`shell.overlay`)

After opt-in in plugin details, the app allows only the enabled `shell.overlay` cells of that package. Official entries, disabled packages and entries with unknown ownership are not revealed alongside them. The switch is a **local preference stored per host**: hosts have separate choices, and host configuration is not rewritten. Explicit values for this slot / package in `ui.json`'s `plugins.seats` take precedence over the local switch; edit that configuration first when it controls the choice.

For example, host configuration `{"version":1,"plugins":{"seats":{"shell.overlay":{"dsh-go-example-overlay":"island"}}}}` explicitly enables the example; replace `island` with `hidden` to disable it. Merge into existing configuration without overwriting other keys.

- Overlays live inside `ChatScreen` within `HomeShell.chat`. A `ClipRect` strictly confines the viewport to chat content between the native header and composer, without covering native chrome, the drawer, right detail pane or native modals. Pending approvals or unanswered questions stop the overlay; it is also absent outside the chat page. It is not an Android cross-app floating window.
- Empty areas pass touches through. Hit testing uses **reported rectangles**, not image alpha or pixel-transparent cutouts. Transparent pixels inside an image's rectangle can still consume touches. Sampling and bridge delivery can lag fast movement; hit regions are not guaranteed to track animation exactly.
- Set the root to `pointer-events: none` and only actual interactive elements to `pointer-events: auto`. Do not cover the chat with a transparent full-screen target; keep interactive regions small and stable.
- The keyboard shrinks the available chat-content area through native layout, and the overlay viewport shrinks with it. CSS `--dsh-go-island-top` / `--dsh-go-island-bottom` remain readable pixel insets (use a `0px` fallback on the web). They may be `0` inside this area because native chrome is already reserved; do not subtract header / composer heights again. These are not plugin-controlled native layout.
- The local engine, attributable bridge occupancy, route guard and resource budget are still required. Opt-in does not bypass these gates; failure retains the web entry.
- Audio keeps the existing WebView user-gesture requirement; gesture-free playback is not enabled automatically. This work adds no native `pets` / `bubbles` / `actions` protocol.

See the [web overlay and three-slot example](../../../examples/plugins/dsh-go-example-overlay/README.en.md), with no extra dependencies or build chain. The plugin was not installed or run for this work, and physical-device verification has not been performed.

## Touch sizes in the full web page

In the app's full DSH Web page, when **Web phone layout** is enabled and the browser reports `pointer: coarse`, `button`, `[role="button"]`, `select` and `input` under `[data-slot="main"]` receive a **44 × 44 CSS px** minimum size. The main slot also contains the official conversation, so this affects more than plugin pages. Fine pointers do not receive this additional size rule; turning phone layout off removes its injection. Standalone web islands and native Flutter panels do not use this stylesheet.

`role="switch"`, `role="slider"`, `input[type="range"]` and hidden elements are not made visible; switches and tracks keep their authored sizes. Ordinary HTML checkboxes and radios also receive the minimum size. Naturally inline `a[role="button"]` / `span[role="button"]` receive an `inline-block` default so min-size can apply; the whole default layer stylesheet is placed before existing page styles so author `display` rules retain priority. Plugins should verify explicit inline layouts and fixed-size wrappers themselves, without assuming that the host rewrites their internal layout.

Set `data-dsh-adapt="off"` on a control or any ancestor to keep that subtree's own control sizes and display modes. This also works on `html` or the main slot itself:

```html
<section data-dsh-adapt="off">
  <!-- The plugin supplies adequate hit areas and room for their neighbours. -->
</section>
```

This attribute opts out of the touch-size rule only; safe areas, drawers and other phone-layout rules remain. The minimum occupies real layout space: use rows that can accommodate or wrap their controls, rather than clipping enlarged controls inside compact wrappers. Use the opt-out when a plugin manages its own hit areas; the host does not insert DOM or change event handlers.

## Hosts and fallback

- Islands still require a host with web pages, the existing route gate and available resource budget.
- If an island cannot open, the existing DSH Web entry opens the sidebar so the person can choose the panel. The web opening bridge has no third-party panel deep-link id, so it cannot promise to land on an arbitrary plugin cell.
- Relay hosts without web pages do not show web-only panels.

## Resource and compatibility limits

About 19% of packages in the historical survey used `shell.overlay`. That is static slot usage, not a promise that all of those plugins work unchanged. Host-internal state, full-screen event capture, custom dialogs and browser APIs still need per-plugin checks.

About 200 MB for the first island (renderer plus app increment), with roughly 1–3 s cold opening, is an estimate from an Android 15 x86_64 debug emulator only. It has not been verified on physical devices and does not establish release, other-ABI or per-plugin costs.

## Not yet available

This entry adds no `plugin:` page references to `ui.json`, cross-plugin `open` aliases or `dsh-go://panel/…` deep links. Native `open` effects still target supported app pages or the calling plugin's `panel:<id>`. Additional targets need separately defined validation, lifecycle and permission boundaries.
