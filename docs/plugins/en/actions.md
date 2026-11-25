# Actions and effects

A plugin cannot touch the app directly. When someone taps something of yours, you can only **return effects**, which the app runs from a whitelist.

```
tap ──▶ app ──invoke──▶ bridge ──▶ plugin handler(scope, event)
                                          │ effects
app runs them (only if they arrive within 3 s of the tap) ◀──┘
```

## The whitelist

| Effect | Form | Constraints | The app |
|---|---|---|---|
| Insert | `{ type: 'insert', text }` | 1–2000 characters | Inserts at the cursor and **never sends**; the person taps Send |
| Slash command | `{ type: 'command', name, args? }` | `name` without `/`; `args` ≤ 500 | Runs it in the current chat; ignored without one |
| Open | `{ type: 'open', page }` | An app page id, or `panel:<your panel id>` | Opens it; unknown pages are ignored |
| Link | `{ type: 'link', url }` | `https://` only, ≤ 2048 characters | Confirms each time, showing the domain, then opens the browser |
| Toast | `{ type: 'toast', text }` | ≤ 40 characters, longer is cut | A one-line notice, throttled |
| Copy | `{ type: 'copy', text }` | 1–8000 characters | Puts it on the clipboard |
| Refresh | `{ type: 'refresh', id? }` | One of your panels | Fetches the view again |
| Patch | `{ type: 'patch', data, id? }` | JSON Merge Patch, ≤ 16 KiB | Merges into the panel's data at once |

At most 4 effects at a time. Static `effect`s in the manifest may use only the first six.

## Shorthand

Return effect objects, an array of them, or shorthand; several keys in one shorthand object expand in key order.

| Shorthand | Means |
|---|---|
| `{ insert: '…' }` | `{ type: 'insert', text: '…' }` |
| `{ toast: '…' }`, `{ copy: '…' }` | likewise, field `text` |
| `{ link: 'https://…' }` | `{ type: 'link', url }` |
| `{ open: 'panel:usage' }` | `{ type: 'open', page }` |
| `{ command: 'compact' }`, `{ command: { name, args } }` | `{ type: 'command', … }` |
| `{ refresh: true }`, `{ refresh: 'usage' }` | `{ type: 'refresh', id? }` |
| `{ patch: { … } }` | `{ type: 'patch', data }` |
| `{ copy: md, toast: 'Copied' }` | Copy, then the toast |
| `undefined` | Nothing |

The SDK has matching constructors: `effects.insert(text)`, `effects.openPanel(id)` and so on.

## Taps inside a view

A v1 panel view has four kinds of tappable elements. Each tap is one invoke to the same-named handler in `panel(id, { actions })` (without an `actions` table it goes to `on(panel id)`, with `event.action` telling them apart).

| Element | In the view | The handler's `event` |
|---|---|---|
| Button | `actions`: `{ label, action: 'refresh' }` | `action: 'refresh'`, `value: {}` |
| List row | `list` row: `{ title, action: { id: 'open', args: { row: 3 } } }` | `action: 'open'`, `value: { row: 3 }` |
| Options | `options`: `{ id: 'range', options: [...] }` | `action: 'range'`, `value: { value }` / `{ values }` |
| Confirm | `confirm`: `{ id: 'clear' }` | `action: 'clear'`, `value: { confirmed: true \| false }` |

- Action ids: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`; `args` ≤ 1 KiB after bindings resolve.
- The tapped element shows a spinner until the answer; on failure it resets and the app shows the error, never your view.
- `options` show the `selected` you push: update it in your data after a tap.
- Tool cards (phase 0) are not tappable: buttons and confirms are hidden, options read-only.

## The 3-second window

The app runs effects only if they arrive within 3 s of the tap; late ones are dropped quietly (with a short "no response" notice). The bridge gives handlers 3 s too. For longer work, use a deferred result.

## Deferred results (model calls, network)

Return `pending` first: the tapped element shows a waiting state at once, and the real result arrives up to 60 s later.

```js
import { effects } from '@dsh-go/plugin-kit'

ctx.dshGo.on('translate', (scope, event) =>
  effects.deferred(async (signal) => ({ insert: await translate(scope.clipboard, signal) }), { label: 'Translating' }))

// the same without the SDK
ctx.dshGo.on('translate', (scope) => ({
  pending: { label: 'Translating', timeoutMs: 60_000 },
  result: async (signal) => ({ insert: await translate(scope.clipboard, signal) }),
}))
```

| Item | Rule |
|---|---|
| When | The result waits on a model, the network or a slow command. If you can answer within 3 s, answer directly |
| `pending` | `true` or `{ label?, timeoutMs? }`; `label` ≤ 16 characters, shown in the waiting state |
| `timeoutMs` | 1–60 s, default 30 s; clamped |
| `result` | A Promise, or `(signal) => value \| Promise`, with the same value forms as an ordinary handler |
| Allowed effects | **Only `insert`, `copy`, `toast`, `patch`.** Opening pages, links and commands must come straight from a tap |
| Per plugin | At most 2 at a time; another tap is refused (the app says try again shortly) |
| Settles once | Done, timeout, cancel by the person, or disconnect — first one wins; later results are dropped |
| `signal` | Fires on timeout, cancel or disconnect. Stop then: abort requests, stop the model call |
| Errors | If `result` throws or rejects, the tap is void: nothing runs, the element resets. Timeouts and errors are not violations (slow networks happen); a malformed `pending` or disallowed effects in the result are |

**Keep in mind**

- `insert` lands at the cursor **when the result arrives**: the person may have typed meanwhile, so insert, don't assume an empty composer.
- Model calls spend the person's quota: one call per tap, and say what is happening ("Translating").
- Example: the "To English" capsule in [`examples/plugins/dsh-go-example-quick`](../../../examples/plugins/dsh-go-example-quick/) translates the clipboard with the default DSH model, and falls back to inserting a request when the host has no model service.

## Effects in tests

`checkEffects` / `checkPending` in the SDK are the bridge's own code:

```js
import { checkEffects, checkPending } from '@dsh-go/plugin-kit'

checkEffects({ copy: md, toast: 'Copied' })
// → { effects: [{ type: 'copy', … }, { type: 'toast', … }], issues: [], violation: false }
checkEffects({ link: 'http://x' }).violation           // true: https only
checkEffects({ open: 'panel:usage' }, { panels: ['usage'] })
checkPending(result)                                    // how a deferred request is read: { ok, label, timeoutMs, … }
```

To run handlers too, use the test host (`@dsh-go/plugin-kit/testing`): `await host.invoke('translate', { context: { clipboard } })` gives `{ effects, pending?, settled? }`; `await settled` gives `{ t: 'done', effects }` or `{ t: 'void', reason }`.

## Selecting files and images (NA v1.3)

With `files` declared and negotiated, a tap may return `pickFile` / `pickImage`. The original plugin receives one-shot read-only handles; the callback accepts only data effects and notices. See [Selecting files and images](files.md) for budgets, Android APIs, remote hosts and a complete example.

## Never available

Approving tool calls, changing permission modes, phone control, installing or removing plugins, switching hosts, reading app settings or credentials, automatic actions without user interaction. View v2 permits bounded inputs and forms; approval-card styling and password fields remain unavailable.

## View-v2 edits and submissions

A user edit may invoke a throttled `onChange`; `form.submit` validates and freezes a value snapshot. See [Inputs and forms](inputs.md) for inline errors, the 4 KiB dynamic payload limit, per-panel ordering and offline drafts. Patches and data emissions never trigger change actions themselves.
