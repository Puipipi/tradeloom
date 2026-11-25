import 'dart:async';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_edit_page.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, remembering every patch it was asked to save.
class _Recording extends PreviewTavern {
  _Recording() : super(tick: const Duration(milliseconds: 1));

  final patches = <Map<String, Object?>>[];

  @override
  Future<TavernCharacter> updateCharacterFields(String characterId, Map<String, Object?> fields) {
    patches.add(fields);
    return super.updateCharacterFields(characterId, fields);
  }
}

Future<void> _open(WidgetTester tester, PreviewTavern tavern, {Widget? home}) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [tavernProvider.overrideWith((ref) => tavern)],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: home ?? const TavernCharacterPage(characterId: 'sample-innkeeper'),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// Brings [target] to the middle of the page, clear of the save bar.
Future<void> _center(WidgetTester tester, Finder target) async {
  unawaited(Scrollable.ensureVisible(tester.element(target), alignment: 0.5));
  await tester.pumpAndSettle();
}

Finder _field(String key) =>
    find.descendant(of: find.byKey(ValueKey('tavern-field-$key')), matching: find.byType(TextField));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('tags split on either comma and 、, without blanks or repeats', () {
    expect(parseTavernTags('悬疑， 示例,,示例、 雨夜 '), ['悬疑', '示例', '雨夜']);
    expect(parseTavernTags('  '), isEmpty);
  });

  testWidgets('saving sends only what changed and the character page follows', (tester) async {
    final tavern = _Recording();
    await _open(tester, tavern);

    await tester.tap(find.byKey(const ValueKey('tavern-character-edit')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernCharacterEditPage), findsOneWidget);
    // The card's second greeting is there to edit.
    expect(find.text('开场白 2'), findsOneWidget);

    await tester.enterText(_field('name'), '林晚晚');
    await tester.enterText(_field('tags'), '示例，悬疑，雨夜');
    await tester.tap(find.byKey(const ValueKey('tavern-edit-save')));
    await tester.pumpAndSettle();

    expect(tavern.patches, [
      {
        'name': '林晚晚',
        'tags': ['示例', '悬疑', '雨夜'],
      },
    ]);
    expect(find.byType(TavernCharacterEditPage), findsNothing);
    expect(find.text('已保存'), findsOneWidget);
    expect(find.text('林晚晚'), findsWidgets);
  });

  testWidgets('an extra greeting can be added and an empty one is not saved', (tester) async {
    final tavern = _Recording();
    await _open(tester, tavern, home: const TavernCharacterEditPage(characterId: 'sample-navigator'));

    await _center(tester, find.byKey(const ValueKey('tavern-add-greeting')));
    await tester.tap(find.byKey(const ValueKey('tavern-add-greeting')));
    await tester.pumpAndSettle();
    expect(find.text('开场白 2'), findsOneWidget);
    await _center(tester, find.byKey(const ValueKey('tavern-add-greeting')));
    await tester.tap(find.byKey(const ValueKey('tavern-add-greeting')));
    await tester.pumpAndSettle();

    final greetings = find.descendant(
      of: find.ancestor(of: find.text('开场白 2'), matching: find.byType(Column)).first,
      matching: find.byType(TextField),
    );
    await tester.enterText(greetings, '「警报解除。舰长，要喝咖啡吗？」');
    await tester.tap(find.byKey(const ValueKey('tavern-edit-save')));
    await tester.pumpAndSettle();

    expect(tavern.patches.single, {
      'alternate_greetings': ['「警报解除。舰长，要喝咖啡吗？」'],
    });
    final fields = await tavern.characterFields('sample-navigator');
    expect(fields!['alternate_greetings'], ['「警报解除。舰长，要喝咖啡吗？」']);
  });

  testWidgets('an empty name is not saved', (tester) async {
    final tavern = _Recording();
    await _open(tester, tavern, home: const TavernCharacterEditPage(characterId: 'sample-innkeeper'));

    await tester.enterText(_field('name'), '  ');
    await tester.tap(find.byKey(const ValueKey('tavern-edit-save')));
    await tester.pumpAndSettle();

    expect(find.text('名字不能空着'), findsOneWidget);
    expect(tavern.patches, isEmpty);
  });

  testWidgets('leaving with unsaved edits asks first', (tester) async {
    await _open(tester, _Recording());
    await tester.tap(find.byKey(const ValueKey('tavern-character-edit')));
    await tester.pumpAndSettle();

    await tester.enterText(_field('scenario'), '暴雨封山的第三天。');
    await tester.pump();
    final navigator = tester.state<NavigatorState>(find.byType(Navigator).first);
    navigator.maybePop();
    await tester.pumpAndSettle();
    expect(find.text('放弃修改？'), findsOneWidget);
  });

  testWidgets('fields the page does not edit are counted as kept', (tester) async {
    await _open(tester, _Recording(), home: const TavernCharacterEditPage(characterId: 'sample-innkeeper'));
    // The sample card carries an extension and a lorebook the page does not show.
    await tester.scrollUntilVisible(find.textContaining('卡里还有 2 项'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.textContaining('卡里还有 2 项'), findsOneWidget);
  });
}
