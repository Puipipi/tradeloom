# UI theme Host write fixture result

This candidate investigates the reported `operation-failed` receipt without changing the installed application or SDK source. The actual `SettingsController` archive member was extracted from `C:/Users/23825/Desktop/TLUI-18-20261101/app/resources/app.asar` into `before/index.js`; `after/index.js` is byte-identical. No product patch was found or proposed because the reported rejection did not reproduce in the isolated real-SDK composition.

## Reproduced composition

The test uses the pinned `rep12` Cordis, app boot, SettingsForms, ConfigEditor and SettingsController source modules, plus the actual compiled `@deepseek-ai/dsh-client-ui-theme` package reached through a junction inside a marker-owned synthetic profile. The fixture uses the real profile entry identity (`id: ui-theme`, package name `@deepseek-ai/dsh-client-ui-theme`) and a synthetic `preference: light` baseline. It performs one real `SettingsController.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }], 0)` through the SDK services. No user profile, preference value, browser session, or secret was read or written.

The isolated write succeeded: the active entry and descriptor were present, the preference schema was available, SettingsForms and ConfigEditor both resolved, and the owned profile patch changed with revision `0 -> 1`. This shows the tested composition can commit the write; it does not identify why the live Host's earlier `operation-failed` occurred.

## SDK/source correspondence

The copied source mirrors are under `source/`. The `rep12` versions of Cordis, app boot, ConfigEditor, SettingsForms, its schema, SettingsController, and ui-theme source match the current pinned SDK source hashes. The live ASAR `dsh-settings`, `dsh-config-editor`, and `dsh-client-ui-theme` compiled members match the corresponding `rep12` compiled files byte-for-byte. The current ASAR SettingsController member contains the separate UI18 receipt wrapper; its underlying compiled `write(ns, mode, input, expectedRevision)` method is byte-identical to the pinned compiled method.

## Fixture setup note and limits

An early fixture setup pointed `profile.patchPath` at the bundle's `cordis.patch.yml` instead of the profile-root patch used by the official fixture. The SDK then reported the safe class `profile-overlay-conflict`. A subsequent test alias also did not match the actual package entry. The final fixture uses the profile-root patch and actual theme package name; it passes. These were fixture setup errors, not evidence of the live product root cause.

Because the live receipt only says `operation-failed`, the failing Host stage remains unknown. The next diagnostic should wait for frontend schema review and use one bounded phase indicator around the real namespace/provider/schema/CAS/editor/readback stages. This candidate does not implement that diagnostic. Nothing was deployed, and the desktop environment remains under frontend maintenance.

See `../../recovery-20261029/ui-theme-host-write-fix-20261101/VALIDATION.md` for the exact fixture command, safe stdout, exit code and hashes. `patch/NO_PRODUCT_PATCH.md` records that `before` and `after` are identical.
