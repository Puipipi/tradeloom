# UI18 Theme Controller Failure Location Candidate

This is an isolated candidate for the actual UI18 ASAR member `dsh/node_modules/@deepseek-ai/dsh-api-settings-controller/lib/index.js`. `before/index.js` is the current extracted member at 24,017 bytes, SHA-256 `96CDF68772889B1E1E32D15392D2CCCB320D81384CC81A076580706B5329DF56`. It adds optional `failureSite`, `failureLine`, and `failureColumn` fields only to an existing `host-error` receipt. It does not add a stage or error code and does not change normal controller results, thrown exception identity, settings CAS, or persistence.

The location projection reads at most one `cause` level (or the caught error when there is no cause), and only its stack. It accepts up to 8,192 stack characters and at most 12 `at` frames. It emits only one of these fixed values with safe non-negative integer coordinates:

- `controller-compiled`, `forms-compiled`, `editor-compiled`
- `controller-source`, `forms-source`, `editor-source`

The matcher recognizes only the three SDK package `lib/index.js` suffixes and the three corresponding source suffixes. It never emits a path, function name, stack, message, config, or arbitrary error field. Unknown, malformed, oversized, over-frame-limit, or throwing stack/cause accessors omit all three location fields. It does not traverse nested causes. A source-map or packaged-layout mismatch also means the suffix is unknown and the location is omitted. A location identifies a throw site only; it is not a root-cause diagnosis. Existing `revision-conflict` and `operation-failed` code mapping is unchanged.

## SDK fixture evidence

The focused test composes the pinned rep12 Cordis, SettingsForms, ConfigEditor, and SettingsController source modules with the actual SDK `ui-theme` package in an isolated marker-owned profile. A deliberate synthetic overlay conflict produces a real generic SettingsController rejection whose single cause stack maps to `editor-source` and safe coordinates. This demonstrates the location projection on the source-loaded fixture; it is not evidence about the live UI18 failure. Separate fixture cases exercise all six accepted suffixes and fail-closed behavior. See `../../recovery-20261029/ui18-theme-receipt-location-20261101/VALIDATION.md`.

## Minimal frontend receipt allowlist update

For `stage: "host-error"`, the consumer may additionally allow:

```text
failureSite: controller-compiled | controller-source | forms-compiled | forms-source | editor-compiled | editor-source
failureLine: safe non-negative integer
failureColumn: safe non-negative integer
```

Each field is optional; the three are emitted together only for a recognized frame. No new `code` or `stage` value is introduced. This candidate is not installed or deployed. Rollback is restoring the exact `before/index.js` member.
