# View v2: text, colours and containers

Set `v: 2` on the view root to enable styles. Omitting `v`, or setting `v: 1`, keeps the original rendering path. `dshGo.v` remains the NA protocol major version `1`; it is not the view version.

```js
{
  v: 2,
  accent: 'teal',
  type: 'stack',
  style: { card: 'surface', padding: 'L', gap: 'M' },
  children: [
    { type: 'text', text: 'Completed 7 / 10 this week',
      style: { size: 'title', weight: 'bold' } },
    { type: 'text', text: '3 remaining',
      spans: [
        { text: '3', color: 'accent', mono: true, background: 'teal' },
        { text: ' remaining', color: 'gray' },
      ] },
  ],
}
```

The machine-readable source is [`view.schema.json`](../../../sdk/plugin-kit/schema/view.schema.json). Run `node sdk/plugin-kit/bin/check.mjs view.json` for the same path-labelled diagnostics as the app. A colour correction is a note and does not reject the view.

## Text

`text`, `metric` and `callout` accept `style`. For a metric, the style applies to its value; the label and caption keep the app's secondary text treatment. In v2, a callout uses ordinary plugin text rather than the decoration of a system warning panel.

| Property | Values | Default |
|---|---|---|
| `size` | `display`, `title`, `subtitle`, `body`, `caption`, `mono` | `body`; metric values use `title` |
| `weight` | `regular`, `medium`, `semibold`, `bold` | `regular`; metric values use `semibold` |
| `italic`, `underline`, `strike` | Boolean | `false` |
| `align` | `start`, `center`, `end` | `start`, following text direction |
| `maxLines` | Integer 1–20 | No extra line limit; text budgets still apply |
| `color` | A named colour, `accent`, or `#RRGGBB` | App foreground or the node's semantic tone |

| Size | Base logical pixels | Weight | Value |
|---|---:|---|---:|
| `display` | 28 | `regular` | 400 |
| `title` | 24 | `medium` | 500 |
| `subtitle` | 20 | `semibold` | 600 |
| `body` | 16 | `bold` | 700 |
| `caption` | 13 | | |
| `mono` | 14 | | |

The system `TextScaler` remains active, including both enlargement and reduction. Fonts come from the app; `mono` and spans with `mono: true` use its monospace font. Text exceeding `maxLines` ends in an ellipsis. The existing 2000 / 200 character budgets still apply.

Without explicit spans, text retains its restricted `**bold**` and inline-code syntax. An explicit span's `text` is literal and does not parse Markdown.

## Inline spans

A text node may add `spans: [{ text, color?, weight?, mono?, background? }]`. Its ordinary `text` remains **required** as the fallback for old apps, strips and copied summaries. Valid spans are shown when present; an empty or wholly invalid list falls back to `text`.

- At most 32 spans per text node, and 64 / 256 / 16 per tool card / panel / strip.
- All spans in one text node share its text budget. Splitting text into spans cannot increase it; excess text is clipped with an ellipsis.
- A span may override colour, weight, monospace and highlight. Node-level italic, underline and strike still apply to the whole paragraph.
- Spans are not components and cannot nest or hold actions. `link`, `url`, `href` and `action` are ignored with diagnostics. A URL in the text is not tappable. Links continue to use the invoke `link` effect.
- A style, spans list or individual style value may bind to `data`. Budgets apply after resolving bindings.

## Colours and actual backgrounds

The root may declare `accent` as a named colour or six-digit `#RRGGBB`. Other colour fields also accept `accent` as a reference. The default accent is blue. Names are case sensitive; hexadecimal digits are not.

`accent: "app"` follows the palette the person picked in the app: the view changes with it, and contrast is corrected by the rules below all the same. It suits a plugin that should blend in and has no brand colour. `check` previews it with the app's default palette, `#4B67B4`; an older app does not know `"app"` and draws the default blue.

| Name | Requested colour | Name | Requested colour |
|---|---|---|---|
| `red` | `#D04545` | `blue` | `#3D6FD6` |
| `orange` | `#CA6328` | `indigo` | `#5B5CC7` |
| `amber` | `#AA7900` | `violet` | `#8554BB` |
| `green` | `#258051` | `pink` | `#B94F83` |
| `teal` | `#167F84` | `gray` | `#697382` |

These are requests, not promises to paint unchanged. The app produces a light and a dark result:

1. The content background is explicitly opaque: `#F8FAFE` in light mode and `#272A33` in dark mode. Surface cards use `#F0F3F9` / `#30343F`.
2. Container backgrounds and span highlights mix 10% / 16% of the requested colour into the light / dark content anchor, rounded to 8-bit sRGB. Nesting does not accumulate transparency; the result remains opaque.
3. Each foreground is checked against its actual background using WCAG relative luminance. Below 4.5:1, two bounded searches of 16 steps each move towards black and white. The qualifying result with the smaller mixing amount wins. Each candidate is checked after 8-bit quantisation; 4.499 is not rounded up to 4.5.
4. Diagnostics report the path, `light` / `dark`, requested and corrected colours, and the bound. Repeated accent corrections against the same background are reported once.

WCAG requires 4.5:1 for ordinary text and 3:1 for large text. This implementation conservatively uses **4.5:1 for all new text**, so reducing the system font scale cannot break the bound and parsing does not depend on text scale. Metric captions and plugin button text also use readable colours for their backgrounds. The fixed ownership mark uses separate app colours, unaffected by the plugin accent.

