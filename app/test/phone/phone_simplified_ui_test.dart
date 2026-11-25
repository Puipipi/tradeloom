import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/ui/phone/dnd_mode_page.dart';
import 'package:dsh_app/ui/phone/phone_control_screen.dart';
import 'package:dsh_app/ui/phone/phone_self_check_panel.dart';
import 'package:dsh_app/ui/phone/phone_widgets.dart';
import 'package:dsh_app/ui/settings/index/settings_pages.dart';
import 'package:dsh_app/ui/settings/index/spot_anchor.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/english_preview.dart';
import 'harness.dart';
import 'support.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('setup shows only the missing next step and advanced settings remain recoverable', (tester) async {
    final native = FakePhoneNative(status: phoneStatus(notifications: false));
    await pumpPhone(tester, const PhoneControlScreen(), native: native);
    expect(find.byType(PhoneStepRow), findsOneWidget);
    expect(find.text(appL10n.phoneControlAccessibilityService), findsOneWidget);
    expect(find.text(appL10n.phoneControlNotifications), findsNothing);
    expect(find.byType(PhoneSelfCheckPanel), findsNothing);
    expect(find.byKey(const ValueKey('android-shell-entry')), findsNothing);
    expect(find.byKey(const Key('phone-a11y-restore')), findsNothing);

    native.push(phoneStatus(a11y: true, notifications: false));
    await settlePhone(tester);
    expect(find.byType(PhoneStepRow), findsOneWidget);
    expect(find.text(appL10n.phoneControlAccessibilityService), findsNothing);
    expect(find.text(appL10n.phoneControlNotifications), findsOneWidget);

    native.push(phoneStatus(a11y: true));
    await settlePhone(tester);
    expect(find.byType(PhoneStepRow), findsNothing);
    expect(find.text(appL10n.phoneControlReadScreen), findsOneWidget);
    native.calls.clear();
    await openPhoneFold(tester, 'phone-more-options');
    expect(find.byType(PhoneSelfCheckPanel), findsNothing);
    expect(find.byKey(const ValueKey('phone-self-check-entry')), findsOneWidget);
    expect(find.byKey(const ValueKey('android-shell-entry')), findsOneWidget);
    expect(find.byKey(const Key('phone-a11y-restore')), findsOneWidget);
    expect(native.calls, isEmpty);
    final entry = find.byKey(const ValueKey('phone-self-check-entry'));
    await tester.ensureVisible(entry);
    await tester.tap(entry);
    await tester.pumpAndSettle();
    expect(find.byType(PhoneSelfCheckPage), findsOneWidget);
    expect(find.byType(DropdownButton<String>), findsNothing);
    expect(find.byKey(const ValueKey('self-check-save')), findsNothing);
    expect(find.byKey(const ValueKey('self-check-step-device')), findsNothing);
    expect(native.callsOf('phoneSelfCheckStatus'), hasLength(1));
    expect(native.callsOf('startPhoneSelfCheck'), isEmpty);
  });

  for (final spot in [Spots.phoneA11yRestore, Spots.phoneAutoCollapse, Spots.phoneReturn, Spots.phoneBackgroundGuide]) {
    testWidgets('settings search reveals folded phone setting without authorization: ${spot.id}', (tester) async {
      final native = FakePhoneNative(status: phoneStatus(a11y: true));
      await pumpPhone(tester, spotPage(spot), native: native, size: const Size(390, 844));
      await tester.pumpAndSettle();
      expect(find.byKey(SpotKey(spot.id)).hitTestable(), findsOneWidget);
      expect(tester.widget<PhoneOptionsFold>(find.byKey(const ValueKey('phone-more-options'))).initiallyOpen, isTrue);
      expect(
        native.methods.where(
          (method) => {
            'grantSecureSettings',
            'requestShizukuPermission',
            'setBackgroundMode',
            'prepareRoot',
            'setBackgroundKeep',
          }.contains(method),
        ),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
    });
  }

  for (final english in [false, true]) {
    testWidgets('connected page stays concise at 320dp with large text: english=$english', (tester) async {
      if (english) useEnglish();
      tester.platformDispatcher.textScaleFactorTestValue = 1.5;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final base = privilegedStatus(mode: 'shizuku', ready: true, provider: 'shizuku', running: true, granted: true);
      final native = FakePhoneNative(
        status: {
          ...base,
          'background': {
            ...(base['background'] as Map),
            'viewport': {'v': 1, 'preset': 'portrait'},
            'parallelism': {'v': 1, 'configuredLimit': 1, 'effectiveLimit': 1, 'heldSlots': 0},
          },
        },
      );
      await pumpPhone(
        tester,
        english ? inEnglish(const PhoneDndPage()) : const PhoneDndPage(),
        native: native,
        size: const Size(320, 844),
      );
      expect(find.text('Root'), findsNothing);
      expect(find.text('Sui'), findsNothing);
      expect(find.text(appL10n.phoneDndDirectAdb), findsNothing);
      expect(find.byKey(const ValueKey('phone-background-limit-2')), findsNothing);
      expect(find.byKey(const ValueKey('phone-viewport-landscape')), findsNothing);
      native.calls.clear();
      await openPhoneFold(tester, 'phone-dnd-options');
      expect(find.byKey(const ValueKey('phone-background-limit-2')), findsOneWidget);
      expect(find.byKey(const ValueKey('phone-viewport-landscape')), findsOneWidget);
      expect(native.calls, isEmpty);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('connection failure survives closing its details and changing visible choices', (tester) async {
    const reason = 'Connection lost: authorize again';
    final native = FakePhoneNative(
      status: privilegedStatus(mode: 'root', reason: reason),
    );
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    expect(find.widgetWithText(PhoneNote, reason), findsOneWidget);
    await openPhoneChannel(tester, 'Root');
    expect(find.widgetWithText(PhoneNote, reason), findsOneWidget);
    await openPhoneFold(tester, 'phone-dnd-channels');
    expect(find.widgetWithText(PhoneNote, reason), findsOneWidget);
    expect(native.callsOf('setBackgroundMode'), isEmpty);
    expect(native.callsOf('prepareRoot'), isEmpty);
  });
}
