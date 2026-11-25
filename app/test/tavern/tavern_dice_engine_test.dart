import 'dart:convert';
import 'dart:math' as math;

import 'package:dsh_app/tavern/deferred_tavern.dart';
import 'package:dsh_app/tavern/tavern_dice.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_tool_turns.dart';
import 'package:dsh_app/ui/common/fluid_bits.dart';
import 'package:dsh_app/ui/tavern/tavern_dice_sheet.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _chat = 'c1';
const _at = '2026-11-13T00:00:00.000Z';

/// The preview whose dice the engine rolls: each ask takes the next answer,
/// a receipt's committed (true, null, false) or a refusal.
class _Roller extends PreviewTavern {
  _Roller(this.answers) : super(tick: Duration.zero);

  final List<Object?> answers;
  final asked = <({String chatId, String actionId, String dice})>[];

  @override
  Future<TavernToolReceipt> rollDice(
    String chatId, {
    required String actionId,
    required String dice,
    String? label,
    int? target,
    String? expectedNodeId,
  }) async {
    asked.add((chatId: chatId, actionId: actionId, dice: dice));
    final answer = answers.removeAt(0);
    if (answer is TavernToolException) throw answer;
    final committed = answer as bool?;
    return TavernToolReceipt.fromJson({
      'version': 1,
      'receiptId': actionId,
      'executionId': actionId,
      'chatId': chatId,
      'kind': 'roll',
      'origin': 'manual',
      'status': switch (committed) {
        true => 'committed',
        null => 'unresolved',
        false => 'failed',
      },
      'committed': committed,
      'capturedParameters': {'dice': dice},
      if (committed == true) 'result': {'dice': dice, ..._faces(dice)},
      if (committed == false) 'error': {'message': 'dice_invalid'},
      'createdAt': _at,
      'updatedAt': _at,
    });
  }
}

/// What the engine lands on, faces the dice can show and the total with the
/// modifier: not what the sheet's own dice (seed 7) would.
Map<String, Object?> _faces(String dice) => switch (dice) {
  '2d6+1' => {
    'values': [4, 5],
    'total': 10,
  },
  _ => {
    'values': [19],
    'total': 19,
  },
};

TavernToolException _refused(TavernToolErrorCode code) =>
    TavernToolException(code: code, operation: 'rollDice', message: code.name, committed: false);

