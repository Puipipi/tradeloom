// Measured, not eyeballed: the unpack capsule's insets and centring, its slot
// that never moves the page, the status sheet's buttons, and every first-run
// page that runs beside the unpack at 320 dp with 1.3× and 2× text, in both
// languages, without an overflow or a cut-off line.

import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/performance/performance_state.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/drawer_view_state.dart';
import 'package:dsh_app/state/onboarding_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/state/balance_state.dart';
import 'package:dsh_app/ui/common/progress_halo.dart';
import 'package:dsh_app/ui/common/side_insets.dart';
import 'package:dsh_app/ui/onboarding/appearance_step.dart';
import 'package:dsh_app/ui/onboarding/connect_page.dart';
import 'package:dsh_app/ui/onboarding/onboarding_scaffold.dart';
import 'package:dsh_app/ui/onboarding/runtime_setup_page.dart';
import 'package:dsh_app/ui/onboarding/setup_progress.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../account/support.dart' show FakeBrowser;
import '../performance/support.dart';
import '../shell/golden_harness.dart';
import '../support/test_fonts.dart';
import 'parallel_setup_support.dart';

const _capsule = ValueKey('setup-capsule');
const _slot = ValueKey('setup-capsule-slot');

Widget _beside(Widget page, {int step = 2}) =>
    OnboardingProgress(step: step, steps: 3, runtime: true, onRemote: () {}, child: page);

/// [goldenApp] in either language, with the text size the platform reports.
Widget _app(Widget home, {required Locale locale, required List<Override> overrides}) => ProviderScope(
  overrides: [
    localConnectionProvider.overrideWith(FakeConnection.new),
    onboardingPrefsProvider.overrideWith(FakeOnboardingPrefs.new),
    accountWalletBalanceProvider.overrideWithValue(null),
    drawerClockProvider.overrideWithValue(() => sampleNow),
    settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
    accountProvider.overrideWith(RecordingAccount.new),
    accountEngineStarterProvider.overrideWithValue(() async {}),
    accountBrowserProvider.overrideWithValue(FakeBrowser()),
    ...notifications(enabled: true),
    ...overrides,
  ],
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: withTestFonts(buildLightTheme()),
    locale: locale,
    supportedLocales: AppLocale.supported,
    // No L10n delegate, as in goldenApp: text follows AppLocale (appL10n).
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(disableAnimations: true),
      child: MirroredSideInsets(child: child!),
    ),
    home: home,
  ),
);

Future<UnpackingRuntime> _pump(
  WidgetTester tester,
  Widget home, {
  LocalRuntimeState runtime = const LocalRuntimeState(loaded: true),
  Size size = const Size(390, 844),
  double scale = 1,
  bool english = false,
  List<Override> overrides = const [],
}) async {
  final fake = UnpackingRuntime(runtime);
  if (english) AppLocale.use(AppLocale.en);
  addTearDown(() => AppLocale.use(AppLocale.zhCN));
  tester.view.devicePixelRatio = 2;
  tester.view.physicalSize = size * 2;
  tester.view.padding = const FakeViewPadding(top: 32 * 2, bottom: 24 * 2);
  tester.view.viewPadding = const FakeViewPadding(top: 32 * 2, bottom: 24 * 2);
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  await tester.pumpWidget(
    _app(
      home,
      locale: english ? AppLocale.en : AppLocale.zhCN,
      overrides: [localRuntimeProvider.overrideWith(() => fake), ...overrides],
    ),
  );
  await frames(tester, 8);
  return fake;
}

/// No line anywhere cut short by its line limit.
void _expectNothingCut(WidgetTester tester, String where) {
  for (final paragraph in tester.allRenderObjects.whereType<RenderParagraph>()) {
    expect(paragraph.didExceedMaxLines, isFalse, reason: '$where: "${paragraph.text.toPlainText()}" is cut');
  }
}

