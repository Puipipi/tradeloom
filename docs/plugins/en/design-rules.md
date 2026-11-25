# Design rules

A plugin supplies content, structure and bounded styles. The app owns actual geometry, readable colours and attribution. V1 keeps its original appearance; explicit v2 enables [text, colour and container styles](styles.md) while retaining system text scaling and both themes.

## What you cannot customize

| Closed | Why | Use instead |
|---|---|---|
| Author opacity and gradients | Compositing expands the contrast proof surface | V2 accent, named colours and #RRGGBB are corrected; backgrounds use fixed tints |
| Font files, arbitrary sizes and line heights | Keep app fonts and system text scaling | Six semantic sizes, four weights and spans in [v2 styles](styles.md); v1 remains unchanged |
| Arbitrary dimensions, radii, positioning and layers | The app owns symmetry and content boundaries | Card variants, S/M/L gaps and equal padding, proportional columns and narrow-screen wrapping |
| Animation parameters | Motion and reduced-motion settings belong to the app | Existing app motion |
| External image URLs and SVG | No tracking pixels or external resources | Plugin assets and bounded inline bitmaps |
| Clickable inline links and HTML | Links retain domain confirmation | An invoke link effect |
| Approval cards, grant buttons and password fields | These powers do not belong to a plugin view | Plugin outline actions; ordinary controls are documented in the catalogue |
| Custom components, code and arbitrary expressions | No external code executes in the renderer | The catalogue; formulas only through a separately bounded evaluator |
| Replacing official UI or changing the app theme | Plugins add content within their own area | User-controlled ui.json |

V2 panels and tool cards additionally carry a fixed “Plugin content” mark outside the author tree. Structural checks cannot identify the meaning of arbitrary bitmaps or wording; [Styles](styles.md#boundaries-that-stay-closed) separates mechanical guarantees from the remaining impersonation risk.

## Attribution

Plugin content is always attributed, so people know who is speaking:

| Place | How |
|---|---|
| Panel | A top line in the frame: plugin icon + plugin name |
| Reply menu | Grouped per plugin under its `title` |
| Strip | Led by the plugin icon |
| Tool card | The tool row it sits in |

So make `title` a product name, not "Tap me" or "Important".

## Copy

dsh-go copy is short, confident and product-like. Plugins share the screen, so the same applies:

| Do | Don't |
|---|---|
| "Usage", "To English", "Copied" | "Click here to view usage statistics" |
| Numbers with units: `12.4k`, `63%`, `¥0.42` | Raw numbers like `12403` |
| Human errors: "The clipboard is empty" | `Error: clipboard is empty` |
| Full-width punctuation in Chinese | Mixed punctuation |
| No "experimental" / "beta" labels or disclaimers | "This feature is in beta; results may vary" |

- Capsules ≤ 10, menu items ≤ 12, strip ≤ 24, panel titles ≤ 16 characters; longer is cut.
- Write both Chinese and English (`{ "zh": "…", "en": "…" }`); the app has an English UI.

## Choosing components

| Content | Component |
|---|---|
| Two or three key numbers | `metric`s in a `row` |
| Trends, comparisons | `chart` (≤ 6 series, 60 points) |
| Details: name …… value | `keyValue` |
| Tappable items | `list` with row `action`s |
| Regular two-dimensional data | `table` (≤ 8 columns; fewer on a phone) |
| Quota, completion | `progress` |
| One or two operations | `actions`, at most one `primary` |
| A single warning | `callout` |

One card, one topic. If a `metric` says it, skip the chart.

## Performance

| Rule | Why |
|---|---|
| Tool cards ≤ 8 KiB | They are written into the log and parsed on every replay |
| Panel views hold structure; numbers are bindings | Data changes become patches; the view is not resent |
| `emit` the whole data; don't diff yourself | The bridge diffs and throttles to 4 per second |
| Data functions return a cancel function | The bridge stops them when nobody is looking |
| Handlers answer within 3 s; slow work uses a deferred result | Late effects do not run |
