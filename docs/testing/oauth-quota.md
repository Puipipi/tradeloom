# OAuth subscription quota

The context usage sheet can request the selected Codex or Claude subscription
quota from the active engine. These percentages describe account-level rolling
windows, not the current conversation token count, API balance, or a fixed number
of remaining messages. Reset timestamps are rendered in the device local time.

## Integration and security

- `appAuth/usage {provider}` supports `openai-codex` and `anthropic`.
- The engine reads its existing OAuth grant; it never returns access or refresh
  tokens to the Dart client. It does not refresh or rewrite credentials.
- Requests go only to fixed HTTPS vendor hosts, with redirects disabled, a
  timeout, bounded response size, and no upstream error body in the RPC reply.
- Absent, rejected, expired, inaccessible, and malformed data must never become
  zero-percent usage. Replacing or removing a grant while a request is pending
  must discard that request result.
- Both HTTP usage endpoints are undocumented and may change or reject access.
  In particular, Anthropic restricts unapproved third-party Claude OAuth use;
  endpoint availability is not evidence of permission or compliance. This
  change does not alter the existing sign-in flow or claim official support.
- Remote connections query the remote engine account, not the phone account.
  Older engines without this method must remain usable.

## Validation checklist

On remote CI, regenerate localization with the repository localization script
and run the scoped auth-bridge, subscription-client, and usage-sheet tests.
Run normal CI checks for affected packages; do not run a full build or test suite
on the user phone without separate authorization.

Before release, verify on a real device using an authorized test account:

1. Select DeepSeek, Codex OAuth, Claude OAuth, and an API-key route in turn.
   Verify that the account section matches the selected route.
2. Compare displayed window percentages and reset times with the vendor usage
   page for the same account; do not infer a weekly window solely from its slot.
3. Verify loading, manual retry, local expiry, 401, 403, 429, malformed response,
   and offline states without exposing credentials in UI or logs.
4. Switch engine, sign out, or change accounts while a request is pending.
   No previous account quota may be displayed for the new account.
5. Connect to an older engine without `appAuth/usage`; verify the context/token
   sections still work and quota is shown as unsupported or unavailable.

## Local validation record

Completed source-only checks: `git diff --check`, Node syntax checks for the auth
bridge and mock test sources, and `python3 app/tool/l10n_merge.py --check`.
Localization was generated through the repository script using the existing
ARM64 Flutter wrapper, then formatted to the project width of 120 columns.
No app compilation or test runner was invoked. The initial x86-64 Flutter entry
could not execute on this ARM64 device; the native wrapper completed successfully.
Scoped Dart formatting also parsed the changed source and widget test files.
It reported unresolved lint-package includes because this isolated worktree has
no resolved package configuration; this is not a Dart type-analysis or lint pass.

## Remote CI record

The source-only implementation did not run tests on the phone. Remote CI for
`37dc9884e8c735bb9853ba16963df9972b6e3da2` ran at
https://github.com/ccch1mneyyy/dsh-Go/actions/runs/42872439645 .
Dart packages, Runtime and bridge, Android JVM, generated resources/tooling, and
Flutter shard 1 passed. Flutter analysis and generated-localization consistency
also passed. The new subscription state regression passed in shard 2.

The overall workflow failed on four existing tests: `notice_action_test.dart`,
`phone_floating_bar_test.dart`, and both language cases in `guide_nav_test.dart`.
The same four failures are present in the unmodified baseline `8f31b2ed` run:
https://github.com/ccch1mneyyy/dsh-Go/actions/runs/42782302996 .
This is not a claim that the full CI suite is green. The initial feature run also
found two internal-member warnings in deliberate retained-AsyncValue test fixtures;
those were annotated locally in the test and the next analysis pass succeeded.

Real-account queries, APK builds, and device validation have not been performed.
