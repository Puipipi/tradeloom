# Native for free

Six things in a DSH plugin already show natively in the dsh-go app, with no dsh-go-specific code (the sixth needs one function). Use them before reaching for [slots](slots.md).

| In your plugin | In the app | How native | Hosts |
|---|---|---|---|
| Slash commands (`ctx.commands`) | The composer's `/` menu; results in the chat | Fully | All |
| Skills (`SKILL.md`) | The `/` menu's skill group, the Skills page | Fully | All |
| Plugin settings (an exported `Config`, live-editable fields) | Plugin details and the plugin group in Settings: a native form | Fully | On-device, SSH; relay depends on the host |
| Tools (`defineTool`) | The tool row: icon + name + one-line summary; expands to arguments and result | Generic | All |
| Teaching the model to write ` ```dsh-ui ` blocks (in a skill or system prompt) | Charts, metrics, comparisons and options in replies | Fully | All |
| `"dsh-go/view"` in a tool's `presentationMeta` | A native card in the tool row | Fully | All |

## The tool row's summary

Without a card the app uses the generic tool row. The name is the tool name (`mcp__server__tool` shows the last part); the summary is the first non-empty string argument in this order:

`command` → `file_path` → `path` → `pattern` → `query` → `url` → `description` → `prompt` → `name` → the first other string argument

So name the argument that best describes a call `query`, `url`, `path` or `name`, and the collapsed row reads well. With a card, the summary is the view's `title`.

## Settings forms

Your exported `Config` (schemastery) becomes a native settings page, reached from the plugin's details and Settings › Engine parameters › Plugins. `.volatile()` fields apply as they change; the rest apply when the person taps Save, which reloads the plugin. Secret fields (`role('secret')`) are write-only. Nested objects become groups, `.collapse()` groups start folded, and a `description` written as `{ zh, en }` follows the app's language. If your plugin has its own web settings page, register `configure({ auto: false })` in `apply`: the app puts "Set up on the web" at the top and still draws every field it can.

Every field shows on a host whose dsh-go bridge serves `/dsh-go/v1/plugin-config`; elsewhere the app only gets volatile fields. Bind secrets to a credential with a `role('credential-ref')` field: a bare `role('secret')` shows whether it is set but can't be filled in from the app ([design](../../design/plugin-config.md)).

## dsh-ui blocks

When the model writes a ` ```dsh-ui ` block, the app draws it natively; the web UI shows code. It understands the first 10 [components](components.md) (not the six plugin-only ones); keep it ≤ 4 KiB and 40 nodes (long output is slow). Good for "draw a chart when it helps", e.g. in your plugin's skill:

~~~markdown
To compare numbers, output a chart in a ```dsh-ui block: {"type":"chart","kind":"bar","categories":[…],"series":[{"values":[…]}]}
~~~

`options` / `confirm` in a model's view send a message back to the model when tapped; the same components in a plugin view go to the plugin (see [Actions and effects](actions.md)).

### The genui dialect

On a host with `@changfenhuang/dsh-genui`, the model writes genui's own JSON in the same ` ```dsh-ui ` block (a root of `{ title?, items: [...] }`). The app recognises it and draws what it can match as a native, read-only card instead of raw JSON:

| genui | Native |
|---|---|
| `stat` / `hero` (`delta`, `spark`) | `metric` (tone from the sign, `spark` as a trend line) |
| A `grid` of numbers only | A row of metrics |
| `callout` | A tinted panel |
| `progress` (`variant: ring`) | A ring progress |
| `chart`, `table`, `keyvalue`, `list`, `steps`, `timeline`, `tabs`, `accordion`, `code`, `diff` | The matching native components |
| `image` / `image-group` | `image` / a gallery (`data:` only) |
| Buttons, forms and other interactive parts | One "Interactive part" tag |
| `echart`, `svg`, `mermaid`, maps, scenes and the like | A "… · View in DSH Web" tag; a run of them folds into one |

The card is read-only: nothing to tap, nothing sent. A block with nothing to match is one line, "This block shows in DSH Web", with no resend. To have the app draw more of it, have your skill ask for the components in the left column.

## When you need slots

Only for what the six above cannot do: capsules above the composer, the reply menu, the status strip, native panels. See [Slots](slots.md).
