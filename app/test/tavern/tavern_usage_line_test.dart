import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
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

/// The preview, its replies carrying what the provider reported: the greeting
/// (written by the card, not a model) none.
class _Reported extends PreviewTavern {
  _Reported({this.usage = const TavernUsage(promptTokens: 1200, cacheHitTokens: 900, completionTokens: 54), this.at})
    : super(tick: Duration.zero);

  final TavernUsage usage;

  /// When the replies say they were written, if not now.
  final DateTime? at;

  @override
  Future<List<TavernMessage>> path(String chatId, {int limit = 60, String? beforeNodeId}) async => [
    for (final (i, m) in (await super.path(chatId, limit: limit, beforeNodeId: beforeNodeId)).indexed)
      if (m.role == TavernRole.character && i > 0)
        TavernMessage(
          nodeId: m.nodeId,
          parentId: m.parentId,
          role: m.role,
          speaker: m.speaker,
          text: m.text,
          at: at ?? m.at,
          siblingIndex: m.siblingIndex,
          siblingCount: m.siblingCount,
          reportedUsage: usage,
        )
      else
        m,
  ];
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

Future<void> _openAfterOneExchange(WidgetTester tester, Map<String, Object> prefs, [_Reported? reported]) async {
  SharedPreferences.setMockInitialValues(prefs);
  final tavern = reported ?? _Reported();
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

const _line = '输入 1,200（命中缓存 900）· 输出 54';

void main() {
  for (final layout in ['bubble', 'novel']) {
    testWidgets('$layout: a reply shows the tokens it took; the greeting and your line none', (tester) async {
      await _openAfterOneExchange(tester, {'tavern.layout': layout});
      expect(find.text(_line), findsOneWidget);
      expect(find.byWidgetPredicate((w) => '${w.key}'.contains('tavern-usage-')), findsOneWidget);
    });
  }

  // A Wednesday, at peak (01:00-04:00 UTC) and off it.
  final peak = DateTime.utc(2026, 11, 11, 2);
  final offPeak = DateTime.utc(2026, 11, 11, 12);
  const pro = TavernUsage(promptTokens: 12000, cacheHitTokens: 9000, completionTokens: 540, model: 'deepseek-v4-pro');

  testWidgets('a DeepSeek reply adds what it cost, at the hour it was written', (tester) async {
    // 9000 × 0.044 + 3000 × 1.32 + 540 × 3.96 = 6494.4 per million tokens.
    await _openAfterOneExchange(tester, {}, _Reported(usage: pro, at: peak));
    expect(find.text('输入 12,000（命中缓存 9,000）· 输出 540 · 约\u00a0US\$0.0065'), findsOneWidget);
  });

  testWidgets('off peak it is half', (tester) async {
    await _openAfterOneExchange(tester, {}, _Reported(usage: pro, at: offPeak));
    expect(find.text('输入 12,000（命中缓存 9,000）· 输出 540 · 约\u00a0US\$0.0032'), findsOneWidget);
  });

  testWidgets('one too small for four places says so', (tester) async {
    const tiny = TavernUsage(promptTokens: 100, cacheHitTokens: 0, completionTokens: 10, model: 'deepseek-v4-flash');
    await _openAfterOneExchange(tester, {}, _Reported(usage: tiny, at: offPeak));
    expect(find.text('输入 100 · 输出 10 · 不到\u00a0US\$0.0001'), findsOneWidget);
  });

  testWidgets('a model not on the price list shows its tokens alone', (tester) async {
    const other = TavernUsage(promptTokens: 100, cacheHitTokens: 0, completionTokens: 10, model: 'gpt-x');
    await _openAfterOneExchange(tester, {}, _Reported(usage: other, at: peak));
    expect(find.text('输入 100 · 输出 10'), findsOneWidget);
  });

  testWidgets('turned off in 酒馆设置, no reply shows it', (tester) async {
    await _openAfterOneExchange(tester, {'tavern.showUsage': false});
    expect(find.text(_line), findsNothing);
  });

  testWidgets('酒馆设置 turns the line off and keeps it so', (tester) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(390, 844) * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_app(PreviewTavern(tick: Duration.zero), const TavernSettingsPage()));
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('tavern-show-usage'));
    await tester.scrollUntilVisible(row, 200, scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(find.descendant(of: row, matching: find.byType(Switch))).value, isTrue);
    await tester.tap(find.descendant(of: row, matching: find.byType(Switch)));
    await tester.pumpAndSettle();
    expect((await SharedPreferences.getInstance()).getBool('tavern.showUsage'), isFalse);
  });
}
