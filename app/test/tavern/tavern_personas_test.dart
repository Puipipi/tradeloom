import 'dart:async';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_personas.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

Future<void> _open(WidgetTester tester, PreviewTavern tavern, Widget home) async {
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
        home: home,
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

Finder _input(String key) => find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(TextField));

PreviewTavern _tavern() => PreviewTavern(tick: const Duration(milliseconds: 1));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('the first persona becomes the default', (tester) async {
    final tavern = _tavern();
    await _open(tester, tavern, const TavernPersonasPage());
    expect(find.text('还没有人设'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-persona-new')));
    await tester.pumpAndSettle();
    await tester.enterText(_input('tavern-persona-name'), '阿遥');
    await tester.enterText(_input('tavern-persona-description'), '镇上新来的医生，话不多。');
    await tester.tap(find.byKey(const ValueKey('tavern-persona-save')));
    await tester.pumpAndSettle();

    expect(find.byType(TavernPersonaEditPage), findsNothing);
    expect(find.text('阿遥'), findsOneWidget);
    expect(find.text('默认'), findsOneWidget);
    final selection = await tavern.personaSelection();
    expect(selection.persona?.name, '阿遥');
    expect(selection.persona?.description, '镇上新来的医生，话不多。');
  });

  testWidgets('a persona without a name is not saved', (tester) async {
    final tavern = _tavern();
    await _open(tester, tavern, const TavernPersonaEditPage());
    await tester.tap(find.byKey(const ValueKey('tavern-persona-save')));
    await tester.pumpAndSettle();
    expect(find.text('名字不能空着'), findsOneWidget);
    expect(await tavern.watchPersonas().first, isEmpty);
  });

  testWidgets('a chat picks its own persona from the composer key', (tester) async {
    final tavern = _tavern();
    final doctor = await tavern.createPersona(name: '阿遥');
    final sailor = await tavern.createPersona(name: '老周');
    await tavern.setDefaultPersona(doctor.id);
    final chat = await tavern.createChat('sample-innkeeper');
    await _open(tester, tavern, TavernChatPage(chatId: chat));

    expect(find.byTooltip('以「阿遥」的身份'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-persona-key')));
    await tester.pumpAndSettle();
    expect(find.text('这段对话里你是'), findsOneWidget);
    // Each persona shows with its own picture.
    expect(
      find.descendant(
        of: find.byKey(ValueKey('tavern-persona-pick-${sailor.id}')),
        matching: find.byType(TavernPersonaAvatar),
      ),
      findsOneWidget,
    );
    await tester.tap(find.byKey(ValueKey('tavern-persona-pick-${sailor.id}')));
    await tester.pumpAndSettle();

    final selection = await tavern.personaSelection(chatId: chat);
    expect(selection.source, PersonaSelectionSource.chat);
    expect(selection.persona?.name, '老周');
    expect(find.byTooltip('以「老周」的身份'), findsOneWidget);

    // Back to the default.
    await tester.tap(find.byKey(const ValueKey('tavern-persona-key')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-persona-follow')));
    await tester.pumpAndSettle();
    expect((await tavern.personaSelection(chatId: chat)).source, PersonaSelectionSource.globalDefault);
  });

  testWidgets('deleting from the editor asks, then removes it', (tester) async {
    final tavern = _tavern();
    final persona = await tavern.createPersona(name: '阿遥');
    await _open(tester, tavern, const TavernPersonasPage());

    await tester.tap(find.byKey(ValueKey('tavern-persona-${persona.id}')));
    await tester.pumpAndSettle();
    await _center(tester, find.byKey(const ValueKey('tavern-persona-delete')));
    await tester.tap(find.byKey(const ValueKey('tavern-persona-delete')));
    await tester.pumpAndSettle();
    expect(find.text('删除「阿遥」？'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '删除'));
    await tester.pumpAndSettle();

    expect(find.byType(TavernPersonaEditPage), findsNothing);
    expect(find.text('还没有人设'), findsOneWidget);
  });
}
