# UI18 app-boot line 3803 investigation candidate

This investigation produced **no product patch**. The isolated candidate contains exact compiled copies of the app-boot member as `before/index.js` and `after/index.js`; their bytes match. The purpose of this directory is to retain the narrow fixture and source correspondence for the observed failure location.

## Actual installed artifact and source

Read-only archive: `C:/Users/23825/Desktop/TLUI-18-20261101/app/resources/app.asar`, SHA-256 `58feb86f5329472999e563b79f3225b785c61a79a5fa5a7ac6e7e8a1308bd80c`.

The reported member `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` is 203,572 bytes, SHA-256 `5135179ac810e4f626f32ec3bdc3293dc7d2028e8aa92e5e0c006f1a33b78e76`. This is byte-identical to pinned rep12 `packages/boot/app-boot/lib/index.js`.

The exact guard in pinned source `packages/boot/app-boot/src/index.ts:336-337` is `bootstrapIncludes.get(ctx) === undefined`, which throws `profile reload requires the root Include entry`. The map is populated by `mountRootInclude` at `src/index.ts:784-789`. ConfigEditor calls `reconcileProfilePatches(this.ownerContext.root, ...)` before editing at `packages/boot/config-editor/src/index.ts:93-96` (the mapped editor call is line 75 in the compiled member).

The actual `dsh` profile-boot chunk imports `boot` from the bare package specifier `@deepseek-ai/dsh-app-boot`; it does not inline another `bootstrapIncludes` WeakMap. The compiled ConfigEditor imports `reconcileProfilePatches` from the same package specifier. The archive contains one `dsh-app-boot` package directory, version `0.2.1-rc.3`, whose export points to `./lib/index.js`.

Pinned resolver source `packages/boot/app-boot/src/profile-resolution/resolver.ts:565-634` routes an installation-scoped package through its resolution entry and Node's default resolver. The route caches by importer/request, but does not add an epoch or query to the module URL. This supports a shared package path; it is not proof of every URL used by the live Host.

Cordis source `vendor/cordis/src/context.ts:70-83` sets each newly constructed root context's `root` to that root proxy. `extend()` at lines 90-107 prototypically inherits the context; `isolate()` creates a separate service scope through `extend()` and does not create a new root. Thus ordinary child/plugin scopes keep the same `root`; another constructed `Context` would be a separate root. SettingsForms injects `configEditor` and `profileContext` at `packages/settings/settings/src/index.ts:223-235`; ConfigEditor calls reconciliation with `ownerContext.root`. SettingsController reads `this.ctx.get('settings')` at `packages/api/settings-controller/src/index.ts:216-225` and calls `settings.mutate()` at lines 197-205. These sources do not establish that the live Host passes the same root Context to both sides.

## Isolated compiled-module fixture

The one fixture used compiled rep12 AppBoot, CLI profile-boot wrapper/chunk, ConfigEditor, Settings, and SettingsController with a synthetic marker-owned profile. It started the real `runProfile` composition with `resolvedProfile`, no patch files, a root Include row present in the Loader, and `ConfigEditor.ownerContext.root === runtime.ctx`. The settings mutation resolved at revision 1. Thus the missing-root-Include guard did not reproduce in this compiled fixture. The fixture does not load all actual installed bundles or duplicate the live bundle resolver; it does not establish the live refusal's root cause.

The test's SettingsController is the pinned rep12 compiled member, not the current installed receipt-instrumented Controller. The installed Controller member was read-only identified separately as `c9c810483cfa1347ba0d2b9756e92531d4a07672e52ebf1752db320a91e476ba`. Its diagnostic wrapper does not establish an app-boot cause.

No profile values, credentials, user messages, raw errors, or live memory were recorded. The actual ASAR, profile, and user settings were not modified. Do not apply or deploy this candidate.

## Remaining evidence gap

The synthetic fixture proves only that this pinned compiled composition mounts and uses the root Include successfully. It does not reveal why the live Host's `bootstrapIncludes` lookup returned `undefined`. The minimal next diagnostic, if approved, is a fixed projection at the mount and failing reconciliation sites: `rootIncludePresent` boolean, `ownerRootMatchesBootRoot` boolean/unknown, and `appBootModuleInstanceMatches` boolean/unknown. Correlate those within one write using an opaque process-local tag/monotonic counter; do not emit context objects, URL/path, config, error text, or stack. Do not infer duplication or bypass the guard from this fixture.
