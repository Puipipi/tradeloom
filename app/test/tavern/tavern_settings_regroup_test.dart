import 'dart:io';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_storage.dart';
import 'package:dsh_app/ui/tavern/tavern_preset_page.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _storage = TavernStorage(characters: 3 * 1024 * 1024, chats: 512 * 1024, live2d: 40 * 1024 * 1024, other: 2048);

Future<(PreviewTavern, String)> _open(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final tavern = PreviewTavern(tick: Duration.zero);
  final id = (await tester.runAsync(
    () => tavern.importPreset('{"temperature": 1.3, "openai_max_context": 16384}', fileName: '长篇小说.json'),
  ))!.preset.id;
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => tavern),
        tavernStorageProvider.overrideWith((ref) async => _storage),
      ],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: const TavernSettingsPage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (tavern, id);
}

Future<void> _reveal(WidgetTester tester, Key key) async {
  await tester.scrollUntilVisible(find.byKey(key), 300, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('模型与连接 comes first, then 生成 with the default preset on top', (tester) async {
    await _open(tester);
    expect(find.text('模型与连接'), findsOneWidget);
    final connection = tester.getTopLeft(find.byKey(const ValueKey('tavern-connection'))).dy;
    final generation = tester.getTopLeft(find.byKey(const ValueKey('tavern-generation'))).dy;
    expect(connection, lessThan(generation));
    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-default-preset')), matching: find.text('SillyTavern 默认预设')),
      findsOneWidget,
    );
  });

  testWidgets("a library preset as the default: its own numbers are changed in it, ST's rows go", (tester) async {
    final (tavern, id) = await _open(tester);
    expect(find.byKey(const ValueKey('tavern-max-context')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-default-preset-edit')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('tavern-default-preset')));
    await tester.pumpAndSettle();
    expect(find.text('新对话用的预设'), findsOneWidget);
    await tester.tap(find.byKey(ValueKey('tavern-default-preset-$id')));
    await tester.pumpAndSettle();

    final selection = (await tester.runAsync(() => tavern.presetSelection()))!;
    expect(selection.defaultPresetId, id);
    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-default-preset')), matching: find.text('长篇小说')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('tavern-max-context')), findsNothing);
    expect(find.byKey(const ValueKey('tavern-temperature')), findsNothing);
    expect(find.text('改「长篇小说」的参数'), findsOneWidget);
    expect(find.textContaining('新对话用「长篇小说」'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-default-preset-edit')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernPresetPage), findsOneWidget);
    Navigator.of(tester.element(find.byType(TavernPresetPage))).pop();
    await tester.pumpAndSettle();

    // Back to SillyTavern's own: the three rows return.
    await tester.tap(find.byKey(const ValueKey('tavern-default-preset')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-default-preset-st')));
    await tester.pumpAndSettle();
    expect((await tester.runAsync(() => tavern.presetSelection()))!.defaultPresetId, isNull);
    await _reveal(tester, const ValueKey('tavern-max-context'));
    expect(find.byKey(const ValueKey('tavern-default-preset-edit')), findsNothing);
  });

  testWidgets('数据 says how much room the tavern takes, and what it goes to', (tester) async {
    await _open(tester);
    await _reveal(tester, const ValueKey('tavern-storage'));
    final tile = find.byKey(const ValueKey('tavern-storage'));
    expect(find.descendant(of: tile, matching: find.text('44 MB')), findsOneWidget);

    await tester.tap(tile);
    await tester.pumpAndSettle();
    expect(find.text('存储占用 · 44 MB'), findsOneWidget);
    String size(String part) => tester
        .widgetList<Text>(
          find.descendant(of: find.byKey(ValueKey('tavern-storage-$part')), matching: find.byType(Text)),
        )
        .last
        .data!;
    expect(size('characters'), '3.0 MB');
    expect(size('chats'), '512 KB');
    expect(size('live2d'), '40 MB');
    expect(size('other'), '2 KB');
    expect(find.textContaining('换手机或卸载前'), findsOneWidget);
  });

  test('the folder is measured by part, all the way down; a missing one is empty', () async {
    final root = await Directory.systemTemp.createTemp('dsh-tavern-storage-');
    addTearDown(() => root.delete(recursive: true));
    Future<void> put(String path, int bytes) async {
      final file = File('${root.path}/$path');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(List.filled(bytes, 1));
    }

    await put('characters/a/card.json', 100);
    await put('character-index/a.json', 7);
    await put('tavern.sqlite3', 200);
    await put('tavern.sqlite3-wal', 50);
    await put('live2d/x/model/model.moc3', 300);
    await put('lorebooks/b.json', 10);
    await put('backgrounds/c.jpg', 20);
    await put('settings.json', 5);

    final storage = await measureTavernStorage(root.path);
    expect(storage.characters, 107);
    expect(storage.chats, 250);
    expect(storage.live2d, 300);
    expect(storage.other, 35);
    expect(storage.total, 692);

    expect((await measureTavernStorage('${root.path}/nowhere')).total, 0);
  });
}
