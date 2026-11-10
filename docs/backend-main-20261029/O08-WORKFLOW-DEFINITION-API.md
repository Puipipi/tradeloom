# O08 Canvas workflow definition API

This is a Host-only, durable definition endpoint. It is separate from the local JSON `createWorkflowStore` CAS interface and from `CanvasWorkflowRun`; runs keep their own frozen document and digest. It does not add a current-definition foreign key to run history.

## Access and validation

All methods require the existing private `X-TradeLoom-Native-Bridge` header checked by `_native_bridge_authorized`. Browser cookies alone do not authorize reads or writes. The endpoint accepts no actor or session fields.

The Python API delegates canonical schema validation to `workbench/workflow_definition_validator.mjs`, which imports the existing JavaScript `validateWorkflow` and `createConfirmedWorkflowDefinition`. Python does not reimplement the workflow schema or digest. The bridge uses the existing `TRADELOOM_ARTIFACT_NODE` and `TRADELOOM_ARTIFACT_NODE_SHA256` setting/environment pair, verifies the absolute Node executable against that SHA on each call, uses a fixed helper path, bounded JSON stdin/stdout, `shell=False`, a restricted environment, and an eight-second process deadline. A missing or mismatched Node pin/helper returns `503 workflow_validation_unavailable`; there is no PATH fallback.

Production must configure the trusted Node path and its SHA through the Host/bootstrap settings. This worktree's isolated tests supplied the explicit Node 24.16.0 test-machine executable and SHA; that is test evidence, not proof that a production launcher currently sets the pin.

The endpoint stores the normalized document as ASCII-escaped JSON in a text column. PostgreSQL `jsonb` rejects the legal JSON string value U+0000, while the JavaScript schema permits it. ASCII JSON text preserves NUL, emoji, and lone-surrogate escapes without changing the shared schema or the API's JSON-object shape. The first PG attempt confirmed the `jsonb` failure; the successful implementation uses `TextField` for this one opaque document payload.

## Routes

### List active definitions

`GET /api/canvas-workflow-definitions?offset=0&limit=50`

Only `offset` and `limit` are accepted. Both are nonnegative decimal integers; `limit` is 1–100. Results use stable `workflowId` ascending order and exclude tombstones.

```json
{
  "definitions": [
    {
      "workflowId": "seasonal-flow",
      "revision": 2,
      "definitionRevision": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "document": {"version": 1, "id": "seasonal-flow", "title": "Seasonal flow", "description": "", "source": "manual", "confirmed": true, "nodes": [{"id": "start", "kind": "input", "title": "Start", "instruction": "", "position": {"x": 40, "y": 40}}, {"id": "finish", "kind": "output", "title": "Finish", "instruction": "", "position": {"x": 280, "y": 40}}], "edges": [{"from": "start", "to": "finish"}]},
      "deleted": false,
      "updatedAt": "2026-10-31T12:00:00+08:00"
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50,
  "nextOffset": null
}
```

The placeholder digest above illustrates the field shape; actual confirmed definitions use the shared canonical digest. Drafts have `definitionRevision: null`.

### Get one definition, including a tombstone

`GET /api/canvas-workflow-definitions?id=seasonal-flow`

Returns the same definition DTO. A deleted record remains readable with `deleted: true`, `document: null`, `definitionRevision: null`, and its current revision. Missing IDs return `404 definition_not_found`.

### Create or update

`POST /api/canvas-workflow-definitions`

The body has exactly `document` and `expectedRevision`. `expectedRevision` is an integer (not a boolean) in the JavaScript safe-integer range.

```json
{
  "document": {
    "version": 1,
    "id": "seasonal-flow",
    "title": "Seasonal flow",
    "source": "manual",
    "confirmed": true,
    "nodes": [
      {"id": "start", "kind": "input", "title": "Start"},
      {"id": "finish", "kind": "output", "title": "Finish"}
    ],
    "edges": [{"from": "start", "to": "finish"}]
  },
  "expectedRevision": 0
}
```

For a new ID, expected revision `0` creates revision `1` and returns `201`. Updating an active definition with its current revision increments it and returns `200`. A draft is valid when the canonical schema says `confirmed: false`; its digest is null. A confirmed definition's `definitionRevision` is the shared `sha256:<hex>` content digest and is independent of the integer storage revision.

