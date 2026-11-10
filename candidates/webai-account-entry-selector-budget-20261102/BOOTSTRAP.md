# DeepSeek first-open bootstrap candidate

This isolated candidate adds a fixed bootstrap path for a fresh, lazy-open DeepSeek provider document whose account menu is closed. Main must already own the provider window and bind the operation to the expected origin, main frame, document generation, and focus. It does not pre-open hidden providers or claim whole-desktop startup authentication.

## Strict evidence source

The strict menu expression is the cooked `DEEPSEEK_ACCOUNT_MENU_PROBE_SCRIPT` template from the UI18 Main source snapshot `candidate/product/ui18-account-trigger-dev-20261102/main-x-normal-quit-r1/after/main.js` (Main source SHA-256 `3a30f6cd9801a78eebfe8d1efd85ec92509912045c8648f6948cbc477b5ebd92`). Its cooked template SHA-256 is `6f34978d2cbfbdf9c667dbaf5c90878b85b16050b72186fb24b00d0886df2712`; the candidate embeds that frozen input.

The existing role gate `[role="menu"].ds-dropdown-menu.ds-elevated`, exact four visible menu semantics, `sameContainer`, and eleven-boolean DTO are preserved. At runtime, the candidate replaces only Main's development `projectConfirmedMenuTrigger` hook with a callback scoped to the current operation's isolated-world map. That callback captures the exact menu element only when the original strict probe reaches its all-four-label branch. It does not call or mutate the R2 trusted-pointer capture and does not write Main's placeholder result key. Locator classes only identify an exact candidate for the one-time action and restoration; they never establish authentication. A class-only menu without the strict role gate remains unknown and is not toggled if already visible.

## Stages and trust boundary

Main invokes fixed isolated-world scripts in this order: `prepare`, `open`, bounded `settle`, `inspect`, `restore`, bounded `settle`, `verify`, and private-token `dispose`. Each call returns to Main, which must recheck the same owned WebContents/frame/document/generation/focus before the next action. `settle` only waits; it does not click or retry. `open` uses one synthetic DOM click and never claims a trusted human gesture. If the action executor fails after the script may have run, the controller can inspect and safely restore, but reports no click receipt. An already-open menu is observed without being toggled.

`inspect` returns strict raw observations only when the strict probe's local menu reference equals the one unique new class-root element held by this operation. Main must pass that raw observation to its existing `sampleAccountMenu()` path while the menu is still open. The injected callback receives a private owner/origin/document/frame/generation/negative-revision ticket and must recheck it before handing the raw DTO to the existing adapter. The callback must not set authenticated directly. After restoration, Main refreshes its existing adapter; its projected state is authoritative. Negative evidence wins late observations. If projector publication throws, restoration still runs. If owner, frame, document, generation, liveness, or focus changes, no subsequent UI action is issued; cleanup only removes the operation token while the same owner/document/frame remains.

Required private Main integration shape (new code for C to add; none of these helper names is an existing API):

```js
createDeepseekAccountBootstrapController({
  readContext: captureOwnedFocusedMainFrame,
  refreshAuthState: () => existingDeepseekAdapter.sample(),
  publishStrictObservation: (raw, ticket) => withOneShotBootstrapRaw(raw, ticket, () => adapter.sampleAccountMenu()),
  executeFixedScript: code => ownedWebContents.executeJavaScriptInIsolatedWorld(21580, [{ code }], false),
  subscribeLifecycle: invalidateOnNavigationOrClose,
})
```

`withOneShotBootstrapRaw` is a new private Main helper, not an exported API or renderer-callable parameter. It validates the ticket, makes the raw observation available to the existing `executeAuthProbe` path for that exact DeepSeek strict script, then invokes `adapter.sampleAccountMenu()`. `executeAuthProbe` must recognize only the original strict script and consume the one-shot raw synchronously before its first `await`, under the current scope and negative-epoch checks. The slot surrounds only the synchronous `sampleAccountMenu()` invocation and is cleared in `finally`; awaiting its returned promise continues through the unchanged R3 sample ordering and negative barrier. The helper never writes auth state. Main's existing projector and negative-epoch barrier remain authoritative; the controller's DTO is not an auth decision.

## Evidence boundary

The two supplied real observations show the same DeepSeek document/generation with the known candidate path open and closed: `deepseek-account-entry-open.json` and `deepseek-account-entry-closed.json` (closed SHA-256 `bd565d619b21bcc873a888eaa031917ea382084f8c45886145eaeb4001ad909`). They do not prove this synthetic action in a live WebContents. The 20-case owned VM suite checks stage behavior, delayed menu commit, strict local identity, restoration, stale scope, negative races, and callback failure. It is not real DOM, SDK, GUI, profile, cold-start, or whole Main acceptance. No candidate source is installed or deployed. Doubao remains out of scope.
