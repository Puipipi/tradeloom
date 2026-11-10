# UI18 app-boot root identity observation candidate

This is a temporary diagnostic-only replacement candidate for the compiled app-boot member. It does not repair or bypass `bootstrapIncludes`, Loader reconciliation, reload, or any settings behavior.

## Pinned target

- Read-only installed archive: `C:/Users/23825/Desktop/TLUI-18-20261101/app/resources/app.asar` (archive SHA-256 `58feb86f5329472999e563b79f3225b785c61a79a5fa5a7ac6e7e8a1308bd80c`).
- Exact member: `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` (203,572 bytes; base SHA-256 `5135179ac810e4f626f32ec3bdc3293dc7d2028e8aa92e5e0c006f1a33b78e76`). The `before/index.js` copy is byte-identical to the earlier installed-member extraction and pinned rep12 compiled app-boot.
- Source mirror: `source/app-boot/index.ts` is pinned `packages/boot/app-boot/src/index.ts`. It records the unchanged source contracts; this candidate intentionally patches the compiled member only.

## Observation hooks and wire

The mount hook runs only after the existing `bootstrapIncludes.set(ctx, entry)` succeeds. It stores weak references to the boot Context, its `root`, and a module-local opaque token in a diagnostic-only `Symbol.for('tradeloom.ui18.appBootRootIdentity.v1')` slot. It never changes the real `bootstrapIncludes` WeakMap. The slot is process-local, bounded to nine context/module associations, and is not persisted or consulted by reload.

The two source hook sites correspond to pinned `packages/boot/app-boot/src/index.ts`: the missing-map guard around line 336 and `mountRootInclude` registration around lines 743–789. In the compiled target these are around lines 3892 and 4245, respectively. The source mirror is unchanged; the candidate modifies only the compiled member.

The only output hook is inside the existing `bootstrapIncludes.get(ctx) === undefined` guard, immediately before that same guard throws. It emits one line to `console.log`:

```text
[UI18_ROOT_IDENTITY_V1]{"rootCount":1,"moduleCount":2,"rootIncludePresent":true,"ownerRootMatchesBootRoot":true,"appBootModuleInstanceMatches":false}
```

Exact fields are required `rootCount` and `moduleCount` integers in `0..3`, plus optional booleans `rootIncludePresent`, `ownerRootMatchesBootRoot`, and `appBootModuleInstanceMatches`. No `stage` or other fields are emitted.

- `rootIncludePresent` is based on the actual root Loader tree: `resolve('include')`, the root tree's own `store.include`, `id === 'include'`, `name === 'cordis:include'`, and exact root-group ownership. A complete root store with no `include` yields `false`; an inaccessible Loader, getter failure, or failed resolve while a stored entry exists omits the field.
- `ownerRootMatchesBootRoot` is emitted only when exactly one boot root is recorded without registry overflow; it compares the current missing-guard `ctx.root` with that unique mount-time root. No record, multiple roots, overflow, or inaccessible values omit it.
- `appBootModuleInstanceMatches` is emitted only when one module token was recorded for this exact Context; it compares that token with the module executing the missing guard. Missing or ambiguous records omit it.
- Counts are capped distinct associations observed by this process-local diagnostic slot, with the currently executing root/module included when readable. They are bounded observations, not an authoritative inventory of every Context or ESM module in the process.

All observation and logging work is best-effort inside exception isolation. It emits no Context, object identity, path, URL, configuration, error, stack, account, or credential. It cannot replace the existing guard error or alter successful boot/recompose behavior.

## Evidence and integration boundary

`recovery-20261029/ui18-appboot-root-identity-20261101/` contains the focused compiled-Cordis fixture, raw command output, and hashes. The fixture imports two separately copied instances of the compiled candidate; one mounts a real root Include and successfully recomposes, while the other observes the original missing-WeakMap guard. It also covers mismatched owner root, unavailable Loader resolution, no mount record, multiple boot roots, and a throwing console sink. These are isolated fixture observations, not the UI18 runtime root cause.

The current Main does not persist this prefix. The candidate uses only `console.log`; C/Main must separately add a fixed-prefix parser and bounded receipt sink before this output can be read from a future diagnostic run. This candidate is not installed or deployed, and it does not establish an app-boot instance duplication in the live Host.

To roll back, restore the exact `before/index.js` member with its pinned SHA. A final diagnostic build must remove these temporary hooks.
