# TradeLoom Go mobile slice

This branch starts from the clean `dsh-Go` upstream clone at
`148d1712576fd0800c2d15ada35e220933347626` (2026-11-25). The upstream is
AGPL-3.0; its license and copyright notices stay with the app and runtime.

## Upstream inputs and license boundary

| Repository | Locked `main` SHA | Use | License |
| --- | --- | --- | --- |
| `ccch1mneyyy/dsh-Go` | `148d1712576fd0800c2d15ada35e220933347626` | Flutter app, DSH client/runtime, Android and HarmonyOS hosts | AGPL-3.0 |
| `mini-yifan/deepseek-harness-orb` | `225379f1097313df75f9be7b7a5409b82cc2e62e` | Desktop orb reference only | MIT |
| `mini-yifan/dsh-orb-cordis` | `390363bb20f77b03eb2d024111c88b74f1e0fd00` | Plugin orb reference only | MIT |
| `mini-yifan/dsh-orb-android` | `da3a025933b3894b6499e8e3096e1fa6e2c405c7` | Android/cross-platform product reference; not copied into this slice | AGPL-3.0 |

The mobile base is the real Flutter DSH Go app: Android runs its bundled DSH
runtime in PRoot; HarmonyOS uses the shared Dart app with its ArkTS host and
in-process Node runtime. iOS support exists in the upstream tree, but the
upstream README still marks iOS as in development and requiring Mac signing.
The existing HarmonyOS AOT and release workflows are retained.

The desktop RC19 Owner build has a local workbench across eight scenarios and
requires at least 960×560. Factory builds do not expose it. RC21's enterprise
portal does not mount the desktop `workbench.urls`, so mobile portal login does
not provide those local workbench scenarios. Mobile work in this slice is the
real portal entry and existing DSH Go base; it does not implement order
production, source-file preview/mapping, material and documents, workflow
editing or delivery review, customer analysis, ERPNext, or the desktop DSH
plugin/skill/MCP business-data integration. No claim of parity is made.

## Product entry and server contract

The new **TradeLoom Workbench** entry is a server-rendered portal opened by the
existing `webview_flutter` host. The user enters an origin because the desktop
deployment has no public canonical URL. HTTPS is required except for loopback
HTTP used by QA. WebView navigation requests exposed by the platform are
restricted to the configured exact origin. This does not filter subresources or
page POST requests. If the platform refuses to install that policy, the page is
not loaded; an out-of-origin navigation request is blocked and reported. The
portal owns its Django session, CSRF challenge,
role checks, and logout. No password/token is stored by the app, no DSH Web
JavaScript bridge is installed, and no TradeLoom business data is read by the
local DSH runtime.

On a fresh branded install, **Open TradeLoom Workbench first** appears beside
the normal DSH Go setup action on the welcome screen. It opens the portal over
the welcome step; backing out returns to the original setup choice. Users can
therefore sign in before entering an API key or connecting a DSH host, then
continue with the DSH Go base when they want it. After setup, the workbench is
also in the quick panel.

The login starts at `/accounts/login/?next=/enterprise/`. The server's
capabilities policy remains authoritative after login:

| Account class | `local_workbench` | `owner_tools` | `server_ops` |
| --- | --- | --- | --- |
| Non-registrar Owner: superuser, or enterprise-owner group with `view_business_data` and `view_all_enterpriseentry` | Server-derived | Server-derived | Server-derived |
| Factory registrar | Off | Off | Off |

Edition/build labels never grant server permission. The server re-checks
capabilities for each request. Logout remains the portal's same-origin POST
form so its CSRF and session rules stay in force (`config/enterprise_urls.py`
and `enterprise_portal/policy.py` in the desktop service).

## Upstream update and build

Check current upstream and create an isolated update candidate with:

```sh
node tooling/tradeloom/sync-upstream.mjs --check --repo .
node tooling/tradeloom/sync-upstream.mjs --candidate --repo . --dest /path/outside/this/repo
```

Candidate mode requires a clean source worktree, refuses destinations inside
the source tree, keeps the source unchanged, and leaves conflicts in the
candidate for review. Removing the candidate rolls the operation back. Its
isolated tests cover shallow history, clean merges, conflicts, and dirty-source
refusal. The existing mobile updater is still configured for official DSH Go
release assets; branded builds disable those endpoints, so they cannot install
an APK signed for the official package. A TradeLoom production release feed is
not configured.

Branded builds also disable DSH Go product telemetry and hide its opt-in
switch; ordinary DSH Go builds keep their upstream behavior.