Future<void> _open(WidgetTester tester, Tavern tavern, {Map<String, Object> prefs = const {}}) async {
  SharedPreferences.setMockInitialValues(prefs);
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
        home: const Scaffold(body: TavernDiceSheet(chatId: _chat)),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(ValueKey(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(ValueKey(key)));
  await tester.pump();
  await tester.pump(TavernDiceSheet.tumble + const Duration(milliseconds: 100));
  await tester.pumpAndSettle();
}

String? _total(WidgetTester tester) {
  final total = find.byKey(const ValueKey('tavern-dice-total'));
  return total.evaluate().isEmpty ? null : tester.widget<RollingCount>(total).text;
}

bool _enabled(WidgetTester tester, String key) =>
    tester.widget<ButtonStyleButton>(find.byKey(ValueKey(key))).onPressed != null;

Future<String?> _kept() async => (await SharedPreferences.getInstance()).getString('$tavernRollIntentKey$_chat');

void main() {
  testWidgets('in a chat the engine rolls, and the sheet lands on its faces', (tester) async {
    final engine = _Roller([true]);
    await _open(tester, DeferredTavern(Future.value(engine)));
    await _tap(tester, 'tavern-dice-roll');

    expect(engine.asked.single.chatId, _chat);
    expect(engine.asked.single.dice, '1d20');
    expect(engine.asked.single.actionId, startsWith('dshgo-'));
    expect(_total(tester), '19');
    expect(find.text('放进输入框'), findsOneWidget);
    expect(await _kept(), isNull);
  });

  testWidgets('not settled: asked again as it was, never thrown anew', (tester) async {
    final engine = _Roller([null, true]);
    await _open(tester, DeferredTavern(Future.value(engine)));
    await _tap(tester, 'tavern-dice-roll');

    expect(find.text('结果还没确认，可以再查一次'), findsOneWidget);
    expect(_total(tester), isNull);
    expect(_enabled(tester, 'tavern-dice-roll'), isFalse);
    final kept = TavernRollIntent.fromJson(jsonDecode((await _kept())!))!;
    expect(kept.actionId, engine.asked.single.actionId);

    await _tap(tester, 'tavern-dice-recheck');
    expect(engine.asked, hasLength(2));
    expect(engine.asked.last.actionId, engine.asked.first.actionId);
    expect(_total(tester), '19');
    expect(find.byKey(const ValueKey('tavern-dice-recheck')), findsNothing);
    expect(await _kept(), isNull);
  });

  testWidgets('a roll left unsettled is there when the sheet opens again', (tester) async {
    final engine = _Roller([true]);
    final intent = const TavernRollIntent(chatId: _chat, actionId: 'dshgo-earlier', dice: '2d6+1');
    await _open(
      tester,
      DeferredTavern(Future.value(engine)),
      prefs: {'$tavernRollIntentKey$_chat': jsonEncode(intent.toJson())},
    );
    expect(find.text('上次那次掷骰还没确认'), findsOneWidget);
    expect(_enabled(tester, 'tavern-dice-roll'), isFalse);

    await _tap(tester, 'tavern-dice-recheck');
    expect(engine.asked.single, (chatId: _chat, actionId: 'dshgo-earlier', dice: '2d6+1'));
    expect(_total(tester), '10');
  });

  testWidgets('放弃这次 lets the unsettled roll go', (tester) async {
    final engine = _Roller([]);
    final intent = const TavernRollIntent(chatId: _chat, actionId: 'dshgo-earlier', dice: '1d20');
    await _open(
      tester,
      DeferredTavern(Future.value(engine)),
      prefs: {'$tavernRollIntentKey$_chat': jsonEncode(intent.toJson())},
    );
    await _tap(tester, 'tavern-dice-forget');
    expect(find.byKey(const ValueKey('tavern-dice-note')), findsNothing);
    expect(_enabled(tester, 'tavern-dice-roll'), isTrue);
    expect(await _kept(), isNull);
    expect(engine.asked, isEmpty);
  });

  testWidgets('dice turned off say so, and nothing waits', (tester) async {
    final engine = _Roller([_refused(TavernToolErrorCode.policyDisabled)]);
    await _open(tester, DeferredTavern(Future.value(engine)));
    await _tap(tester, 'tavern-dice-roll');
    expect(find.text('酒馆设置里关了掷骰'), findsOneWidget);
    expect(_enabled(tester, 'tavern-dice-roll'), isTrue);
    expect(await _kept(), isNull);
  });

  testWidgets('not saved: kept, to be asked again', (tester) async {
    final engine = _Roller([_refused(TavernToolErrorCode.storageFailure)]);
    await _open(tester, DeferredTavern(Future.value(engine)));
    await _tap(tester, 'tavern-dice-roll');
    expect(find.text('没确认上：storageFailure'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-dice-recheck')), findsOneWidget);
    expect(await _kept(), isNotNull);
  });

  testWidgets('a roll that failed says why and lets go', (tester) async {
    final engine = _Roller([false]);
    await _open(tester, DeferredTavern(Future.value(engine)));
    await _tap(tester, 'tavern-dice-roll');
    expect(find.text('没掷成：dice_invalid'), findsOneWidget);
    expect(_enabled(tester, 'tavern-dice-roll'), isTrue);
    expect(await _kept(), isNull);
  });

  test('notation back to dice', () {
    expect(TavernDice.parse('2d6+1')?.notation, '2d6+1');
    expect(TavernDice.parse('d8-2')?.notation, '1d8-2');
    expect(TavernDice.parse('1d20')?.notation, '1d20');
    expect(TavernDice.parse('dragon'), isNull);
  });
}
