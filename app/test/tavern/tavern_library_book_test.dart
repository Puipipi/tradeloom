import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/tavern/tavern_book_entry.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_library_book_page.dart';
import 'package:dsh_app/ui/tavern/tavern_lorebook_page.dart';
import 'package:dsh_app/ui/tavern/tavern_lorebooks_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// An ST world file: entries by uid, in ST's own field names.
final _world = jsonEncode({
  'entries': {
    '0': {
      'uid': 0,
      'comment': '码头',
      'key': ['码头'],
      'content': '镇东有个小码头。',
      'order': 50,
      'position': 0,
      'disable': false,
    },
    '1': {
      'uid': 1,
      'comment': '灯塔',
      'key': ['灯塔'],
      'content': '灯塔熄了十年。',
      'order': 100,
      'position': 4,
      'depth': 2,
      'role': 0,
      'probability': 60,
      'useProbability': true,
      'caseSensitive': true,
      'disable': false,
    },
  },
});

Future<(PreviewTavern, String)> _openBook(WidgetTester tester, String text, {String name = '雨镇.json'}) async {
  SharedPreferences.setMockInitialValues({});
  final tavern = PreviewTavern(tick: Duration.zero);
  final id = (await tester.runAsync(() => tavern.importLorebook(text, fileName: name)))!.book.id;
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
        home: const TavernLorebooksPage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  // 资源库 › 世界书 › the book › 看条目、改条目.
  await tester.tap(find.byKey(ValueKey('tavern-lorebook-$id')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('看条目、改条目'));
  await tester.pumpAndSettle();
  expect(find.byType(TavernLibraryBookPage), findsOneWidget);
  return (tavern, id);
}

Future<Map<String, Object?>> _raw(WidgetTester tester, PreviewTavern tavern, String id) async =>
    (await tester.runAsync(() => tavern.lorebook(id)))!;

Finder _row(int i) => find.byKey(ValueKey('tavern-library-entry-$i'));

Future<void> _center(WidgetTester tester, Finder target) async {
  unawaited(Scrollable.ensureVisible(tester.element(target), alignment: 0.5));
  await tester.pumpAndSettle();
}

void main() {
  group("ST's own entry and the editor's", () {
    test('turn into each other, enabled the other way round from disable', () {
      final card = tavernNativeToCard((jsonDecode(_world) as Map)['entries']['1'] as Map<String, Object?>);
      expect(card['keys'], ['灯塔']);
      expect((card['insertion_order'], card['enabled'], card['position']), (100, true, 'after_char'));
      expect(card['extensions'], {
        'position': 4,
        'depth': 2,
        'role': 0,
        'probability': 60,
        'useProbability': true,
        'case_sensitive': true,
      });
      expect(
        tavernCardToNative({
          'keys': ['船'],
          'enabled': false,
          'position': 'after_char', // the word goes: the number says it
          'extensions': {'position': 1, 'match_whole_words': false, 'unknown': 1},
        }),
        {
          'key': ['船'],
          'disable': true,
          'position': 1,
          'matchWholeWords': false,
        },
      );
      expect(
        tavernMergeEntry(
          {
            'a': 1,
            'extensions': {'x': 1, 'y': 2},
          },
          {
            'extensions': {'y': 3},
          },
        ),
        {
          'a': 1,
          'extensions': {'x': 1, 'y': 3},
        },
      );
    });
  });

  testWidgets("a library book in ST's own shape lists, switches, edits and adds entries in that shape", (tester) async {
    final (tavern, id) = await _openBook(tester, _world);
    // Highest order first.
    expect(find.descendant(of: _row(0), matching: find.text('灯塔')), findsOneWidget);
    expect(find.descendant(of: _row(1), matching: find.text('码头')), findsOneWidget);

    // The switch: ST's disable, turned over.
    await tester.tap(find.descendant(of: _row(1), matching: find.byType(Switch)));
    await tester.pumpAndSettle();
    expect(((await _raw(tester, tavern, id))['entries']! as Map)['0'], containsPair('disable', true));

    // The editor shows ST's own fields as it does a card's, and writes them back in ST's names.
    await tester.tap(find.descendant(of: _row(0), matching: find.text('灯塔')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernLorebookEntryPage), findsOneWidget);
    await _center(tester, find.byKey(const ValueKey('tavern-lore-depth')));
    expect(tester.widget<Text>(find.byKey(const ValueKey('tavern-lore-depth-value'))).data, '2');
    await _center(tester, find.byKey(const ValueKey('tavern-lore-chance')));
    expect(tester.widget<Text>(find.byKey(const ValueKey('tavern-lore-chance-value'))).data, '60%');
    await tester.tap(find.byKey(const ValueKey('tavern-lore-chance-up')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(of: find.byKey(const ValueKey('tavern-lore-keys')), matching: find.byType(TextField)),
      '灯塔，守塔人',
    );
    await tester.tap(find.byKey(const ValueKey('tavern-lore-save')));
    await tester.pumpAndSettle();
    final lighthouse = ((await _raw(tester, tavern, id))['entries']! as Map)['1'] as Map<String, Object?>;
    expect(lighthouse['key'], ['灯塔', '守塔人']);
    expect((lighthouse['probability'], lighthouse['useProbability'], lighthouse['depth']), (65, true, 2));
    expect(lighthouse.keys, isNot(contains('keys'))); // no card names left behind
    expect(lighthouse.keys, isNot(contains('extensions')));
    expect(lighthouse['content'], '灯塔熄了十年。'); // the rest kept

    // A new one: the next uid, in ST's names.
    await tester.tap(find.byKey(const ValueKey('tavern-library-book-add')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(of: find.byKey(const ValueKey('tavern-lore-keys')), matching: find.byType(TextField)),
      '旅店',
    );
    await tester.enterText(
      find.descendant(of: find.byKey(const ValueKey('tavern-lore-content')), matching: find.byType(TextField)),
      '旅店只有三间房。',
    );
    await tester.tap(find.byKey(const ValueKey('tavern-lore-save')));
    await tester.pumpAndSettle();
    final added = ((await _raw(tester, tavern, id))['entries']! as Map)['2'] as Map<String, Object?>;
    expect(added['key'], ['旅店']);
    expect((added['uid'], added['disable'], added['content']), (2, false, '旅店只有三间房。'));
    expect(find.text('3 条'), findsOneWidget);
  });

  testWidgets('a library book kept as a list edits in place; delete asks, then it goes', (tester) async {
    final (tavern, id) = await _openBook(
      tester,
      jsonEncode({
        'entries': [
          {
            'keys': ['雨'],
            'content': '雨下了三天。',
            'insertion_order': 10,
            'enabled': true,
          },
          {
            'keys': ['风'],
            'content': '风从海上来。',
            'insertion_order': 5,
            'enabled': true,
          },
        ],
      }),
    );
    await tester.tap(find.descendant(of: _row(0), matching: find.byType(Switch)));
    await tester.pumpAndSettle();
    final entries = (await _raw(tester, tavern, id))['entries']! as List;
    expect((entries.first as Map)['enabled'], isFalse);

    await tester.tap(find.descendant(of: _row(1), matching: find.text('风')));
    await tester.pumpAndSettle();
    final delete = find.byKey(const ValueKey('tavern-lore-delete'));
    await _center(tester, delete);
    await tester.tap(delete);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '删除'));
    await tester.pumpAndSettle();
    expect((await _raw(tester, tavern, id))['entries'], hasLength(1));
    expect(find.text('1 条'), findsOneWidget);
  });
}
