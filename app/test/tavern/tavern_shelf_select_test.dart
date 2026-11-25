import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_home_page.dart';
import 'package:dsh_app/ui/tavern/tavern_widgets.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, with a card file to export.
class _Exporting extends PreviewTavern {
  _Exporting() : super(tick: Duration.zero);

  @override
  Future<Uint8List> exportCard(String characterId, {TavernCardFormat format = TavernCardFormat.png}) async =>
      Uint8List.fromList([0x89, 0x50, 0x4e, 0x47, characterId.length]);
}

/// The shelf with both sample cards; what is shared goes to the list returned.
Future<(PreviewTavern, List<List<(String, Uint8List)>>)> _open(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final tavern = _Exporting();
  final shared = <List<(String, Uint8List)>>[];
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => tavern),
        tavernCardsSinkProvider.overrideWithValue((files) async => shared.add(files)),
      ],
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
  return (tavern, shared);
}

Finder _tile(String id) => find.byKey(ValueKey('tavern-character-$id'));

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('选择 picks cards instead of opening them; 删除 asks once for all of them', (tester) async {
    final (tavern, _) = await _open(tester);
    await _tap(tester, find.byKey(const ValueKey('tavern-shelf-select')));
    expect(find.text('已选 0 个'), findsOneWidget);

    await _tap(tester, _tile('sample-innkeeper'));
    expect(find.byType(TavernCharacterPage), findsNothing);
    await _tap(tester, _tile('sample-navigator'));
    expect(find.text('已选 2 个'), findsOneWidget);

    await _tap(tester, find.byKey(const ValueKey('tavern-shelf-delete')));
    expect(find.text('删除这 2 个角色？'), findsOneWidget);
    await _tap(tester, find.widgetWithText(TextButton, '删除'));
    // Their files go after: real IO, let it finish.
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await tester.pumpAndSettle();

    final left = (await tester.runAsync(() => tavern.watchCharacters().first))!;
    expect(left, isEmpty);
    expect(find.byKey(const ValueKey('tavern-shelf-picked')), findsNothing); // out of picking
  });

  testWidgets('导出 shares the picked cards together, as PNG', (tester) async {
    final (_, shared) = await _open(tester);
    await _tap(tester, find.byKey(const ValueKey('tavern-shelf-select')));
    await _tap(tester, _tile('sample-innkeeper'));
    expect(find.byKey(const ValueKey('tavern-pick-sample-innkeeper')), findsOneWidget);
    await _tap(tester, find.byKey(const ValueKey('tavern-shelf-export')));

    expect(shared.single.map((f) => f.$1), ['林晚.png']);
    expect(shared.single.single.$2, isNotEmpty);
    expect(find.text('已选 1 个'), findsOneWidget); // still picking
  });

  testWidgets('nothing picked, nothing to do; 取消 goes back to opening cards', (tester) async {
    await _open(tester);
    await _tap(tester, find.byKey(const ValueKey('tavern-shelf-select')));
    expect(tester.widget<IconButton>(find.byKey(const ValueKey('tavern-shelf-delete'))).onPressed, isNull);
    expect(tester.widget<IconButton>(find.byKey(const ValueKey('tavern-shelf-export'))).onPressed, isNull);

    await _tap(tester, find.byKey(const ValueKey('tavern-shelf-done')));
    expect(find.byKey(const ValueKey('tavern-pick-sample-innkeeper')), findsNothing);
    await _tap(tester, _tile('sample-innkeeper'));
    expect(find.byType(TavernCharacterPage), findsOneWidget);
  });
}
