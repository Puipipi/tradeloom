# dsh-go-example-quick

English | [中文](README.md)

A dsh-go native plugin example: two capsules above the composer and two items in a reply's long-press menu.

| Where | Item | Does | How |
|---|---|---|---|
| Capsule | Summarize | Puts "总结上面的对话，列三条要点。" into the composer | A static `effect` in the manifest; the app runs it, no host code |
| Capsule | To English | Translates the clipboard with your default DSH model and puts the English into the composer | invoke → **deferred result**: shows "Translating", inserts the translation up to 60 s later; on a host without a model service it inserts a translation request instead |
| Reply menu | Copy as MD | Copies the reply without its native cards (` ```dsh-ui `) | invoke → `copy` + `toast` |
| Reply menu | Save note | Appends the reply to `notes/<today>.md` in the chat's working directory | invoke → writes on the host → `toast` |

Nothing is sent automatically: what goes into the composer waits for you to tap Send.

`wants: ["clipboard", "message"]`: To English carries the clipboard, the reply menu carries that reply's text. The app asks once before the first tap; say no and nothing is attached. To English uses one model call of your quota.

## Install

Shows on hosts with the dsh-go bridge (the on-device engine ships it). Requires DSH 0.2.1-rc.2 or later.

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-quick
```

On-device engine: put the folder inside the on-device environment (e.g. `/root/.dsh/dsh-go/plugins/`, kept when the engine is reset) and run the command in the app's Terminal. Uninstall: `dsh plugin --profile web remove dsh-go-example-quick`.

## How it works

| File | Role |
|---|---|
| `package.json` → `dshGo` | Two capsules (one with a static `effect`), two menu items, `wants` |
| `lib/index.js` | Registers three `on(id)` handlers inside `ctx.inject(['dshGo'], …)` |
| `lib/actions.js` | The three handlers: effects (shorthand) or a deferred result |
| `lib/model.js` | One history-free, tool-free model call through DSH's `agentDefaultModel` and `llm` services, cancelled by `signal` |

A deferred result:

```js
return {
  pending: { label: 'Translating', timeoutMs: 60_000 },
  result: async (signal) => ({ insert: await model.complete(text, signal) }),
}
```

The result may carry only `insert`, `copy`, `toast` and `patch`; cancel, timeout or disconnect fire `signal` and void the result. See [`docs/plugins/en/actions.md`](../../../docs/plugins/en/actions.md).

## Check

```sh
npm test                       # against the sdk/plugin-kit test host, incl. deferred done / failed / cancelled
npm run check -- --load
```

## License

MIT © DSH-TUI (ccch1mneyyy)
