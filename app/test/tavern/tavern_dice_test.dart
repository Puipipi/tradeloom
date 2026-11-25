import 'dart:math' as math;

import 'package:dsh_app/tavern/tavern_dice.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/common/fluid_bits.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_dice_sheet.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

Widget _app(Widget home, {bool reduced = false}) => ProviderScope(
  overrides: [
    tavernProvider.overrideWith((ref) => PreviewTavern(tick: const Duration(milliseconds: 1))),
    tavernDiceRandomProvider.overrideWithValue(math.Random(7)),
  ],
  child: MaterialApp(
    theme: withTestFonts(buildLightTheme()),
    locale: const Locale('zh', 'CN'),
    supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    builder: (context, child) =>
        reduced ? MediaQuery(data: MediaQuery.of(context).copyWith(disableAnimations: true), child: child!) : child!,
    home: home,
  ),
);

Future<void> _tap(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(ValueKey(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(ValueKey(key)));
  await tester.pump();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the dice', () {
    test('say what they are in tabletop notation', () {
      expect(const TavernDice().notation, '1d20');
      expect(const TavernDice(count: 2, sides: 6, modifier: 1).notation, '2d6+1');
      expect(const TavernDice(count: 3, sides: 8, modifier: -2).notation, '3d8-2');
    });

    test('roll faces on the dice, and add the modifier', () {
      const dice = TavernDice(count: 3, sides: 6, modifier: -2);
      for (var seed = 0; seed < 50; seed++) {
        final roll = dice.roll(math.Random(seed));
        expect(roll.faces, hasLength(3));
        expect(roll.faces.every((f) => f >= 1 && f <= 6), isTrue);
        expect(roll.total, roll.faces.reduce((a, b) => a + b) - 2);
        expect(roll.total, inInclusiveRange(dice.lowest, dice.highest));
      }
    });

    test('show their working only when one die does not say it all', () {
      expect(const TavernRoll(TavernDice(), [14]).working, isNull);
      expect(const TavernRoll(TavernDice(count: 2, sides: 6, modifier: 1), [3, 5]).working, '3 + 5 + 1');
      expect(const TavernRoll(TavernDice(sides: 20, modifier: -3), [12]).working, '12 − 3');
    });

    test('keep to their limits', () {
      expect(const TavernDice().copyWith(count: 0).count, 1);
      expect(const TavernDice().copyWith(count: 99).count, tavernDiceMaxCount);
      expect(const TavernDice().copyWith(modifier: -99).modifier, -tavernDiceMaxModifier);
    });
  });

  testWidgets('掷骰 above the box: the roll goes in on a line of its own', (tester) async {
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await tavern.createChat('sample-innkeeper');
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          tavernProvider.overrideWith((ref) => tavern),
          tavernDiceRandomProvider.overrideWithValue(math.Random(7)),
        ],
        child: MaterialApp(
          theme: withTestFonts(buildLightTheme()),
          locale: const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: TavernChatPage(chatId: chat),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // There even without quick replies.
    expect(find.byKey(const ValueKey('tavern-dice')), findsOneWidget);
    await tester.enterText(find.byType(TextField), '我拔剑砍过去');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('tavern-dice')));
    await tester.pumpAndSettle();

    await _tap(tester, 'tavern-dice-d6');
    await _tap(tester, 'tavern-dice-count-up');
    await _tap(tester, 'tavern-dice-modifier-up');
    await tester.pumpAndSettle();
    expect(find.text('2d6+1'), findsOneWidget);

    await _tap(tester, 'tavern-dice-roll');
    await tester.pump(TavernDiceSheet.tumble + const Duration(milliseconds: 200));
    await tester.pumpAndSettle();
    final expected = const TavernDice(count: 2, sides: 6, modifier: 1).roll(math.Random(7));
    expect(tester.widget<Text>(find.byKey(const ValueKey('tavern-dice-working'))).data, '2d6+1 · ${expected.working}');

    await _tap(tester, 'tavern-dice-use');
    await tester.pumpAndSettle();
    expect(find.byType(TavernDiceSheet), findsNothing);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '我拔剑砍过去\n🎲 2d6+1 掷出 ${expected.total}（${expected.working}）',
    );
  });

  testWidgets('with reduced motion the number lands at once', (tester) async {
    await tester.pumpWidget(_app(const Scaffold(body: TavernDiceSheet()), reduced: true));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('tavern-dice-roll')));
    await tester.pump();
    final expected = const TavernDice().roll(math.Random(7));
    expect(tester.widget<RollingCount>(find.byKey(const ValueKey('tavern-dice-total'))).text, '${expected.total}');
    expect(find.text('再掷一次'), findsOneWidget);
    expect(find.text('放进输入框'), findsOneWidget);
  });
}
