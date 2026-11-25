import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_lorebooks_page.dart';
import 'package:dsh_app/ui/tavern/tavern_presets_page.dart';
import 'package:dsh_app/ui/tavern/tavern_regex_page.dart';
import 'package:dsh_app/ui/tavern/tavern_report_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, noting which report each page asks for.
class _Asked extends PreviewTavern {
  _Asked() : super(tick: Duration.zero);

  final asked = <(TavernImportKind, String)>[];

  @override
  Future<TavernImportReport?> readImportReport(TavernImportKind kind, String assetId) async {
    asked.add((kind, assetId));
    return null;
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

/// Taps [row], then 导入体检 in its actions.
Future<void> _report(WidgetTester tester, String row) async {
  await tester.tap(find.byKey(ValueKey(row)));
  await tester.pumpAndSettle();
  await tester.tap(find.text('导入体检'));
  await tester.pumpAndSettle();
  expect(find.byType(TavernImportReportPage), findsOneWidget);
}

void main() {
  testWidgets('a preset opens its import report', (tester) async {
    final tavern = _Asked();
    final id = (await tester.runAsync(() => tavern.importPreset('{"temperature": 1}', fileName: '社区预设.json')))!
        .preset
        .id;
    await _open(tester, tavern, const TavernPresetsPage());
    await _report(tester, 'tavern-preset-$id');
    expect(tavern.asked, contains((TavernImportKind.preset, id)));
  });

  testWidgets('a lorebook opens its import report', (tester) async {
    final tavern = _Asked();
    final id = (await tester.runAsync(() => tavern.importLorebook('{"entries": {}}', fileName: '雨镇.json')))!.book.id;
    await _open(tester, tavern, const TavernLorebooksPage());
    await _report(tester, 'tavern-lorebook-$id');
    expect(tavern.asked, contains((TavernImportKind.lorebook, id)));
  });

  testWidgets('a regex script opens its import report', (tester) async {
    final tavern = _Asked();
    final id = (await tester.runAsync(
      () => tavern.importRegexScripts('{"scriptName": "去星号", "findRegex": "/\\\\*/g", "replaceString": ""}'),
    ))!.scripts.single.id;
    await _open(tester, tavern, const TavernRegexPage());
    await _report(tester, 'tavern-regex-$id');
    expect(tavern.asked, contains((TavernImportKind.regex, id)));
  });
}
