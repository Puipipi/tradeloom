# Inputs, forms and local state (view v2)

Set `v: 2` on the root to use these 24 components. The manifest still uses `dshGo.v: 1`; the view format and bridge protocol evolve separately. See the complete [workbench example](../../../examples/plugins/dsh-go-example-workbench/) and [design rules](design-rules.md).

## A small form

```js
{
  v: 2, type: 'form', submit: 'save', submitLabel: 'Save',
  children: [
    { type: 'textField', label: 'Name', bind: 'data.form.name',
      required: true, minLength: 2, maxLength: 80 },
    { type: 'number', label: 'Unit price', bind: 'data.form.price', min: 0, max: 10000 },
    { type: 'stepper', label: 'Count', bind: 'data.form.count', min: 1, max: 20 },
    { type: 'metric', label: 'Total', value: { '=': 'data.form.price * data.form.count' } }
  ]
}
```

The panel's `data(scope, emit)` emits `{ form: { name, price, count } }`. Editing immediately overlays a local draft at that path. Read bindings and formulas see the draft; the plugin does not receive a submit-only field until submission.

```js
actions: {
  save: (_scope, event) => {
    const name = event.value.values['data.form.name']
    if (typeof name !== 'string' || name.trim().length < 2) throw new Error('Invalid name')
    return { patch: { form: { name: name.trim() } } }
  }
}
```

`patch` remains the existing JSON Merge Patch effect and redraws the panel. Also update the plugin's own data source so future subscriptions see saved values. Validate again on the host before storing input or acting on it; client validation only improves interaction.

## Input catalog

Every input requires a non-empty `label`. `bind` supplies a writable path and overrides literal `value`. Without `bind`, an input displays `value` read-only. `readOnly: true` also disables edits.

| Component | Properties | Value and behavior |
|---|---|---|
| `textField` | `placeholder?`, `maxLength?`, `multiline?`, `maxLines?` | String; defaults to 256 Unicode scalars, at most 2000. Single line by default; multiline defaults to 4 lines, at most 8. Editor, counter and validation use the same scalar count |
| `number` | `min?`, `max?` | Editable number; incomplete input stays a draft. Submission converts it to a finite number; optional empty input becomes `null` |
| `stepper` | `min?`, `max?`, `step?` | Decrease/increase controls, default step 1; the relevant button disables at each limit |
| `toggle` | — | Boolean; `false` is a filled value |
| `slider` | `min?`, `max?`, `step?`, `range?` | Defaults to 0–100 with step 1; a range is `[start,end]`. The step must divide the range into 1–1000 equal intervals, otherwise the component becomes a placeholder |
| `select` | `options`, `placeholder?` | Dropdown, one string value |
| `segmented` | `options` | One string value; wraps on narrow screens or large text |
| `chips` | `options`, `multi?` | One string, or an array of strings with `multi: true` |
| `date` | `minDate?`, `maxDate?` | Host date picker, `YYYY-MM-DD`, valid calendar dates in 1900–2100 |
| `time` | — | Native time picker, 24-hour `HH:mm`, no timezone |
| `rating` | `max?` | Integer 0 through `max`; maximum defaults to 5 and is bounded to 1–10; buttons choose 1–`max` |

`number` and `stepper` default to −10⁹ through 10⁹. Explicit numeric bounds have absolute value at most 10¹²; `max > min`, and step is at least 10⁻⁹. `options` has at most 24 entries, each a string or `{ label, value }`. Values must be unique, non-empty strings of at most 200 UTF-16 units.

A stepper adds or subtracts finite doubles and clamps the final value to its declared endpoints. Display formatting never rounds or rewrites the draft, so fractional endpoints retain their exact representable value at submission. At a very large value, a tiny step may not produce a different representable number; that direction disables instead of jumping farther than the declared step. Hosts needing exact decimal money should use integer minor currency units and validate them again.

Password fields, `password`, `obscureText`, and password keyboard types are rejected. Input belongs to the plugin; never request system credentials in a plugin form.

Date, time and dropdown pickers are host-controlled overlays opened by an explicit user tap. The app retains fixed “Plugin date”, “Plugin time” and “Plugin options” headings that plugins cannot replace; long option lists scroll below their heading. Their surfaces are explicitly opaque, with no additional surface tint, and their foregrounds match that exact background. These selectors do not request system authorization.

## Writable paths and payloads

