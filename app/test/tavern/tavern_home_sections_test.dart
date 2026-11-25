import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_home_page.dart';
import 'package:dsh_app/ui/tavern/tavern_personas.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

Future<void> _openHome(WidgetTester tester, PreviewTavern tavern) async {
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
        home: const TavernHomePage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _section(WidgetTester tester, String label) async {
  await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-sections')), matching: find.text(label)));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('书架 first: the characters, and no settings key in the header', (tester) async {
    await _openHome(tester, PreviewTavern(tick: Duration.zero));
    expect(find.byKey(const ValueKey('tavern-sections')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-character-sample-innkeeper')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-settings')), findsNothing); // 我的 holds them
  });

  testWidgets('对话 lists every chat, newest first, and opens one', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final first = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
    final second = (await tester.runAsync(() => tavern.createChat('sample-innkeeper', greeting: 1)))!;
    await _openHome(tester, tavern);

    await _section(tester, '对话');
    final rows = [first, second].map((id) => find.byKey(ValueKey('tavern-chat-row-$id')));
    expect(rows.first, findsOneWidget);
    expect(rows.last, findsOneWidget);
    // The newer one above.
    expect(tester.getTopLeft(rows.last).dy, lessThan(tester.getTopLeft(rows.first).dy));
    expect(find.textContaining('条消息'), findsWidgets);

    await tester.tap(rows.first);
    await tester.pumpAndSettle();
    expect(find.byType(TavernChatPage), findsOneWidget);
  });

  testWidgets('对话 with none yet says where to start', (tester) async {
    await _openHome(tester, PreviewTavern(tick: Duration.zero));
    await _section(tester, '对话');
    expect(find.byKey(const ValueKey('tavern-no-chats')), findsOneWidget);
  });

  testWidgets('资源库 opens the personas and quick replies', (tester) async {
    await _openHome(tester, PreviewTavern(tick: Duration.zero));
    await _section(tester, '资源库');
    expect(find.byKey(const ValueKey('tavern-library-presets')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-library-regex')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-library-lorebooks')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-library-quick-replies')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-library-personas')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernPersonasPage), findsOneWidget);
  });

  testWidgets('我的 is 酒馆设置, right on the home', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _openHome(tester, tavern);
    await _section(tester, '我的');
    expect(find.byKey(const ValueKey('tavern-model')), findsOneWidget);
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-max-context')), matching: find.text('64K')));
    await tester.pumpAndSettle();
    final preset = (await tavern.readSettings())['preset']! as Map<String, Object?>;
    expect(preset['openai_max_context'], 65536);
  });
}
