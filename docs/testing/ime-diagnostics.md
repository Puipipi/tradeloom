# Input-method diagnostics verification

## Scope

This change improves opt-in system input-method evidence collection; it does not claim to fix keyboard dismissal or issue #366. Retained events are memory-only and bounded, and exclude editor contents, candidates, cursor positions, keystrokes, and session identifiers. A logged show/hide request is not proof of actual keyboard visibility. This change does not instrument the chat editor or collect per-keystroke observations.

The optional system capture requires separate native consent on every attempt. It reuses an already selected and live privileged channel; it must not start a privileged service, grant READ_LOGS, run an arbitrary shell command, create a virtual display, inject input, or change the selected phone-control mode. Only fixed recent IME events associated with this app may leave the privileged parser. Raw log lines must not enter the engine, the diagnostic export, or an AI prompt.

## Integration status

The native `dsh/diagnostics` methods `collectSystemIme` and `cancelSystemIme` are exposed through Settings > Diagnostics. Captured evidence is included only in a user-requested local-AI snapshot or diagnostic ZIP. The implementation lives in a separate worktree to avoid an unrelated concurrent editing session. No APK has been installed or tested on the user's phone; after the user requested no further local compilation/tests, generation and build/test verification are delegated to remote CI.

## Native interface

- Channel: `dsh/diagnostics`. `collectSystemIme` takes no parameters and always requires a fresh native consent dialog. `cancelSystemIme` takes no parameters and returns null; call when the owning screen/request is abandoned. Cancellation does not revoke the user's existing phone-control permissions.
- Result: `{ok, code, capturedAt, source, events}`. `capturedAt` and each event's `timestamp` use epoch milliseconds. `source` is `privilegedIme`. Each event has only `{timestamp, event, fromUser, reason, origin}`; `fromUser` may be null. Never infer false from unknown.
- The logcat header accepts Android epoch timestamp padding. All accepted events must be emitted by the current app PID, including ImeTracker: a package name inside a log message is not producer authentication. System/IME-process messages are deliberately excluded rather than attributed from text alone.
- Events: `requestShow`, `requestHide`, `connectionClosed`. Origins: `imeTracker`, `inputMethodManager`, `inputConnection`. Reasons are a fixed Android allowlist or `unknown`, not arbitrary log strings. A show/hide request is not proof of actual keyboard visibility.
- Codes: `ok`, `noEvents`, `unavailable`, `unsupported`, `denied`, `cancelled`, `busy`, `timeout`, `limitExceeded`, `failed`. Only `ok` and `noEvents` have `ok: true`; non-success results carry no partial events. An old core's unknown-operation response becomes `unsupported`.
- The fixed logcat command reads at most 1,000 retained entries for selected tags, with a 128 KiB read budget and a 1.5-second logcat-process deadline. The parser retains at most 64 known events in the preceding 120 seconds. Lines older than that can be read transiently but cannot be returned. Unknown/malformed/oversized/unassociated rows are discarded.
- Manual publication atomically writes only the fixed `diagnostics-manual.md` report; automatic connection refreshes atomically write only `diagnostics.md`. Each request has one target, so a failed manual write cannot partially publish its evidence into the automatic report. The support skill checks both timestamps so an old manual report cannot be mistaken for current evidence. No client-supplied filename is accepted.
- The Dart consumer must revalidate the response shape, make retained evidence and clearing visible, cancel abandoned requests, guard against late results after clearing, and include evidence only in a deliberate local-AI snapshot or export. An updated skill alone is not proof that an older installed APK supports this interface.

## Automated checks

Lead independently compiled `SystemImeEvidence.kt`, `SystemImeLogcat.kt`, the existing phone-prompt policy/framed-session dependencies and three JUnit test classes with Kotlin 2.2.0 (`org.jetbrains.kotlin.cli.jvm.K2JVMCompiler`), then ran:

```sh
java -cp "$OUT:$TEST_CP" org.junit.runner.JUnitCore \
  io.github.ccch1mneyyy.dsh_app.diagnostics.SystemImeEvidenceTest \
  io.github.ccch1mneyyy.dsh_app.diagnostics.SystemImeLogcatTest \
  io.github.ccch1mneyyy.dsh_app.phone.PhonePromptTest
```

