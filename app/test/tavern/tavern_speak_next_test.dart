import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

Future<(PreviewTavern, String)> _open(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
  final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
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

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 200; i++) {
    await tester.pump(const Duration(milliseconds: 5));
  }
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('with nothing written, the send key lets her speak next, no line of yours added', (tester) async {
    final (tavern, chat) = await _open(tester);
    final key = find.bySemanticsLabel('让林晚接着说');
    expect(key, findsOneWidget);

    await tester.tap(key);
    await _settle(tester);
    final path = (await tester.runAsync(() => tavern.path(chat)))!;
    expect(path.map((m) => m.role), [TavernRole.character, TavernRole.character]);
    expect(path.last.text, isNotEmpty);
  });

  testWidgets('with a line written, the key sends it as usual', (tester) async {
    final (tavern, chat) = await _open(tester);
    await tester.enterText(find.byType(TextField), '外面怎么了？');
    await tester.pump();
    expect(find.bySemanticsLabel('让林晚接着说'), findsNothing);
    await tester.tap(find.bySemanticsLabel('发送'));
    await _settle(tester);
    final path = (await tester.runAsync(() => tavern.path(chat)))!;
    expect(path.map((m) => m.role), [TavernRole.character, TavernRole.user, TavernRole.character]);
  });
}