The upstream Android build uses Flutter 3.47.7, JDK 17 and the `arm64` ABI
flavor; its HarmonyOS compile workflow pins oh-flutter 3.47.9-ohos-1.0.0 at
`e5f752df3e25ec897da3c98a74bcced7c21b0bd3`. Flutter 3.47.7, JDK 17 and the
Android SDK/NDK are installed in the isolated `D:/tl-mobile-toolchain` tree.

## Verification record

| Check | Status |
| --- | --- |
| Upstream SHA and license readback | Complete; listed above |
| Upstream candidate sync tests | Pass: `node --test tooling/tradeloom/tests/sync-upstream.test.mjs` (3/3) |
| TradeLoom origin, updater, telemetry policy tests | Pass: focused Flutter tests plus existing `root_gate_autostart_test.dart` (14/14) |
| Flutter analyze | Pass: no issues |
| Flutter focused tests | Pass: origin, updater, telemetry policy and existing `root_gate_autostart_test.dart` (14/14) |
| Localization merge check | Pass: `python app/tool/l10n_merge.py --check` (79 parts, 8,989 keys) |
| Android x64 TradeLoom debug | Built at `app/build/app/outputs/flutter-apk/tradeloom-app-x64-debug.apk`; package `io.github.ccch1mneyyy.dsh_app.tradeloom`, version 1.3.0, 161,903,011 bytes, SHA-256 `5ba997de88936b390be86a63b09c2fea6e1abf05633b42a4cef90f6583c49c74` |
| Android x64 install and UI | Installed on Android 15 x86_64 TCG; actual welcome, first-run workbench entry, origin form and RC21 login GET 200 observed. First startup was slow; WebView Chromium 124 renderer SIGTRAP occurred twice (including Reopen). A separate plain-Java WebView control on the same emulator and URL also SIGTRAPped, so the renderer failure reproduces outside the Flutter app. In-app password/OTP and capabilities were not completed. |
| Android arm64 TradeLoom debug | Built at `app/build/app/outputs/flutter-apk/tradeloom-app-arm64-debug.apk`; package `io.github.ccch1mneyyy.dsh_app.tradeloom`, version 1.3.0, 162,370,149 bytes, SHA-256 `ed0e4412b627b40f8d45207c3d01c021128e8e161650ed9d8f3d82f7f64989d8`; not installed or device-tested |
| iOS build/install | Pending; requires macOS signing/device |
| HarmonyOS build/install | Workflow retained; local SDK/signing/device not yet validated |
| Owner/Factory app login, OTP, capabilities and logout | Not completed; this app test did not reach policy verification |

The first Android builds needed the SQLite 3.9.1 precompiled x64 and arm64
artifacts. Dart's native asset hook did not inherit the configured Windows
trust roots inside WSL and failed TLS validation. The exact upstream GitHub
release assets were downloaded with Windows trust roots and verified against
the hashes embedded in the locked pub package before placing them in the
isolated `.dart_tool` build cache. No TLS checks, proxies, app dependencies or
lockfiles were changed. This native cache is local build state, not app source.

The x64 debug APK above predates the source-only branded telemetry UI
suppression. Its debug telemetry collection was already inactive under the
upstream release-only switch, but its welcome page still showed the upstream
statistics opt-in. Do not treat that earlier APK as containing the later UI
change.

## Android runtime with local read-only Mesh

The optional branded runtime ships the checked-in read-only Mesh module and
its MIT notices. The source base, TradeLoom patch and packager inputs are in
`runtime/vendor/tradeloom-mesh/`. The build reads only the locked local package.
The option selects an independent Android runtime directory.

```sh
TRADELOOM_RUNTIME_MESH=1 bash runtime/build-runtime.sh x86_64
TRADELOOM_RUNTIME_MESH=1 bash tooling/build-apk.sh --tradeloom --flavor x64
```

Use `arm64-v8a` and `--flavor arm64` for an arm64 package. Use the same option
for the runtime and APK steps. Standard runtime builds and existing development
builds continue to use `runtime/out`. The packaged runtime uses a local Cordis
overlay under its own profile. Pairing state is stored by the plugin in the
local DSH guest, separately from upstream Mesh. A compatible authorized Relay
and a desktop profile running the same read-only plugin are required for sharing.

To boot just the checked-in integration over a previously built x64 runtime,
without building an APK, use the isolated host smoke test:

```sh
TRADELOOM_MESH_ONLY=1 RUNTIME_OUT=/path/to/runtime/out bash runtime/test-host.sh
```

This stages only the branded overlay files in a fresh guest. The guest test
can use an independently supplied Linux PRoot executable via
`TRADELOOM_MESH_PROOT`. The default uses the test host's existing bubblewrap.
