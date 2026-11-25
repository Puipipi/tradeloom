import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_quick_replies.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_quick_replies_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

Future<void> _open(WidgetTester tester, PreviewTavern tavern, Widget home) async {
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

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 200; i++) {
    await tester.pump(const Duration(milliseconds: 5));
  }
  await tester.pumpAndSettle();
}

PreviewTavern _tavern() => PreviewTavern(tick: const Duration(milliseconds: 1));

void main() {
  testWidgets('quick replies are added, changed and removed, and kept', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await _open(tester, _tavern(), const TavernQuickRepliesPage());
    expect(find.text('还没有快速回复'), findsOneWidget);

    await tester.tap(find.text('加一条'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('tavern-qr-field')), '*环顾四周*');
    await tester.tap(find.byKey(const ValueKey('tavern-qr-save')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-qr-add')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('tavern-qr-field')), '你叫什么名字？');
    await tester.tap(find.byKey(const ValueKey('tavern-qr-save')));
    await tester.pumpAndSettle();

    // Change the first, then remove it.
    await tester.tap(find.text('*环顾四周*'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('tavern-qr-field')), '*推开门*');
    await tester.tap(find.byKey(const ValueKey('tavern-qr-save')));
    await tester.pumpAndSettle();
    expect(find.text('*推开门*'), findsOneWidget);

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getStringList(TavernQuickReplies.key), ['*推开门*', '你叫什么名字？']);

    await tester.tap(find.byKey(const ValueKey('tavern-qr-delete-0')));
    await tester.pumpAndSettle();
    expect(prefs.getStringList(TavernQuickReplies.key), ['你叫什么名字？']);
  });

  testWidgets('in a chat, a quick reply sends on tap and fills the box on long-press', (tester) async {
    SharedPreferences.setMockInitialValues({
      TavernQuickReplies.key: ['外面怎么了？', '*坐到壁炉边*'],
    });
    final tavern = _tavern();
    final chat = await tavern.createChat('sample-innkeeper');
    await _open(tester, tavern, TavernChatPage(chatId: chat));

    expect(find.byKey(const ValueKey('tavern-quick-replies')), findsOneWidget);
    await tester.longPress(find.byKey(const ValueKey('tavern-qr-1')));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, '*坐到壁炉边*'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-qr-0')));
    await _settle(tester);
    final path = await tavern.path(chat);
    expect(path.map((m) => m.text), contains('外面怎么了？'));
    expect(find.textContaining('地下室'), findsOneWidget); // the reply to it
    // The box keeps what was being written.
    expect(find.widgetWithText(TextField, '*坐到壁炉边*'), findsOneWidget);
  });

  testWidgets('全部 shows every quick reply whole: a tap sends, the pencil fills the box', (tester) async {
    const long = '我把湿透的外套挂在门边，抖掉帽檐上的雨水，然后走到柜台前，问她今晚还有没有空房。';
    SharedPreferences.setMockInitialValues({
      TavernQuickReplies.key: ['外面怎么了？', long],
    });
    final tavern = _tavern();
    final chat = await tavern.createChat('sample-innkeeper');
    await _open(tester, tavern, TavernChatPage(chatId: chat));

    final all = find.byKey(const ValueKey('tavern-qr-all'));
    await tester.scrollUntilVisible(
      all,
      100,
      scrollable: find.descendant(
        of: find.byKey(const ValueKey('tavern-quick-replies')),
        matching: find.byType(Scrollable),
      ),
    );
    await tester.tap(all);
    await tester.pumpAndSettle();
    expect(find.text(long), findsOneWidget); // whole, not cut to the capsule
    expect(find.byKey(const ValueKey('tavern-qr-manage')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-qr-all-edit-1')));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, long), findsOneWidget);

    await tester.tap(all);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-qr-all-0')));
    await _settle(tester);
    expect((await tavern.path(chat)).map((m) => m.text), contains('外面怎么了？'));
  });

  testWidgets('with no quick replies there is no 全部', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final tavern = _tavern();
    final chat = await tavern.createChat('sample-innkeeper');
    await _open(tester, tavern, TavernChatPage(chatId: chat));
    expect(find.byKey(const ValueKey('tavern-dice')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-qr-all')), findsNothing);
  });
}
