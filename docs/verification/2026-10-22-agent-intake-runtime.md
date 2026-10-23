# Agent intake tools verification — 2026-10-22

## Scope

This change adds read-only intake discovery and role checks in `packages/tradeloom-shell/business-tools.js`, with regression coverage in `packages/tradeloom-shell/tests/business-tools.test.js`. These are the two product JavaScript files changed for this work.

The tools support the discovery path `tradeloom_intake_sources` → `tradeloom_intake_candidates` → `tradeloom_intake_candidate`. Source and candidate directory results expose bounded metadata and opaque IDs; candidate detail applies the existing schema and provenance checks and reports source coordinates. Directory output omits candidate field values and mapping details.

| Preset | Source metadata | Candidate directory | Candidate detail |
| --- | --- | --- | --- |
| center | Read-only source metadata | All four types; optional type filter | All four types |
| delivery | Read-only | `production_instruction` only | `production_instruction` only |
| product | Read-only | `product_identity` only | `product_identity` only |

Explicit role-incompatible types are refused before HTTP. Requests without a valid session retain `agent_session_required`.

## Automated verification

The complete candidate-8 shell Node test suite passed **171 tests, 0 failures, 0 skipped**. It used the pinned candidate-8 Node 24 runtime and the existing full dependency environment, including the two DOM test environment variables backed by the installed jsdom runtime. The exact command, dependency manifest, and raw stdout/stderr are preserved in the private external test evidence directory; the suite was run once.

An independent narrow-diff review accepted the implementation and the captured full-suite result. No product-code changes followed that review.

## Real Host probe

The latest real Host attempt used the official candidate-8 `runProfile` boot path, an isolated profile/home, a loopback temporary provider, and a separately launched Django process. PostgreSQL reported `default_transaction_read_only=on` on the Django connection, and the temporary Host reached `ready` with the base, web, and business-shell bundles loaded.

The final diagnostic probe failed during the center session with `provider_turn_timeout`. The temporary provider confirmed it sent the complete `tool_calls` SSE sequence and `[DONE]`, and that the response finished and closed. The session emitted `assistant/attempt` with finish kind `error` and safe failure code `INVALID_REQUEST`, then `turn/end` with reason kind `error` and the same code; HTTP status was absent. The agent status was `idle`. No `assistant/message`, `tool/call`, `tool/result`, approval events, or Django intake routes were recorded. The failure was classified as `INVALID_REQUEST` within the LLM/adapter/AgentLoop path, but the trigger remains unknown because human-readable error text was intentionally not read. Real tool execution, HTTP authority, shared candidate discovery, product denial, and live provenance coordinates remain unverified. This attempt is not a real Host pass.

Earlier attempts stopped before Host startup due to probe-only port-check/import defects; their reports remain in the private external evidence directory. The latest run's cleanup confirmed the probe's Django child stopped and no listener remained on the temporary Host or Django ports. Only the pre-existing PostgreSQL listeners remained.

The automated suite validates tool schemas and behavior with the official candidate-8 tool runtime and fixtures. This document does not claim UI, mobile, paid-model, ERP, or whole-project acceptance.

## Local bundle synchronization and application restart

After the probe completed, the existing local sync workflow was run and the official development application was restored. The synchronized bundle hash was `a3b57e3546162aeab6bf77cce23b7d73559ea8b65aedd162513b463d8de13894`; the five profile files were unchanged and the dependency count remained 20. The launcher reported desktop startup, Django and artifacts checks returned HTTP 200, and three expected `data-testid` markers were present.

These are process and HTTP readiness checks only. They do not establish visual correctness, mobile behavior, or successful real Host tool scheduling; the separate real Host probe remains timed out as described above.
