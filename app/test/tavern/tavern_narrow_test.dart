// docs/design/roleplay-ui.md §12: every tavern screen fits a 360-wide phone
// with the system's text at 1.3×. An overflow fails the test on its own.

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_quick_replies.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/tavern/tavern_character_edit_page.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_dice_sheet.dart';
import 'package:dsh_app/ui/tavern/tavern_home_page.dart';
import 'package:dsh_app/ui/tavern/tavern_inspector_page.dart';
import 'package:dsh_app/ui/tavern/tavern_lorebook_page.dart';
import 'package:dsh_app/ui/tavern/tavern_message_edit_page.dart';
import 'package:dsh_app/ui/tavern/tavern_personas.dart';
import 'package:dsh_app/ui/tavern/tavern_quick_replies_page.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/tavern/tavern_storybook_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _replies = ['*环顾四周，看看还有没有别的客人*', '你叫什么名字？', '*坐到壁炉边，把湿透的斗篷搭在椅背上*'];

Future<PreviewTavern> _tavern(WidgetTester tester, {int turns = 2}) async {
  final tavern = PreviewTavern(tick: Duration.zero);
  await tester.runAsync(() async {
    final chat = await tavern.createChat('sample-innkeeper');
    for (var i = 0; i < turns; i++) {
      await tavern.send(chat, '外面怎么了？这么晚还有人赶路吗？第 $i 次问').drain<void>();
    }
  });
  return tavern;
}

Future<String> _chat(PreviewTavern tavern) async => (await tavern.watchChats().first).first.id;

/// [home] on a 360 × 740 phone with text at 1.3×.
Future<void> _narrow(
  WidgetTester tester,
  PreviewTavern tavern,
  Widget home, {
  Map<String, Object> prefs = const {},
}) async {
  SharedPreferences.setMockInitialValues({TavernQuickReplies.key: _replies, ...prefs});
  tester.view.physicalSize = const Size(720, 1480);
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
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.3)),
          child: child!,
        ),
        home: home,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// Scrolls [scrollable] end to end, so everything on it gets laid out once.
Future<void> _through(WidgetTester tester, Finder scrollable) async {
  for (var i = 0; i < 12; i++) {
    await tester.drag(scrollable, const Offset(0, -400));
    await tester.pumpAndSettle();
  }
}

void main() {
  testWidgets('the home and a character', (tester) async {
    final tavern = await _tavern(tester);
    await _narrow(tester, tavern, const TavernHomePage());
    await _narrow(tester, tavern, const TavernCharacterPage(characterId: 'sample-innkeeper'));
    await _through(tester, find.byType(CustomScrollView).first);
  });

  for (final layout in TavernLayout.values) {
    testWidgets('a chat laid out as ${layout.name}, with its chips', (tester) async {
      final tavern = await _tavern(tester);
      final chat = await tester.runAsync(() => _chat(tavern));
      await _narrow(
        tester,
        tavern,
        TavernChatPage(chatId: chat!),
        prefs: {TavernSettingsController.layoutKey: layout.name},
      );
      expect(find.byKey(const ValueKey('tavern-quick-replies')), findsOneWidget);
    });
  }

  testWidgets('the chat\'s sheets: the quick look, a message\'s menu, the dice', (tester) async {
    final tavern = await _tavern(tester);
    final chat = await tester.runAsync(() => _chat(tavern));
    await _narrow(tester, tavern, TavernChatPage(chatId: chat!));

    // 舞台, its 本局 page first, scrolled through.
    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();
    await _through(tester, find.byKey(const ValueKey('tavern-stage')));
    Scaffold.of(tester.element(find.byKey(const ValueKey('tavern-stage')))).closeEndDrawer();
    await tester.pumpAndSettle();

    await tester.longPress(find.textContaining('地下室').last);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-menu-copy')), findsOneWidget);
    await _through(tester, find.byType(SingleChildScrollView).last);
    Navigator.of(tester.element(find.byKey(const ValueKey('tavern-menu-copy')))).pop();
    await tester.pumpAndSettle();

    // Last in the row, past the quick replies: the row scrolls to it.
    await tester.drag(find.byKey(const ValueKey('tavern-quick-replies')), const Offset(-2000, 0));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-dice')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernDiceSheet), findsOneWidget);
    await _through(
      tester,
      find.descendant(of: find.byType(TavernDiceSheet), matching: find.byType(SingleChildScrollView)),
    );
    expect(find.byType(TavernDiceSheet), findsOneWidget);
  });

  testWidgets('the pages around a chat', (tester) async {
    final tavern = await _tavern(tester);
    final chat = (await tester.runAsync(() => _chat(tavern)))!;
    for (final page in <Widget>[
      const TavernSettingsPage(),
      const TavernPersonasPage(),
      const TavernQuickRepliesPage(),
      const TavernLorebookPage(characterId: 'sample-innkeeper'),
      const TavernCharacterEditPage(characterId: 'sample-innkeeper'),
      TavernStorybookPage(chatId: chat, character: '林晚'),
      TavernInspectorPage(chatId: chat),
      const TavernMessageEditPage(speaker: '林晚', text: '「这么晚了还在赶路？进来吧，炉子还热着。」'),
    ]) {
      await _narrow(tester, tavern, page);
      await _through(tester, find.byType(Scrollable).first);
    }
  });
}
