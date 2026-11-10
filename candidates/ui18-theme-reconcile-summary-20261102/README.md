# UI18 theme reconcile summary candidate

This isolated candidate adds a bounded failure summary to the existing UI18 theme receipt. It does not change the settings request, validation, compare-and-swap, write, rollback, or activation behavior.

## Files

Only these compiled members are intended for a controlled candidate package:

- `after/packages/boot/app-boot/lib/index.js`
- `after/packages/boot/config-editor/lib/index.js`
- `after/packages/api/settings-controller/lib/index.js`

The pinned TypeScript source mirrors are included under `after/.../src/index.ts` for review of the app-boot and ConfigEditor logic. The SettingsController TypeScript source is unchanged: the current UI18 receipt hook is compiled-only in the pinned source snapshot. The compiled files are hand-patched mirrors; this is not a full SDK build and a later build from the pinned source would not reproduce the existing compiled-only UI18 receipt/location instrumentation.

## Receipt extension

On a `host-error` row, when the trusted app-boot guard has attached a complete summary, the existing `[UI18_THEME_RECEIPT_V1]` JSON row gains these five top-level fields. This is an example value set, not a claim that every listed value occurred in the fixture or live Host:

```json
{
  "failureCode": "profile-reconcile-inactive",
  "introducedInactiveCount": "2_plus",
  "introducedFailedCount": "1",
  "introducedPendingCount": "1",
  "editorPhase": "apply"
}
```

The three count strings are each one of `0`, `1`, or `2_plus`; they describe only entries introduced by the current reconciliation, not every existing inactive entry. `failureCode` is fixed to `profile-reconcile-inactive`. `editorPhase` is `before`, `apply`, `rollback`, or `unknown`; if phase metadata is absent or invalid, the projector emits `unknown`. If the failure code or any count is absent or invalid, all five receipt fields are omitted. No names, IDs, paths, missing dependency lists, configuration values, or error text are projected.

App-boot puts the frozen summary on the original activation `Error` as a non-enumerable `Symbol.for('tradeloom.ui18.themeReconcileSummary.v1')` property. ConfigEditor annotates that same error at its before/apply/rollback boundaries. SettingsController reads only the direct error or one own-data `cause`, validates the complete summary, and leaves the existing error code and thrown object unchanged. Diagnostic attachment and receipt emission are best-effort.

## Validation boundary

The focused fixture runs the candidate app-boot and ConfigEditor compiled members with an owned temporary profile and a controlled local plugin activation rejection. It verifies the real ConfigEditor apply rollback restores the owned patch, then verifies the compiled SettingsController receipt projection using that same error as a controlled rejected service result. It does not reproduce the full installed Host/plugin composition or prove the cause of any particular live failure. No active profile or user setting was written.

See [the recovery validation record](../../recovery-20261029/ui18-theme-reconcile-summary-20261102/VALIDATION.md) and [the source hash inventory](../../recovery-20261029/ui18-theme-reconcile-summary-20261102/SOURCE-SHA256.txt).
