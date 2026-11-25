# Android Shell command channel

## Scope and protocol

An independent, default-off Android command capability exposed as the fixed phone MCP tool `android_shell(command, timeout_ms?)`. It uses the selected Shizuku UserService or local wireless ADB backend, never the PRoot shell or the display protocol. The native app owns selection; tools cannot request authorization, pair ADB, select root or change configuration. No fallback/replay after dispatch.

Commands are noninteractive Android sh scripts, with a 2048-byte UTF-8 limit, a default 30-second / maximum 60-second deadline, and a shared 64-KiB text-output budget. Concurrently drain both streams after truncation. Per-command approval shows the entire command and actual backend/UID; screen/task waivers are never accepted. The MCP call holds the main/unknown-app lease without requesting a screen observation or accessibility driver. Arbitrary effects invalidate UI-route verification.

## Lifecycle

Independent service tag/revision, app-private ADB host identity, and backend connections avoid coupling Shell teardown to background-display teardown. Short start/poll/cancel messages leave the control channel available during execution. Jobs bind to the native task owner and configuration generation. Stops, pause, owner retirement, lock/screen-off and engine shutdown invalidate pending confirmation/execution. Never publish a late connection or reuse an incomplete stream. Implement Shizuku destroy, not just unbind.

The Android job helper creates a new session/process group and waits for a verified ownership handshake before running user code. Parent EOF and a local deadline provide additional cleanup paths. Termination targets only the owned process group, not global process names. Cancellation is not rollback, and deliberate daemonization/session escape is outside the supported job model. Shell access is a trusted high-privilege capability, not a sandbox; same-UID rootfs code is not isolated by bridge tokens.

## Reference and licensing

Design review only; no Operit source was copied or adapted. Reviewed Operit main commit `16cffb98f52a11dc77bd0a789ffa0b01ed398ee4` (LGPL-3.0-only):

- https://github.com/AAswordman/Operit/tree/16cffb98f52a11dc77bd0a789ffa0b01ed398ee4
- https://github.com/AAswordman/Operit/blob/16cffb98f52a11dc77bd0a789ffa0b01ed398ee4/LICENSE
- `ShellExecutor.kt`, `AndroidShellExecutor.kt`, `DebuggerShellExecutor.kt`, `ShizukuAuthorizer.kt` under its Android tool implementation.

Borrowed architectural ideas: separate availability/authorization/result states and respect user backend selection. Do not copy its deprecated newProcess/reflection path, sequential stdout/stderr reads, ignored timeout, background-command success guesses or grep-specific exit-code rewriting. Its named ADB tool depends on Shizuku; this review found no self-ADB pairing/client to reuse.

Shizuku integration follows the official UserService contract: https://github.com/RikkaApps/Shizuku-API#userservice . Existing declared Shizuku/libadb dependencies and licenses remain unchanged.
