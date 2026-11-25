# dsh-go-example-weather

English | [中文](README.md)

A DSH plugin example: it registers a `weather_forecast` tool. The model reads plain text; the dsh-go app shows a native weather card.

| Days | Card |
|---|---|
| 1–3 | One number block per day: high / low, conditions, chance of rain; thunderstorms, heavy rain and rain ≥ 70 % use the warning tone |
| 4–7 | Today and tomorrow as number blocks, plus a temperature line |

The card travels in `presentationMeta`: no bridge, no manifest. It shows on on-device, SSH and relay hosts alike and stays in the conversation history. The DSH web UI keeps showing its generic tool card.

Weather data: [Open-Meteo](https://open-meteo.com) (free, no key, CC BY 4.0); the card credits it.

## Install

Requires DSH 0.2.1-rc.2 or later (`engines.dsh`). Put the folder on the host, then:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-go-example-weather
```

| Host | Where the folder goes, where to run it |
|---|---|
| On-device engine | Inside the on-device environment (e.g. `/root/.dsh/dsh-go/plugins/`, kept when the engine is reset); run the command in the app's Terminal |
| SSH / relay host | Any directory on the host; run it in the host's shell, with the profile that host uses |
| Dev machine | Same; restart DSH after code changes |

Then ask "What's the weather in Hangzhou for the next three days?". Uninstall: `dsh plugin --profile web remove dsh-go-example-weather`.

## Files

| File | Role |
|---|---|
| `lib/index.js` | Registers the tool. `toolCard()` wraps the view builder: on an error, over 8 KiB, or non-lossless JSON it returns no card instead of failing the tool call |
| `lib/view.js` | Pure functions: forecast → card view, forecast → text for the model |
| `lib/open-meteo.js` | City name → coordinates → daily forecast |
| `cordis.patch.yml` | Bundle patch with a single `insert`, mounted on install |
| `test/` | `npm test` (Node's test runner; uses the real `defineTool` when a DSH install is found) |

## The lines that matter

```js
output: {
  schema,
  render: (_args, value) => [{ type: 'text', text: forecastText(value) }],      // what the model reads
  presentationMeta: toolCard((_args, value) => forecastView(value)),          // what the app draws
}
```

`toolCard()` returns `{ "dsh-go/view": view }`. View format, components and limits: [`docs/plugins/`](../../../docs/plugins/en/README.md).

## Check

```sh
npm test
npm run check        # the sdk/plugin-kit checker in this repo
```

## License

MIT © DSH-TUI (ccch1mneyyy)
