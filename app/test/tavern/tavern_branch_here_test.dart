import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The chat with the greeting and three lines of yours after it.
Future<(PreviewTavern, String)> _open(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final tavern = PreviewTavern(tick: Duration.zero);
  final chat = (await tester.runAsync(() async {
    final chat = await tavern.createChat('sample-innkeeper');
    for (final line in ['（我推门进来。）', '（我坐到炉边。）', '（我看向楼梯。）']) {
      await tavern.sendOnly(chat, line);
    }
    return chat;
  }))!;
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
        home: TavernChatPage(chatId: chat),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (tavern, chat);
}

Future<void> _menuOn(WidgetTester tester, String text) async {
  await tester.longPress(find.textContaining(text, findRichText: true).last);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('从这里分叉 ends the story at that message and keeps the rest; 撤销 picks the old end', (tester) async {
    final (tavern, chat) = await _open(tester);
    await _menuOn(tester, '我坐到炉边');
    await tester.tap(find.byKey(const ValueKey('tavern-menu-branchHere')));
    await tester.pumpAndSettle();

    final path = (await tester.runAsync(() => tavern.path(chat)))!;
    expect(path.last.text, '（我坐到炉边。）');
    expect(find.textContaining('我看向楼梯', findRichText: true), findsNothing);
    // Nothing gone: the old end is still in the tree.
    final tree = (await tester.runAsync(() => tavern.tree(chat)))!;
    expect(tree.map((n) => n.preview), contains('（我看向楼梯。）'));

    await tester.tap(find.text('撤销'));
    await tester.pumpAndSettle();
    expect((await tester.runAsync(() => tavern.path(chat)))!.last.text, '（我看向楼梯。）');
    expect(find.textContaining('我看向楼梯', findRichText: true), findsOneWidget);
  });

  testWidgets('the newest message has nothing after it to branch from', (tester) async {
    await _open(tester);
    await _menuOn(tester, '我看向楼梯');
    expect(find.byKey(const ValueKey('tavern-menu-branchHere')), findsNothing);
  });
}
