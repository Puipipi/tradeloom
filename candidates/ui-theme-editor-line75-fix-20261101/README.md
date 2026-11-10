# UI18 theme editor line 75: isolated fixture evidence

This candidate contains no product change. `before/index.js` and `after/index.js` are byte-identical copies of the pinned compiled ConfigEditor member; the `patch/` directory records that no patch was produced.

## Evidence

The actual installed archive was read only: `C:/Users/23825/Desktop/TLUI-18-20261101/app/resources/app.asar`, SHA-256 `ed8b1944b0605cacbdb0b6b5bcd85d8d8775546ba6d102b83ffafe1b9f4f3a60`. Its member `dsh\\node_modules\\@deepseek-ai\\dsh-config-editor\\lib\\index.js` was 7,411 bytes, SHA-256 `373e05c8250d25dda983ccf6e214a55e3792a211d1a7b883affcd66de47b5bf8`.

At compiled ConfigEditor line 75, the rejected await is `reconcileProfilePatches(this.ownerContext.root, beforePatches, "dsh")`. The matching pinned source is `packages/boot/config-editor/src/index.ts` line 96. This is an error propagation boundary; its caller frame does not establish the underlying cause.

One owned synthetic-profile fixture exercised the real pinned `runProfile`/boot composition with `resolvedProfile`, `patchFiles: []`, ConfigEditor, SettingsController, SettingsForms, and the ui-theme package. It passed a preference update (revision 0 to 1). The fixture did **not** load the installed full bundles, so it did not reproduce or explain the field failure. The receipt's `editor-compiled` location is not a root-cause diagnosis. No settings values, user profile contents, or raw error text are included.

The fixture's `profile.patchPath` setup error from an earlier setup attempt is retained in the recovery evidence and is not a product failure or root cause. The owned fixture root is retained; no cleanup of its parent was performed.

## Remaining narrow diagnostic option

If further diagnosis is authorized, the smallest useful extension to the existing fixed `failureSite` allowlist is `app-boot-compiled` and `app-boot-source`, so a propagated reconciliation failure can identify the known upstream package frame. This would still be a source location only, not a cause code or proof of the live failure. No such enum extension is included here.

There is no deployable change in this candidate. The actual ASAR and profile were not modified.
