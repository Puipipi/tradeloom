# Intake product candidate application contract

This document is the approved Task 4 implementation contract. The earlier
business-intake implementation plan describes the original intent; it does
not mean that a product-application DTO or endpoint already exists.

## Request

`POST /api/intake/candidates/<candidate_id>/apply` requires the existing
same-origin/CSRF protection and a valid `Idempotency-Key`. The JSON object is
closed and contains only `source_sha256`, `mapping_id`, `mapping_revision`,
`target`, and `fields`. `target` contains an explicitly selected `task_id`,
`product_id` (or `null` for a new product), and the exact expected
`expected_revision_id` (or `null` when no revision exists). Each finite product field
contains `{value, source_fields, note}`. The server fixes the actor to
`local_workbench`.

Only `sku`, `name`, `category`, `material`, `size`, and `color` may be applied.
New products require non-empty human-entered SKU and name; an existing product
may preserve those fields when only another field is updated, but the final
revision must still retain both. Image paths, image filenames, ERP actions, arbitrary
model fields, and other candidate types are not accepted. An empty
`source_fields` list means a manually entered value and requires a note. A
non-empty list must name candidate fields whose values are all `present`; a
width source requires its present non-empty `width_unit`, and a roll-length
source requires its present non-empty `roll_length_unit`. Values and source
links are explicitly supplied by a person; the server does not infer identity
from a style number or join candidates across files. Unfilled Product fields
remain empty and appear in `missing_fields`.

## Persistence and replay

The candidate is bound to its immutable source and exact mapping revision; a
newer mapping does not invalidate it. New products require an explicitly
selected Task. Existing products must belong to that Task and the submitted
expected revision must match the latest revision, including explicit `null`
when none exists. New and appended revisions remain `draft` or
`needs_review`; this operation never confirms a revision. If a Task is already
`confirmed`, the operation returns it to `awaiting_confirmation` so the existing
confirmation gate can inspect newly missing fields; other Task statuses are
preserved. Existing snapshot values, field sources, image references, and prior
revisions are preserved unless a submitted field is explicitly changed.

Application, Product/ProductRevision writes, and the existing
`IntakeOperationReceipt` commit atomically. Lock order is Task, Product when
present, then candidate. Replaying the same key and payload returns the frozen
first receipt. Replaying the same candidate/target/request with a different
key returns that same receipt. A candidate is not globally limited to one
application: a person may explicitly apply it to another target or create
another product variant. A changed request against a stale expected revision
conflicts. Replay lookup occurs before
stale-revision validation so later review or product changes cannot alter the
original response. The frozen response is stored with the immutable revision's
`source_refs`; it does not read mutable current status or missing-field state.

Per-field provenance distinguishes candidate references from manual entries.
It retains candidate/source/snapshot/mapping identifiers, source hash, source
field names, cell locators and formula/cache state, plus the submitted value,
note, and fixed actor. The response reports the product,
revision, non-confirmed status, missing fields, and bounded source references.
This does not create a workflow trace or an ERP order.

## Existing UI and verification boundary

The implementation extends the artifacts/intake candidate detail with explicit
Task and existing Product/revision selection, finite field review, and the
frozen receipt. It does not choose the first Task/Product or submit without a
user action. Only synthetic workbooks and the dedicated PostgreSQL test cluster
are used for implementation tests; the four real source files are not
imported.

### Implementation status (2026-10-24)

The candidate-application endpoint, frozen receipt/history projection, and
explicit artifacts-page review form are implemented in this worktree. The
PostgreSQL regression run covered `workbench.tests.test_intake_product_application`,
`workbench.tests.test_intake_api`, `workbench.tests.test_intake_mapping`,
`workbench.tests.test_product_library_api`, `workbench.tests.test_legacy_compat`,
and `workbench.tests.test_pages`: 69 tests passed, with no skips. The dedicated DOM suite for
`workbench/tests/js/test_intake_product_application.js` passed 6 tests,
including existing-product revision targeting, stale asynchronous product
responses, and pending-to-receipt rendering through actual form submission.

These results are focused automated evidence, not full application acceptance.
No real workbook was imported, and this worktree has not been deployed or
exercised through the GUI. Four-source human confirmation,
phone-sized layout, and end-to-end behavior outside the synthetic PostgreSQL
and DOM test environments remain unverified.
