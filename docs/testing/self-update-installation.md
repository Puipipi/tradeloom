# Self-update route verification

Scope: trusted local implementation on feat/self-update-transports, based on origin/main 3edc945fcdd950bd06083f9789eaa63f1693564b. This is not evidence that a signed APK has been installed or that Xiaomi accepts it.

## Local resource policy

The user restricts heavy testing and builds on the phone. After that policy arrived, no further full Flutter analysis, full test suite or APK build was started. The user subsequently explicitly allowed small, short targeted tests. Final native checks therefore use at most two active processors, bounded heaps, a hard 20-second compile limit and a hard 10-second JVM-test limit. No real package installation, permission change, Shizuku grant or device security-setting change was performed.

## Checks actually performed

- Enforced dependency resolution: dart pub get --enforce-lockfile, exit 0. Dependency locks remain unchanged.
- Generated bilingual localization: l10n_merge.py, 63 parts / 6212 keys. Guide source and embedded copies synchronized with guide_sync.py. These are necessary generated artifacts, not hand-edited snapshots.
- git diff --check, localization --check, guide --check and dependency-lock diff checks passed.
- Intermediate Flutter run before the new local restriction: privileged_installer_test.dart, privileged_state_test.dart and privileged_sheet_test.dart, 33 tests passed. Later queued-port regression cases and small static corrections were not rerun locally; they remain for CI.
- Intermediate full flutter analyze completed with exit 1 and one curly_braces_in_flow_control_structures informational finding in update_state.dart. That exact multi-line if was wrapped in a block. Full analysis was not repeated under the resource restriction; do not describe the final analyzer result as green.
- Initial native backend type checking against real Android 36, Shizuku 13.1.5 and libadb 3.1.1 artifacts passed. Later final bounded type checking also includes UpdatePlugin, SelfUpdateConfirmation, existing ApkInstaller, AppStrings, AdbKeyStore, all new installer classes and focused JVM tests. AndroidX core and real Flutter embedding classes are on the classpath. Only generated R IDs use an external compile-only fixture; resources, whole-app compilation and R8 are not validated by this step. The fixture and compiler outputs are outside the repository and are not deliverables.
- Final focused JVM run: **44 tests passed**, exit 0 (9 native argument tests, 21 policy/stream/recovery tests and 14 process-launch guards). The test execution took about 5 seconds. An earlier attempt had a JUnit command-line class-name separator typo after successful compilation; it was corrected without changing production code or rerunning compilation.

## Static review

The independent review checked native and Dart contracts, fixed self-package/current-signer/newer-version restrictions, owned read-only snapshots, actual UID 2000, native one-attempt confirmation, standard install flags, loopback-only ADB, typed bounded receipts, persistent-before-dispatch journaling and installed-artifact recovery. It also checked new launcher ownership independently from the production allowlist and found no credentials, temporary fixtures or dependency upgrades in the change scope.

Two reported issues were fixed: ADB OPEN itself now sits inside bounded futures, with late sends rejected after retirement and asynchronous disconnect; queued installation/retry callbacks now snapshot and validate the current manual port at execution time, rather than turning invalid text into automatic discovery. Source was reread to verify both fixes; timeout-device fault injection and the new queued-widget cases remain CI/device work.

Installed-artifact verification is cached only after a real matching digest and while package, current signers, build, source size and PackageManager lastUpdateTime remain unchanged. Pending/unknown receipts, changed metadata and fresh mismatching digests cannot use this cache.

## Remaining merge/release gates

- Remote CI: final Flutter analysis, all applicable updater regressions, new queued-port widget cases, Android unit compilation and source-launch guards.
- Build a properly signed APK in an authorized build environment. No local SDK license was accepted and no APK was built for this change.
- Explicitly authorized devices: first-use native confirmation and denial, permission revocation, unavailable/blocked backends, wrong package/signer/hash/ABI/version, ADB OPEN timeout and stream loss, replacement killing the old app, restart reconciliation, working profiles, and coexistence with ordinary Shell/background display.
- Xiaomi/HyperOS: collect the actual system rejection and test the supported route on that device. The available local diagnostic snapshot describes a vivo device, not the reported Xiaomi rejection. No Xiaomi success or anti-fraud bypass has been demonstrated.
- A normal signed update is still needed once to introduce this new updater into an older installed app. Self-update source code alone cannot bootstrap a feature that the installed version does not yet contain.
