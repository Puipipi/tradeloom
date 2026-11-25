import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_inspector_page.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, its replies reporting [usage], written on a Wednesday at
/// peak (02:00 UTC).
class _Priced extends PreviewTavern {
  _Priced(this.usage) : super(tick: Duration.zero);

  final TavernUsage usage;

  @override
  Stream<TavernEvent> send(String chatId, String text) => super
      .send(chatId, text)
      .map(
        (e) => switch (e) {
          TavernTurnDone(:final message, :final finishReason) => TavernTurnDone(
            TavernMessage(
              nodeId: message.nodeId,
              parentId: message.parentId,
              role: message.role,
              speaker: message.speaker,
              text: message.text,
              at: DateTime.utc(2026, 11, 11, 2),
              siblingIndex: message.siblingIndex,
              siblingCount: message.siblingCount,
              reportedUsage: usage,
            ),
            finishReason: finishReason,
          ),
          _ => e,
        },
      );
}

/// A group round where each member's reply reports [usage] by who wrote it.
class _PricedGroup extends PreviewTavern {
  _PricedGroup(this.usage) : super(tick: Duration.zero);

  final Map<String, TavernUsage> usage;

  @override
  Stream<TavernGroupEvent> sendGroup(String chatId, String text, {String? speakerCharacterId}) => super
      .sendGroup(chatId, text, speakerCharacterId: speakerCharacterId)
      .map(
        (e) => switch (e) {
          TavernGroupMemberEvent(:final progress, :final characterId, event: TavernTurnDone(:final message)) =>
            TavernGroupMemberEvent(
              progress: progress,
              characterId: characterId,
              event: TavernTurnDone(
                TavernMessage(
                  nodeId: message.nodeId,
                  parentId: message.parentId,
                  role: message.role,
                  speaker: message.speaker,
                  text: message.text,
                  at: DateTime.utc(2026, 11, 11, 2),
                  speakerCharacterId: message.speakerCharacterId,
                  reportedUsage: usage[characterId],
                ),
              ),
            ),
          _ => e,
        },
      );
}

Widget _app(PreviewTavern tavern, Widget home) => ProviderScope(
  overrides: [tavernProvider.overrideWith((ref) => tavern)],
  child: MaterialApp(
    theme: withTestFonts(buildLightTheme()),
    locale: const Locale('zh', 'CN'),
    supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: home,
  ),
);

/// 120000 in (none cached) and 2000 out on v4-pro at peak:
/// 120000 × 1.32 + 2000 × 3.96 = 166320 per million.
const _big = TavernUsage(promptTokens: 120000, cacheHitTokens: 0, completionTokens: 2000, model: 'deepseek-v4-pro');

Future<void> _oneTurn(WidgetTester tester, Map<String, Object> prefs, [TavernUsage usage = _big]) async {
  SharedPreferences.setMockInitialValues(prefs);
  final tavern = _Priced(usage);
  final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_app(tavern, TavernChatPage(chatId: chat)));
  await tester.pumpAndSettle();
  await tester.enterText(find.byType(TextField), '外面怎么了？');
  await tester.pump();
  await tester.tap(find.byIcon(AppIcons.send));
  for (var i = 0; i < 100; i++) {
    await tester.pump(const Duration(milliseconds: 5));
  }
  await tester.pumpAndSettle();
}

const _said = '这一回合约\u00a0US\$0.1663，超过了提醒线 US\$0.10';

void main() {
  testWidgets('a turn over the line is said over the composer; 看看发了什么 opens what went in', (tester) async {
    await _oneTurn(tester, {TavernSettingsController.costAlertKey: 0.1});
    final notice = find.byKey(const ValueKey('tavern-notice'));
    expect(find.descendant(of: notice, matching: find.text(_said)), findsOneWidget);
    await tester.tap(find.descendant(of: notice, matching: find.text('看看发了什么')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernInspectorPage), findsOneWidget);
  });

  testWidgets('its button sits beside the words with room, under them when narrow and large', (tester) async {
    await _oneTurn(tester, {TavernSettingsController.costAlertKey: 0.1});
    final notice = find.byKey(const ValueKey('tavern-notice'));
    final words = find.descendant(of: notice, matching: find.text(_said));
    final button = find.descendant(of: notice, matching: find.text('看看发了什么'));
    expect(tester.getRect(button).left, greaterThan(tester.getRect(words).right));

    tester.platformDispatcher.textScaleFactorTestValue = 1.3;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    tester.view.physicalSize = const Size(360, 740) * 2;
    await tester.pumpAndSettle();
    expect(tester.getRect(button).top, greaterThanOrEqualTo(tester.getRect(words).bottom));
    // The words keep the row: a line or two, not a column.
    expect(tester.getRect(words).width, greaterThan(200));
  });

  testWidgets('under the line: nothing said', (tester) async {
    await _oneTurn(tester, {TavernSettingsController.costAlertKey: 0.5});
    expect(find.byKey(const ValueKey('tavern-notice')), findsNothing);
  });

  testWidgets('off, as it starts: nothing said', (tester) async {
    await _oneTurn(tester, {});
    expect(find.byKey(const ValueKey('tavern-notice')), findsNothing);
  });

  testWidgets('a model not on the price list: nothing said', (tester) async {
    await _oneTurn(tester, {
      TavernSettingsController.costAlertKey: 0.01,
    }, const TavernUsage(promptTokens: 120000, cacheHitTokens: 0, completionTokens: 2000, model: 'gpt-x'));
    expect(find.byKey(const ValueKey('tavern-notice')), findsNothing);
  });

  testWidgets('酒馆设置 › 生成 picks the line, off until chosen, and keeps it', (tester) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(390, 844) * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_app(PreviewTavern(tick: Duration.zero), const TavernSettingsPage()));
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('tavern-cost-alert'));
    await tester.scrollUntilVisible(row, 200, scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: row, matching: find.text('\$0.05')));
    await tester.pumpAndSettle();
    expect((await SharedPreferences.getInstance()).getDouble(TavernSettingsController.costAlertKey), 0.05);
  });

  testWidgets("a group round: its costliest reply is the one said, once the round ends", (tester) async {
    SharedPreferences.setMockInitialValues({TavernSettingsController.costAlertKey: 0.1});
    final tavern = _PricedGroup({
      'sample-innkeeper': const TavernUsage(
        promptTokens: 60000,
        cacheHitTokens: 0,
        completionTokens: 1000,
        model: 'deepseek-v4-pro',
      ),
      'sample-navigator': _big,
    });
    final chat = (await tester.runAsync(
      () => tavern.createGroupChat(
        ['sample-innkeeper', 'sample-navigator'],
        activation: TavernGroupActivation.listOrder,
        addGreetings: false,
      ),
    ))!;
    tester.view.physicalSize = const Size(390, 844) * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_app(tavern, TavernChatPage(chatId: chat)));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '大家好');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    for (var i = 0; i < 200; i++) {
      await tester.pump(const Duration(milliseconds: 5));
    }
    await tester.pumpAndSettle();
    final notice = find.byKey(const ValueKey('tavern-notice'));
    expect(find.descendant(of: notice, matching: find.text(_said)), findsOneWidget);
  });

  test('a stored line outside the range reads as off', () async {
    SharedPreferences.setMockInitialValues({TavernSettingsController.costAlertKey: -1.0});
    final container = ProviderContainer();
    addTearDown(container.dispose);
    container.read(tavernSettingsProvider);
    await Future<void>.delayed(Duration.zero);
    expect(container.read(tavernSettingsProvider).costAlert, 0);
  });
}
