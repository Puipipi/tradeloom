import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_report_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

TavernImportReport _report({bool stale = false}) => TavernImportReport(
  kind: TavernImportKind.character,
  checkedAt: DateTime.now(),
  verdict: TavernImportVerdict.partial,
  counts: const {'entriesStored': 37, 'helperScripts': 2, 'regexIncompatible': 1, 'scripts': 0},
  findings: const [
    TavernImportFinding(
      path: r'$.data.extensions.tavern_helper',
      code: 'helper-script-not-run',
      message: '此助手脚本保留原文；本引擎不提供助手脚本执行环境。',
      kind: TavernImportFindingKind.unsupported,
    ),
  ],
  renderLevel: 1,
  fingerprint: 'f',
  stale: stale,
);

/// The preview, with a report on file once [filed] (or after a check).
class _Reported extends PreviewTavern {
  _Reported({this.filed}) : super(tick: Duration.zero);

  TavernImportReport? filed;
  int checks = 0;

  @override
  Future<TavernImportReport?> readImportReport(TavernImportKind kind, String assetId) async => filed;

  @override
  Future<TavernImportReport> recheckImport(TavernImportKind kind, String assetId) async {
    checks++;
    return filed = _report();
  }
}

Future<void> _open(WidgetTester tester, PreviewTavern tavern, Widget home) async {
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
        home: home,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

const _page = TavernImportReportPage(kind: TavernImportKind.character, assetId: 'sample-innkeeper', name: '林晚');

void main() {
  testWidgets('a report says how much runs, what it holds, and what is kept but not run', (tester) async {
    await _open(tester, _Reported(filed: _report()), _page);
    expect(find.text('部分能用'), findsOneWidget);
    expect(find.textContaining('单条消息里的网页'), findsOneWidget);
    expect(find.text('世界书条目'), findsOneWidget);
    expect(find.text('37'), findsOneWidget);
    expect(find.text('酒馆助手脚本'), findsOneWidget);
    expect(find.text('脚本'), findsNothing); // a count of none is left out
    expect(find.textContaining('不提供助手脚本执行环境'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-report-stale')), findsNothing);
  });

  testWidgets('an asset from before reports is checked on request', (tester) async {
    final tavern = _Reported();
    await _open(tester, tavern, _page);
    expect(find.byKey(const ValueKey('tavern-report-none')), findsOneWidget);
    await tester.tap(find.text('检查一下'));
    await tester.pumpAndSettle();
    expect(tavern.checks, 1);
    expect(find.text('部分能用'), findsOneWidget);
  });

  testWidgets('a report from before an edit says so and checks again', (tester) async {
    final tavern = _Reported(filed: _report(stale: true));
    await _open(tester, tavern, _page);
    await tester.tap(find.byKey(const ValueKey('tavern-report-stale')));
    await tester.pumpAndSettle();
    expect(tavern.checks, 1);
    expect(find.byKey(const ValueKey('tavern-report-stale')), findsNothing);
  });

  testWidgets('the character page shows the verdict and opens the report', (tester) async {
    await _open(tester, _Reported(filed: _report()), const TavernCharacterPage(characterId: 'sample-innkeeper'));
    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-character-tabs')), matching: find.text('配置')),
    );
    await tester.pumpAndSettle();
    final tile = find.byKey(const ValueKey('tavern-character-report'));
    await tester.scrollUntilVisible(tile, 300, scrollable: find.byType(Scrollable).first);
    await Scrollable.ensureVisible(tester.element(tile), alignment: 0.5);
    await tester.pumpAndSettle();
    expect(find.descendant(of: tile, matching: find.text('部分能用')), findsOneWidget);
    await tester.tap(tile);
    await tester.pumpAndSettle();
    expect(find.byType(TavernImportReportPage), findsOneWidget);
  });
}
