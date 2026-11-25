import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, counting replies asked for; with [broken], adding a line
/// without a reply fails.
class _Counted extends PreviewTavern {
  _Counted({this.broken = false}) : super(tick: Duration.zero);

  final bool broken;
  int replies = 0;

  @override
  Stream<TavernEvent> send(String chatId, String text) {
    replies++;
    return super.send(chatId, text);
  }

  @override
  Future<TavernMessage> sendOnly(String chatId, String text) =>
      broken ? Future.error(StateError('disk full')) : super.sendOnly(chatId, text);
}

Future<String> _open(WidgetTester tester, PreviewTavern tavern, {String layout = 'bubble'}) async {
  SharedPreferences.setMockInitialValues({'tavern.layout': layout});
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
  return chat;
}

Future<void> _sendAs(WidgetTester tester, String line, String option) async {
  await tester.enterText(find.byType(TextField), line);
  await tester.pump();
  await tester.tap(find.byKey(const ValueKey('tavern-send-as')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(ValueKey(option)));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('the other ways to send show once a line is written', (tester) async {
    await _open(tester, _Counted());
    expect(find.byKey(const ValueKey('tavern-send-as')), findsNothing);
    expect(find.byKey(const ValueKey('tavern-write-for-me')), findsOneWidget);
    await tester.enterText(find.byType(TextField), '（我坐下了。）');
    await tester.pump();
    expect(find.byKey(const ValueKey('tavern-send-as')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-write-for-me')), findsNothing);
  });

  testWidgets('只发，不回复 puts the line in the story and asks for no reply', (tester) async {
    final tavern = _Counted();
    final chat = await _open(tester, tavern);
    await _sendAs(tester, '（我坐下了，没说话。）', 'tavern-send-only');
    final path = await tavern.path(chat);
    expect(path.last.role, TavernRole.user);
    expect(path.last.text, '（我坐下了，没说话。）');
    expect(tavern.replies, 0);
    expect(find.textContaining('我坐下了，没说话', findRichText: true), findsOneWidget);
    expect(find.text('正在回复…'), findsNothing);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
  });

  for (final layout in ['bubble', 'novel']) {
    testWidgets('$layout: narration goes in as the narrator and says so', (tester) async {
      final tavern = _Counted();
      final chat = await _open(tester, tavern, layout: layout);
      await _sendAs(tester, '雨停了。', 'tavern-narrate');
      final last = (await tavern.path(chat)).last;
      expect(last.role, TavernRole.narrator);
      expect(last.text, '雨停了。');
      expect(tavern.replies, 0);
      expect(find.textContaining('雨停了', findRichText: true), findsOneWidget);
      expect(find.text('旁白'), findsOneWidget);
      expect(find.text('System'), findsNothing);
    });
  }

  testWidgets('with a line written, a long press on send offers the same ways', (tester) async {
    final tavern = _Counted();
    final chat = await _open(tester, tavern);
    await tester.enterText(find.byType(TextField), '雨停了。');
    await tester.pump();
    await tester.longPress(find.byIcon(AppIcons.send));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-narrate')));
    await tester.pumpAndSettle();
    final last = (await tavern.path(chat)).last;
    expect((last.role, last.text), (TavernRole.narrator, '雨停了。'));
    expect(tavern.replies, 0);
  });

  testWidgets('a line that could not go in is back in the box, and says so', (tester) async {
    await _open(tester, _Counted(broken: true));
    await _sendAs(tester, '（我坐下了。）', 'tavern-send-only');
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, '（我坐下了。）');
    expect(find.text('没能发出去'), findsOneWidget);
  });
}
