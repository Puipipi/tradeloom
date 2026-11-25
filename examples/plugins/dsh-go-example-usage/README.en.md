# dsh-go-example-usage

English | [中文](README.md)

A dsh-go native plugin example: a status strip above the composer with the tokens used in this chat and today; tap it for the Usage panel.

| Where | What |
|---|---|
| Strip | `Chat 12.4k · Today 186k`; steps aside while a reply is generating; tap opens the panel |
| Panel (chat details › Plugins) | This chat / today / cache hits, a 7-day bar chart, this chat's breakdown (input, cache reads, cache writes, output, reasoning, model calls), today's tokens per model, a Copy summary button |
| Panel (All features) | The same, led by today |

Everything comes from the engine's own session events (`usage` on each `assistant/message`); no network, no estimates:

- **This chat**: computed from the chat's log when opened, then kept current call by call;
- **Today / last 7 days**: counted live once the plugin is installed; when a chat is first seen, its calls from before the install are added too (deduplicated by event seq, never counted twice). Per local day, in `$DSH_HOME/cache/dsh-go-example-usage/days.json` (30 days kept).

## Install

Shows on hosts with the dsh-go bridge (the on-device engine ships it). Requires DSH 0.2.1-rc.2 or later.

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-usage
```

On-device engine: put the folder inside the on-device environment (e.g. `/root/.dsh/dsh-go/plugins/`, kept when the engine is reset) and run the command in the app's Terminal. Uninstall: `dsh plugin --profile web remove dsh-go-example-usage`.

## How it works

| File | Role |
|---|---|
| `package.json` → `dshGo` | Declares one strip (tap opens the panel) and one panel (chat details and All features) |
| `lib/index.js` | Counts `session/event`s; `ctx.dshGo.strip()` pushes the strip text, `ctx.dshGo.panel()` serves the view, pushes data, handles Copy summary |
| `lib/view.js` | Panel view (fixed structure, every number a binding `{ "$": "data.today.total" }`), data model, strip text, clipboard text |
| `lib/tally.js` | Pure functions: `TokenUsage` from events, sums, formatting (12.4k) |
| `lib/ledger.js` | Daily ledger: atomic writes, delayed saves, 30 days, per-chat seq marks so calls count once |

Notes:

- The view is sent once; afterwards the bridge pushes data patches only (≤ 4 per second), so the view holds bindings, not numbers;
- The data model is language-neutral; the strip text follows `caps.locale`, the data function's third argument;
- Data functions return a cancel function; the bridge stops them when nobody is looking.

## Check

```sh
npm test                       # runs against the test host in sdk/plugin-kit (the bridge's own manifest and effect code)
npm run check -- --load        # manifest + loads the host half and checks the views
```

## License

MIT © DSH-TUI (ccch1mneyyy)
