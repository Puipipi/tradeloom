import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_widgets.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, exporting a small JSON card.
class _Exporting extends PreviewTavern {
  _Exporting() : super(tick: const Duration(milliseconds: 1));

  final formats = <TavernCardFormat>[];

  @override
  Future<Uint8List> exportCard(String characterId, {TavernCardFormat format = TavernCardFormat.png}) async {
    formats.add(format);
    return Uint8List.fromList(utf8.encode('{"spec":"chara_card_v3"}'));
  }
}

typedef _Shared = ({String name, Uint8List bytes, String mime});

Future<List<_Shared>> _open(WidgetTester tester, PreviewTavern tavern) async {
  final shared = <_Shared>[];
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => tavern),
        tavernCardSinkProvider.overrideWithValue((name, bytes, mime) async {
          shared.add((name: name, bytes: bytes, mime: mime));
        }),
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

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('card file names drop path and reserved characters', () {
    expect(tavernCardFileName('林晚', TavernCardFormat.png), '林晚.png');
    expect(tavernCardFileName('a/b:c?', TavernCardFormat.json), 'a_b_c_.json');
    expect(tavernCardFileName('  ', TavernCardFormat.json), 'character.json');
  });

  testWidgets('导出为 JSON hands the card file to the share sheet', (tester) async {
    final tavern = _Exporting();
    final shared = await _open(tester, tavern);

    await tester.tap(find.byKey(const ValueKey('tavern-character-more')));
    await tester.pumpAndSettle();
    expect(find.text('导出角色卡（PNG）'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-export-json')));
    await tester.pumpAndSettle();

    expect(tavern.formats, [TavernCardFormat.json]);
    expect(shared.single.name, '林晚.json');
    expect(shared.single.mime, 'application/json');
    expect(utf8.decode(shared.single.bytes), contains('chara_card_v3'));
  });

  testWidgets('a card that cannot be exported says so', (tester) async {
    // The plain preview has no card files to export.
    final shared = await _open(tester, PreviewTavern(tick: const Duration(milliseconds: 1)));

    await tester.tap(find.byKey(const ValueKey('tavern-character-more')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-export-png')));
    await tester.pumpAndSettle();

    expect(shared, isEmpty);
    expect(find.text('没能导出这张卡'), findsOneWidget);
  });
}