Writable paths start with `data.` and have 1–16 dot-separated field names. A segment starts with an ASCII letter or underscore, followed by letters, digits, underscores or hyphens. Maximum lengths are 256 overall and 64 per segment. Arrays, empty segments, `__proto__`, `prototype`, and `constructor` are forbidden. Inputs cannot bind the same path twice, or bind both an object and its descendant.

Draft overlays copy their map paths without mutating remote data. The host must supply a new data object after patching; the existing identity-based parse cache still applies.

| Trigger | `event.value` |
|---|---|
| `onChange: 'changed'` | `{ bind: 'data.form.name', value: 'new value' }` |
| `form.submit: 'save'` | `{ values: { 'data.form.name': 'new value', 'data.form.count': 2 } }` |

An action may be `{ id, args }`. Resolved static args remain limited to 1 KiB. Dynamic `bind`, `value`, and `values` replace same-named static keys. The complete `event.value` is still limited to **4 KiB of UTF-8 JSON**. Oversized values retain the draft and show an inline error; they are never silently truncated and sent.

## Validation

`form` takes `children`, required `submit`, and optional `label`/`submitLabel`. Forms cannot nest. Tabs and folded sections may be inside a form; their hidden fields still count toward validation and budgets.

- `required` rejects blank strings, empty arrays and null. Zero and false remain valid.
- `min`/`max` validate finite numbers and both ordered range endpoints.
- `minLength`/`maxLength` count Unicode scalars in strings; minimum length defaults to zero.
- `pattern` is one of `email`, `integer`, `decimal`, `alphanumeric`, `slug`. These are fixed bounded app rules, not plugin-supplied regular expressions. The email rule checks a common format, not every standardized mailbox syntax.
- Choice values must belong to `options`; dates and times must satisfy their format and bounds.

A submit collects editable bound descendants. Read-only fields are omitted; take those values from host state. Validation failure sends no invoke and shows a field error plus a form summary. Errors inside a folded section or another page appear when that section opens, so keep required fields easy to discover.

## Scheduling, ordering and errors

Changes are coalesced until a field has been quiet for **250 ms**. All change messages in one panel also share a send window of at most one per 250 ms. This adopts the existing native data channel's 4 Hz policy; it is a design policy, not a measured device latency. Continuous input may update locally until it pauses. Fields without `onChange` are sent only by a form submit.

One `PluginView` has at most one invoke in flight. A queued change for the same field is replaced by its newest value; distinct explicit button actions are preserved. Submission freezes its value snapshot, cancels unsent changes for its own fields, and joins the serial lane. The submit button disables while waiting. Explicit submits and taps can use the next free lane without waiting for a change rate slot; an in-flight request always finishes first. There are at most 120 queued requests; further requests fail visibly.

**The three-second effect window starts at the actual tap, before queuing.** The app records its host clock synchronously for buttons and form submission and preserves that time through dispatch. Waiting for permissions, a connection or another request never renews it. A request dispatched after three seconds may still save data, but carries `userGesture: false` and accepts only `patch`/`refresh`. Changes always carry false; they cannot copy, notify, navigate, run commands, select files or start media capabilities. The first pending acknowledgement must also arrive within the original tap window before later results may use the existing deferred-effect exception. A stale dispatch, a late initial acknowledgement or a change event cannot acquire authority through pending.

A successful request acknowledges only drafts with the same local revision it captured. If the corresponding remote field changed while the request was in flight, the returned value wins for that acknowledged revision. Without a returned patch, the acknowledged local value stays until that remote field next changes. **Edits made after a request started always survive its response.** Thus an older local invoke cannot finish after a newer local invoke from this same panel.

This is ordering within one panel instance, not a transaction protocol across devices or panels. Existing data-stream revision rules still apply. Hosts with multiple writers must implement their own version or conflict checks. Closing or switching the panel instance releases drafts; existing invoke/deferred timeout and cancellation rules remain in force.

Failure preserves drafts and shows “Not saved. Try again.” A short outage on the same host retains the open v2 panel, disables editing/submission and provides Retry. Editing resumes after a fresh view arrives. Only the currently open instance is retained; there is no cross-host or persistent draft store. Changing host, session or panel, or closing the instance, releases its drafts. Authoritative removal, disablement, degradation or panel removal also releases them. Disconnect cancels unsent changes and queued requests; reconnect does not replay them automatically. Removed fields cannot retain queued changes. Programmatic patches and emits never fire `onChange`, and a change event cannot launch a file picker.

Each invocation also belongs to its initiating host, bridge object, stream connection and source surface read generation. Responses arriving after a host/bridge/reconnection change, a new view read, plugin disablement, or a session/panel change cannot apply patches, notifications, picker completion results or other effects. A valid response may advance its own generation through `refresh` and continue with its remaining effects. Connection changes clear busy markers; an older completion only removes its own marker. This applies to immediate and deferred results.

