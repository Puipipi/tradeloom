import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_lorebooks_page.dart';
import 'package:dsh_app/ui/tavern/tavern_personas.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

String _world(String key) => jsonEncode({
  'entries': {
    '0': {
      'uid': 0,
      'key': [key],
      'content': '$key的设定。',
    },
  },
});

/// The preview with two lorebooks in its library, 雨镇 on in every chat.
Future<(PreviewTavern, String town, String inn)> _library(WidgetTester tester) async {
  final tavern = PreviewTavern(tick: Duration.zero);
  final ids = (await tester.runAsync(() async {
    final town = (await tavern.importLorebook(_world('雨镇'), fileName: '雨镇.json')).book.id;
    final inn = (await tavern.importLorebook(_world('旅店'), fileName: '旅店.json')).book.id;
    await tavern.bindLorebooks([town]);
    return (town, inn);
  }))!;
  return (tavern, ids.$1, ids.$2);
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

/// Brings [target] to the middle of the page, clear of the glass header.
Future<void> _center(WidgetTester tester, Finder target) async {
  unawaited(Scrollable.ensureVisible(tester.element(target), alignment: 0.5));
  await tester.pumpAndSettle();
}

Future<void> _flip(WidgetTester tester, String id) async {
  await tester.tap(find.byKey(ValueKey('tavern-bind-lorebook-$id')));
  await tester.pumpAndSettle();
}

Future<void> _closeSheet(WidgetTester tester) async {
  await tester.tapAt(const Offset(195, 40));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('本局 binds a lorebook to this chat alone; the global one says so', (tester) async {
    final (tavern, town, inn) = await _library(tester);
    final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
    final other = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
    await _open(tester, tavern, TavernChatPage(chatId: chat));
    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();

    final row = find.byKey(const ValueKey('tavern-chat-lorebooks'));
    expect(find.descendant(of: row, matching: find.text('无')), findsOneWidget);
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.text('这段对话的世界书'), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(ValueKey('tavern-bind-lorebook-$town')), matching: find.text('1 条 · 全局')),
      findsOneWidget,
    );

    await _flip(tester, inn);
    expect(((await tavern.readSettings(chatId: chat))['lorebooks'] as Map)['chat'], [inn]);
    expect(((await tavern.readSettings(chatId: other))['lorebooks'] as Map)['chat'], isNull);
    expect(((await tavern.readSettings())['lorebooks'] as Map)['global'], [town]);

    await _closeSheet(tester);
    expect(find.descendant(of: row, matching: find.text('1 本')), findsOneWidget);
  });

  testWidgets('the character page binds lorebooks to every chat with the character', (tester) async {
    final (tavern, town, inn) = await _library(tester);
    await _open(tester, tavern, const TavernCharacterPage(characterId: 'sample-innkeeper'));
    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-character-tabs')), matching: find.text('配置')),
    );
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('tavern-character-lorebooks'));
    await tester.scrollUntilVisible(row, 200, scrollable: find.byType(Scrollable).first);
    await _center(tester, row);
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.text('「林晚」的世界书'), findsOneWidget);

    await _flip(tester, town);
    await _flip(tester, inn);
    await _flip(tester, town);
    final settings = await tavern.readSettings();
    expect((settings['characterLorebooks'] as Map)['sample-innkeeper'], [inn]);

    await _closeSheet(tester);
    expect(find.descendant(of: row, matching: find.text('1 本')), findsOneWidget);
  });

  testWidgets('a saved persona binds its own; a new one has no row yet', (tester) async {
    final (tavern, _, inn) = await _library(tester);
    final persona = (await tester.runAsync(() => tavern.createPersona(name: '阿遥')))!;
    await _open(tester, tavern, TavernPersonaEditPage(persona: persona));
    final row = find.byKey(const ValueKey('tavern-persona-lorebooks'));
    await _center(tester, row);
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.text('用「阿遥」时的世界书'), findsOneWidget);
    await _flip(tester, inn);
    expect(((await tavern.readSettings())['personaLorebooks'] as Map)[persona.id], [inn]);

    await _open(tester, tavern, const TavernPersonaEditPage());
    expect(find.byKey(const ValueKey('tavern-persona-lorebooks')), findsNothing);
  });

  testWidgets('a book bound and then deleted shows as deleted, and turning it off lets it go', (tester) async {
    final (tavern, town, inn) = await _library(tester);
    await tester.runAsync(() async {
      await tavern.bindLorebooks([inn], source: WorldInfoSource.character, characterId: 'sample-innkeeper');
      await tavern.deleteLorebook(inn);
    });
    await _open(tester, tavern, const TavernCharacterPage(characterId: 'sample-innkeeper'));
    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-character-tabs')), matching: find.text('配置')),
    );
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('tavern-character-lorebooks'));
    await tester.scrollUntilVisible(row, 200, scrollable: find.byType(Scrollable).first);
    await _center(tester, row);
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.text('已删除的世界书'), findsOneWidget);
    expect(find.byKey(ValueKey('tavern-bind-lorebook-$town')), findsOneWidget);

    await _flip(tester, inn);
    expect(((await tavern.readSettings())['characterLorebooks'] as Map)['sample-innkeeper'], isEmpty);
    expect(find.text('已删除的世界书'), findsNothing);
  });

  testWidgets('with an empty library the picker points to it', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _open(tester, tavern, const TavernCharacterPage(characterId: 'sample-innkeeper'));
    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-character-tabs')), matching: find.text('配置')),
    );
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('tavern-character-lorebooks'));
    await tester.scrollUntilVisible(row, 200, scrollable: find.byType(Scrollable).first);
    await _center(tester, row);
    await tester.tap(row);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-bind-lorebook-library')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernLorebooksPage), findsOneWidget);
  });
}
