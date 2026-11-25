// Goldens for first run's 「想让 DSH Go 帮你做哪些事」 beside the unpack (the
// pick, a step, a step after a denial, a maker's switch after the trip, the
// restricted-settings steps, the summary) and 设置 › 系统权限, on a vivo.
//
//   flutter test --update-goldens test/access/access_golden_test.dart

import 'package:dsh_app/phone/phone_channel.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/access_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/access/access_pick_page.dart';
import 'package:dsh_app/ui/access/access_summary_page.dart';
import 'package:dsh_app/ui/access/access_walk.dart';
import 'package:dsh_app/ui/onboarding/access_step.dart';
import 'package:dsh_app/ui/onboarding/onboarding_scaffold.dart';
import 'package:dsh_app/ui/settings/system_access_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show ProviderScope;
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../onboarding/parallel_setup_support.dart';
import '../shell/golden_harness.dart';
import '../support/english_preview.dart';
import 'support.dart';

/// Step 3 of 4 with the unpack's capsule, as first run shows it.
Widget _beside(Widget page) => OnboardingProgress(step: 3, steps: 4, runtime: true, onRemote: () {}, child: page);

/// Overrides built inside each test (fakes made at load time would live
/// outside the test's zone).
List<Override> Function() _with(AccessReadings readings, {Answer? answer, Set<String> visited = const {}}) => () {
  SharedPreferences.setMockInitialValues({if (visited.isNotEmpty) AccessVisitedController.prefsKey: [...visited]});
  return [
    localRuntimeProvider.overrideWith(() => UnpackingRuntime(unpackingState(0.55))),
    settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
    ...notifications(enabled: true),
    ...accessOverrides(FakeAccessDriver(readings, answer: answer)),
  ];
};

void _light(
  String name,
  Widget Function() home,
  List<Override> Function() overrides, {
  bool english = false,
  Brightness brightness = Brightness.light,
  Future<void> Function(WidgetTester tester)? before,
}) {
  final dark = brightness == Brightness.dark;
  testWidgets('$name (${[if (english) 'en', if (dark || !english) brightness.name].join(' ')})', (tester) async {
    if (english) useEnglish();
    await tester.runAsync(loadGoldenFonts);
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(home: english ? inEnglish(home()) : home(), brightness: brightness, overrides: overrides()),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    if (before != null) await before(tester);
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/${english ? 'en_' : ''}${name}_${brightness.name}.png'),
    );
  });
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.tap(finder);
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Widget _pick() => _beside(AccessPickPage(onPicked: (_, _) {}, onSkip: () {}));

Widget _walk(List<AccessItem> items) => _beside(AccessWalk(items: items, onDone: () {}));

final _vivoWalk = accessWalk({AccessFeature.voice, AccessFeature.background}, 'vivo');

final _summaryReadings = readingsWith(offPhone, mic: true, notifications: true, battery: true, accessibility: true);

Widget _summary() => _beside(AccessSummaryPage(items: accessWalk(AccessFeature.values, 'vivo'), voice: true, onDone: () {}));

void main() {
  goldenBoth('access_pick', _pick, overrides: _with(offPhone));
  _light('access_pick', _pick, _with(offPhone), english: true);
  _light(
    'access_pick_voice_metered',
    _pick,
    _with(readingsWith(offPhone, metered: true)),
    before: (tester) async {
      await _tap(tester, find.byKey(const ValueKey('access-feature-voice')));
      await _tap(tester, find.byKey(const ValueKey('access-feature-background')));
    },
  );

  goldenBoth('access_walk', () => _walk(_vivoWalk), overrides: _with(readingsWith(offPhone, mic: true)));
  _light(
    'access_walk_retry',
    () => _walk(_vivoWalk),
    _with(readingsWith(offPhone, mic: true, notifications: true), answer: (_, r) => r),
    before: (tester) => _tap(tester, find.byKey(const ValueKey('access-primary'))),
  );
  goldenBoth(
    'access_walk_vendor',
    () => _walk(_vivoWalk),
    overrides: _with(readingsWith(offPhone, mic: true, notifications: true, battery: true), answer: (_, r) => r),
    before: (tester) async {
      await _tap(tester, find.byKey(const ValueKey('access-primary')));
      await awayAndBack(tester);
    },
  );

  final restricted = readingsWith(offPhone, notifications: true, restricted: RestrictedSettingsState.guarded);
  final phoneWalk = accessWalk({AccessFeature.phone}, 'vivo');
  goldenBoth('access_walk_restricted', () => _walk(phoneWalk), overrides: _with(restricted));
  _light('access_walk_restricted', () => _walk(phoneWalk), _with(restricted), english: true);

  goldenBoth('access_summary', _summary, overrides: _with(_summaryReadings, visited: {'vendorBackground'}));
  _light('access_summary', _summary, _with(_summaryReadings, visited: {'vendorBackground'}), english: true);
  _light(
    'access_summary',
    _summary,
    _with(_summaryReadings, visited: {'vendorBackground'}),
    english: true,
    brightness: Brightness.dark,
  );

  // 继续 failed (the readings could not be taken): the notice with 重试.
  late FlakyAccessDriver flaky;
  goldenBoth(
    'access_summary_finish_failed',
    () => _beside(AccessStepPage(onDone: () {})),
    overrides: () {
      SharedPreferences.setMockInitialValues({});
      flaky = FlakyAccessDriver(readingsWith(offPhone, mic: true));
      return [
        localRuntimeProvider.overrideWith(() => UnpackingRuntime(unpackingState(0.55))),
        settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
        ...notifications(enabled: true),
        ...accessOverrides(flaky),
      ];
    },
    before: (tester) async {
      final c = ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
      await c.read(accessSetupProvider.notifier).choose({AccessFeature.voice});
      for (var i = 0; i < 20 && find.byKey(const ValueKey('access-summary-done')).evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      flaky.failures = 1;
      await _tap(tester, find.byKey(const ValueKey('access-summary-done')));
    },
  );

  goldenBoth(
    'system_access',
    () => const SystemAccessPage(),
    overrides: _with(readingsWith(offPhone, notifications: true, mic: true), visited: {'autostart'}),
  );
}