Chart category colours and the “other” segment are also checked against their actual v2 container background, retaining at least 3:1 non-text contrast and reporting corrections under `palette`. A category colour qualified on the old neutral background is not simply reused on a different tint. Selecting a category keeps other categories opaque, including donut legend labels, numbers, units, percentages and colour keys; tooltips, guides, font weight and ring width indicate selection. Comparison cards use an outline for emphasis, progress tracks use the checked background with an outline, and read-only options keep opaque text. Control foreground / fill pairs are recomputed for the current node.

References: [WCAG 2.2 text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). Contrast is mechanically enforced; colour blindness still calls for redundant labels, icons or positions rather than colour alone.

## Containers

`stack` / `row` support these `style` fields:

| Property | Values | Behaviour |
|---|---|---|
| `card` | `plain`, `surface`, `tinted`, `outlined` | Ordinary content, raised neutral background, accent tint, accent outline |
| `background` | Named colour, `accent`, `#RRGGBB` | Derives a fixed tint, overriding the card's default background |
| `padding` | `S` / `M` / `L` = 8 / 12 / 16 dp | Requested value; all four sides shrink together when narrow. Plain defaults to 0, other cards to M |
| `gap` | `S` / `M` / `L` = 8 / 12 / 16 dp | L at the root, M in nested containers |
| `align` | `start`, `center`, `end` | Horizontal for a stack, vertical for a row |
| `columns` | `equal`, or 1–8 integer weights of 1–12 | Used by rows; absent means up to three equal columns |
| `dividers` | Boolean | Horizontal between stack items; vertical between row columns and horizontal between wrapped rows |

A narrow row reduces its column count until it fits, down to one column. The design threshold for each column is `136 × clamp(text scale, 1, 2)` dp after subtracting gaps and distributing weights. Wrapped rows use the first N weights; an incomplete last row retains empty columns to align it. This number is a layout rule, not a performance measurement. Existing node, depth, child and JSON byte budgets remain in force.

Nested containers use the same preferred content width to limit padding. Given available width W, the preferred width M above and requested padding P, each side uses `min(P, max(0, (W − M) / 2))`. A host already narrower than M retains its entire available width instead of losing more to padding. Repeated L containers therefore cannot keep consuming the space needed by buttons; overflow, clipping and content scaling do not stand in for a real touch target. Width is known during layout, so this does not produce a false parse error. Flutter Inspector exposes the applied values under `plugin-v2-padding:<node path>`. Invalid types such as arrays, objects, numbers and booleans still fall back with a parse diagnostic; they are never coerced into S/M/L keys.

Corners follow the app and accept no numeric radius. Plugin buttons have 12 dp of equal padding on all sides and a minimum 48 × 48 dp target. Two buttons share a row only when each can retain the preferred content width after subtracting their 12 dp gap; otherwise they form a vertical group. Buttons in the same row share the tallest actual height. Vertically stacked buttons use their own content height, allowing long labels to wrap. Keyboard focus, hovering and pressing thicken the outline while keeping the background under text unchanged. V2 list and option rows use this feedback too, preventing ink overlays from reducing secondary-text contrast. V2 `actions` and `confirm` use plugin outlines; `style: "primary"` is downgraded with a diagnostic.

## Boundaries that stay closed

V2 panel and tool-card content stays inside an opaque app-owned area, with a fixed “Plugin content” mark outside the author's tree. Content is clipped to that area. A strip still becomes one plain-text line with an owned icon mark. Existing panel plugin names and tool-row identity remain visible.

The interpreter can mechanically establish that:

- Components come from the catalogue. Reserved `role` values `system`, `approval`, `authorization`, `dialog` and `permission` invalidate that node; other unknown roles are never turned into native semantic roles.
- Only the documented style fields are consumed. Positioning, layers, dimensions, arbitrary radii, font files, line heights, opacity, gradients, transforms, shadows and elevation cannot execute.
- A v2 plugin tree does not construct an approval card, grant button or system dialog. Its actions continue to invoke only the owning plugin and gain no native approval effect.
- Styles do not add password inputs, external code or expression execution, external image URLs or SVG.

**Structural checks do not identify the meaning of arbitrary pictures or wording.** A permitted bitmap can contain a screenshot of a fake interface, and a plugin can write misleading text. The app guarantees that it cannot cover ownership marks, paint outside its content or take over approval actions. It does not claim a proof that all visual or semantic impersonation is impossible. Review of content and user recognition are separate concerns.

Gradients, author-controlled opacity and animation parameters remain closed. Fixed tints cover emphasis and highlights without the additional contrast complexity of changing backgrounds or alpha composition. Existing app motion and reduced-motion settings continue to apply.

## Compatibility and example

Old apps ignore unfamiliar `v`, `accent`, `style` and `spans` properties and draw existing `text` / `value` fields. Keeping those fallbacks allows the same style view to work there. New components additionally require degradation using `caps.components`. Tool cards persist in history, so retain all fields required by v1.

The complete style dashboard is [`dsh-go-example-styles`](../../../examples/plugins/dsh-go-example-styles/README.en.md). Component and action documentation covers the additional interactive controls and their state budgets.
