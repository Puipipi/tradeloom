# WebAI native bridge candidate

This isolated candidate supplies a Main-process bridge and a narrowly scoped preload API. It is not wired into the shipped Host/controller and does not contain a provider DOM adapter. It starts unavailable until a trusted conversation notification or a successful live `inspect` confirms the conversation; a new-chat landing page with no conversation ID stays unavailable.

## Trusted attachment

The existing trusted controller constructs `createWebAiNativeBridge({ authorizeNativeToolRun, runtimeFiles, createFileTools, createToolEnvelope, toolManifest })`, calls `attachProvider({ providerId, ownerWebContents, webContents, adapter })` with the actual UI observer and provider `WebContents` objects, calls `registerIpc(ipcMain)`, and calls the returned unregister function during teardown. The provider origin is checked against the fixed origin table in `bridge.mjs`. One provider `WebContents` object may have only one attached target record; same-numbered but different objects do not share target authority.

The trusted Main-side adapter contract is:

| Method | Contract |
| --- | --- |
| `inspect({ signal })` | Promise of `{ conversationId, draftText, attachmentCount }` from the live provider state. `conversationId` must be real and nonempty; the bridge rejects any draft text, including whitespace, or any attachment. |
| `onConversationChange(listener)` | Subscribe to trusted live conversation changes and return an unsubscribe function. The listener receives a conversation ID string or `{ conversationId }`. An initial notification may be sent during subscription; otherwise status stays unavailable until `inspect` confirms an ID. |
| `ask({ requestId, prompt, signal, conversationId, taskNonce, fileTask, onProgress })` | Start one native-authorized request and resolve only with the complete assistant observation described below. The adapter must refuse any draft or attachment and must not clear or replace user input. |
| `continueWithToolResult({ requestId, taskId, taskNonce, conversationId, result, signal })` | For O07 only, return the next complete assistant observation in that same provider conversation after receiving the real envelope result. |

Each assistant observation must contain `source: 'native-assistant-observation'`, `role: 'assistant'`, `isNew: true`, exact `conversationId`, exact nonempty `taskNonce`, exact `requestId`, nonempty `messageId`, string `content`, and either `complete: true` or `generating: false`. Missing adapters, conversation state, or any correlation field fail closed. Page-supplied IDs and roots are not accepted as authority.

The controller owns provider-view visibility and lifetime. Hiding/showing the view, switching scenes, or changing its parent while retaining the same provider `WebContents`, provider conversation, and native authorization must leave the target attached; an in-flight background ask may complete. These UI changes do not create a visibility authorization marker. Detach the target with `detachProvider(targetId, webContents)` when the provider target is destroyed or replaced. Real provider navigation or conversation change invalidates outstanding work and grants; a fresh request may inspect the newly navigated conversation after navigation settles. The physical provider queue remains held until an outstanding adapter operation actually settles, including across an explicit detach/reattach of the same provider `WebContents`.

The observer owner is separate from the provider target and native authorization. The bridge binds `windowId` to `String(webContents.id)`, not the observer owner ID. Native authorization must return `{ exec, webContents, isCurrent }` with the exact provider `WebContents` object; same numeric IDs do not match. Main may transfer the observer using `transferOwner({ targetId, currentOwner, newOwner })` with the actual owner objects. This method is not exposed by preload or renderer APIs. The old owner immediately loses status access and progress events move to the new owner. Closing an owner removes only its observer; it does not invalidate an otherwise-current provider target or native task. Transfer does not alter or migrate a grant. This preserves the shared grant's exact `providerId/windowId/conversationId` contract (`webai-file-tools.js:83-107,155-156`; envelope `webai-tool-envelope.js:117-128`) because `windowId` remains the provider `WebContents.id` across owner changes.

## Native calls and O07 composition

`askFromNative` and `beginFileTask` are Main-only candidate entry points. Their caller must pass the exact native ToolRun execution object; the injected `authorizeNativeToolRun({ exec, providerId })` callback must validate its live native authorization and return `{ exec, webContents, isCurrent }`, plus `fs`, `getRoot()`, and `getDeniedTools()` for file tasks. The callback must return the same execution object and the exact provider target object. The bridge does not treat a nonempty object or renderer argument as authorization. These authorization objects, filesystem accessors, roots, grants, and capabilities remain in Main and are never serialized.

Request-idempotency records remain while the underlying provider operation is unsettled or the original native execution is still current. A settled record is pruned only after its original `exec.signal` is aborted or its original authorization callback returns `false` at a check point; there is no LRU or lifetime request-count cap. Retrying the same request ID and content with the same live exec reuses its operation/result, while changed content or a different exec is rejected. A caller timeout may return before the provider operation settles; it does not free the physical target queue or the request record. Cancellation stops the caller's wait and signals the adapter, but cannot promise to withdraw a message already sent to the webpage. Authorization is checked at operation checkpoints, not polled continuously; after a failed currentness check, file results are not processed or returned.

File support composes injected `runtimeFiles.bind/execute/revoke`, the existing `createWebAiFileTools` and `createWebAiToolEnvelope` factories, and their manifest. The task grant remains in Main. The candidate does not implement filesystem operations or replace runtime scope/policy. The focused suite dynamically imports the real shared factory modules when `TRADELOOM_WEB_AI_SHELL_ROOT` points to the source package; it verifies a read-envelope → runtime fixture → continuation → final response → revoke round trip. Its `runtimeFiles` and filesystem are controlled fixtures, so this proves the shared factories compose with the candidate, not real DSH filesystem execution.

## Preload and lifecycle

`createWebAiPreloadApi(ipcRenderer)` exposes only `getStatus(targetId)` and `onProgress(targetId, listener)`. Merge this object into the existing trusted `app.sourceWebAi` namespace or another unique key in the existing preload. Do not create a second `app` exposure or call it the old vendor `app.webai` task bus. The owner preload must remain separate from the provider page. Main status requests are accepted only when `event.sender` is the exact registered owner object. Progress payloads are restricted to request/target/provider/phase/error-code fields.

## Verification boundary

Run the focused candidate checks with:

```sh
$env:TRADELOOM_WEB_AI_SHELL_ROOT='C:/Users/23825/Desktop/ICT/tradeloom/packages/tradeloom-shell'; node --test candidates/webai-native-bridge/bridge.test.mjs
```

The candidate has no hide/reparent API or listener; the controller must retain the same attachment for those UI actions. The focused tests cover object identity, origin rejection, unavailable/dirty provider state, conversation absence, stale-inspect/navigation protection, request cache identity, task/observation correlation, early abort, same-target serialization across timeout and detach/reattach, queued cancellation cleanup, owner transfer while an ask and file grant are active, owner destruction without task invalidation, target/conversation/native-permission invalidation, real shared factory composition over a runtime fixture, and preload payload filtering. The provider adapter is a controlled test double. No provider DOM selectors, login, real web message, paid model call, Host/UI wiring, or real DSH file operation is included.
