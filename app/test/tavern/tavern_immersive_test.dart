import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The sample chat in [layout], a few exchanges long: enough to read back.
Future<void> _openLong(WidgetTester tester, String layout) async {
  SharedPreferences.setMockInitialValues({'tavern.layout': layout});
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
  for (final line in ['外面怎么了？', '你认识他吗', '地下室在哪？', '我们走吧']) {
    await tester.enterText(find.byType(TextField), line);
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    for (var i = 0; i < 200; i++) {
      await tester.pump(const Duration(milliseconds: 5));
    }
    await tester.pumpAndSettle();
  }
  // Nothing typed now: the box lets go of the focus.
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pumpAndSettle();
}

bool _hidden(WidgetTester tester, String key) => tester
    .widget<IgnorePointer>(find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(IgnorePointer)).first)
    .ignoring;

Future<void> _drag(WidgetTester tester, double dy) async {
  await tester.drag(find.byKey(const ValueKey('tavern-transcript')), Offset(0, dy));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('小说: reading back, the header and the box step aside; a tap brings them back', (tester) async {
    await _openLong(tester, 'novel');
    expect(_hidden(tester, 'tavern-chrome-top'), isFalse);

    // Down the screen is back into the story (the list runs newest first).
    await _drag(tester, 500);
    expect(_hidden(tester, 'tavern-chrome-top'), isTrue);
    expect(_hidden(tester, 'tavern-chrome-bottom'), isTrue);

    await tester.tapAt(tester.getCenter(find.byKey(const ValueKey('tavern-transcript'))));
    await tester.pumpAndSettle();
    expect(_hidden(tester, 'tavern-chrome-top'), isFalse);
    expect(_hidden(tester, 'tavern-chrome-bottom'), isFalse);

    // Back into the story, then toward the newest lines: back again.
    await _drag(tester, 300);
    expect(_hidden(tester, 'tavern-chrome-top'), isTrue);
    await _drag(tester, -150);
    expect(_hidden(tester, 'tavern-chrome-top'), isFalse);
  });

  testWidgets('气泡 keeps its header and box while reading back', (tester) async {
    await _openLong(tester, 'bubble');
    await _drag(tester, 500);
    expect(_hidden(tester, 'tavern-chrome-top'), isFalse);
    expect(_hidden(tester, 'tavern-chrome-bottom'), isFalse);
  });
}