## Structure and display

| Component | Shape | Limits and behavior |
|---|---|---|
| `tabs` | `items: [{ label, children }]` | Up to 8 locally selected tabs |
| `collapsible` | `label?`, `children`, `expanded?` | One folded section |
| `accordion` | `items: [{ label, children }]`, `expanded?` | Up to 8 independently opened sections; expanded opens the first initially |
| `carousel` | `items: [{ label, children }]` | Up to 8 pages with Previous/Next; no autoplay |
| `grid` | `children`, `columns?` | 1–4 columns, default 2; responsive, equal width and height within each row |
| `timeline` | `items: [{ label, children }]` | Up to 24 ordered entries |
| `badge` / `tag` | `text`, `tone?` | Up to 200 UTF-16 units; display-only |
| `avatar` | `src`, `alt?` | 48 dp square with an icon fallback; existing image source/pixel limits; no caption |
| `codeBlock` | `code`, `language?` | 8000 UTF-16 units with diagnostic truncation; existing app highlighter, unknown languages plain; code viewport up to 240 dp, scrolling and Copy; no Mermaid/HTML/script execution |
| `divider` | — | App divider |
| `spacer` | `size: S\|M\|L` | 8/16/24 dp; no arbitrary dimension |

Tabs, folds and pagination only update local presentation state and do not invoke. Hidden descendants and group headers still consume the parse budget.

Layout uses the style layer's content-width rule, `M = 136 × clamp(text scale, 1, 2)`. Grid column counts account for gaps. Grid cards, expanded sections and code blocks reduce all four padding edges together to `min(12, max(0, (W−M)/2))`. Timeline markers, code headers and steppers stack vertically when their remaining width is insufficient. Stepper targets remain at least 48 dp; an actual 80 dp region uses separate button rows instead of forcing two 48 dp buttons into one row. Targets on the same row have equal height; different rows may grow with their content.

Toggle colors are rebuilt against the node's actual opaque surface. Off state has a distinct thumb and outline, and on state uses a paired primary palette. Keyboard focus, hover and press change the outline rather than tinting the verified background. Narrow toggles place label and switch vertically, retaining native toggle semantics and Space-key operation.

Code highlighting retains the existing lexer and cache and corrects each text color to at least 4.5:1 against the opaque surface actually painted behind it. Truncated code receives an additional ellipsis marker beyond the retained 8000 units.

## Bounded arithmetic

A display value can be `{ '=': 'data.form.price * data.form.count' }`. Allowed: decimal numbers, read-only numeric `data` paths, parentheses, unary signs, `+ - * / %`, and `abs(x)`, `min(a,b)`, `max(a,b)`, `clamp(x,lo,hi)`. Paths accept dot fields and nonnegative array indexes, with letters/digits/underscores in names; hyphenated field names are not formula identifiers. Decimal strings held by numeric drafts may participate.

Limits: 256 UTF-16 units, 128 tokens, parse recursion depth 16, path segments 16. Results must be finite. Missing fields, division by zero, overflow, invalid functions and exceeded limits produce a missing value and a diagnostic. `%` has nonnegative modulo semantics. There are no assignments, loops, object calls or external code. `type` cannot be computed, and data returned by `$` is not reinterpreted as a formula.

## Profiles and compatibility

| Item | Panel | Tool card | Strip |
|---|---|---|---|
| New inputs/form | Editable; at most 32 fields per view | Read-only, no submit; still subject to field and total limits | Unavailable |
| New structure/display | Available | Available; local tab/page controls work | Unavailable |
| Existing total budget | 32 KiB / 120 nodes / 8 levels | 8 KiB / 40 nodes / 6 levels | 2 KiB / 8 nodes / 3 levels |
| Direct children per container | 32 | 16 | — |

See [view.schema.json](../../../sdk/plugin-kit/schema/view.schema.json) and [view specification §5](../../design/native-plugins-views.md#5-上限). `node sdk/plugin-kit/bin/check.mjs <plugin-directory> --load` checks registered host behavior and views; the F2 checker shares its diagnostic corpus with Dart.

When `caps.components` lacks the new names, return a v1 summary. `adaptView` supplies static text for inputs and expanded structure fallbacks; missing caps still mean v1. Include meaningful legacy content so an old interpreter does not receive a root containing only unknown children. Plugins without root `v: 2` retain their original parse and render paths.
