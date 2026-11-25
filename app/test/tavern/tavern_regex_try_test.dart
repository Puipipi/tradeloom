import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_regex_page.dart';
import 'package:dsh_app/ui/tavern/tavern_regex_test_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The regex library with one rule ([json]), its 试一下 page opened.
Future<void> _openTry(WidgetTester tester, String json) async {
  SharedPreferences.setMockInitialValues({});
  final tavern = PreviewTavern(tick: Duration.zero);
  final id = (await tester.runAsync(() => tavern.importRegexScripts(json)))!.scripts.single.id;
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
        home: const TavernRegexPage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(ValueKey('tavern-regex-$id')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('试一下'));
  await tester.pumpAndSettle();
  expect(find.byType(TavernRegexTestPage), findsOneWidget);
}

/// Types [text] and tries it; the rule runs in its own worker, in real time.
Future<void> _try(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(const ValueKey('tavern-regex-test-input')), text);
  await tester.tap(find.byKey(const ValueKey('tavern-regex-test-run')));
  for (var i = 0; i < 40 && find.byKey(const ValueKey('tavern-regex-test-run')).evaluate().isNotEmpty; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    final button = tester.widget<FilledButton>(find.byKey(const ValueKey('tavern-regex-test-run')));
    if (button.onPressed != null) break;
  }
  await tester.pumpAndSettle();
}

/// Leaves the page: its worker is closed, and the close's own grace timer runs out.
Future<void> _leave(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
  await tester.pump(const Duration(seconds: 2));
}

void main() {
  testWidgets('a rule tried on a line shows the line after it, and how many it replaced', (tester) async {
    await _openTry(tester, r'{"scriptName": "去星号", "findRegex": "/\\*([^*]+)\\*/g", "replaceString": "（$1）"}');
    expect(find.text(r'/\*([^*]+)\*/g'), findsOneWidget);
    await _try(tester, '*看了你一眼* 好啊。*笑*');
    expect(find.text('替换后（2 处）'), findsOneWidget);
    expect(
      tester.widget<SelectableText>(find.byKey(const ValueKey('tavern-regex-test-output'))).data,
      '（看了你一眼） 好啊。（笑）',
    );
    await _leave(tester);
  });

  testWidgets('a rule that is off still runs here; no match says so', (tester) async {
    await _openTry(tester, r'{"scriptName": "关着的", "findRegex": "/雨/g", "replaceString": "雪", "disabled": true}');
    await _try(tester, '天晴了。');
    expect(find.byKey(const ValueKey('tavern-regex-test-none')), findsOneWidget);
    await _try(tester, '雨停了，雨又下了。');
    expect(tester.widget<SelectableText>(find.byKey(const ValueKey('tavern-regex-test-output'))).data, '雪停了，雪又下了。');
    await _leave(tester);
  });

  testWidgets('a rule with macros says they are taken as written', (tester) async {
    await _openTry(tester, r'{"scriptName": "名字", "findRegex": "/{{char}}/g", "replaceString": "她"}');
    expect(find.textContaining('不展开'), findsOneWidget);
  });
}
