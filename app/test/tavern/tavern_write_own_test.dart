import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_edit_page.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_home_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, taking a card in by recording it and handing back one of its
/// own (so its pages open); with [empty], its shelf shows nothing.
class _Writing extends PreviewTavern {
  _Writing({this.empty = false}) : super(tick: Duration.zero);

  final bool empty;
  final imported = <({String? fileName, Uint8List bytes})>[];

  @override
  Stream<List<TavernCharacter>> watchCharacters() => empty ? Stream.value(const []) : super.watchCharacters();

  @override
  Future<TavernCharacter> importCard(Uint8List bytes, {String? fileName}) async {
    imported.add((fileName: fileName, bytes: bytes));
    return (await character('sample-navigator'))!;
  }
}

Future<void> _home(WidgetTester tester, PreviewTavern tavern) async {
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
        home: const TavernHomePage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// The blank card that was taken in.
Map<String, Object?> _card(_Writing tavern) {
  final card = jsonDecode(utf8.decode(tavern.imported.single.bytes)) as Map<String, Object?>;
  expect(card['spec'], 'chara_card_v2');
  return card['data']! as Map<String, Object?>;
}

void main() {
  testWidgets('导入 › 自己写一个角色 takes in a blank card and opens it for writing', (tester) async {
    final tavern = _Writing();
    await _home(tester, tavern);
    await tester.tap(find.byKey(const ValueKey('tavern-import')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-import-blank')));
    await tester.pumpAndSettle();

    final data = _card(tavern);
    expect(data['name'], '新角色');
    expect(data['first_mes'], '');
    expect(data['description'], '');
    expect(tavern.imported.single.fileName, 'new_character.json');
    // Writing on top, the character's page under it.
    expect(find.byType(TavernCharacterEditPage), findsOneWidget);
    Navigator.of(tester.element(find.byType(TavernCharacterEditPage))).pop();
    await tester.pumpAndSettle();
    expect(find.byType(TavernCharacterPage), findsOneWidget);
  });

  testWidgets('an empty shelf offers to write one too, under the sample card', (tester) async {
    final tavern = _Writing(empty: true);
    await _home(tester, tavern);
    expect(find.text('还没有角色'), findsOneWidget);
    final sample = tester.getTopLeft(find.byKey(const ValueKey('tavern-try-sample'))).dy;
    final own = tester.getTopLeft(find.byKey(const ValueKey('tavern-write-own'))).dy;
    expect(own, greaterThan(sample));

    await tester.tap(find.byKey(const ValueKey('tavern-write-own')));
    await tester.pumpAndSettle();
    expect(_card(tavern)['name'], '新角色');
    expect(find.byType(TavernCharacterEditPage), findsOneWidget);
  });
}
