// Goldens for first run's 确认方式 sheet over 「想让 DSH Go 帮你做哪些事」:
// nothing chosen yet, and 全程自动 chosen with what stays with the person.
//
//   flutter test --update-goldens test/access/phone_mode_golden_test.dart

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/onboarding/access_step.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../phone/support.dart';
import '../shell/golden_harness.dart';
import '../support/english_preview.dart';
import 'support.dart';

Future<void> _frames(WidgetTester tester, [int n = 8]) async {
  for (var i = 0; i < n; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  for (final brightness in Brightness.values) {
    final mode = brightness == Brightness.dark ? 'dark' : 'light';
    for (final (name, auto, english) in [
      ('phone_mode', false, false),
      ('phone_mode_auto', true, false),
      ('en_phone_mode_auto', true, true),
    ]) {
      testWidgets('$name ($mode)', (tester) async {
        if (english) useEnglish();
        await tester.runAsync(loadGoldenFonts);
        // The disclosure was accepted already: picking 手机操控 goes straight to the choice.
        SharedPreferences.setMockInitialValues({PhoneController.disclosureKey: true});
        FakePhoneNative(status: phoneStatus(enabled: false)).install();
        usePhoneSurface(tester);
        const page = AccessStepPage(onDone: _none);
        await tester.pumpWidget(
          goldenApp(
            home: english ? inEnglish(page) : page,
            brightness: brightness,
            overrides: [
              ...accessOverrides(FakeAccessDriver(offPhone)),
              localRuntimeProvider.overrideWith(
                () => FakeRuntime(const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.installing))),
              ),
              settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
            ],
          ),
        );
        // Read now, so the accepted disclosure is known before the tap.
        ProviderScope.containerOf(tester.element(find.byType(MaterialApp))).read(phoneProvider);
        await _frames(tester);
        await tester.tap(find.byKey(const ValueKey('access-feature-phone')));
        await tester.pumpAndSettle();
        if (auto) {
          await tester.tap(find.byKey(const ValueKey('phone-mode-always')));
          await tester.pumpAndSettle();
        }
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/${name}_$mode.png'));
      });
    }
  }
}

void _none() {}
