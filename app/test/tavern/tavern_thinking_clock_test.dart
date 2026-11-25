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

/// The preview, thinking for 3.5 s (five pieces, 0.7 s apart) before its
/// reply starts; then the reply a piece every 150 ms.
class _Thinker extends PreviewTavern {
  _Thinker() : super(tick: Duration.zero);

  @override
  Stream<TavernEvent> send(String chatId, String text) async* {
    var thought = false;
    await for (final event in super.send(chatId, text)) {
      if (!thought && event is TavernTextDelta) {
        thought = true;
        for (var i = 0; i < 5; i++) {
          yield TavernReasoningDelta(event.nodeId, '先想想她会怎么回答。');
          await Future<void>.delayed(const Duration(milliseconds: 700));
        }
      }
      // The pieces came in while it thought: spaced out again.
      if (event is TavernTextDelta) await Future<void>.delayed(const Duration(milliseconds: 150));
      yield event;
    }
  }
}

Finder get _clock => find.byKey(const ValueKey('tavern-thinking-clock'));

void main() {
  testWidgets('the thinking counts its seconds, stops when the reply starts, and goes with it', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final tavern = _Thinker();
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
    await tester.enterText(find.byType(TextField), '外面怎么了？');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));

    // Thinking, not yet a second in: no count.
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('思考中'), findsOneWidget);
    expect(_clock, findsNothing);

    // Two seconds in.
    for (var i = 0; i < 16; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.descendant(of: _clock, matching: find.text('2 秒')), findsOneWidget);

    // The reply has started at about 3.6 s: the count stays at what it was.
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.textContaining('这个问题', findRichText: true), findsOneWidget);
    expect(find.descendant(of: _clock, matching: find.text('3 秒')), findsOneWidget);
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.descendant(of: _clock, matching: find.text('3 秒')), findsOneWidget);

    // In and stored: the count went with the reply being written.
    for (var i = 0; i < 300; i++) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    await tester.pumpAndSettle();
    expect(find.textContaining('地下室'), findsOneWidget);
    expect(_clock, findsNothing);
  });
}
