# UI18 reconcile detail candidate (r2)

This isolated candidate extends the existing `UI18_THEME_RECEIPT_V1` `host-error` row with four bounded string fields. It does not change settings admission, schema validation, CAS, filesystem write/rollback order, reconciliation, or thrown-error identity.

## Exact family mapping

Mapping uses exact `Entry.options.name` strings only. No prefix, substring, config value, entry ID, or raw name is returned. The public package names below were checked in their `package.json` `name` fields (line 2); the business shell name is from this worktree's `packages/tradeloom-shell/package.json`.

| family | exact package names |
| --- | --- |
| `ui-theme` | `@deepseek-ai/dsh-client-ui-theme` |
| `ui-layout` | `@deepseek-ai/dsh-client-ui-layout` |
| `ui-settings` | `@deepseek-ai/dsh-client-ui-settings`, `@deepseek-ai/dsh-client-ui-settings-account`, `@deepseek-ai/dsh-client-ui-settings-agent-loop`, `@deepseek-ai/dsh-client-ui-settings-general`, `@deepseek-ai/dsh-client-ui-settings-models`, `@deepseek-ai/dsh-client-ui-settings-plugin-inventory`, `@deepseek-ai/dsh-client-ui-settings-plugins`, `@deepseek-ai/dsh-client-ui-settings-session-log`, `@deepseek-ai/dsh-client-ui-settings-shell`, `@deepseek-ai/dsh-client-ui-settings-subagent`, `@deepseek-ai/dsh-client-ui-settings-web-search` |
| `business-shell` | `@tradeloom/dsh-business-shell` |
| `config-editor` | `@deepseek-ai/dsh-config-editor` |
| `app-boot` | `@deepseek-ai/dsh-app-boot` |
| `settings-controller` | `@deepseek-ai/dsh-api-settings-controller` |
| `other` | any other readable exact name |
| `multiple` | more than one introduced failed entry |
| `unknown` | no failed entry or safe name unavailable |

## Error-code projection

`introducedFailureCode` and `applyFailureCode` are restricted to `ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`, `ERR_REQUIRE_ESM`, `ERR_UNKNOWN_FILE_EXTENSION`, `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`, `ENOENT`, `EACCES`, `EPERM`, `EEXIST`, `ETIMEDOUT`, and `SETTINGS_CONFLICT`, plus `multiple` and `unknown`.

Only an own data `code` is inspected, first on the error and then on at most one own-data `cause`. Accessor getters are not invoked. A non-allowlisted or unavailable code projects as `unknown`; multiple failed entries project `multiple`. No error message, stack, path, entry ID, plugin name, or configuration is projected.

The four top-level strings on `host-error` are:

```json
{
  "introducedFailureFamily": "other",
  "introducedFailureCode": "EACCES",
  "applyFailureFamily": "other",
  "applyFailureCode": "ERR_MODULE_NOT_FOUND"
}
```

These sample values reflect only the synthetic owned fixture. App-boot summarizes the current reconciliation error. ConfigEditor preserves the safe apply family/code when rollback reconciliation itself fails; if no valid apply summary exists, the apply pair is `unknown`. SettingsController emits all four only when the base reconciliation summary is valid. If there is no summary, it emits none of these fields. Earlier receipt fields and their behavior remain in place.

## Candidate files

Use only the three compiled `after` members as an overlay on the verified current compiled baseline:

- `after/packages/boot/app-boot/lib/index.js`
- `after/packages/boot/config-editor/lib/index.js`
- `after/packages/api/settings-controller/lib/index.js`

App-boot and ConfigEditor TypeScript source mirrors are included for review. The SettingsController TypeScript source remains unchanged because the existing receipt/location hook is compiled-only in the current pinned source snapshot. The compiled files are manual incremental mirrors, not a full SDK build. This candidate does not modify or replace the r1 candidate.

See [validation and evidence](../../recovery-20261029/ui18-theme-reconcile-detail-20261102/VALIDATION.md) and [the hash inventory](../../recovery-20261029/ui18-theme-reconcile-detail-20261102/SOURCE-SHA256.txt).
