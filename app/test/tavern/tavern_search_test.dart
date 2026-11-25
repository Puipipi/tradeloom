import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_search_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

Future<(PreviewTavern, String)> _chat(WidgetTester tester) async {
  final tavern = PreviewTavern(tick: Duration.zero);
  final chat = (await tester.runAsync(() async {
    final chat = await tavern.createChat('sample-innkeeper');
    await tavern.send(chat, '外面怎么了？').drain<void>();
    await tavern.send(chat, '地下室在哪？').drain<void>();
    return chat;
  }))!;
  return (tavern, chat);
}

Future<void> _pump(WidgetTester tester, PreviewTavern tavern, Widget home) async {
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
        home: home,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _type(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField), text);
  await tester.pump(const Duration(milliseconds: 300));
  await tester.pumpAndSettle();
}

void main() {
  test('a hit shows the words around the match, cut before it', () {
    expect(tavernSearchSnippet('她说：\n去地下室看看。', '地下室'), ('她说： 去', '地下室', '看看。'));
    final (before, match, after) = tavernSearchSnippet('${'雨' * 30}地下室', '地下室');
    expect(before, '…${'雨' * 20}');
    expect((match, after), ('地下室', ''));
    // Letters regardless of case; the match as written.
    expect(tavernSearchSnippet('Go to the Cellar.', 'cellar').$2, 'Cellar');
    // Matched by the speaker's name: the start of the text.
    expect(tavernSearchSnippet('「进来吧。」', '林晚'), ('「进来吧。」', '', ''));
  });

  testWidgets('a word finds every message with it, newest first, and says how many', (tester) async {
    final (tavern, chat) = await _chat(tester);
    await _pump(tester, tavern, TavernSearchPage(chatId: chat));
    expect(find.textContaining('所有分支'), findsOneWidget);

    await _type(tester, '地下室');
    expect(find.text('找到 3 条，新的在前'), findsOneWidget);
    final hits = find.byWidgetPredicate((w) => '${w.key}'.contains('tavern-chat-search-hit-'));
    expect(hits, findsNWidgets(3));
    // Your question, second newest, with the match marked in it.
    expect(find.descendant(of: hits.at(1), matching: find.textContaining('在哪？', findRichText: true)), findsOneWidget);
  });

  testWidgets('nothing found says so; cleared, the page is as it opened', (tester) async {
    final (tavern, chat) = await _chat(tester);
    await _pump(tester, tavern, TavernSearchPage(chatId: chat));
    await _type(tester, '码头');
    expect(find.text('没有找到「码头」'), findsOneWidget);
    await _type(tester, '');
    expect(find.textContaining('所有分支'), findsOneWidget);
  });

  testWidgets('a hit opens whole, and copies', (tester) async {
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String);
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    final (tavern, chat) = await _chat(tester);
    await _pump(tester, tavern, TavernSearchPage(chatId: chat));
    await _type(tester, '在哪');
    await tester.tap(find.byWidgetPredicate((w) => '${w.key}'.contains('tavern-chat-search-hit-')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-chat-search-whole')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-chat-search-copy')));
    await tester.pumpAndSettle();
    expect(copied, ['地下室在哪？']);
    expect(find.text('已复制'), findsOneWidget);
  });

  testWidgets('舞台 › 本局 opens the search', (tester) async {
    final (tavern, chat) = await _chat(tester);
    await _pump(tester, tavern, TavernChatPage(chatId: chat));
    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('tavern-chat-search'));
    await tester.scrollUntilVisible(row, 200, scrollable: find.byType(Scrollable).last);
    await tester.pumpAndSettle();
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.byType(TavernSearchPage), findsOneWidget);
  });
}
