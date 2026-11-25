// Golden screenshots of phone control: the main page (mid-setup and off), the
// 显著披露 sheet, the restricted-settings guide and the app list (不打扰模式 is
// dnd_mode_golden_test.dart).
//
//   flutter test --update-goldens test/phone/phone_golden_test.dart

import 'package:dsh_app/phone/phone_channel.dart';
import 'package:dsh_app/ui/phone/app_rules_page.dart';
import 'package:dsh_app/ui/phone/a11y_restore_sheet.dart';
import 'package:dsh_app/ui/phone/hold_to_confirm.dart';
import 'package:dsh_app/ui/phone/phone_control_screen.dart';
import 'package:dsh_app/ui/phone/phone_unlock_page.dart';
import 'package:dsh_app/ui/phone/restricted_settings_guide.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';
import '../support/english_preview.dart';
import 'harness.dart';
import 'support.dart';

void phoneGolden(
  String name,
  Widget Function() home, {
  FakePhoneNative Function()? native,
  Size size = const Size(390, 844),
  Future<void> Function(WidgetTester tester)? before,
}) {
  for (final brightness in Brightness.values) {
    final mode = brightness == Brightness.dark ? 'dark' : 'light';
    testWidgets('$name ($mode)', (tester) async {
      await tester.runAsync(loadGoldenFonts);
      await pumpPhone(tester, home(), native: native?.call(), size: size, brightness: brightness);
      if (before != null) await before(tester);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/${name}_$mode.png'));
    });
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // Turned on, accessibility still off on a sideloaded vivo: the usual first visit.
  phoneGolden('phone_main', () => const PhoneControlScreen(), size: const Size(390, 1720));

  phoneGolden(
    'a11y_restore',
    () => const Scaffold(body: A11yRestoreSheet()),
    size: const Size(320, 680),
    native: () => FakePhoneNative(
      status: {
        ...phoneStatus(),
        'a11yKeeper': {
          'granted': false,
          'path': 'shizuku',
          'command': 'adb shell pm grant io.github.ccch1mneyyy.dsh_app android.permission.WRITE_SECURE_SETTINGS',
        },
      },
    ),
  );

  phoneGolden(
    'phone_off',
    () => const PhoneControlScreen(),
    native: () => FakePhoneNative(status: phoneStatus(enabled: false)),
  );

  phoneGolden(
    'phone_disclosure',
    () => const PhoneControlScreen(),
    native: () => FakePhoneNative(status: phoneStatus(enabled: false)),
    before: (tester) async {
      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();
    },
  );

  phoneGolden(
    'phone_confirm_mode',
    () => const PhoneControlScreen(),
    before: (tester) async {
      await tester.ensureVisible(find.text('确认方式'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认方式'));
      await tester.pumpAndSettle();
    },
  );

  phoneGolden('phone_restricted_guide', () => const RestrictedSettingsGuidePage(), size: const Size(390, 1240));

  phoneGolden('phone_app_rules', () => const PhoneAppRulesPage(), size: const Size(390, 1000));

  // 解除限制: all off, one on (its tag on the main page), the confirmation page and its hold.
  phoneGolden('phone_unlocks', () => const PhoneUnlockPage());

  phoneGolden(
    'phone_unlocks_on',
    () => const PhoneUnlockPage(),
    native: () => FakePhoneNative(
      policies: {
        ...defaultPolicies(),
        'unlocks': {'secretFields': true},
      },
    ),
  );

  phoneGolden(
    'phone_unlocked_main',
    () => const PhoneControlScreen(),
    native: () => FakePhoneNative(
      status: phoneStatus(a11y: true),
      policies: {
        ...defaultPolicies(),
        'unlocks': {'systemPages': true, 'secretFields': true},
      },
    ),
  );

  phoneGolden('phone_unlock_confirm', () => const PhoneUnlockConfirmPage(unlock: PhoneUnlock.secretFields));

  // The whole page, for reading every line.
  phoneGolden(
    'phone_unlock_confirm_full',
    () => const PhoneUnlockConfirmPage(unlock: PhoneUnlock.systemPages),
    size: const Size(390, 1240),
  );

  for (final brightness in Brightness.values) {
    final mode = brightness == Brightness.dark ? 'dark' : 'light';
    for (final (name, page) in [
      ('en_phone_unlocks', const PhoneUnlockPage()),
      ('en_phone_unlock_confirm_full', const PhoneUnlockConfirmPage(unlock: PhoneUnlock.secretFields)),
    ]) {
      testWidgets('$name ($mode)', (tester) async {
        useEnglish();
        await tester.runAsync(loadGoldenFonts);
        await pumpPhone(tester, inEnglish(page), size: const Size(390, 1240), brightness: brightness);
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/${name}_$mode.png'));
      });
    }
  }

  phoneGolden(
    'phone_unlock_holding',
    () => const PhoneUnlockConfirmPage(unlock: PhoneUnlock.ownApp),
    before: (tester) async {
      // Halfway through the hold.
      final gesture = await tester.startGesture(tester.getCenter(find.byType(HoldToConfirmButton)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 750));
      addTearDown(gesture.up);
    },
  );
}
