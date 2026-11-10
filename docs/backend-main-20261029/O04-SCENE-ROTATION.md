# O04 backend scene rotation slice

This is a backend candidate over the O03 scene-memory store. It rotates one trusted scene binding to a new blank SDK Session, makes the existing scene handoff readable through the new binding, and optionally archives the old Session after the new binding is committed. It preserves the handoff's original `sourceSessionId`, content and revision as provenance; it does not claim the new Session authored or acknowledged that text, and it does not copy or resend session messages.

## Trusted controller API

```js
import { createStateStore } from '@tradeloom/dsh-business-shell/state'
import { createSceneMemoryStore } from '@tradeloom/dsh-business-shell/scene-memory'
import {
  createSceneRotationController,
  createSdkSceneRotationAdapter,
} from '@tradeloom/dsh-business-shell/scene-rotation'

const state = await createStateStore()
const sceneMemory = createSceneMemoryStore(state, {
  sceneIds: trustedSceneCatalog.map(scene => scene.id),
  verifySession: async ({ sceneId, sessionId }) => hostOwnsLiveSession(sceneId, sessionId),
})
const rotation = createSceneRotationController({
  sceneMemory,
  adapter: createSdkSceneRotationAdapter(hostContext),
})

const preview = await rotation.preview(sceneId, { archiveOld: false })
// A trusted Host controller may show this data and then call execute.
// previewId is an expiring operation handle, not proof of human approval.
const operation = await rotation.execute(preview.previewId)
```

The candidate exports `./scene-rotation` and includes `scene-rotation.js` in the package file list. The production Host does not currently mount this controller or supply `trustedSceneCatalog`/`hostOwnsLiveSession`; the example describes the required integration seam. The API is not registered as an AI tool. Calling `execute` is a trusted controller action, not evidence that a user saw or approved a dialog.

`preview(sceneId, { archiveOld })` requires an existing bound Session and stored handoff. It snapshots the scene binding generation, profile revision, handoff revision, old session identity, workspace membership, cwd and current preset. If the old Session belongs to more than one workspace, preview fails with `scene_rotation_workspace_ambiguous`. A token expires after five minutes by default and can be cancelled with `cancel(previewId)` before execution; preview and cancel do not write state.

Preview DTO:

```json
{
  "previewId": "opaque-expiring-id",
  "operationId": "rotation-id",
  "sceneId": "scene-example",
  "oldSessionId": "session-old",
  "plannedSessionId": "session-new",
  "bindingRevision": 4,
  "profileRevision": 2,
  "handoffRevision": 7,
  "handoff": { "revision": 7, "sourceSessionId": "session-old", "text": "stored handoff" },
  "profile": { "revision": 2, "responsibility": "configured value", "assetRefs": [], "primarySkill": null },
  "archiveOld": false,
  "workspaceId": "workspace-id-or-null",
  "cwd": "captured-session-working-directory",
  "agentPreset": "configured-preset-or-null",
  "recoverOperationId": null,
  "expiresAt": "2026-10-30T00:05:00.000Z"
}
```

The example IDs and content are illustrative. The controller validates inputs and stores an allowlisted snapshot; it does not accept an arbitrary cwd, workspace, preset, actor, or new session ID from a UI caller.

## Persisted operation and recovery

Rotation records live under `sceneMemory.scenes[sceneId].rotations[operationId]`, within the existing owned state transaction. Existing O03 records without O04 fields load as generation `0` and an empty rotation map; they are not rewritten until a state mutation. Binding changes increment a monotonic per-scene `bindingRevision`, so changing A→B→A does not validate an older preview.

After a process restart, a trusted controller can discover candidates without reading the raw namespace: call `sceneMemory.getRotationSnapshot(sceneId)`, inspect `pendingOperationIds`, then call `rotation.getOperation(operationId)` for each ID and let an operator explicitly choose `resume(operationId)` or `abandon(operationId)`. The snapshot is a durable projection of nonterminal operations, not proof that an SDK task in another process has stopped; local in-flight tasks are still awaited/rejected under the existing coordination rules. `complete` and `abandoned` operations are not listed as pending.

The operation moves through:

