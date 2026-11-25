import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_files.dart';
import 'package:dsh_app/ui/tavern/tavern_presets_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _source = '﻿{\r\n  "temperature": 1.3, "openai_max_context": 32768\r\n}\r\n';

/// A preset file as a phone hands it over: bytes, a BOM first.
TavernChatFile _file(String name, String text) => TavernChatFile(
  fileName: name,
  bytes: Uint8List.fromList([
    if (text.startsWith('﻿')) ...[0xEF, 0xBB, 0xBF],
    ...utf8.encode(text.startsWith('﻿') ? text.substring(1) : text),
  ]),
);

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
        home: const TavernPresetsPage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return shared;
}

Future<void> _import(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('tavern-preset-import')));
  await tester.pumpAndSettle();
}

Future<void> _act(WidgetTester tester, String id, String action) async {
  await tester.tap(find.byKey(ValueKey('tavern-preset-$id')));
  await tester.pumpAndSettle();
  await tester.tap(find.text(action));
  await tester.pumpAndSettle();
}

Finder _defaultMark(String key) => find.descendant(of: find.byKey(ValueKey(key)), matching: find.text('默认'));

void main() {
  testWidgets('with none yet, SillyTavern\'s own is the default and the page says what imports', (tester) async {
    await _open(tester, PreviewTavern(tick: Duration.zero));
    expect(_defaultMark('tavern-preset-st'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-presets-empty')), findsOneWidget);
  });

  testWidgets('an imported preset keeps its text exactly, BOM included, named after its file', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _open(tester, tavern, picked: [_file('社区预设.json', _source)]);
    await _import(tester);

    final presets = await tavern.listPresets();
    expect(presets.single.name, '社区预设');
    expect((await tavern.preset(presets.single.id))!.sourceText, _source);
    expect(find.byKey(ValueKey('tavern-preset-${presets.single.id}')), findsOneWidget);
    expect(find.text('已导入「社区预设」'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-presets-empty')), findsNothing);
  });

  testWidgets('one is made the default, then SillyTavern\'s own again', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _open(tester, tavern, picked: [_file('社区预设.json', _source)]);
    await _import(tester);
    final id = (await tavern.listPresets()).single.id;

    await _act(tester, id, '设为默认');
    expect(_defaultMark('tavern-preset-$id'), findsOneWidget);
    expect(_defaultMark('tavern-preset-st'), findsNothing);
    expect((await tavern.presetSelection()).defaultPresetId, id);

    await tester.tap(find.byKey(const ValueKey('tavern-preset-st')));
    await tester.pumpAndSettle();
    expect(_defaultMark('tavern-preset-st'), findsOneWidget);
    expect((await tavern.presetSelection()).defaultPresetId, isNull);
  });

  testWidgets('export hands over the source as it came; delete asks first', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final shared = await _open(tester, tavern, picked: [_file('社区预设.json', _source)]);
    await _import(tester);
    final id = (await tavern.listPresets()).single.id;

    await _act(tester, id, '导出预设');
    expect(shared.single.single.fileName, '社区预设.json');
    expect(utf8.decode(shared.single.single.bytes, allowMalformed: true), contains('"temperature": 1.3'));

    await _act(tester, id, '删除预设');
    expect(find.text('删除预设「社区预设」？'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '删除'));
    await tester.pumpAndSettle();
    expect(await tavern.listPresets(), isEmpty);
    expect(find.byKey(ValueKey('tavern-preset-$id')), findsNothing);
  });

  testWidgets('a file that is not a preset says why it could not be imported', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _open(tester, tavern, picked: [_file('笔记.txt', '这不是预设')]);
    await _import(tester);
    expect(await tavern.listPresets(), isEmpty);
    expect(find.textContaining('没能导入'), findsOneWidget);
  });
}
