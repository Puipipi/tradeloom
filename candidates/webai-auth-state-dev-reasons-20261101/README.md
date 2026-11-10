# WebAI auth development reasons candidate

This is a separate development-only candidate based on the frozen
`webai-auth-state-20261101` source. Its before file is the unchanged 26841
candidate (`26841E98D9FD1FFC622000B19AC77512295CFB926D939263EEF14AA74BD02413`).
The complete after module is SHA-256
`2154C6FAA69A544DF9422F48192EEAE7054125776C4D43DFE456FBDCDBB666D1`.
The original candidate and its test evidence remain untouched.

## Change boundary

Only `sampleDeepSeekMenuDevelopment()` and the fixed DeepSeek development probe
return the additional safe diagnostic fields. `getState()`, `sample()`,
`sampleAccountMenu()`, their production-facing DTOs, provider selectors, scan
budgets, and authentication decisions are copied unchanged. A menu match never
produces `authenticated`; these diagnostics do not establish authentication.

The development DTO adds a fixed `reason`, `budgetKind`, and bounded counters:

- `rootCount` is capped at 33, where 33 means “over the 32-root limit”.
- `visitedNodes` is capped at 512.
- `processedRoots` is capped at 32.
- `budgetKind` is one of `none`, `per_root`, `total_nodes`,
  `direct_children`, `children`, or `stack`.
- `reason` is one of `matched`, `no_same_container_match`, `roots_missing`,
  `roots_over_limit`, `traversal_budget_exceeded`, `probe_error`,
  `document_identity_unavailable`, `unsupported_origin`,
  `generation_changed_or_disposed`, `document_changed`,
  `projection_rejected`, or `adapter_unavailable`.

The probe reports missing/over-limit roots and traversal budget exhaustion
inside its fixed script. `no_same_container_match` can include the already
allowlisted partial-label booleans, but does not claim a login state. The
adapter supplies fixed reasons for missing/unsupported host identity, thrown
probe execution, generation invalidation, changed document identity, and a
rejected projection. Counters do not expose raw DOM sizes beyond the fixed
caps. No original exception, DOM text, URL, account value, or message is
returned.

## Files and focused evidence

- `before/webai-auth-state.js`: byte-identical frozen 26841 source.
- `after/webai-auth-state.js`: complete candidate source for review/transfer.
- `webai-auth-state.js`: same after source for direct module import.
- `webai-auth-state.d.ts`: development DTO reason/count types; normal auth DTO
  is unchanged.
- `webai-auth-state.patch`: one-file patch with `a/webai-auth-state.js` and
  `b/webai-auth-state.js` paths.
- `recovery-20261029/webai-auth-state-dev-reasons-20261101/testing/`: isolated
  copy of the prior fixture suite plus reason and bounded-counter cases. It is
  not a real webpage or live WebContents test.

The final focused run passed 26/26 tests with exit 0. The first run was 24/26:
one fixture expected the stack budget before the per-root cap, and one used a
nonexistent lifecycle event name. Those fixture mistakes were corrected; the
original failed output is retained separately. `node --check` also passed.

## Minimal transplant map

For a separate development build, the changed pieces are limited to the fixed
probe constant at `webai-auth-state.js:129`, the fail-closed dev DTO constructor
and validator at `:279` and `:289`, and the adapter method at `:478`. Its
public fixed-script accessor is at `:527`; the matching types are
`webai-auth-state.d.ts:43-81`.

The method also relies on the existing, unchanged adapter closure: provider,
`executeReadOnlyProbe`, generation/disposed state, `documentIdentity`,
`sameDocument`, and `invalidate` (`webai-auth-state.js:333-410`). Copying only
the method will omit those bindings. Keep the original `sample()`,
`sampleAccountMenu()`, `getState()`, and normal `authState` projection unchanged
(`:427-477`); the development reason DTO is a separate return value.

## Transfer boundary

This candidate is not deployed and has not sampled the live UI. It only adds
temporary diagnostics for discovering why a bounded probe returns unknown.
Keep it separate from normal auth-state wiring and remove the development method
and fields after the real DOM root is understood. Do not change the original
26841 frozen candidate in place.
