// Measured, not eyeballed (docs/design/polish-guide.md §1): the 解除限制
// confirmation's hold key and disclaimer, the 「已解除限制」 tag, 确认方式's
// 「这些由你来操作」 lines, and first run's 确认方式 sheet.

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/common/list_page_row.dart';
import 'package:dsh_app/ui/onboarding/access_step.dart';
import 'package:dsh_app/ui/phone/hold_to_confirm.dart';
import 'package:dsh_app/ui/phone/phone_control_screen.dart';
import 'package:dsh_app/ui/phone/phone_unlock_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../access/support.dart';
import '../shell/golden_harness.dart';
import 'harness.dart';
import 'support.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final (name, size, scale) in [
    ('phone', const Size(390, 844), 1.0),
    ('320 dp × 2', const Size(320, 900), 2.0),
  ]) {
    testWidgets('the hold key: equal gutters, its label centred, nothing overflows ($name)', (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await pumpPhone(tester, const PhoneUnlockConfirmPage(unlock: PhoneUnlock.systemPages), size: size);
      final key = tester.getRect(find.byType(HoldToConfirmButton));
      expect(key.left, closeTo(size.width - key.right, 0.5));
      expect(key.left, 16);
      expect(key.height, HoldToConfirmButton.height);
      // Both faces' labels sit on the key's centre, the filled one exactly over the other.
      final faces = find.descendant(of: find.byType(HoldToConfirmButton), matching: find.byType(Text));
      expect(faces, findsNWidgets(2));
      final label = tester.getRect(faces.first);
      expect(label.center.dx, closeTo(key.center.dx, 0.5));
      expect(label.center.dy, closeTo(key.center.dy, 0.5));
      expect(tester.getRect(faces.last), label);
      // The disclaimer lines up with the cards above it.
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('unlock-disclaimer')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      final card = tester.getRect(find.byKey(const ValueKey('unlock-disclaimer')));
      expect(card.left, 16);
      expect(card.right, closeTo(size.width - 16, 0.5));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('the 「已解除限制」 tag: equal ends, everything on its centre line', (tester) async {
    await pumpPhone(
      tester,
      const PhoneControlScreen(),
      native: FakePhoneNative(
        policies: {
          ...defaultPolicies(),
          'unlocks': {'ownApp': true},
        },
      ),
    );
    final tag = tester.getRect(find.byKey(const ValueKey('unlocked-tag')));
    final icon = tester.getRect(find.byKey(const ValueKey('unlocked-tag-icon')));
    final chevron = tester.getRect(find.byKey(const ValueKey('unlocked-tag-chevron')));
    final label = tester.getRect(find.text('已解除限制'));
    expect(tag.height, UnlockedTag.height);
    expect(icon.left - tag.left, UnlockedTag.pad);
    expect(tag.right - chevron.right, UnlockedTag.pad);
    for (final r in [icon, chevron, label]) {
      expect(r.center.dy, closeTo(tag.center.dy, 0.5));
    }
    // On the overview card's left edge.
    expect(tag.left, 16);
  });

  testWidgets('确认方式: 「这些由你来操作」 lines start where the rows\' titles do', (tester) async {
    await pumpPhone(tester, const PhoneControlScreen());
    await tester.ensureVisible(find.text('确认方式'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认方式'));
    await tester.pumpAndSettle();
    final yours = find.byKey(const ValueKey('confirm-yours'));
    final line = tester.getRect(find.descendant(of: yours, matching: find.text('密码和验证码')));
    final row = tester.getRect(find.descendant(of: yours, matching: find.text('应用名单')));
    final mode = tester.getRect(find.descendant(of: find.byType(BottomSheet), matching: find.text('每次都询问')));
    expect(line.left, closeTo(row.left, 0.5));
    expect(line.left, closeTo(mode.left, 0.5));
    expect(tester.widgetList(find.descendant(of: yours, matching: find.byType(ListPageRow))), hasLength(2));
  });

  testWidgets('first run\'s 确认方式: the note and the key keep the sheet\'s gutters', (tester) async {
    SharedPreferences.setMockInitialValues({PhoneController.disclosureKey: true});
    FakePhoneNative(status: phoneStatus(enabled: false)).install();
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(
        home: AccessStepPage(onDone: () {}),
        brightness: Brightness.light,
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
    containerOf(tester).read(phoneProvider);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('access-feature-phone')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('phone-mode-always')));
    await tester.pumpAndSettle();
    final card = tester.getRect(find.byKey(const ValueKey('phone-mode-choices')));
    final note = tester.getRect(find.byKey(const ValueKey('phone-mode-auto-note')));
    final key = tester.getRect(find.byKey(const ValueKey('phone-mode-confirm')));
    final sheet = tester.getRect(find.byType(BottomSheet));
    // The note's box (its margin included) spans the sheet like the card's.
    expect(note.left, sheet.left);
    expect(note.right, sheet.right);
    expect(key.left - sheet.left, closeTo(sheet.right - key.right, 0.5));
    expect(card.left - sheet.left, closeTo(sheet.right - card.right, 0.5));
    // Both marks on one vertical line, as far in as the icons start.
    final ask = tester.getRect(find.byKey(const ValueKey('phone-mode-ask-mark')));
    final auto = tester.getRect(find.byKey(const ValueKey('phone-mode-always-mark')));
    expect(ask.center.dx, auto.center.dx);
    expect(tester.takeException(), isNull);
  });
}
