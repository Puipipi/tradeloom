# Media configuration and display verification

## Scope

This change implements the native App UX, not another Host media protocol or a publication:

- API-root validation and create-request preview use saved configuration and Host catalog metadata. They never read a key into Flutter or contact a provider. Saved key presence is not authentication verification.
- Changing target origin or manually reusing a key across origins requires explicit confirmation. Default credential reuse is limited to the same provider and origin.
- Images show loading and actionable file-read failures. Reload evicts the image/read cache, keeps the original Host and session, and never submits generation.
- Videos have local first-frame previews, in-App texture playback with play/pause/seek, and external-app fallback. Remote files are materialized only for an explicit action, never for scrolling previews. Poster requests serialize; frame dimensions are bounded to 512 pixels. On API 26, automatic full-frame extraction skips videos over four megapixels.
- Videos save via local-file streaming into Android MediaStore Movies/DSH Go. Image writes retain their existing permission flow. No complete video is sent as a platform-channel byte array.
- Player preparation, late completion, background pause, audio focus and surface disposal have explicit cleanup paths.

## Verification environment

Android/PRoot Linux arm64; Flutter 3.47.7; Dart 3.13.5. A real linux-arm64 flutter_tester is available. Widget tests load actual Noto Sans CJK Light/Regular/Bold through DSH_TEST_FONT_DIR; no font, test bootstrap or pixel-comparator bypass is used.

The mirror's online dependency resolution failed for image_picker_ios. An offline mirror attempt also selected unrelated newer packages; its generated lock changes were removed. Final resolution uses the original pub.dev registry with --offline --enforce-lockfile. The [App manifest](../../app/pubspec.yaml) and [dependency lock](../../app/pubspec.lock) remain unchanged. No playback package was added.

## Commands and evidence

From app/ (use a compatible Flutter executable):

	dart analyze lib/ui/chat/media lib/ui/settings/media lib/media lib/state/media_settings.dart test/media/media_image_retry_test.dart test/media/media_video_test.dart test/media/media_settings_feedback_test.dart
	flutter analyze --no-pub
	DSH_TEST_FONT_DIR=/path/to/noto-cjk flutter test --no-pub --concurrency=2 test/media

Focused behavior coverage includes URL/root/origin validation, Host authority on settings writes, key-sharing consumers, no key/network probing, image read failure/reload and original-Host retry, stale session completions, concurrent video posters, failed-poster queue recovery, original-Host materialization, late-player disposal, background pause, video controls and path-only gallery saves.

The full Media run before the last fixture-side-effect fix completed 350 tests with 20 failures: 16 pixel comparisons plus four cascading unmocked native-event failures. The event initialization was fixed by avoiding Host reads for a supplied video poster or a plugin-only gallery. Renderer-sensitive visual comparisons are recorded separately rather than silently accepting or bulk-replacing their baselines. Final behavior-only run: **348 passed**, exit 0. It included every Media test file except the pixel-only media_golden_test, and excluded generate_mode_test's named goldens group; header grammar golden-data cases still ran. The command was the same font-enabled Flutter invocation with all other Media test files and --name '^(?!goldens )'. This is explicitly not a full pixel-golden pass.

The two wide video/missing-file visual tests were rerun after the native-event fix: only pixel mismatches remain (about 0.50% in each theme), with no native event exceptions. The new central play affordance and file-reload control intentionally differ from the old screenshots. Other pixel-only failures also cover untouched generation sheets/chat snapshots in this already-dirty worktree; their cause is not established here. No old screenshot baselines were updated or pixel tolerance relaxed.

Whole-App flutter analyze --no-pub: **passed**, exit 0 after original dependency restoration. A subsequent scoped native-Dart analysis of final Media source/tests also passed. After the final compact-tile adjustment, all **5 image reload/layout/Host-affinity widget tests** were rerun and passed, exit 0. Bilingual l10n and guide generation checks and git diff --check passed.

Native validation used JDK 17, Kotlin 2.2.20, the actual Android API 36 android.jar and Flutter android-arm64 flutter.jar. Both MediaPlugin and MediaVideoPlugin compile. A compile-only FilesPlugin safeName/unique boundary stub was used so unrelated dirty file integration was not replaced or claimed validated. JUnit 4.13.2 / Hamcrest 1.3 runs MediaVideosTest: **3 passed** (absolute local files, bounded/aspect-preserving poster sizes and seek bounds). This is not a Gradle/APK build or decoder/MediaStore integration test.

## Latest-main integration before commit

The final commit is assembled in an isolated worktree based on origin/main 3a91fab9, not by committing the stale dirty source tree. Upstream image filename Unicode safety, atomic CREATE_NEW ownership, permission queue/owner epochs and runtime storage/lifecycle fixes are preserved. No unrelated pending edits, dependency upgrades or new runtime lock are included.

- Clean latest-main App: **351 behavior tests passed**, exit 0; the same explicit pixel-only exclusions described above remain in effect. Whole-App flutter analyze --no-pub passed, exit 0.
- Actual Android/Flutter API native compilation and JUnit: **12 passed**, covering the existing permission/image race tests plus streamed-video name-race and partial-file cleanup tests. The FilesPlugin compile boundary contains the exact current-main safeName/unique methods; the full Gradle/APK build remains unrun.
- Both supported Host versions: **325 Node tests passed each**, four rc.1-only gated cases skipped in the default run; separately the real rc.1 owner lifecycle **4 passed**, no skips. Both versions' real headless image/video sessions passed with local mocks.
- Native permission queue source/tests, image uniqueness test, runtime production source/locks/patches and App manifest/lock are unchanged against the integration base.

## Device checks still required

- Install the rebuilt App and verify a newly generated MP4, rotated video and unsupported codec.
- Play, pause, seek, background/foreground, route pop, repeated opens and activity/surface recreation; ensure audio and textures do not survive closure.
- Interrupt playback with another audio app/call and verify focus behavior.
- Save a local and a remote video; verify gallery visibility, actual location, permission denial/retry and failed-copy cleanup on API 26–28 and API 29+.
- Change active Host with an image or video viewer open and retry; never send the original session/path to the new Host.

Verification performed no paid provider request, production credential probe, App installation or publication. Repository commits/merge are a separate user-requested action.
