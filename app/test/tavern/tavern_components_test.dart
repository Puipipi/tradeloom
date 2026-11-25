import 'package:dsh_app/tavern/tavern_components.dart';
import 'package:dsh_app/tavern/tavern_islands.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/chat/render/markdown_body.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_component_view.dart';
import 'package:dsh_app/ui/tavern/tavern_island.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _letter = '<dsh-letter from="林" date="三月初七">见字如面。A &amp; B<br>勿念。</dsh-letter>';

Widget _fakeIsland(String html) => SizedBox(key: ValueKey('island:$html'), height: 40);

Widget _app(Widget child, {Brightness brightness = Brightness.light}) => MaterialApp(
  theme: withTestFonts(brightness == Brightness.light ? buildLightTheme() : buildDarkTheme()),
  locale: const Locale('zh', 'CN'),
  supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
  localizationsDelegates: GlobalMaterialLocalizations.delegates,
  home: Scaffold(
    body: Padding(padding: const EdgeInsets.all(16), child: child),
  ),
);

Future<void> _chat(WidgetTester tester, String narration, {Map<String, Object> prefs = const {}}) async {
  SharedPreferences.setMockInitialValues({...prefs});
  final tavern = PreviewTavern(tick: Duration.zero);
  final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
  await tester.runAsync(() => tavern.narrate(chat, narration));
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => tavern),
        tavernIslandBuilderProvider.overrideWithValue(_fakeIsland),
      ],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: TavernChatPage(chatId: chat),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  test('component tags are read with their attributes and plain words', () {
    final pieces = tavernSplitComponents('她把信递过来。\n\n$_letter\n\n「收好。」');
    expect(pieces, hasLength(3));
    expect(pieces.first, '她把信递过来。\n\n');
    final letter = pieces[1] as TavernComponent;
    expect(letter.kind, TavernComponentKind.letter);
    expect(letter.attribute(const ['from']), '林');
    expect(letter.attribute(const ['date']), '三月初七');
    expect(letter.body, '见字如面。A & B\n勿念。');
    expect(pieces.last, '\n\n「收好。」');

    // A bare attribute is there; a self-closing tag has no words.
    final item = tavernSplitComponents('<dsh-item name="铜钥匙" take>锈迹斑斑，齿纹很深。</dsh-item>').single as TavernComponent;
    expect(item.kind, TavernComponentKind.item);
    expect(item.has('take'), isTrue);
    expect(item.has('given'), isFalse);
    expect(item.attribute(const ['name']), '铜钥匙');
    final game = tavernSplitComponents("<dsh-game id='lockpick' difficulty=3/>").single as TavernComponent;
    expect(game.kind, TavernComponentKind.game);
    expect(game.attributes, {'id': 'lockpick', 'difficulty': '3'});
    expect(game.body, '');

    // A kind not drawn here reads as its words; a tag never closed stays as written.
    expect(tavernSplitComponents('去<dsh-map>北边的森林</dsh-map>看看'), ['去北边的森林看看']);
    expect(tavernSplitComponents('<dsh-letter from="林">没写完'), ['<dsh-letter from="林">没写完']);
    // Blank attributes don't count; the first one with a value does.
    final roll =
        tavernSplitComponents('<dsh-roll skill="" check="潜行" value="14" target="12" result="success"/>').single
            as TavernComponent;
    expect(roll.attribute(const ['skill', 'check']), '潜行');
  });

  test('outside an HTML block a component is a part of its own; inside it, the island keeps it', () {
    final parts = tavernParts('她把信递过来。\n\n$_letter\n\n「收好。」');
    expect(parts.map((p) => p.runtimeType), [TavernTextPart, TavernComponentPart, TavernTextPart]);
    expect((parts[0] as TavernTextPart).markdown, '她把信递过来。');
    expect((parts[2] as TavernTextPart).markdown, '「收好。」');

    // The 。 after a card in the middle of a sentence ends the sentence before it.
    final inline = tavernParts('她递给你<dsh-item name="铜钥匙">锈迹斑斑</dsh-item>。');
    expect(inline.map((p) => p.runtimeType), [TavernTextPart, TavernComponentPart]);
    expect((inline.first as TavernTextPart).markdown, '她递给你。');

    final fenced = tavernParts('```html\n<div>$_letter</div>\n```');
    expect(fenced.single, isA<TavernIslandPart>());
    expect((fenced.single as TavernIslandPart).html, contains('<dsh-letter'));

    // With islands off, components are still cards and the HTML block is text.
    final off = tavernParts('```html\n<div>x</div>\n```\n\n$_letter', islands: false);
    expect(off.map((p) => p.runtimeType), [TavernTextPart, TavernComponentPart]);
    // Nothing to draw: the text as it is, one part.
    expect(tavernParts('她笑了。', islands: false).single, isA<TavernTextPart>());
  });

  test('while a reply is written, its component tags give only their words', () {
    expect(tavernComponentTagsOut('她写道：$_letter'), '她写道：见字如面。A &amp; B<br>勿念。');
    expect(tavernComponentTagsOut('她写道：<dsh-letter from="林">见字'), '她写道：见字');
    expect(tavernComponentTagsOut('她写道：<dsh-let'), '她写道：');
    expect(tavernComponentTagsOut('她写道：<dsh-letter from="林'), '她写道：');
    expect(tavernComponentTagsOut('a < b，<b>粗</b>'), 'a < b，<b>粗</b>');
  });

  testWidgets('each kind draws as its card', (tester) async {
    Future<void> show(String tag) async {
      final component = tavernSplitComponents(tag).single as TavernComponent;
      await tester.pumpWidget(_app(TavernComponentView(component: component)));
      await tester.pumpAndSettle();
    }

    await show(_letter);
    expect(find.text('林的信'), findsOneWidget);
    expect(find.text('三月初七'), findsOneWidget);
    expect(find.text('见字如面。A & B\n勿念。'), findsOneWidget);
    // Short: nothing to fold.
    expect(find.byKey(const ValueKey('tavern-component-fold')), findsNothing);

    await show('<dsh-item name="铜钥匙" take>锈迹斑斑，齿纹很深。</dsh-item>');
    expect(find.text('铜钥匙'), findsOneWidget);
    expect(find.text('获得'), findsOneWidget);
    expect(find.text('锈迹斑斑，齿纹很深。'), findsOneWidget);
    await show('<dsh-item name="旧地图">一角烧焦了。</dsh-item>');
    expect(find.text('获得'), findsNothing);

    await show('<dsh-clue title="脚印">泥里的脚印朝北。</dsh-clue>');
    expect(find.text('脚印'), findsOneWidget);
    await show('<dsh-clue>窗台上有划痕。</dsh-clue>');
    expect(find.text('线索'), findsOneWidget);

    await show('<dsh-phone from="林" time="21:04">在吗？</dsh-phone>');
    expect(find.text('林 发来消息'), findsOneWidget);
    expect(find.text('21:04'), findsOneWidget);
    expect(find.text('在吗？'), findsOneWidget);

    await show('<dsh-roll skill="潜行" value="14" target="12" result="failure">1d20+3</dsh-roll>');
    expect(find.text('检定：潜行'), findsOneWidget);
    expect(find.text('14 / 12'), findsOneWidget);
    final failed = tester.widget<Text>(find.text('失败'));
    expect(failed.style?.color, DshColors.of(tester.element(find.text('失败'))).danger);
    expect(find.text('1d20+3'), findsOneWidget);
    // A result we don't know is shown as written, uncoloured.
    await show('<dsh-roll skill="说服" result="勉强通过"/>');
    expect(find.text('勉强通过'), findsOneWidget);

    await show('<dsh-notice>好感 +5</dsh-notice>');
    expect(find.text('好感 +5'), findsOneWidget);
    await show('<dsh-game id="lockpick"/>');
    expect(find.textContaining('小游戏'), findsOneWidget);
  });

  testWidgets('a long letter folds past four lines and opens on 展开', (tester) async {
    final long = List.filled(12, '今日天晴，院里的海棠开了，想起你说过要回来看。').join();
    final component = tavernSplitComponents('<dsh-letter from="林">$long</dsh-letter>').single as TavernComponent;
    await tester.pumpWidget(_app(TavernComponentView(component: component)));
    await tester.pumpAndSettle();
    final folded = tester.getSize(find.text(long)).height;
    await tester.tap(find.text('展开'));
    await tester.pumpAndSettle();
    expect(tester.getSize(find.text(long)).height, greaterThan(folded * 1.4));
    expect(find.text('收起'), findsOneWidget);
  });

  testWidgets('in the story, a component is a card between the words around it', (tester) async {
    await _chat(tester, '她把信递过来。\n\n$_letter\n\n「收好。」');
    expect(find.byKey(const ValueKey('tavern-component-letter')), findsOneWidget);
    expect(find.byWidgetPredicate((w) => w is MarkdownBody && w.text.trim() == '她把信递过来。'), findsWidgets);
    expect(find.byWidgetPredicate((w) => w is MarkdownBody && w.text.contains('dsh-letter')), findsNothing);
  });

  testWidgets('with 消息里的网页 off, components still draw', (tester) async {
    await _chat(tester, _letter, prefs: {TavernSettingsController.islandsKey: false});
    expect(find.byKey(const ValueKey('tavern-component-letter')), findsOneWidget);
  });
}