void main() {
  setUpAll(loadTestFonts);

  group('capsule', () {
    for (final scale in [1.0, 1.3, 2.0]) {
      testWidgets('equal insets on every side, mark centred, page-centred (×$scale)', (tester) async {
        await _pump(
          tester,
          _beside(AppearanceStepPage(onDone: () {})),
          runtime: unpackingState(0.42),
          scale: scale,
        );
        final pill = tester.getRect(find.byKey(_capsule));
        final content = tester.getRect(find.byKey(const ValueKey('setup-capsule-content')));
        const inset = SetupProgressCapsule.inset;
        expect(content.left - pill.left, moreOrLessEquals(inset, epsilon: 0.01));
        expect(pill.right - content.right, moreOrLessEquals(inset, epsilon: 0.01));
        expect(content.top - pill.top, moreOrLessEquals(inset, epsilon: 0.01));
        expect(pill.bottom - content.bottom, moreOrLessEquals(inset, epsilon: 0.01));
        final mark = tester.getRect(find.byKey(const ValueKey('setup-capsule-mark')));
        expect(mark.center.dy, moreOrLessEquals(pill.center.dy, epsilon: 0.01));
        if (scale == 1) {
          // The ring sits concentric with the rounded end.
          expect(mark.center.dx - pill.left, moreOrLessEquals(pill.height / 2, epsilon: 0.5));
          expect(mark.height, moreOrLessEquals(content.height, epsilon: 0.01));
        }
        // Centred on the page, the same distance from both edges.
        expect(pill.left, moreOrLessEquals(390 - pill.right, epsilon: 0.01));
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('its slot holds still through progress, done, hidden and failed', (tester) async {
      final runtime = await _pump(tester, _beside(AppearanceStepPage(onDone: () {})), runtime: unpackingState(0.1));
      Rect slot() => tester.getRect(find.byKey(_slot));
      Rect button() => tester.getRect(find.widgetWithText(FilledButton, '继续'));
      final (s0, b0) = (slot(), button());
      final heights = <double>[tester.getSize(find.byKey(_capsule)).height];

      runtime.unpack(0.73);
      await frames(tester, 2);
      heights.add(tester.getSize(find.byKey(_capsule)).height);
      runtime.finish();
      await frames(tester, 2);
      expect(find.text('运行环境已就绪'), findsOneWidget);
      heights.add(tester.getSize(find.byKey(_capsule)).height);
      await tester.pump(SetupProgressCapsule.readyHold);
      await frames(tester, 4);
      heights.add(tester.getSize(find.byKey(_capsule)).height);
      runtime.fail();
      await frames(tester, 2);
      expect(find.text('安装未完成'), findsOneWidget);
      heights.add(tester.getSize(find.byKey(_capsule)).height);

      expect(heights.toSet(), hasLength(1), reason: '$heights');
      expect(slot(), s0);
      expect(button(), b0);
    });

    testWidgets('steps aside for the keyboard', (tester) async {
      await _pump(tester, _beside(ConnectPage(onDone: () {}), step: 3), runtime: unpackingState(0.5));
      expect(find.byKey(_slot), findsOneWidget);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300 * 2);
      await frames(tester, 2);
      expect(find.byKey(_slot), findsNothing);
      tester.view.resetViewInsets();
      await frames(tester, 2);
      expect(find.byKey(_slot), findsOneWidget);
    });
  });

  group('status sheet after a failure', () {
    Future<Rect> open(WidgetTester tester, {Size size = const Size(390, 844), double scale = 1, bool english = false}) async {
      await _pump(
        tester,
        _beside(AppearanceStepPage(onDone: () {})),
        runtime: const LocalRuntimeState(loaded: true, status: failedStatus),
        size: size,
        scale: scale,
        english: english,
      );
      await tester.tap(find.byKey(_capsule));
      await frames(tester, 6);
      return tester.getRect(find.byKey(const ValueKey('setup-status-sheet')));
    }

    Rect remote(WidgetTester tester) => tester.getRect(find.byKey(const ValueKey('setup-use-remote')));
    Rect retry(WidgetTester tester) => tester.getRect(find.byKey(const ValueKey('setup-retry')));

    testWidgets('the two ways on are twins, centred, when both names fit', (tester) async {
      final sheet = await open(tester);
      final (r, t) = (remote(tester), retry(tester));
      expect(find.descendant(of: find.byKey(const ValueKey('setup-use-remote')), matching: find.text('改用远程主机')), findsOneWidget);
      expect(r.size, t.size);
      expect(r.top, t.top);
      expect(t.left - r.right, moreOrLessEquals(12, epsilon: 0.01));
      expect(r.left - sheet.left, moreOrLessEquals(sheet.right - t.right, epsilon: 0.01));
      final logs = tester.getRect(find.widgetWithText(TextButton, '查看日志'));
      expect(logs.center.dx, moreOrLessEquals(sheet.center.dx, epsilon: 0.01));
      _expectNothingCut(tester, 'twins');
    });

    for (final (english, width, scale) in [(true, 390.0, 1.0), (false, 320.0, 2.0), (true, 320.0, 1.3)]) {
      testWidgets('a name that would wrap stacks them, 重试 on top (${english ? 'en' : 'zh'}, ${width.round()} dp, ×$scale)', (
        tester,
      ) async {
        final sheet = await open(tester, size: Size(width, 844), scale: scale, english: english);
        final (r, t) = (remote(tester), retry(tester));
        expect(r.top - t.bottom, moreOrLessEquals(10, epsilon: 0.01));
        expect(r.left, t.left);
        expect(r.width, t.width);
        expect(t.left - sheet.left, moreOrLessEquals(sheet.right - t.right, epsilon: 0.01));
        expect(tester.takeException(), isNull);
        _expectNothingCut(tester, 'stacked');
      });
    }
  });

  group('320 dp, large text: nothing overflows or is cut', () {
    final low = [
      performanceChannelProvider.overrideWithValue(FakePerformanceChannel(Future.value(snapshot(DeviceTier.low)))),
    ];
    final screens = <String, (Widget Function(), LocalRuntimeState, List<Override>, Future<void> Function(WidgetTester)?)>{
      'appearance': (() => _beside(AppearanceStepPage(onDone: () {})), unpackingState(0.42), const [], null),
      'appearance, low-end, failed': (
        () => _beside(AppearanceStepPage(onDone: () {})),
        const LocalRuntimeState(loaded: true, status: failedStatus),
        low,
        null,
      ),
      'connect': (() => _beside(ConnectPage(onDone: () {}), step: 3), unpackingState(0.68), const [], null),
      'sign-in waits': (
        () => _beside(ConnectPage(onDone: () {}), step: 3),
        unpackingState(0.68),
        const [],
        (tester) async {
          // At a large text size the page scrolls: bring the sign-in in first.
          final signIn = find.byType(FilledButton).first;
          await tester.ensureVisible(signIn);
          await tester.pump();
          await tester.tap(signIn);
          await frames(tester, 6);
          expect(find.byType(ProgressHalo), findsOneWidget);
        },
      ),
      'waiting': (() => RuntimeSetupPage(onDone: () {}, waiting: true), unpackingState(0.86), const [], null),
      'status sheet': (
        () => _beside(AppearanceStepPage(onDone: () {})),
        unpackingState(0.42),
        const [],
        (tester) async {
          await tester.tap(find.byKey(_capsule));
          await frames(tester, 6);
          expect(find.byKey(const ValueKey('setup-status-sheet')), findsOneWidget);
        },
      ),
      'status sheet, failed': (
        () => _beside(AppearanceStepPage(onDone: () {})),
        const LocalRuntimeState(loaded: true, status: failedStatus),
        const [],
        (tester) async {
          await tester.tap(find.byKey(_capsule));
          await frames(tester, 6);
          expect(find.byKey(const ValueKey('setup-status-sheet')), findsOneWidget);
        },
      ),
    };
    for (final english in [false, true]) {
      for (final scale in [1.3, 2.0]) {
        for (final MapEntry(key: name, value: (home, runtime, overrides, then)) in screens.entries) {
          final label = '$name (${english ? 'en' : 'zh'}, ×$scale)';
          testWidgets(label, (tester) async {
            await _pump(
              tester,
              home(),
              runtime: runtime,
              size: const Size(320, 568),
              scale: scale,
              english: english,
              overrides: overrides,
            );
            if (then != null) await then(tester);
            expect(tester.takeException(), isNull);
            _expectNothingCut(tester, label);
            // The capsule, where there is one, stays inside the page.
            final capsule = find.byKey(_capsule);
            if (capsule.evaluate().isNotEmpty) {
              final rect = tester.getRect(capsule);
              expect(rect.left, greaterThanOrEqualTo(24));
              expect(rect.right, lessThanOrEqualTo(320 - 24));
            }
          });
        }
      }
    }
  });
}