Result: exit 0, **47 tests passed**, on Linux ARM64 with JUnit 4.13.2. `OUT` is the temporary compiled-class directory; `TEST_CP` contains the Kotlin standard library, JUnit, Hamcrest and the Android API jar used to type-check the existing framing file. Tests cover allowlisted parsing, old/new Android message shapes, app association, nullable user attribution, malformed/stale data, consent cancellation/reuse, byte/event limits, nonzero process exit, timeout cleanup and existing phone-prompt policies. The additional framed-session test only verifies consent-token revocation and a subsequent exchange; it does not execute Android `SystemImePrompt.finish()` or prove the full UI cancellation path. No real system logs were read.

The native-only tests above ran during the earlier implementation phase, before the user prohibited further phone-local compilation/testing. No further local build or test is used for the integrated change. Remote CI results will be recorded in the PR. Native permission/transport validation and device IME verification have **not run**. JVM tests are not device permission or transport tests.

## Required device checks (not yet run)

Use test-only draft text and review all exported files before sharing. Cover Android 12 and a newer Android version: ImeTracker availability and vendor logging differ.

1. Merely entering Diagnostics must not collect system evidence. The user requests a capture and confirms a separate native scope/consent prompt. Verify retained known events and timestamps with no draft text or selection data.
2. Verify event/time limits, repeated attempts, clearing, app restart, and callbacks arriving after cancellation. Clearing memory must not claim to delete snapshots or archives already created.
3. Refresh diagnostics for the local AI and export a ZIP manually. Confirm bounded events and limits in both. Automatic background snapshot publication must not silently include opt-in captured events.
4. With no configured/live privileged channel, system capture reports unavailable without requesting or changing permissions. With a live Shizuku/Sui/ADB/root channel, check that merely entering Diagnostics does not collect system events. Test each supported transport separately.
5. Cancel the native system-capture prompt, press Back, leave the app, rotate, lock, and detach/recreate the Activity. No cancelled capture result may be retained or exported. Cancellation must not interrupt or close a shared ADB/root exchange: an incomplete frame retires that channel and could interrupt phone control. An already executing bounded privileged read may need to reach its own deadline; discard its reply and do not replay it. If the shared transport itself stalls before the core can reply, the one in-flight worker remains busy; do not spawn retries or interrupt the shared exchange. A later completed exchange or an explicit user-led app restart is required for recovery. Check busy behavior during a phone-control task. The preflight check is best effort, not a global task reservation: a task starting immediately afterwards may briefly wait for the already approved fixed read on the shared serialized channel. Diagnostics never takes or changes its display lease.
6. Confirming the native prompt permits one fixed read, not continuing monitoring or persistent log access. The user must confirm again on the next attempt. The consent dialog can make Flutter inactive without backgrounding the Activity; that must not revoke approval. In visible multi-window mode, switching focus alone also does not revoke the approved read. Background/route exit/clear still cancel, and export remains a separate deliberate user action.
7. Check matching app ImeTracker requests and legacy app-PID InputMethodManager/input-connection events. Reject other apps, malformed lines, stale/future timestamps, unknown messages, oversized input, and injected text containing method names. Unknown fromUser is null, never fabricated false.
8. Force channel loss, an old privileged core, permission denial, timeout, and an empty supported-log window. Show stable failure/empty codes. No events is not proof that the keyboard behaved correctly.
9. Inspect the ZIP and local-AI snapshot for raw lines, package/PID identifiers, free-form exception messages, credentials, and editor content. Confirm no diagnostics are uploaded automatically.

## Follow-up candidates

Separately evaluate native own-window IME visibility/window focus, hardware-keyboard configuration, own-process historical exit reasons (API 30+), memory pressure, power-save state and validated-network transport. Keep unavailable facts unknown and omit crash traces/descriptions and network identifiers by default. General bugreports, unrestricted logcat, and application inventories are not part of this change.
