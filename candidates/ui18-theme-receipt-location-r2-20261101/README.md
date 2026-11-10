# UI18 theme failure-location candidate, revision 2

This is an isolated single-member candidate based on the installed Controller member hash `AF47647B80D892D415A5D75B4CCB01C4A7E4DAA8518DC455596126ADFABFB9E4`. The observed archive was read-only: `C:/Users/23825/Desktop/TLUI-18-20261101/app/resources/app.asar`, SHA-256 `ed8b1944b0605cacbdb0b6b5bcd85d8d8775546ba6d102b83ffafe1b9f4f3a60`. The current candidate before image was copied from the preceding frozen location candidate and matches the Controller member hash supplied for this installed archive.

## Change

Only two exact source suffix mappings were added to `themeReceiptFailureLocation`:

- `/@deepseek-ai/dsh-app-boot/lib/index.js` → `app-boot-compiled`
- `/packages/boot/app-boot/src/index.ts` → `app-boot-source`

The existing six mappings, single-cause behavior, maximum stack length, 12-frame cap, safe coordinate checks, omitted unknown locations, receipt fields, stages, and rethrow of the same error object remain unchanged. The first recognized frame still wins; a test verifies an app-boot frame is selected before a later ConfigEditor await frame. The location identifies a stack frame only; it is not a root-cause classification.

## Evidence and limits

The focused fixture suite passed 6/6 with zero skips. It includes the real pinned Cordis/SettingsController synthetic overlay rejection fixture; that fixture maps to `editor-source` and is not the live profile or the observed desktop failure. No current ASAR member, profile, preference, Main process, or frontend file was changed. The actual installed SettingsController member hash was independently reported as AF476…; this candidate does not extract or rewrite the archive.

For C integration, add the two enum strings above to the existing `failureSite` allowlist and replace only this SettingsController member in an isolated package candidate. Preserve all other receipt schema and behavior. This candidate is not deployed.
