# Supported self-update installation routes

The updater keeps its existing download, digest-binding and normal PackageInstaller flow. An explicit choice on a fully downloaded APK adds Shizuku and local ADB routes. These are alternative authorized installation entry points, not a guarantee of bypassing vendor malware/fraud checks. No verifier, security app, install-source identity or system policy is changed.

## Scope and authorization

- Normal installation remains the default. A route is not silently changed after rejection, cancellation, lost transport or restart.
- The privileged route has no command, target-package, install-flag or installer-identity argument. Its native schema accepts only an updater-cache APK, release SHA-256, expected build number, selected backend and optional local ADB port.
- Native preparation creates a private, read-only snapshot from the updater cache, checks its digest and length, parses the APK, requires the fixed DSH Go package and strictly equal nonempty current signer sets, and requires a higher build number. Key rotation and reinstalling an equal build are deliberately outside this first version; these are product restrictions, not a claim that Android universally prohibits them.
- A one-attempt foreground native prompt identifies the actual backend/UID, version and digest. It cannot inherit Phone control waivers. No general MCP installation tool is added.
- Both routes accept only actual shell UID 2000. Root is neither requested nor used. Permission, pairing and installation are separate explicit actions; merely opening the update UI requests none of them.

## Transports and lifetime

Shizuku uses a separate, bounded one-attempt UserService and Binder descriptor. A read-only APK descriptor is passed instead of a path readable only by the app. The service verifies its caller, nonce/revision, actual UID and the APK again before invoking the standard system command. Its finite lifetime can outlive replacement of the app; it is not an unrestricted resident shell service.

Local ADB uses its own connection manager and the existing app-private paired identity. Discovery supplies only a local port, and all sockets connect to 127.0.0.1. Pairing is not automatically started, and the background-display or ordinary Android Shell connection is not borrowed or disconnected.

The fixed system operation is an ordinary replacement install with an explicit target app user, known APK byte length and standard input. It sets no installer-source, downgrade, force, low-target-SDK-bypass or verification-skip flags. The app user is captured in the original app process, not inferred from shell UID or the foreground Android user. Updating package code may affect other profiles with the same package installed.

The APK is streamed concurrently with bounded receipt reading, without a PTY or base64 RPC payload. ADB standard input stays open after the exact declared bytes are flushed: closing it would close the entire ADB stream before reading the result. Platform package code bounds the APK read by its declared size, so a real EOF is not required. Both local snapshot checks and the final system result remain necessary; a write acknowledgment alone is not proof of a complete APK or installation.

## Receipts and recovery

Before dispatch, native code synchronously journals the attempt and expected artifact identity. Transport timeouts and disconnects after possible submission are unknown, never automatic retries. An explicit system rejection is reported separately; raw system messages, paths and pairing secrets are not persisted as error text.

On resume or next launch, reconciliation reads the actually installed package, signer set, build number and, for the exact target build, its APK digest. After an exact digest match, later reconciliations reuse the verified receipt only while package, current signer set, build, size and PackageManager lastUpdateTime remain identical; changed or unresolved records require fresh evidence. The journal is updated only if its request identity is still current. Dispatch, Activity resume and CLI acknowledgment alone are not installation-success evidence. An already newer compatible installed build is distinguished as superseded.

An active attempt cannot be cleared. An inactive unknown record can be acknowledged only through another native foreground warning: forgetting it does not cancel a possibly running system install and sends no new install request. The user must check that no system installation is running before a later, separately confirmed retry. No file path, command or backend is reconstructed into an automatic replay.

## Verification and release gates

See the [verification record](../testing/self-update-installation.md) for actual commands, intermediate results and tests not run. Source changes and static review are not equivalent to a signed APK or a Xiaomi device installation test.

## Platform references

Fixed AOSP source was downloaded from public GitHub mirrors after the web-fetch service returned errors; it was read for protocol semantics, not copied into the implementation.

- [Android 15 package shell install flow](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/services/core/java/com/android/server/pm/PackageManagerShellCommand.java#L1564-L1653)
- [Size-bounded session writing](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/services/core/java/com/android/server/pm/PackageInstallerSession.java#L1996-L2030)
- [System-owned commit lifetime](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/services/core/java/com/android/server/pm/PackageInstallerSession.java#L2482-L2493)
- [Android 8 sized input stream](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-8.0.0_r1/core/java/com/android/internal/util/SizedInputStream.java#L49-L64)
