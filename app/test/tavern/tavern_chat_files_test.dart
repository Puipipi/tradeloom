import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_files.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, reading and writing ST chat files.
class _Files extends PreviewTavern {
  _Files({this.notices = const []}) : super(tick: const Duration(milliseconds: 1));

  final List<String> notices;
  final imported = <List<String>>[];
  final exported = <(String, String?)>[];

  @override
  Future<TavernChatImportResult> importChats(
    String characterId,
    List<TavernChatFile> files, {
    Map<String, String> lorebookIds = const {},
  }) async {
    imported.add([for (final f in files) f.fileName]);
    return TavernChatImportResult(
      chatIds: [for (var i = 0; i < files.length; i++) 'c$i'],
      chatsByFile: {for (final f in files) f.fileName: 'c0'},
      notices: notices,
    );
  }

  @override
  Future<List<TavernChatFile>> exportChat(String chatId, {String? fileName}) async {
    exported.add((chatId, fileName));
    return [TavernChatFile(fileName: fileName ?? 'chat.jsonl', bytes: Uint8List.fromList(utf8.encode('{}\n')))];
  }
}

TavernChatFile _file(String name) => TavernChatFile(fileName: name, bytes: Uint8List.fromList(utf8.encode('{}\n')));

Future<List<List<TavernChatFile>>> _open(WidgetTester tester, _Files tavern, List<TavernChatFile> picked) async {
  final shared = <List<TavernChatFile>>[];
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
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
        home: const TavernCharacterPage(characterId: 'sample-innkeeper'),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return shared;
}

Future<void> _importFromMore(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('tavern-character-more')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('tavern-import-chats')));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('export names drop path and reserved characters', () {
    expect(tavernChatFileName('林晚 2026-11-10 0530'), '林晚 2026-11-10 0530.jsonl');
    expect(tavernChatFileName('a/b:c'), 'a_b_c.jsonl');
    expect(tavernChatFileName(' '), 'chat.jsonl');
  });

  testWidgets('importing takes only .jsonl files and shows what the import noticed', (tester) async {
    final tavern = _Files(notices: ['世界书「雨镇」在本机找不到，导出时会原样保留。']);
    await _open(tester, tavern, [_file('主线.jsonl'), _file('封面.png')]);
    await _importFromMore(tester);

    expect(tavern.imported, [
      ['主线.jsonl'],
    ]);
    expect(find.text('导入了 1 段对话'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-import-notices')), findsOneWidget);
    expect(find.textContaining('世界书「雨镇」在本机找不到'), findsOneWidget);
  });

  testWidgets('files that are not .jsonl are not imported', (tester) async {
    final tavern = _Files();
    await _open(tester, tavern, [_file('卡.png')]);
    await _importFromMore(tester);

    expect(tavern.imported, isEmpty);
    expect(find.text('只能导入 .jsonl 聊天记录'), findsOneWidget);
  });

  testWidgets('a chat exports from its long-press menu, named after the character', (tester) async {
    final tavern = _Files();
    final chat = await tavern.createChat('sample-innkeeper');
    final shared = await _open(tester, tavern, const []);

    // To the middle of the screen, clear of the floating header.
    await tester.scrollUntilVisible(
      find.byKey(ValueKey('tavern-chat-$chat')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await Scrollable.ensureVisible(tester.element(find.byKey(ValueKey('tavern-chat-$chat'))), alignment: 0.5);
    await tester.pumpAndSettle();
    await tester.longPress(find.byKey(ValueKey('tavern-chat-$chat')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('导出聊天记录'));
    await tester.pumpAndSettle();

    expect(tavern.exported.single.$1, chat);
    expect(tavern.exported.single.$2, startsWith('林晚 '));
    expect(tavern.exported.single.$2, endsWith('.jsonl'));
    expect(shared.single.single.fileName, tavern.exported.single.$2);
  });
}