Stale revisions and concurrent create uniqueness races return `409 revision_conflict`; there is no automatic retry. Updates validate/normalize before entering the row-lock transaction and then compare-and-swap the exact expected revision.

### Delete and recreate

`DELETE /api/canvas-workflow-definitions` accepts exactly:

```json
{"workflowId": "seasonal-flow", "expectedRevision": 3}
```

An active row becomes a tombstone at revision `4`, with `document` and `definitionRevision` set to null. Repeating delete with the tombstone's current revision is idempotent and does not increment it. Listing hides tombstones; detail still exposes them. Recreate must submit the tombstone revision (here `4`), and returns the row at revision `5`. Using `0` after deletion returns `409 revision_conflict`, preventing delete/recreate ABA.

## Stable DTO and errors

Every definition DTO has exactly:

```json
{"workflowId":"seasonal-flow","revision":1,"definitionRevision":"sha256:<64 lowercase hex or null>","document":{},"deleted":false,"updatedAt":"<ISO-8601>"}
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Wrong body fields/types or invalid delete input |
| 400 | `invalid_query` | Unknown, repeated, or out-of-range list query parameter |
| 400 | `invalid_workflow_id` | Invalid detail ID |
| 400 | `invalid_workflow` | Rejected by the canonical JavaScript schema |
| 403 | `native_bridge_required` | Private Host bridge header absent or invalid |
| 404 | `definition_not_found` | No definition row for the requested ID |
| 409 | `revision_conflict` | Stale revision, exhausted revision, or concurrent create race |
| 413 | `request_too_large` | Request exceeds the bounded JSON input |
| 422 | `invalid_request` | Malformed/non-standard JSON rejected by the existing parser |
| 503 | `workflow_validation_unavailable` | Trusted Node/helper unavailable, hash mismatch, timeout, or malformed helper result |
| 503 | `definition_store_invalid_record` | Persisted document text is not valid JSON or does not match its row ID |
| 503 | `storage_unavailable` | Database operation failed |

## Verification evidence and limits

- Node canonical-helper tests: 5/5 pass, 0 skipped; the suite covers JS coordinate rounding/defaults, drafts, unknown fields, numeric document IDs, cycles, and NUL plus emoji.
- Private PostgreSQL 17.11 / Python 3.12.14 acceptance attempt 3: `makemigrations --check --dry-run workbench` exit 0; 28 targeted Django tests passed, 0 skipped; PG stop exit 0 and `pg_ctl status` exit 3. Raw logs and receipt are linked from the O08 recovery `VALIDATION.md`.
- One existing native-artifact regression, `NativeArtifactPgTests.test_committed_list_read_in_independent_python`, was deliberately excluded because it hardcodes a separate legacy port/user/database (`55436` / `artifact_test` / `tradeloom_test_native_artifact_20261027_aNN`). It is not counted as passing, and this API change does not alter artifact code.
- A separate private-PG reopen probe (receipt `o08_definition_reopen_probe.evidence.attempt3.json`) used two independent Python processes with Django's in-process `Client`: the writer rejected a numeric workflow ID with `400 invalid_workflow`, created and updated a confirmed definition through the real Node helper, saved a historical run snapshot from the helper-produced non-NUL document and canonical digest, and checked both stayed unchanged after editing the definition; the reader reopened by ID and matched revision, canonical digest, NUL, and emoji. Both processes and migrations exited 0; PG stop exited 0/status 3. The existing run `JSONField` fixture was non-NUL because run snapshots remain PostgreSQL JSONB; the updated definition itself was verified with NUL.
- The separate reopen probe includes assertions added after the 28-test Django suite; those assertions are evidenced by the attempt-3 writer/reader receipt and are not counted in the 28-test total.
- The PG-backed test runner's private test database used the project's `--keepdb` guard and its explicitly named `tradeloom_test_*` database. The source database, user profile, Django HTTP server, production Host bootstrap, frontend, packaged deployment, and production Node-pin configuration were not exercised.
- The initial JSONB attempt failed on PostgreSQL's U+0000 restriction and is preserved in recovery evidence. The current successful storage format does not change the existing JavaScript workflow schema.
