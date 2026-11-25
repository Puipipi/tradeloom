import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

Future<void> _openCharacter(WidgetTester tester, PreviewTavern tavern) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [tavernProvider.overrideWith((ref) => tavern)],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: const TavernCharacterPage(characterId: 'sample-innkeeper'),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('对话, 设定 and 配置 each show their own part; the picture and 继续上次 stay on top', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await tester.runAsync(() => tavern.createChat('sample-innkeeper'));
    await _openCharacter(tester, tavern);
    Future<void> tab(String label) async {
      await tester.tap(
        find.descendant(of: find.byKey(const ValueKey('tavern-character-tabs')), matching: find.text(label)),
      );
      await tester.pumpAndSettle();
    }

    // 对话 first: the greetings and the way to start.
    expect(find.byKey(const ValueKey('tavern-greetings')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-start')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-lorebook')), findsNothing);

    await tab('设定');
    expect(find.byKey(const ValueKey('tavern-character-card')), findsOneWidget);
    expect(find.textContaining('知道很多事', findRichText: true), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-greetings')), findsNothing);
    expect(find.byKey(const ValueKey('tavern-continue-last')), findsOneWidget);

    await tab('配置');
    expect(find.byKey(const ValueKey('tavern-lorebook')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-character-report')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-character-card')), findsNothing);

    await tab('对话');
    expect(find.byKey(const ValueKey('tavern-greetings')), findsOneWidget);
  });

  testWidgets('a first visit has 开始 as its one main button', (tester) async {
    await _openCharacter(tester, PreviewTavern(tick: Duration.zero));
    expect(find.byKey(const ValueKey('tavern-continue-last')), findsNothing);
    expect(find.widgetWithText(FilledButton, '开始'), findsOneWidget);
  });

  testWidgets('the greetings, notes and definition come from the details, which the list leaves out', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final listed = (await tester.runAsync(() => tavern.watchCharacters().first))!
        .firstWhere((c) => c.id == 'sample-innkeeper');
    expect(listed.greetings, isEmpty);
    expect(listed.description, isEmpty);
    await _openCharacter(tester, tavern);

    expect(find.textContaining('带进一阵冷雨', findRichText: true), findsWidgets);
    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-character-tabs')), matching: find.text('设定')),
    );
    await tester.pumpAndSettle();
    final definition = find.textContaining('知道很多事', findRichText: true);
    await tester.scrollUntilVisible(definition, 200, scrollable: find.byType(Scrollable).first);
    expect(definition, findsOneWidget);
    expect(find.textContaining('用来预览酒馆的界面', findRichText: true), findsOneWidget);
  });

  testWidgets('back again, 继续上次 opens the newest chat; a new one is from a greeting', (tester) async {
    // A clock a second on at each read: the two chats never share a moment
    // (warm, both are made within one millisecond).
    var now = DateTime(2026, 11, 11, 9);
    final tavern = PreviewTavern(tick: Duration.zero, clock: () => now = now.add(const Duration(seconds: 1)));
    await tester.runAsync(() => tavern.createChat('sample-innkeeper'));
    final newest = (await tester.runAsync(() => tavern.createChat('sample-innkeeper', greeting: 1)))!;
    await _openCharacter(tester, tavern);

    final resume = find.byKey(const ValueKey('tavern-continue-last'));
    expect(resume, findsOneWidget);
    // On the first screen, above the greetings.
    expect(
      tester.getTopLeft(resume).dy,
      lessThan(tester.getTopLeft(find.byKey(const ValueKey('tavern-greetings'))).dy),
    );
    expect(find.widgetWithText(OutlinedButton, '用这个开场白开始新对话'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '开始'), findsNothing);

    await tester.tap(resume);
    await tester.pumpAndSettle();
    expect(tester.widget<TavernChatPage>(find.byType(TavernChatPage)).chatId, newest);
  });
}
