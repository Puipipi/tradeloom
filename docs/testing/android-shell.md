# Android Shell validation

Scope: independent Shizuku UserService and local self-ADB command backends, phone MCP `android_shell`, separate Flutter configuration/authorization, owner-scoped cancellation and bounded output. Based on `origin/main` commit `1c5b220093295f8d069f6bfb06d8b4fc97b9e9c2`.

## Executed on 2026-11-09

- Flutter dependency resolution used the original lock: `FLUTTER_ROOT=/root/dev/flutter-arm64 PUB_HOSTED_URL=https://pub.dev /root/dev/dart313/dart-sdk/bin/dart pub get --enforce-lockfile`. Dependency lock files have no final changes.
- `flutter analyze --no-pub`: passed, no issues. Used the existing ARM Flutter wrapper and ARM tester, not the unusable x86_64 Dart binary.
- `DSH_TEST_FONT_DIR=/root/.cache/dsh-test-fonts flutter test --no-pub test/phone/android_shell`: 21 passed. One real form bug found by widget tests was fixed: submit now reads/validates current pairing code and port instead of a build-time snapshot. The original exact port assertion remains; a queued-submit invalid-port regression was added.
- Focused JVM source tests with Kotlin compiler 2.2.0 / JVM target 17 / JUnit 4.13.2: 26 Core/schema tests passed (19 Shell/Core and 7 existing schema tests).
- Native protocol/job/environment tests: 27 passed, using the real production `ShellProtocol`, `ShellJobCore` and `ShellEnvironment`, with no Android or backend fixture replacing these classes.
- Process-launch source guard: 13 passed, including a new restriction to exactly the reviewed app_process/sh constructors and two INHERIT descriptor references. This narrows the new file-level exception rather than allowing arbitrary future launch sites. Total focused JVM tests: 66.
- Native Kotlin type check against the real API 36 Android jar, Shizuku api/provider 13.1.5, libadb-android 3.1.1 and declared Bouncy Castle dependencies passed. Bundle.get deprecation is a compatibility warning, not a compile failure. This is not full App compilation.
- `python3 app/tool/l10n_merge.py --check`, `python3 app/tool/guide_sync.py --check`, and `git diff --check`: passed. Flutter localizations and embedded guide assets were generated from their inputs.

The focused Core JVM compiler used exactly one explicitly documented compilation-only boundary fixture: `RuntimeController.PhoneSkillOrigin`, mirroring the real runtime/generation/root fields. Its constructors throw and these tests never instantiate it. Core, Tasks, SafetyGate, workers, session leases, parser, catalog and skill logic were compiled from the real sources. This does not validate RuntimeController or replace the full Android build.

## Actual Android executor probe

`AndroidShellDeviceProbe` is a standalone app_process entry under `src/androidTest`. It runs only synthetic commands at shell UID 2000, without installing an APK, requesting permissions or modifying system settings. Production Shell sources plus the probe were compiled against real Android/library jars and converted with D8 for execution through ADB.

Final result: `ANDROID_SHELL_PROBE_OK tests=5 uid=2000`, exit 0:

1. Separate stdout/stderr and the actual exit status 7.
2. UTF-8 Chinese and supplementary-plane text.
3. Concurrent 90,000-byte streams: successful exit, shared 64-KiB cap, explicit truncation, continued draining and stable completed snapshot.
4. Native deadline termination.
5. Cancel running work and reject a start whose id was already cancelled.

The device probe caught a real helper-startup failure: clearing the environment removed Android boot classpaths, leading to exit 134 before the ownership handshake. Only the helper now receives the platform BOOTCLASSPATH/DEX2OATBOOTCLASSPATH (with boot-classpath property fallback) and its trusted CLASSPATH. The final user sh still receives the minimal environment without helper boot paths, CLASSPATH, LD_* or engine credentials. Four pure environment regressions cover this.

RuntimeInit redirects System.out/err to Android logs; the probe reports through FileDescriptor.out so assertions are visible to ADB. An early console-only Killed/137 was not treated as proof of a ROM restriction or of successful cancellation. Temporary probe jars were removed afterward. Cancellation is not rollback and deliberately daemonized/session-escaped children remain outside this V1 job model.

## Review findings resolved

- Backend/UID must match as a pair; ADB/UID0 is not accepted.
- Strict integer timeout and exit-code receipts reject strings, fractional values and integer-overflow coercion.
- START is fenced again in the RPC worker immediately before sending; lease revocation and the sent receipt are linearized.
- Completed output is frozen; incomplete reader shutdown retires the host/link rather than allowing late output into a later job.
- Shizuku liveness uses local isBinderAlive, not synchronous pingBinder before the timed RPC. Static review confirmed the correction; no live-service freeze fault injection was performed.

## Existing visual regression run

A combined run of `phone_screen_test.dart`, `phone_confirm_mode_test.dart`, `phone_channel_test.dart` and `phone_golden_test.dart` finished with 51 passed / 28 failed. All reported failures were pixel comparisons in the golden suite; examples were 7 pixels in phone_main_dark and 24 in phone_main_light (reported 0.00%). Unmodified guide/unlock pages also failed. The masked image was inspected: sparse pixel differences appeared across the background. No golden baselines or tolerances were changed. The cause was not independently established against an unmodified checkout, so this run is **not passed** and must be rechecked in the baseline rendering environment. A separate run of `flutter test --no-pub test/phone/phone_screen_test.dart test/phone/phone_confirm_mode_test.dart test/phone/phone_channel_test.dart --reporter expanded` passed all 49 tests. Together with the 21 new Shell tests, 70 nonvisual Flutter tests passed.

Temporary compiler artifacts, fixtures and golden failure images were archived outside the repository under `/root/.cache/dsh-android-shell/session-20261109/`; they are not production deliverables or staged files.

## Full APK / remaining release gates

Actual command `tooling/build-apk.sh --debug --keep-daemon` reached Gradle and failed while configuring the Android project: NDK `28.2.13676358` was missing and its SDK license was not accepted. No license was accepted on the user’s behalf. No APK was generated or installed. The Gradle daemon started for this attempt was stopped.

The following are **not** established by the tests above:

- Full debug/release APK compilation or release/R8 behavior.
- The native settings MethodChannel and complete Shizuku grant/deny/revoke/bind lifecycle on an installed new App.
- Complete App-managed wireless-debugging pairing, discovery and reconnection, or coexistence with an active background-display channel.
- Root/Sui, other Android versions/OEMs, work profiles, reboot recovery or intentional daemon escape cleanup.

Before release, build with the required accepted SDK/NDK, install through the normal user-controlled update path, and exercise these gates. Do not label a standalone shell-UID executor probe as complete Shizuku/self-ADB App validation.
