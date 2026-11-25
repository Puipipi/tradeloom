import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_home_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// 对话 with a chat each for the innkeeper and the navigator.
Future<(String, String)> _open(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final tavern = PreviewTavern(tick: Duration.zero);
  final (inn, nav) = (await tester.runAsync(() async {
    final inn = await tavern.createChat('sample-innkeeper');
    await tavern.send(inn, '地下室在哪？').drain<void>();
    final nav = await tavern.createChat('sample-navigator');
    return (inn, nav);
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
        home: const TavernHomePage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-sections')), matching: find.text('对话')));
  await tester.pumpAndSettle();
  return (inn, nav);
}

Finder _row(String id) => find.byKey(ValueKey('tavern-chat-row-$id'));

Future<void> _search(WidgetTester tester, String q) async {
  await tester.enterText(
    find.descendant(of: find.byKey(const ValueKey('tavern-chat-search')), matching: find.byType(TextField)),
    q,
  );
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => TavernHomePage.searchFrom = 2);
  tearDown(() => TavernHomePage.searchFrom = 6);

  testWidgets('对话 narrows by who, and by the last line', (tester) async {
    final (inn, nav) = await _open(tester);
    expect(_row(inn), findsOneWidget);
    expect(_row(nav), findsOneWidget);

    await _search(tester, '星图');
    expect(_row(nav), findsOneWidget);
    expect(_row(inn), findsNothing);

    await _search(tester, '舰桥'); // the navigator's greeting, its last line
    expect(_row(nav), findsOneWidget);
    expect(_row(inn), findsNothing);

    await _search(tester, '没有这句话');
    expect(find.byKey(const ValueKey('tavern-chats-no-match')), findsOneWidget);
    expect(find.text('没有符合的对话'), findsOneWidget);

    await _search(tester, '');
    expect(_row(inn), findsOneWidget);
    expect(_row(nav), findsOneWidget);
  });

  testWidgets('a few chats need no search', (tester) async {
    TavernHomePage.searchFrom = 3;
    await _open(tester);
    expect(find.byKey(const ValueKey('tavern-chat-search')), findsNothing);
  });
}