1. `planned`: persist the intent and planned SDK Session ID before calling the SDK.
2. `session_created`: create only that exact ID, or recover it through exact-ID lookup if a response is lost. A mismatching ID is retained as `needs_review`; it is never rebound as if it were the planned Session.
3. `durable`: verify the exact blank Session, workspace membership, cwd and preset, then flush the live Session and persistence store and stat the same ID.
4. In one owned-state transaction, compare the captured handoff revision and move only the scene-to-session binding. The existing handoff remains unchanged, including its true source session and revision; the rotation journal records the new target Session.
5. If `archiveOld` is true, move to `archive_pending`, request SDK archive with `stopActivity: false`, and confirm the workspace registry reports the old Session archived before marking `complete`. An active-session refusal remains recoverable; this code never stops an active Session to force archive.
6. `complete` means the binding/handoff commit succeeded and, when requested, archive was confirmed. `needs_review` means a captured revision changed or the SDK returned a mismatching identity; a new recovery preview must capture the current state before resume.
7. A trusted controller may call `abandon(operationId)` for a nonterminal operation that no local SDK task is currently executing. It persists terminal phase `abandoned`, preserving the old/planned/created IDs, the existing failure code, the current scene binding and the actual handoff. It does not delete or archive any SDK Session, roll back a committed binding, or claim success. An abandoned operation no longer reserves the scene, so a later explicit preview/bind may proceed. Repeated abandon/resume reads the same terminal record and never calls SDK create again. An in-flight create/attach/archive or recovery task rejects abandonment as `scene_rotation_in_progress`; the caller must wait for that physical task to settle first.

`getOperation(operationId)` reads the durable record. `resume(operationId)` continues only a persisted safe phase. `abandon(operationId)` is a trusted-controller termination choice after a failed or ambiguous operation; it is distinct from cancelling an unexecuted preview (which writes nothing). Same-owned-state wrappers share an in-process pending task keyed by the owned state path, including abandonment, so a write cannot race a live SDK operation or a concurrent resume. The key is non-enumerable and is not part of scene/tool DTOs. This is not a cross-process lock; callers must not run multiple Host processes against the same owned state file.

After a controller restart, enumerate `getRotationSnapshot(sceneId).pendingOperationIds`, then read each candidate with `getOperation(operationId)` and present it for an explicit trusted-controller choice. The snapshot exposes only the IDs in this projection:

```json
{ "sceneId": "scene-example", "pendingOperationIds": ["rotation-id"] }
```

A safe persisted phase can be continued with `resume`; a `needs_review` phase requires a fresh recovery preview and explicit `execute`, or can be ended with `abandon`. `complete` and `abandoned` IDs are excluded from the pending projection. The projection only reports durable operation records; it does not prove that another process's SDK call stopped. The existing in-process pending-task wait behavior is unchanged, and this candidate does not provide a cross-process lock or automatic recovery.

Recovery from `needs_review` uses `preview(sceneId, { archiveOld, recoverOperationId })`; execute compares the preview's captured binding/profile/handoff revisions. Changes after that preview reject with `scene_rotation_stale_preview`. It does not silently adopt a newer handoff or binding. If a create response is ambiguous, the adapter checks only the exact planned Session ID. It does not match by title, list order, or conversation content.

The rep12 adapter uses `SessionController.create`, `SessionPersistence.stat/flush`, `SessionStore.get/flush`, `SessionQuery.observeSession`, and `WorkspaceRegistry`/`Workspace.attachSession`. It never starts a turn or sends a user message. A workspace-bound new Session is created through the same SDK SessionController call; membership is verified before the scene binding moves. The adapter reads the most recent `agent-preset/selected` event from `event.data.agentPreset`, not from an event top-level property.

Stable operation errors include `scene_rotation_closed`, `scene_rotation_preview_expired`, `scene_rotation_not_ready`, `scene_rotation_in_progress`, `scene_rotation_stale_preview`, `scene_rotation_session_mismatch`, `scene_rotation_session_not_durable`, `scene_rotation_workspace_ambiguous`, `scene_rotation_workspace_mismatch`, `scene_rotation_archive_failed`, and `scene_rotation_sdk_unavailable`. `needs_review` and `abandoned` are durable non-success phases: the former requires recovery review or explicit abandonment; the latter records that the controller stopped pursuing the operation without pretending SDK effects were undone.

## Evidence and limits

The targeted evidence is in [O04 validation](../../recovery-20261029/o04-scene-rotation-20261030/VALIDATION.md). It includes isolated marker-owned filesystem tests and one rep12 source-tree SDK composition using the actual Cordis Context, SessionController, AgentLoop testkit/AgentRegistry, SessionStore, JSONL SessionPersistence, SQLite-backed WorkspaceRegistry, and SessionQuery. No external model adapter request was made. The test verifies an empty created Session, flush/stat durability, workspace membership, optional archive/readback, handoff association, and no `user/message` or `turn/start` event. The test kit and selected controller dependencies are test composition; this does not prove a packaged Host installation or production service registration.

There is no Host/UI rotation entry point in this candidate. Preview display, explicit user choice, trusted invocation, post-rotation UI selection, and actual production scene/session registry bindings remain unconnected. No existing user session was rotated. O04 as a full product/UI requirement and the original 51/88/N01–N03 scope remain incomplete.
