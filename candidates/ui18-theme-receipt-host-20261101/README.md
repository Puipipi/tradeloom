# UI18 theme settings receipt candidate

This is a single-member diagnostic candidate for the frozen UI18 archive member `dsh/node_modules/@deepseek-ai/dsh-api-settings-controller/lib/index.js`. It does not modify the ASAR, frontend, SDK source tree, user settings, or the installed application.

## Exact scope

- `before/index.js` is the extracted archive member: 21,775 bytes, SHA-256 `9C92E35D80B2B59D08E38CAFE8FF9896D96F6E82CC3BE4B0E7EAD21432E94E1A`.
- `after/index.js` adds a receipt only when `SettingsController.mutate()` receives namespace `ui-theme` and a `set` operation on exactly `['preference']`.
- Each stdout line begins `[UI18_THEME_RECEIPT_V1]` immediately followed by the JSON row; the row is allowlisted. It can contain only `diagnosticBuild`, `stage`, `code`, optional `ok`, optional `preference`, and optional safe integer `revision`.
- A request row (`stage: host-request`, `code: none`) records an observed request and may include the caller's safe `expectedRevision`; it does not mean the write was accepted. A result row means the existing handler resolved after its write path and redacted namespace readback. Its `revision` is emitted only when the actual result contains a safe revision; the caller's expected revision is never copied into a result row. This does not prove UI or end-to-end user acceptance.
- Error rows use `revision-conflict` only for the actual `settings/conflict` code; all other failures use `operation-failed`. Raw errors, messages, stacks, URLs, settings documents, tokens, and account data are never emitted. Logging failures are swallowed, while the original result object or thrown exception is preserved.
- Other namespaces and settings paths remain on the original `write()` path and emit no receipt.

## Source correspondence and limits

The matching SDK source seam is `packages/api/settings-controller/src/index.ts`: `mutate(ns, ops, expectedRevision)` forwards to the existing settings write path, which calls `settings.mutate(...)` and then reads a redacted namespace view. The actual target is the compiled member extracted from `C:/Users/23825/Desktop/TLUI-18-20261101/app/resources/app.asar`; the source file is reference material only and was not modified. This candidate has not been inserted into or launched from the archive. No live theme setting was changed.

The artifact is diagnostic evidence only. The desktop runtime acceptance is paused and has not been performed. Any later bundle must replace only this exact member after verifying its before hash; rollback is restoring the exact `before/index.js` bytes. No new service, RPC, endpoint, or persistent writer is introduced.

## Validation

Focused local tests exercise the actual compiled `mutate` method and receipt helpers with a fixture writer. They do not run the desktop Host, mutate preferences, call the SDK remotely, or validate a packaged launch. See `../../recovery-20261029/ui18-theme-receipt-host-20261101/VALIDATION.md` for commands, raw output, and hashes.
