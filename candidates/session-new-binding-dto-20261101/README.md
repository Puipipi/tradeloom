# `/tradeloom/session/new` binding DTO candidate

## Change

This candidate changes only `host.js` in the frozen `@tradeloom/dsh-business-shell` package. A successful create now returns the committed role binding as `binding`, alongside the existing `role`, `sessionId`, `operationId`, and `bindingRevision` fields:

```json
{
  "role": "center",
  "sessionId": "session-<operationId>",
  "operationId": "<operationId>",
  "bindingRevision": "17",
  "binding": {
    "scope": "role",
    "roleId": "center",
    "sessionId": "session-<operationId>",
    "workspaceId": "<committed-workspace-id>",
    "bindingRevision": "17",
    "archiveState": "unarchived"
  }
}
```

The DTO is made with the existing `roleBindingMetadata` helper inside the same state transaction that replaces the role binding. It reflects the state that was committed; it does not trigger another read. No route, request fields, persistent operation fields, create behavior, or error semantics change.

Completed operation replay remains HTTP 200 with `replayed: true`. It returns metadata reconstructed from that completed operation's original role/session/workspace/revision fields when those persisted fields are available. A legacy completed operation with no stored revision may omit `binding` if the role has since changed; the handler will not borrow the newer revision. A later role binding is never paired with the earlier session, and replay does not change current role state. Conflict and `session-create-outcome-unknown` responses remain errors and carry no `binding` field.

This replay DTO is historical operation metadata, not proof that the role is still bound to that session. The current `client.js` consumer validates role/session identity but does not compare `bindingRevision`. A future consumer must correlate the operation ID, role, and returned revision, then read and compare the trusted current binding before switching its local session; a historical 200 response alone must not switch a newer binding backwards.

## Candidate application

`before/host.js` is the byte-identical frozen R5 file. `after/host.js` is the proposed replacement at:

`resources/tradeloom/business-shell/host.js`

The before SHA-256 is `546FE96504062C4337AC597D678A80A1F29F0F20B6A843F722EBECCF2F39A463`; the after SHA-256 is `2AB2225D0F26862B9FB8EC8C9B6AEC66EF472493860653E072254FEC9CE207F8`.

`patch/host.patch` uses `a/host.js` and `b/host.js` relative to the business-shell package. The owned fixture check with `git apply --no-index --check` passed; it did not apply the patch to the frozen package.

The frozen deployment manifest is `resources/tradeloom/deployment.json`; its `resources.businessShell` object contains only `root`, `name`, `version`, `fileCount`, `bytes`, and aggregate `sha256`. `host.js` is one of the 55 files declared by the package's separate `package.json.files` list; with `package.json`, the physical package inventory has 56 files. The inspected original manifest entry is 56 files, 2,564,639 bytes, aggregate `2a2d11219269da0e9e54e2fbb22562743b3ce3bf90e7b882f4e0b4a4ff242f14`. Substituting only this candidate `host.js` yields a read-only preview of the same 56 files, 2,566,284 bytes, aggregate `c3b44072a7d7c7814c8d85834db8d6ed3caec48cee9e42d66590840312c22e51`; the other 55 physical files remain unchanged. This is an expected value only, not a deployment. Do not apply this patch to the Django `resources.business` inventory.

The official `stageBusinessShell` implementation in `apps/tradeloom-launcher/stage-desktop.mjs:182-200` enumerates `package.json` plus the package's 55 declared files into temporary per-file records containing path, byte length, and SHA-256. It writes only aggregate fields (`fileCount`, `bytes`, `sha256`) to `deployment.json.resources.businessShell`; the manifest has no per-file `files` array, and this change must not add one. The aggregate is produced by `installed-bootstrap.mjs:87-90`: sort paths with `localeCompare(..., 'en')`, concatenate `path + NUL + decimalBytes + NUL + lowercaseFileSha256 + LF` as UTF-8, then SHA-256. `installed-bootstrap.mjs:241-258` separately reads `package.json.files`, reconstructs per-file records at verification time, and verifies the aggregate and absence of extra files.

No deployment or manifest was changed here. For a future frozen R5 candidate, first require its `host.js` hash to equal before SHA `546FE96504062C4337AC597D678A80A1F29F0F20B6A843F722EBECCF2F39A463`; review any difference instead of overwriting it. Replace only `resources/tradeloom/business-shell/host.js` in a new frozen candidate copy. Preserve the other 55 physical package files and keep manifest `root`, `name`, `version`, and `fileCount` unchanged; update only the existing `resources.businessShell.bytes` and `resources.businessShell.sha256` values. Preserve all other resource entries and all `sourceBuild`/SDK receipt fields. Do not add a manifest `files` array, stage the latest main package over frozen R5, hand-edit inventory details, reuse the Django backend digest, or alter SDK receipts. The complete deployment assembly hash must be computed by its owner after assembly.

## Evidence

The focused owned-state handler tests and syntax checks are in `recovery-20261029/session-new-binding-dto-20261101/`. They exercise a fixture `createStateStore` under a marked temporary home; they do not call a running Host, create a real SDK session, modify the frozen R5 installation, or test GUI adoption.
