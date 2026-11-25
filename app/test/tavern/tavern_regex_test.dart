import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_files.dart';
import 'package:dsh_app/ui/tavern/tavern_regex_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// Two ST regex scripts, exported together.
final _scripts = jsonEncode([
  {'scriptName': '去掉思考', 'findRegex': '/<think>[\\s\\S]*?<\\/think>/g', 'replaceString': '', 'disabled': false},
  {'scriptName': '状态栏', 'findRegex': '/<status>(.*?)<\\/status>/s', 'replaceString': '', 'disabled': false},
]);

TavernChatFile _file(String name, String text) =>
    TavernChatFile(fileName: name, bytes: Uint8List.fromList(utf8.encode(text)));

Future<List<List<TavernChatFile>>> _open(
  WidgetTester tester,
  PreviewTavern tavern, {
  List<TavernChatFile> picked = const [],
}) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  final shared = <List<TavernChatFile>>[];
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => tavern),
        tavernChatPickerProvider.overrideWithValue(() async => picked),
        tavernChatSinkProvider.overrideWithValue((files) async => shared.add(files)),
      ],
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
  return shared;
}

Future<void> _import(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('tavern-regex-import')));
  await tester.pumpAndSettle();
}

Future<void> _act(WidgetTester tester, String id, String action) async {
  await tester.tap(find.byKey(ValueKey('tavern-regex-$id')));
  await tester.pumpAndSettle();
  await tester.tap(find.text(action));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('with none yet, the page says what imports and where card regex lives', (tester) async {
    await _open(tester, PreviewTavern(tick: Duration.zero));
    expect(find.byKey(const ValueKey('tavern-regex-empty')), findsOneWidget);
  });

  testWidgets('a list of scripts imports as scripts, each on, named and showing its pattern', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _open(tester, tavern, picked: [_file('regex.json', _scripts)]);
    await _import(tester);
    final scripts = await tavern.listRegexScripts();
    expect(scripts.map((s) => s.name), ['去掉思考', '状态栏']);
    expect(find.text('导入了 2 条正则'), findsOneWidget);
    expect(find.text('去掉思考'), findsOneWidget);
    expect(find.textContaining('<think>'), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(ValueKey('tavern-regex-${scripts.first.id}')), matching: find.text('开')),
      findsOneWidget,
    );
  });

  testWidgets('a script is turned off, exported as it is, and deleted after asking', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final shared = await _open(tester, tavern, picked: [_file('regex.json', _scripts)]);
    await _import(tester);
    final id = (await tavern.listRegexScripts()).first.id;
    final row = find.byKey(ValueKey('tavern-regex-$id'));

    await _act(tester, id, '停用');
    expect((await tavern.listRegexScripts()).first.enabled, isFalse);
    expect(find.descendant(of: row, matching: find.text('关')), findsOneWidget);

    await _act(tester, id, '导出正则');
    expect(shared.single.single.fileName, '去掉思考.json');
    expect(utf8.decode(shared.single.single.bytes), contains('<think>'));

    await _act(tester, id, '删除正则');
    expect(find.text('删除正则「去掉思考」？'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '删除'));
    await tester.pumpAndSettle();
    expect((await tavern.listRegexScripts()).map((s) => s.name), ['状态栏']);
  });

  testWidgets('a file that is not regex JSON says it could not be imported', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _open(tester, tavern, picked: [_file('note.txt', '不是 JSON')]);
    await _import(tester);
    expect(await tavern.listRegexScripts(), isEmpty);
    expect(find.textContaining('没能导入'), findsOneWidget);
  });
}
