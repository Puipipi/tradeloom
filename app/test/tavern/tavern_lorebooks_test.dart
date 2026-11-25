import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_files.dart';
import 'package:dsh_app/ui/tavern/tavern_lorebooks_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// An ST world file: entries by uid.
final _world = jsonEncode({
  'entries': {
    '0': {
      'uid': 0,
      'key': ['雨镇'],
      'content': '镇上的雨下了三天。',
    },
    '1': {
      'uid': 1,
      'key': ['地下室'],
      'content': '地下室锁着。',
    },
  },
});

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
        home: const TavernLorebooksPage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return shared;
}

Future<void> _import(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('tavern-lorebook-import')));
  await tester.pumpAndSettle();
}

Future<void> _act(WidgetTester tester, String id, String action) async {
  await tester.tap(find.byKey(ValueKey('tavern-lorebook-$id')));
  await tester.pumpAndSettle();
  await tester.tap(find.text(action));
  await tester.pumpAndSettle();
}

Future<List<Object?>?> _global(PreviewTavern tavern) async =>
    ((await tavern.readSettings())['lorebooks'] as Map<String, Object?>?)?['global'] as List<Object?>?;

void main() {
  testWidgets('with none yet, the page says what imports and where a card\'s own lives', (tester) async {
    await _open(tester, PreviewTavern(tick: Duration.zero));
    expect(find.byKey(const ValueKey('tavern-lorebooks-empty')), findsOneWidget);
  });

  testWidgets('an ST lorebook imports named after its file, with its entries counted', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _open(tester, tavern, picked: [_file('雨镇.json', _world)]);
    await _import(tester);
    final books = await tavern.listLorebooks();
    expect(books.single.name, '雨镇');
    expect(find.text('已导入「雨镇」，2 条'), findsOneWidget);
    expect(find.text('2 条'), findsOneWidget);
  });

  testWidgets('a lorebook is used in every chat, then not; exported as it is', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final shared = await _open(tester, tavern, picked: [_file('雨镇.json', _world)]);
    await _import(tester);
    final id = (await tavern.listLorebooks()).single.id;
    final row = find.byKey(ValueKey('tavern-lorebook-$id'));

    await _act(tester, id, '对所有对话生效');
    expect(await _global(tavern), [id]);
    expect(find.descendant(of: row, matching: find.text('全局')), findsOneWidget);

    await _act(tester, id, '不再对所有对话生效');
    expect(await _global(tavern), isEmpty);
    expect(find.descendant(of: row, matching: find.text('全局')), findsNothing);

    await _act(tester, id, '导出世界书');
    expect(shared.single.single.fileName, '雨镇.json');
    expect(utf8.decode(shared.single.single.bytes), contains('地下室锁着'));
  });

  testWidgets('deleting asks first, and takes it out of every chat too', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _open(tester, tavern, picked: [_file('雨镇.json', _world)]);
    await _import(tester);
    final id = (await tavern.listLorebooks()).single.id;
    await _act(tester, id, '对所有对话生效');

    await _act(tester, id, '删除世界书');
    expect(find.text('删除世界书「雨镇」？'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '删除'));
    await tester.pumpAndSettle();
    expect(await tavern.listLorebooks(), isEmpty);
    expect(await _global(tavern), isEmpty);
  });

  testWidgets('a file that is not a lorebook says it could not be imported', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _open(tester, tavern, picked: [_file('预设.json', '{"temperature": 1}')]);
    await _import(tester);
    expect(await tavern.listLorebooks(), isEmpty);
    expect(find.textContaining('没能导入'), findsOneWidget);
  });
}
