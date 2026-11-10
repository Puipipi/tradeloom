# SourceNative factory readiness API candidate

This candidate adds a narrow public notification API to `SlotRegistry` so a consumer can subscribe to late registration, replacement, and removal of one named slot factory. It does not change factory registration, SourceNative production code, or frame lifecycle.

## Public API

```ts
slots.subscribeFactory(name: string, fn: () => void): () => void
slots.getFactoryVersion(name: string): number
```

`getFactoryVersion` returns `0` for a name not yet changed and the factory's current monotonic version otherwise. `subscribeFactory` forwards to the existing `SlotCore` factory event source. The subscription is owned by the Cordis fiber that calls the method; the returned disposer can be called manually and is idempotent, and owner disposal removes the subscription. This is separate from the existing `subscribe`/`getVersion` SlotRecord API.

## Apply scope

Apply only the three changed files shown in the `after` tree; do not copy the full candidate tree over an SDK checkout:

1. `packages/client/ui-renderer/src/client/registry.ts`
2. `packages/client/ui-renderer/lib/client.js`
3. `packages/client/ui-renderer/lib/types/client/registry.d.ts`

The `lib/client.js` change is a manual mirror of the source diff for the isolated compiled-entry candidate. It was not produced by an SDK build. The declarations expose the two methods on the public `SlotRegistry` type. The pinned SDK source, compiled entry, declarations, package manifests, lockfiles, and dependencies were not modified.

## Evidence and limits

The API registry tests used real `SlotTestRuntime`/Cordis ownership and `SlotCore` behavior (3/3). The isolated public consumer passed a no-emit TypeScript check. The SourceNative control and late-factory test passed (2/2) using the pinned SourceNative bundle, real `SourceAwareFrame`, and real `SlotTestRuntime`. For this test only, the input bundle string was changed in memory at the existing SourceNative factory-availability check to call `useSyncExternalStore` with this candidate API. The stable frame was not keyed by factory version and remained mounted once before and after the late factory registration; the actual factory content appeared and the existing `nativeSurfaceMounted` bridge acknowledged the descriptor.

That in-memory test hook is not a production integration. The production SourceNative consumer remains unchanged and must be updated by its owner to subscribe to the factory version at the content availability check. These tests do not claim a packaged SDK build or desktop Host acceptance.

See the recovery directory `recovery-20261029/source-native-factory-ready-20261102/` for exact commands, raw output, and `SOURCE-SHA256.txt`.
