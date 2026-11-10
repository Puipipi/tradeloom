# N03 Managed Agent Configuration Snapshots

This backend slice adds snapshots for the existing managed per-role agent configuration. It is not a whole-profile backup or the complete N03 restore scope.

## Scope and source

The normal package exports `@tradeloom/dsh-business-shell/agent-configuration` and `@tradeloom/dsh-business-shell/agent-configuration-snapshots`. The existing configuration handler remains the only writer: snapshot restore calls its extracted controller, which uses the same owned-profile validation, per-role write lock, revision check, field validation, `ConfigEditor.edit`, preset health check, and compensation path as the existing PUT handler.

Snapshots contain only the projected `mcpServers`, `skill` (`includeDefaultRoots` and workspace-relative `customSkillDirs`), and `deniedTools` fields for one managed role/preset. They never contain raw profile files, session or message state, provider credentials, current-agent state, or arbitrary plugin rows. Secret expressions are represented by `{ "envName", "scheme" }`; secret values and the dynamic `present` flag are not persisted. Preview rechecks whether each referenced environment variable is currently present. A missing reference makes restore non-applicable.

URLs and stdio `command`, `args`, and `cwd` remain controlled configuration text in the snapshot. The projection does not claim to scrub arbitrary text. Existing URL credential validation remains in force.

## API

The factory is `createAgentConfigurationSnapshotsHandler(ctx, dependencies)`. Every request first uses the existing `ctx.connection.requestRejection(req)` result unchanged. Preview tokens live only in that handler instance, are consumed by cancel/restore, and are cleared when its Cordis context effect is disposed. There is no time-based preview expiry. The route is not mounted by a Host in this branch; a future Host must explicitly register the factory and preserve that origin gate.

```http
GET /tradeloom/agent-configuration/snapshots?role=product
```

Returns `{ "role", "snapshots" }`. Each valid row contains `snapshotId`, `kind`, `role`, `preset`, `sourceRevision`, `createdAt`, fixed `scope`, and `checksum`; a pre-restore backup also contains `sourceSnapshotId`. Invalid on-disk rows are listed as `{snapshotId,status:"invalid",errorCode}` rather than projected as usable snapshots.

```http
GET /tradeloom/agent-configuration/snapshots?role=product&snapshotId=<id>
```

Returns `{ "snapshot": { ...metadata, "projection": { "mcpServers": [], "skill": {}, "deniedTools": [] } } }` after schema and checksum validation.

```http
POST /tradeloom/agent-configuration/snapshots
Content-Type: application/json

{"action":"capture","role":"product"}
```

Returns 201 with `{ "snapshot": <metadata> }`. The other strict request bodies are:

```json
{"action":"preview","role":"product","snapshotId":"<id>"}
{"action":"cancel","role":"product","previewId":"<id>"}
{"action":"restore","role":"product","previewId":"<id>"}
```

Preview returns `previewId`, `role`, snapshot metadata, `currentRevision`, current and target managed projections, `applicable`, `reasons`, and `noOp`. It performs no configuration write or workspace creation. The default preview resolver only checks the owned-home path and reparse-point boundary; when the role workspace is absent and `customSkillDirs` is empty, the preview remains valid without creating it. If a Host injects `roleWorkspacePathReadOnly`, that callback must be non-mutating. The existing PUT path continues to use `roleWorkspacePath`, which may create the workspace as before. A missing referenced secret, unmanaged MCP name collision, preset-registry unavailability, or managed validation failure returns a preview with `applicable:false` and the fixed reason code; it does not try a test write. On restore, the preview must still match the same original ConfigEditor/profile provider identities, current owner, revision, and projection.

Cancel removes an unconsumed in-memory preview and writes nothing. Restore rechecks the owned role/preset, provider identity, source checksum, current revision, and current projection under the original per-role lock. A no-op does not write a backup or call ConfigEditor. Otherwise it writes and verifies a `pre-restore-backup` snapshot before calling the shared controlled update. It then re-reads through the current controller and checks both the returned revision and normalized managed projection. Success reports `status:"restored"`, `revision`, `backupSnapshotId`, `appliedForNewAgents:true`, and `currentSessionUnchanged:true`; it does not claim to change an already-running session. If the backup was verified but a later application/readback step fails, the error response includes `backupSnapshotId`. A preview token is not human confirmation. The API does not itself prove a human approved a restore.

Stable snapshot errors include `invalid-query`, `invalid-json`, `invalid-request` (HTTP 400, including prototype-named unknown actions), `request-too-large`, `snapshot-invalid`, `snapshot-checksum-mismatch`, `snapshot-not-found`, `snapshot-role-conflict`, `snapshot-unavailable`, `snapshot-write-failed`, `snapshot-backup-write-failed`, `snapshot-preview-not-found`, `snapshot-handler-closed`, `snapshot-restore-stale`, `snapshot-not-applicable`, and `unsupported-managed-config`. The existing writer may return its established `invalid-configuration`, `revision-conflict`, `configuration-unavailable`, `configuration-apply-failed`, or `configuration-restore-failed` codes. The handler does not expose raw filesystem or profile errors.

## Validation boundary

The adapted controller suite keeps the existing configuration behavior and error ordering. Two unrelated tests from the upstream file that require `cordis.patch.yml`/Host bundle installation are outside this branch's fixture and are recorded as excluded, not counted as passed. The isolated snapshot suite tests owned-home file IO, checksum rejection, backup-before-edit, stale/no-op/cancel, missing references, and ConfigEditor compensation. Rep12 runtime evidence has two distinct layers. The earlier ConfigEditor/Loader case uses a synthetic preset fixture. The later focused case loads the actual rep12 `AgentPresetRegistry`, skill-filesystem plugin, `AgentLoop`/`AgentRegistry`, and real `ToolRuntime`; it binds actual Agents through the registry, verifies the managed policy's exact denial before the local probe body, restores the captured configuration, then verifies one newly created Agent is allowed to execute that probe exactly once. The current `tool-policy.js` is copied byte-for-byte into the owned runtime package overlay. Both cases use an owned synthetic profile and local tool/config data; no model turn is started. The skill row explicitly uses `includeDefaultRoots:false` and an empty owned `customSkillDirs` list. This does not exercise the production `SessionController`/Host route, GUI, or an existing user profile.

The feature remains unmounted until a trusted Host supplies the real `ctx`, `profileContext`, `configEditor`, and request-origin gate. It covers only this managed configuration slice, not engine state, provider credentials, conversations, business data, GUI confirmation, or the remaining N03 scope.
