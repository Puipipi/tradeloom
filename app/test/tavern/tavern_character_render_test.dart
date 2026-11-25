import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/chat/render/markdown_body.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_island.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _lin = 'sample-innkeeper';
const _status = '<div class="bar"><b>好感</b> 42</div>';
final _key = TavernCharacterRenderController.keyFor(_lin);

Widget _fakeIsland(String html) => SizedBox(key: ValueKey('island:$html'), height: 40);

Widget _app(PreviewTavern tavern, Widget home) => ProviderScope(
  overrides: [tavernProvider.overrideWith((ref) => tavern), tavernIslandBuilderProvider.overrideWithValue(_fakeIsland)],
  child: MaterialApp(
    theme: withTestFonts(buildLightTheme()),
    locale: const Locale('zh', 'CN'),
    supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: home,
  ),
);

void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
}

/// A chat with [_lin] whose last line carries HTML.
Future<void> _chat(WidgetTester tester, Map<String, Object> prefs) async {
  SharedPreferences.setMockInitialValues(prefs);
  final tavern = PreviewTavern(tick: Duration.zero);
  final chat = (await tester.runAsync(() => tavern.createChat(_lin)))!;
  await tester.runAsync(() => tavern.narrate(chat, '```html\n$_status\n```'));
  _phone(tester);
  await tester.pumpWidget(_app(tavern, TavernChatPage(chatId: chat)));
  await tester.pumpAndSettle();
}

final _island = find.byKey(const ValueKey('island:$_status'));
final _asText = find.byWidgetPredicate((w) => w is MarkdownBody && w.text.contains('好感'));

Future<void> _setup(WidgetTester tester) async {
  await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-character-tabs')), matching: find.text('配置')));
  await tester.pumpAndSettle();
  await tester.scrollUntilVisible(
    find.byKey(const ValueKey('tavern-character-render')),
    200,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets("a character's own 文字 keeps its HTML as text, whatever the settings", (tester) async {
    await _chat(tester, {TavernSettingsController.islandsKey: true, _key: 'text'});
    expect(_island, findsNothing);
    expect(_asText, findsOneWidget);
  });

  testWidgets("a character's own 消息网页 shows it, with the settings' off", (tester) async {
    await _chat(tester, {TavernSettingsController.islandsKey: false, _key: 'islands'});
    expect(_island, findsOneWidget);
  });

  testWidgets('without its own, the settings say: off', (tester) async {
    await _chat(tester, {TavernSettingsController.islandsKey: false});
    expect(_island, findsNothing);
  });

  testWidgets('without its own, the settings say: on', (tester) async {
    await _chat(tester, {TavernSettingsController.islandsKey: true});
    expect(_island, findsOneWidget);
  });

  testWidgets('配置 › 显示方式 shows the settings until chosen, keeps the choice, and follows again', (tester) async {
    SharedPreferences.setMockInitialValues({TavernSettingsController.islandsKey: true});
    final tavern = PreviewTavern(tick: Duration.zero);
    _phone(tester);
    await tester.pumpWidget(_app(tavern, const TavernCharacterPage(characterId: _lin)));
    await tester.pumpAndSettle();
    await _setup(tester);
    final tile = find.byKey(const ValueKey('tavern-character-render'));
    final follow = find.byKey(const ValueKey('tavern-character-render-follow'));
    expect(follow, findsNothing);

    await tester.tap(find.descendant(of: tile, matching: find.text('整页画布')));
    await tester.pumpAndSettle();
    expect((await SharedPreferences.getInstance()).getString(_key), 'canvas');
    expect(follow, findsOneWidget);

    await tester.ensureVisible(follow);
    await tester.tap(follow);
    await tester.pumpAndSettle();
    expect((await SharedPreferences.getInstance()).getString(_key), isNull);
    expect(follow, findsNothing);
  });
}
