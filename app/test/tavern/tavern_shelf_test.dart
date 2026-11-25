import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_shelf.dart';
import 'package:dsh_app/ui/tavern/tavern_home_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

TavernCharacter _c(String id, String name, {int? chatted, int imported = 0}) => TavernCharacter(
  id: id,
  name: name,
  lastChatAt: chatted == null ? null : DateTime(2026, 11, chatted),
  importedAt: DateTime(2026, 10, 1 + imported),
);

List<String> _ids(List<TavernCharacter> list) => [for (final c in list) c.id];

Future<void> _open(WidgetTester tester, {Map<String, Object> prefs = const {}}) async {
  SharedPreferences.setMockInitialValues(prefs);
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [tavernProvider.overrideWith((ref) => PreviewTavern(tick: Duration.zero))],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: const TavernHomePage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Finder _tile(String id) => find.byKey(ValueKey('tavern-character-$id'));

/// Whether the innkeeper's card comes before the navigator's in the grid.
bool _innkeeperFirst(WidgetTester tester) =>
    tester.getTopLeft(_tile('sample-innkeeper')).dx < tester.getTopLeft(_tile('sample-navigator')).dx;

void main() {
  test('favourites first, then the chosen order; ties keep the list’s order', () {
    final list = [
      _c('a', 'Bea', chatted: 3, imported: 1),
      _c('b', 'ada', imported: 5),
      _c('c', 'Cy', chatted: 9, imported: 2),
      _c('d', 'Bea', imported: 1),
    ];
    expect(_ids(tavernShelfSort(list, const TavernShelf())), ['c', 'a', 'b', 'd']);
    expect(_ids(tavernShelfSort(list, const TavernShelf(order: TavernShelfOrder.name))), ['b', 'a', 'd', 'c']);
    expect(_ids(tavernShelfSort(list, const TavernShelf(order: TavernShelfOrder.imported))), ['b', 'c', 'a', 'd']);
    expect(_ids(tavernShelfSort(list, const TavernShelf(order: TavernShelfOrder.name, favorites: {'c', 'd'}))), [
      'd',
      'c',
      'b',
      'a',
    ]);
  });

  testWidgets('排序 picks another order, and it is kept', (tester) async {
    await _open(tester);
    expect(find.text('最近聊过'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-shelf-sort')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('名字'));
    await tester.pumpAndSettle();

    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-shelf-sort')), matching: find.text('名字')),
      findsOneWidget,
    );
    expect(_innkeeperFirst(tester), isFalse); // 星 before 林
    expect((await SharedPreferences.getInstance()).getString(TavernShelfController.orderKey), 'name');
  });

  testWidgets('a favourite goes first with a star; un-favouring takes it back', (tester) async {
    await _open(tester, prefs: {TavernShelfController.orderKey: 'name'});
    expect(_innkeeperFirst(tester), isFalse);

    await tester.longPress(_tile('sample-innkeeper'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('收藏'));
    await tester.pumpAndSettle();
    expect(_innkeeperFirst(tester), isTrue);
    expect(find.byKey(const ValueKey('tavern-favorite-sample-innkeeper')), findsOneWidget);
    expect((await SharedPreferences.getInstance()).getStringList(TavernShelfController.favoritesKey), [
      'sample-innkeeper',
    ]);

    await tester.longPress(_tile('sample-innkeeper'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消收藏'));
    await tester.pumpAndSettle();
    expect(_innkeeperFirst(tester), isFalse);
    expect(find.byKey(const ValueKey('tavern-favorite-sample-innkeeper')), findsNothing);
  });

  testWidgets('the kept order and favourites are there when the shelf opens', (tester) async {
    await _open(
      tester,
      prefs: {
        TavernShelfController.orderKey: 'name',
        TavernShelfController.favoritesKey: ['sample-innkeeper'],
      },
    );
    expect(_innkeeperFirst(tester), isTrue);
    expect(find.byKey(const ValueKey('tavern-favorite-sample-innkeeper')), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-shelf-sort')), matching: find.text('名字')),
      findsOneWidget,
    );
  });
}
