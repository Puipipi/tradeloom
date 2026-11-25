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

/// The preview, counting stops; with [running], a reply already under way
/// when the page opens (as the engine keeps one going, T24).
class _Engine extends PreviewTavern {
  _Engine({this.running}) : super(tick: const Duration(milliseconds: 20));

  final Stream<TavernEvent> Function()? running;
  int stops = 0;

  @override
  void stop(String chatId) {
    stops++;
    super.stop(chatId);
  }

  @override
  Stream<TavernEvent> resumeTurn(String chatId) => running?.call() ?? const Stream.empty();

  /// 帮我写, slowly: half a line, then a pause.
  @override
  Stream<TavernEvent> impersonate(String chatId) async* {
    yield const TavernTextDelta('draft', '我推开门');
    await Future<void>.delayed(const Duration(milliseconds: 500));
    yield const TavernTextDelta('draft', '，四下看了看。');
  }
}

TavernMessage _reply(String text, {String? reasoning}) => TavernMessage(
  nodeId: 'live',
  role: TavernRole.character,
  speaker: '林晚',
  text: text,
  reasoning: reasoning,
  at: DateTime(2026, 11, 10),
);

/// A reply that has written half a sentence, then writes the rest.
Stream<TavernEvent> _halfWritten() async* {
  yield TavernTurnSnapshot(
    chatId: 'c',
    generationType: 'normal',
    startedAt: DateTime.now().subtract(const Duration(seconds: 3)),
    message: _reply('她把灯拧亮'),
  );
  await Future<void>.delayed(const Duration(milliseconds: 300));
  yield const TavernTextDelta('live', '了一点，又坐回柜台后面。');
  await Future<void>.delayed(const Duration(milliseconds: 300));
  yield TavernTurnDone(_reply('她把灯拧亮了一点，又坐回柜台后面。'));
}

/// A reply still thinking, five seconds in.
Stream<TavernEvent> _stillThinking() async* {
  yield TavernTurnSnapshot(
    chatId: 'c',
    generationType: 'normal',
    startedAt: DateTime.now().subtract(const Duration(seconds: 5)),
    message: _reply('', reasoning: '她在想该说多少。'),
  );
  await Future<void>.delayed(const Duration(seconds: 2));
  yield TavernTurnDone(_reply('「我想想。」'));
}

Future<String> _open(WidgetTester tester, _Engine tavern) async {
  SharedPreferences.setMockInitialValues({});
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
  return chat;
}

Future<void> _leave(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  // What the preview had in hand runs out.
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  testWidgets('leaving while she replies does not stop the reply', (tester) async {
    final tavern = _Engine();
    await _open(tester, tavern);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '外面怎么了？');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(find.text('正在回复…'), findsOneWidget);
    await _leave(tester);
    expect(tavern.stops, 0);
  });

  testWidgets('leaving while 帮我写 writes into the box stops it', (tester) async {
    final tavern = _Engine();
    await _open(tester, tavern);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-write-for-me')));
    await tester.pump(const Duration(milliseconds: 25));
    // Half a line in the box: still writing.
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, '我推开门');
    await _leave(tester);
    expect(tavern.stops, 1);
  });

  testWidgets('opening on a reply under way picks it up where it is and follows it to the end', (tester) async {
    final tavern = _Engine(running: _halfWritten);
    await _open(tester, tavern);
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('她把灯拧亮', findRichText: true), findsOneWidget);
    expect(find.text('正在回复…'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();
    expect(find.textContaining('她把灯拧亮了一点，又坐回柜台后面。', findRichText: true), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(find.text('正在回复…'), findsNothing);
    await _leave(tester);
    expect(tavern.stops, 0);
  });

  testWidgets('a reply still thinking is picked up with its count going on', (tester) async {
    final tavern = _Engine(running: _stillThinking);
    await _open(tester, tavern);
    await tester.pump();
    await tester.pump();
    expect(find.text('思考中'), findsOneWidget);
    final clock = find.byKey(const ValueKey('tavern-thinking-clock'));
    expect(find.descendant(of: clock, matching: find.textContaining('秒')), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('思考中'), findsNothing);
  });

  testWidgets('with nothing running the page opens as it was, and sends', (tester) async {
    final tavern = _Engine();
    await _open(tester, tavern);
    await tester.pumpAndSettle();
    expect(find.text('正在回复…'), findsNothing);
    await tester.enterText(find.byType(TextField), '外面怎么了？');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    for (var i = 0; i < 200; i++) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    await tester.pumpAndSettle();
    expect(find.textContaining('地下室', findRichText: true), findsOneWidget);
  });
}
