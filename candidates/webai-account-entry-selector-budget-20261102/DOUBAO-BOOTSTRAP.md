# Doubao lazy-open account bootstrap candidate

This is an isolated backend-side candidate for a fresh, lazily opened Doubao provider document. It is not installed and does not claim live WebContents or native acceptance.

## Fixed entry and scope

The fixed locator requires exactly one visible `nav,[role="navigation"]` root and exactly one visible button matching:

```css
button[aria-haspopup="menu"].min-w-0.flex-1.w-full.flex.h-48.items-center.border-0.bg-transparent
```

Navigation roots are bounded at 32 and shaped button candidates at 64; overflow or ambiguity fails closed. Other popup buttons do not count as the fixed entry, but another button with the full shape makes the candidate ambiguous. This shape is only an entry locator. The real Doubao evidence showed popup-only ambiguity, and the full-shape count has not been independently established in a live native run; do not describe this candidate as proving native uniqueness.

If the menu is already visible, the operation observes it without toggling it. Otherwise it dispatches one synthetic `pointerdown`/`pointerup` pair (`button: 0`, mouse, `ctrlKey: false`, down `buttons: 1`, up `buttons: 0`). It never calls `.click()`, retries, or claims a trusted human gesture. It then waits a bounded interval, samples the original Main strict probe, restores only the same menu through the same entry if scope and identity still match, and verifies closure. A failed or unknown action does not establish authentication.

## Strict authentication and adapter handoff

The embedded cooked source is the current Main `DOUBAO_ACCOUNT_MENU_PROBE_SCRIPT` template, SHA-256 `a7242fbc1a4971e571c912a87c72befda38af9df86c83f9659a95a85d1c7b020`, from Main source SHA-256 `3a30f6cd9801a78eebfe8d1efd85ec92509912045c8648f6948cbc477b5ebd92`. The ten-field raw DTO is preserved: `menuVisible`, `addAccountVisible`, `logoutVisible`, `sameMenu`, `accountMenuLinkedVisible`, `triggerPresent`, `triggerVisible`, `hasPopup`, `linked`, and `shortcutAttributePresent`.

The runtime substitutes only the development trigger-capture hook with an operation-local hook. It captures only when the original strict probe has reached its same-menu/add-account/logout/linked-trigger branch and `trigger === entry`; it does not read or consume the R2 pointer capture slot and does not write the global placeholder result key. The entry shape and pointer pair are never auth evidence. An explicit unauthenticated result from the existing adapter blocks all entry actions and wins any late positive observation.

Main must route `publishStrictObservation(raw, ticket)` through a new private asynchronous one-shot binding around the existing `adapter.sampleAccountMenu()` call. That call awaits the existing negative-evidence check before it reads the menu, so a synchronous slot like the DeepSeek integration is insufficient. The private binding must be scoped to this operation and exact Main owner/frame/document/generation, consumed only by the matching fixed strict probe, and revalidated against the adapter's negative epoch before the original projector commits. It must not expose a renderer API, accept caller-provided scripts/selectors, or set auth state itself. This async Main adapter is not implemented by this candidate.

The controller's callbacks must capture the already-owned, foreground WebContents and execute only its fixed scripts in Main's fixed isolated world `21580`; the world is not renderer-supplied. Recheck owner, main frame, origin, document generation, liveness, and focus around every awaited stage. Lifecycle invalidation prevents later actions; disposal removes the operation-local isolated-world record when the same document remains. A stale operation must never act on a replacement document.

## Candidate interface

`createDoubaoAccountBootstrapController({readContext, refreshAuthState, publishStrictObservation, executeFixedScript, subscribeLifecycle})` provides `run`, `observeNegative`, `invalidate`, and `dispose`. `doubaoAccountBootstrapStageScript(stage, operationId)` yields only fixed stage scripts; `operationId` is an opaque Main-generated token. `publishStrictObservation` receives the preserved ten-boolean DTO and a private freshness ticket. The candidate returns a separate operation result and never replaces or mutates the production auth DTO.

## Evidence boundary

The owned VM suite verifies the transaction and adapter callback contracts using synthetic DOM and callbacks. It is not a live Doubao DOM, Main integration, native click, account, cold-start, GUI, or installed-package test. The real observations supplied for this task support the candidate selector and strict DTO source, but no real-profile or live-window action was performed by this candidate. Do not infer production readiness from a visible account menu, class match, pointer event, or this fixture.
