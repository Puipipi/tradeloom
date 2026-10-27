# Native web AI ask controller

`ask.ts` owns the shared orchestration only. The caller injects an adapter bound
to an already-owned Electron `BrowserWindow`; the controller does not create a
window, select a website, log in, make HTTP/API calls, or inspect Electron state.

## Adapter contract

- `inspect(signal)` returns current login/composer/answer readiness, current
  draft and attachment count, plus visible message rows. It must report actual
  DOM values and honor cancellation.
- `send(question, signal)` is called only after the controller confirms an empty draft
  and zero attachments. It must recheck that condition immediately before
  sending atomically with the send gesture, add the question, preserve unrelated
  user content, honor cancellation, and return the actual new user-turn DOM key.
  If cancellation rejects, the send side effect must already be stopped. It
  must not clear the composer as cleanup.
- `inspect()` must associate the assistant row with that exact `turnId`. The
  controller snapshots existing message IDs and turn IDs before send, rejects a
  reused turn ID, and ignores message IDs/turn IDs present in that snapshot. If
  the site exposes no reliable turn correlation, the adapter must fail rather
  than guess.
- Login and selector/readiness failures are explicit. It must never simulate
  login or use an unauthenticated/undocumented HTTP model endpoint.

Calls on one controller (one provider/window) queue in FIFO order. Queue wait
does not count against `timeoutMs`; that active deadline starts when a request
leaves the queue. Cancellation while queued returns immediately and the queued
request is skipped when its turn arrives. Create one controller per site to
allow different providers to progress independently. `firstChunkTimeoutMs`
starts after the send adapter confirms submission. The `first-chunk` callback
means non-empty text appeared; the result resolves only when `generating` is
explicitly `false` and the same answer text remains stable for `stableMs`.
Unknown generation state is never treated as complete. Timeout, first-chunk
timeout, cancellation, and a closed window have distinct bounded error codes.
Answer, prompt, and timing options have fixed integer/length limits. Result
source fields are the injected provider ID and fixed origin. Phase observer
exceptions are ignored so they cannot cause an already-submitted request to be
retried.

If a send times out but its adapter promise has not settled, the current call
returns its timeout error while the controller keeps its site queue locked.
Later sends wait until that adapter operation settles; the controller never
assumes an uncooperative send has stopped.

## Verification

Run in the repository checkout with Node 24+:

```powershell
node --experimental-strip-types --test integrations/dsh/native-ai-web/ask.test.mjs
```

The tests use a fake adapter and prove orchestration behavior only. They do not
prove that any live website selectors, login state, send gesture, turn
correlation, or answer extraction work.

The controller also passed strict TypeScript `noEmit` checking with the
runtime-16 TypeScript compiler; see [TYPECHECK-RESULTS.md](./TYPECHECK-RESULTS.md).
The proposed native assistant-to-main-process boundary is documented in
[BRIDGE-CONTRACT.md](./BRIDGE-CONTRACT.md). The protocol is not implemented.

`diagnostics.ts` adds a separate fixed-code, read-only DOM metadata probe.
Its controlled Electron fixture and strict TypeScript evidence are recorded in
[DIAGNOSTICS-RESULTS.md](./DIAGNOSTICS-RESULTS.md). This does not inspect real
site DOM or mean the probe is wired into the app; a future main-owned manager
and fixed export action in the existing Web menu remain necessary. The frontend
must control which owned window is foreground.

## Integration still required

1. Add a reviewed site adapter for each fixed provider, using selectors
   verified against that site at integration time. The only supplied live DOM
   evidence is Doubao's input selector
   `textarea[data-testid=chat_input_input]` (placeholder `发消息...`) and login
   button `data-testid=to_login_button`; there is no evidence here for its send
   or answer selectors. No selector is asserted by this module.
2. Bind that adapter to the existing owned `BrowserWindow` and its lifetime;
   route the native assistant tool request to this controller.
3. Run a consented, manually authenticated per-site end-to-end check, recording
   input preservation, actual turn correlation, first chunk, stable completion,
   and returned source. DeepSeek live/profile was not touched in this work.
