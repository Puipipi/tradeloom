# Preview view JSON locally

[中文](../preview.md)

The checker reports problems by path. To inspect actual layout, the repository's preview command runs the App's `PluginView` and renders static view JSON plus a data snapshot into light and dark PNGs. It uses the App's Flutter parser, components and themes. It does not start DSH, load plugin JavaScript or send actions.

## Prepare the checkout

Use a complete dsh-go checkout, Node 22.19+, the repository's Flutter version, and an `app/` with dependencies, localization, App fonts and test fonts prepared through the normal project workflow. The preview uses the strict font setup in `test/flutter_test_config.dart`; missing fonts fail the run. `DSH_TEST_FONT_DIR` can point to the Noto Sans CJK directory; see `app/test/support/test_fonts.dart`.

The command runs `flutter test --no-pub`. It does not install dependencies, change build configuration or generate localization. This is a source-checkout developer tool, separate from the skill installed on a phone.

## Run it

From the repository root, choose an output directory that does not exist:

```sh
node sdk/plugin-kit/bin/preview.mjs /absolute/path/view.json \
  --data /absolute/path/data.json \
  --out /absolute/path/new-preview-directory \
  --width 320 --height 960 --scale 1.3
```

`--data` is optional. Raw views default to the panel budget. A tool-result envelope such as `{ "dsh-go/view": ... }` selects the tool-card budget automatically; tool cards do not acquire a data model. Override with `--budget panel|strip|toolCard` when needed.

| Option | Default and range |
|---|---|
| `--width` | 390 logical pixels; integer 240–800 |
| `--height` | 960 logical pixels; integer 240–2400 |
| `--scale` | 1; range 1–2, including 1.3 and 2 |
| `--theme` | `both`, or `light` / `dark` |
| `--lang` | `zh`, or `en`; changes App wording, not plugin content |
| `--flutter` | `flutter` on PATH, or an absolute executable path |

Each input file is limited to 1 MiB for preview loading. Actual views still use the App's tool-card, panel or strip budgets. The existing `check.mjs` remains useful before rendering. The preview also prints checker diagnostics first. A fatal root returns 2 without starting Flutter; local errors can still render as placeholders.

## Inspect the output

- `light.png` and `dark.png`: the first viewport in each selected theme, with one image pixel per logical pixel.
- `light.json` and `dark.json`: App parser issues, actual theme and text scale, a native fatal-root flag and `remainingScrollExtent`. A positive remaining extent means content continues beyond the screenshot.
- `sdk-diagnostics.json`: the Node checker's report.
- `request.json`: the exact view and data snapshot. It may contain the private data you supplied; store or share it accordingly.

The command retains the checker's 0/1/2 result. Flutter compilation, layout, capture or output failures return 3; a native fatal root returns at least 2. Existing output directories are not overwritten. Failed runs can leave partial output; use a new directory for the next run.

## Scope

The image represents the selected viewport. Panel actions display their normal appearance but have no host handler; screenshots do not test actions, permissions or live feeds. No plugin asset resolver is installed, so `asset:` images use the App's placeholder. Inline images follow App decoding; asynchronous image timing needs separate tests. The tool does not load web pages or execute plugin code from Markdown.

These are local renderings. The command never reads, updates or approves golden baselines. Final visual checks require complete product fonts and assets, with separate device checks for font fallback, GPU behavior, system scaling and interaction. Verified on Linux with Node 24 and Flutter 3.47; on other platforms, first confirm that Flutter tests run locally. On Windows, `--flutter` may point at `flutter.bat` (the default `flutter` on PATH works too); it is started through `cmd.exe`.
