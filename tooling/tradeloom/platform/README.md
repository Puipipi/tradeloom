# TradeLoom native build entrypoints

These scripts archive the explicitly selected full source commit into a private temporary tree, apply TradeLoom-only native identifiers there, and run the upstream platform build scripts. Set `TRADELOOM_SOURCE_ROOT` to a Git checkout and `TRADELOOM_SOURCE_COMMIT` to its exact 40-character commit SHA. The scripts verify that the SHA resolves exactly before archiving it. The accepted `24afe0b40421382e5edecdc42079a0939d557969` was used to validate this isolated rewrite; it is not hard-coded as the build source. The checkout is read-only, and the official DSH Go identifiers, package, signing profile and publication flow are not changed.

## iOS

Run `build-tradeloom-ios.sh` on macOS with Xcode, Flutter, Rust/Cargo, and an Apple Developer team that has registered these identifiers:

- App: `io.github.ccch1mneyyy.tradeloom`
- Share extension: `io.github.ccch1mneyyy.tradeloom.ShareExtension`
- Companion widget: `io.github.ccch1mneyyy.tradeloom.CompanionWidget`
- Phone runner: `io.github.ccch1mneyyy.tradeloom.PhoneRunner`
- App group: `group.io.github.ccch1mneyyy.tradeloom`

Set `TRADELOOM_SOURCE_ROOT`, `TRADELOOM_SOURCE_COMMIT`, `TRADELOOM_OUTPUT_ROOT`, `TRADELOOM_IOS_TEAM_ID`, and `TRADELOOM_IOS_EXPORT_OPTIONS_PLIST`. Keep the export plist outside the source checkout and configure `destination=export`, `signingStyle=manual`, the selected `teamID`, an installable `method` (`development`, `ad-hoc`, or `enterprise`), and local profile mappings for the TradeLoom app, ShareExtension, and CompanionWidget IDs. The script validates these values without printing profile names or plist contents. It does not request account login, provisioning updates, or upload. The archive and exported IPA are accepted only when their app and embedded extension IDs match, all three components are signed by the selected team, and `codesign --verify --deep --strict` succeeds. The team must register the app group and all embedded target identifiers before provisioning succeeds.

The archive step mirrors the upstream flow: Flutter runs from `app/` through `../tooling/ios/build.sh --config-only`, which prepares its generated plugin package under `ios/Flutter/ephemeral/Packages`; Xcode then archives `ios/Runner.xcworkspace`. The project has a local Swift Package reference to `FlutterGeneratedPluginSwiftPackage` and no checked-in Podfile, so the generated workspace is required.

## HarmonyOS

Run `build-tradeloom-ohos.sh` on macOS arm64 with the matching oh-flutter, Harmony Command Line Tools (`hvigor` and `ohpm`), Node headers, native libraries and composed runtime required by the upstream `tooling/ohos/build-hap.sh`.

The bundle is `io.github.ccch1mneyyy.tradeloom`. Set `TRADELOOM_SOURCE_ROOT`, `TRADELOOM_SOURCE_COMMIT`, `TRADELOOM_OUTPUT_ROOT`, `FLUTTER_OHOS`, `DSH_OHOS_NATIVE_LIBS`, `DSH_NODE_HEADERS`, `DSH_OHOS_RUNTIME`, and all `DSH_OHOS_SIGN_*` values to TradeLoom-specific signing materials. The upstream signing helper receives secrets only in its signing subprocess; do not place them in source or logs. `--distribution device` produces a signed device-installable HAP, not an app-market package.

Both builds pass `--dart-define=TRADELOOM_BRAND=true` through the existing Flutter build path. Native UI names and URL schemes are changed only in the temporary archive so they do not collide with DSH Go. Custom `.dshgo` data-file extensions remain unchanged.

## Verification boundary

The entrypoints can be syntax-checked and their isolated identity rewrite can be checked on any host. The upstream `app/ohos/README.md` documents that the pinned oh-flutter AOT tools (`gen_snapshot` and `frontend_server`) are published for macOS arm64, so Linux/Windows cannot make the installable Harmony HAP; Harmony Command Line Tools (`hvigor`/`ohpm`) and a compatible SDK are also required. The same README says downloading Harmony Command Line Tools requires a Huawei login; this preparation does not sign in or download them. A signed iOS archive and IPA require macOS/Xcode and preconfigured signing identity/profiles. No package was built, signed, exported, or installed in the Windows preparation environment.
