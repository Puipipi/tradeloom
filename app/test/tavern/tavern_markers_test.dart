import 'package:dsh_app/tavern/tavern_live2d.dart';
import 'package:dsh_app/tavern/tavern_markers.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_sprites.dart';
import 'package:dsh_app/tavern/tavern_storybook.dart';
import 'package:dsh_app/ui/chat/render/markdown_body.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_vn_view.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

TavernMessage _her(String text) =>
    TavernMessage(nodeId: 'n', role: TavernRole.character, speaker: '林晚', text: text, at: DateTime(2026));

void main() {
  test('a marker is read in its usual spellings and never shown', () {
    expect(tavernMarkerIn('[表情:开心]她笑了。'), '开心');
    expect(tavernMarkerIn('她笑了。【表情：害羞】'), '害羞');
    expect(tavernMarkerIn('[Expression: joy] She smiles.'), 'joy');
    expect(tavernMarkerIn('[emotion：sad]'), 'sad');
    expect(tavernMarkerIn('[情绪: 惊讶 ]'), '惊讶');
    expect(tavernMarkerIn('她看着[地图]说。'), isNull);
    expect(tavernMarkerIn('[表情:]'), isNull);

    expect(tavernStripMarkers('[表情:开心]她笑了。'), '她笑了。');
    expect(tavernStripMarkers('她笑了。 [表情:开心]\n「来吧。」'), '她笑了。\n「来吧。」');
    // A line that was only a marker goes; the paragraphs keep their gap.
    expect(tavernStripMarkers('她推开门。\n\n[表情:惊讶]\n\n「谁？」'), '她推开门。\n\n「谁？」');
    const plain = '她看着[地图]说。\n\n下一段';
    expect(identical(tavernStripMarkers(plain), plain), isTrue);
    expect(tavernStoryParagraphs('[表情:开心]她笑了。\n[表情:难过]'), ['她笑了。']);
  });

  test("视觉小说's pages carry the marker in force, without its words", () {
    final pages = tavernPages([_her('[表情:开心]她笑着递过茶。\n\n她又低下头。\n\n[表情:难过]\n眼泪掉了下来。')]);
    expect(pages.map((p) => p.text), ['她笑着递过茶。', '她又低下头。', '眼泪掉了下来。']);
    expect(pages.map((p) => p.marker), ['开心', '开心', '难过']);
    // A marker only at the end: the whole message's.
    final trailing = tavernPages([_her('她推开门。\n\n「谁？」\n\n[表情:惊讶]')]);
    expect(trailing.map((p) => (p.text, p.marker)), [('她推开门。', '惊讶'), ('「谁？」', '惊讶')]);
    expect(tavernPages([_her('她推开门。')]).single.marker, isNull);
  });

  test('a marker picks the sprite and the Live2D feeling before the words do', () {
    const sprites = {'joy': '/joy.png', 'sadness': '/sad.png', '惊讶': '/surprised.png', 'neutral': '/neutral.png'};
    expect(tavernSpriteFor(sprites, '她笑了。', marker: '惊讶'), '/surprised.png'); // by name
    expect(tavernSpriteFor(sprites, '她低下头。', marker: '开心'), '/joy.png'); // by the feeling it names
    expect(tavernSpriteFor(sprites, '她哭了。', marker: '???'), '/sad.png'); // unknown: the words decide
    expect(tavernSpriteFor(sprites, '她低下头。'), '/neutral.png');

    String? emotion({String? marker, required String text}) => tavernStageCues(
      you: false,
      text: text,
      marker: marker,
    ).where((c) => c.$1 == 'emotion').map((c) => c.$2['name'] as String).firstOrNull;
    expect(emotion(marker: 'shy', text: '她笑了。'), 'shy');
    expect(emotion(marker: '难过', text: '她笑了。'), 'sad');
    expect(emotion(text: '她笑了。'), 'happy');
    expect(emotion(text: '她推开门。'), isNull);
  });

  testWidgets('in the transcript a marker is not a word', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
    await tester.runAsync(() => tavern.narrate(chat, '[表情:开心]她笑着递过一杯茶。'));
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
          home: TavernChatPage(chatId: chat),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final bodies = tester.widgetList<MarkdownBody>(find.byType(MarkdownBody)).map((b) => b.text);
    expect(bodies, contains('她笑着递过一杯茶。'));
    expect(bodies.where((t) => t.contains('[表情')), isEmpty);
  });
}
