// Goldens for first run set up while the runtime unpacks: 外观 and 连接
// DeepSeek with the unpack capsule, the sign-in waiting for the runtime, the
// waiting page, a failed unpack's capsule, and the status sheet.
//
//   flutter test --update-goldens test/onboarding/parallel_setup_golden_test.dart

import 'package:dsh_app/performance/performance_state.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/onboarding/appearance_step.dart';
import 'package:dsh_app/ui/onboarding/connect_page.dart';
import 'package:dsh_app/ui/onboarding/onboarding_scaffold.dart';
import 'package:dsh_app/ui/onboarding/runtime_setup_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../account/support.dart' show FakeBrowser;
import '../performance/support.dart';
import '../shell/golden_harness.dart';
import '../support/english_preview.dart';
import 'parallel_setup_support.dart';

Widget _beside(Widget page, {int step = 2}) =>
    OnboardingProgress(step: step, steps: 3, runtime: true, onRemote: () {}, child: page);

Widget _appearance() => _beside(AppearanceStepPage(onDone: () {}));

Widget _connect() => _beside(ConnectPage(onDone: () {}), step: 3);

/// Overrides built inside each test (fakes made at load time would live
/// outside the test's zone).
List<Override> Function() _with(LocalRuntimeState runtime, {List<Override> Function()? extra}) =>
    () => [
      localRuntimeProvider.overrideWith(() => UnpackingRuntime(runtime)),
      settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
      accountProvider.overrideWith(RecordingAccount.new),
      accountEngineStarterProvider.overrideWithValue(() async {}),
      accountBrowserProvider.overrideWithValue(FakeBrowser()),
      ...notifications(enabled: true),
      ...?extra?.call(),
    ];

final _failed = _with(const LocalRuntimeState(loaded: true, status: failedStatus));

Future<void> _openSheet(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('setup-capsule')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
}

Future<void> _signIn(WidgetTester tester) async {
  await tester.tap(find.byType(FilledButton).first);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
}

/// One golden, light only: `goldens/<name>_light.png`, or the English one.
void _light(
  String name,
  Widget Function() home,
  List<Override> Function() overrides, {
  bool english = false,
  Future<void> Function(WidgetTester tester)? before,
}) {
  testWidgets('$name (${english ? 'en' : 'light'})', (tester) async {
    if (english) useEnglish();
    await tester.runAsync(loadGoldenFonts);
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(home: english ? inEnglish(home()) : home(), brightness: Brightness.light, overrides: overrides()),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    if (before != null) await before(tester);
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/${english ? 'en_' : ''}${name}_light.png'),
    );
  });
}

void main() {
  goldenBoth('setup_appearance', _appearance, overrides: _with(unpackingState(0.42)));
  _light('setup_appearance', _appearance, _with(unpackingState(0.42)), english: true);
  _light(
    'setup_appearance_low_end',
    _appearance,
    _with(
      unpackingState(0.42),
      extra: () => [
        performanceChannelProvider.overrideWithValue(FakePerformanceChannel(Future.value(snapshot(DeviceTier.low)))),
      ],
    ),
  );
  _light('setup_capsule_failed', _appearance, _failed);

  goldenBoth('setup_connect', _connect, overrides: _with(unpackingState(0.68)));
  goldenBoth('setup_await_sign_in', _connect, overrides: _with(unpackingState(0.68)), before: _signIn);

  goldenBoth(
    'setup_waiting',
    () => RuntimeSetupPage(onDone: () {}, waiting: true),
    overrides: _with(unpackingState(0.86)),
  );

  goldenBoth('setup_status_sheet', _appearance, overrides: _with(unpackingState(0.42)), before: _openSheet);
  goldenBoth('setup_status_sheet_failed', _appearance, overrides: _failed, before: _openSheet);
  _light('setup_status_sheet_failed', _appearance, _failed, english: true, before: _openSheet);
}
