import 'package:dsh_app/tavern/tavern_sprites.dart';
import 'package:dsh_app/ui/companion/companion_log.dart';
import 'package:dsh_app/ui/tavern/tavern_vn_view.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/test_fonts.dart';

const _sprites = {'joy': '/s/joy.png', 'sadness': '/s/sad.png', 'neutral': '/s/neutral.png'};

TavernPage _page(String id, TavernRole role, String text, {String speaker = '林晚', String? speakerId}) => TavernPage(
  TavernMessage(
    nodeId: id,
    role: role,
    speaker: role == TavernRole.user ? 'User' : speaker,
    text: text,
    at: DateTime(2026),
    speakerCharacterId: speakerId,
  ),
  text,
);

Future<void> _show(
  WidgetTester tester,
  List<TavernPage> pages,
  Map<String, String> sprites, {
  TavernVnCast? Function(String id)? castFor,
  String name = '林晚',
}) async {
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: Scaffold(
          body: TavernVisualNovelView(
            pages: pages,
            name: name,
            avatarPath: null,
            topInset: 60,
            onMenu: (_) {},
            footer: (_, _) => null,
            sprites: sprites,
            castFor: castFor,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _back(WidgetTester tester) async {
  await tester.fling(find.byKey(const ValueKey('tavern-vn-box')), const Offset(300, 0), 1000);
  await tester.pumpAndSettle();
}

void main() {
  test("a card's expression pictures: the ones on this phone, by name", () {
    final sprites = tavernSprites(const [
      TavernCharacterAsset(type: 'emotion', name: 'Joy', localPath: '/joy.png'),
      TavernCharacterAsset(type: 'expression', name: ' 害羞 ', localPath: '/shy.png'),
      TavernCharacterAsset(type: 'emotion', name: 'anger', uri: 'https://example.invalid/anger.png'),
      TavernCharacterAsset(type: 'background', name: 'room', localPath: '/room.png'),
      TavernCharacterAsset(type: 'emotion', localPath: '/nameless.png'),
    ]);
    expect(sprites, {'joy': '/joy.png', '害羞': '/shy.png'});
  });

  test('a page picks the sprite its words name, else its feeling, else neutral', () {
    const sprites = {
      'joy': '/joy.png',
      'sadness': '/sad.png',
      '害羞': '/shy.png',
      'neutral': '/neutral.png',
      '笑': '/one.png',
    };
    // Named in the words: the first one named wins over a feeling.
    expect(tavernSpriteFor(sprites, '她有些害羞，却还是笑了。'), '/shy.png');
    expect(tavernSpriteFor(sprites, 'Pure JOY on her face, then sadness.'), '/joy.png');
    // A Latin name only as a word.
    expect(tavernSpriteFor(sprites, 'She did enjoy it.'), '/neutral.png');
    // The feeling the words show, by ST's labels.
    expect(tavernSpriteFor(sprites, '她笑着递过来一杯茶。'), '/joy.png');
    expect(tavernSpriteFor(sprites, '她低下头，眼泪掉了下来。'), '/sad.png');
    // A cold smile is not a happy one; nothing shown: neutral.
    expect(tavernSpriteFor(sprites, '她冷笑一声。'), '/neutral.png');
    // No neutral picture: the card face (null).
    expect(tavernSpriteFor({'joy': '/joy.png'}, '她推开门。'), isNull);
    expect(tavernSpriteFor(const {}, '她笑了。'), isNull);
  });

  testWidgets("her pages show the sprite their words call for; yours keeps her last", (tester) async {
    await _show(tester, [
      _page('a', TavernRole.character, '她笑着递过来一杯茶。'),
      _page('b', TavernRole.user, '你还好吗？'),
      _page('c', TavernRole.character, '她低下头，眼泪掉了下来。'),
    ], _sprites);
    expect(find.byKey(const ValueKey('/s/sad.png')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-vn-face')), findsNothing);

    await _back(tester);
    expect(find.text('2/3'), findsOneWidget);
    expect(find.byKey(const ValueKey('/s/joy.png')), findsOneWidget);
    await _back(tester);
    expect(find.text('1/3'), findsOneWidget);
    expect(find.byKey(const ValueKey('/s/joy.png')), findsOneWidget);
  });

  testWidgets('a group: the stage shows whoever spoke, in their own sprites; back, the one before', (tester) async {
    TavernVnCast? cast(String id) => switch (id) {
      'lin' => (name: '林晚', avatarPath: null, sprites: _sprites),
      'star' => (name: '星图', avatarPath: null, sprites: const {'joy': '/t/joy.png', 'neutral': '/t/neutral.png'}),
      _ => null,
    };
    await _show(
      tester,
      [
        _page('a', TavernRole.character, '她低下头，眼泪掉了下来。', speakerId: 'lin'),
        _page('b', TavernRole.character, '他笑着递过来一杯茶。', speaker: '星图', speakerId: 'star'),
        _page('c', TavernRole.user, '你们俩怎么了？'),
      ],
      _sprites,
      castFor: cast,
    );
    // Your page keeps the last speaker on stage: 星图, smiling.
    expect(find.byKey(const ValueKey('/t/joy.png')), findsOneWidget);
    await _back(tester);
    expect(find.byKey(const ValueKey('/t/joy.png')), findsOneWidget);
    await _back(tester);
    expect(find.byKey(const ValueKey('/s/sad.png')), findsOneWidget);
    expect(find.byKey(const ValueKey('/t/joy.png')), findsNothing);

    // Someone with no sprites stands as their card face.
    await _show(
      tester,
      [_page('d', TavernRole.character, '风停了。', speaker: '路人', speakerId: 'nobody')],
      const {},
      castFor: (id) => (name: '路人', avatarPath: null, sprites: const <String, String>{}),
    );
    expect(find.byKey(const ValueKey('tavern-vn-face')), findsOneWidget);
    expect(find.byKey(const ValueKey(('tavern-vn-cast', '路人'))), findsOneWidget);
  });

  testWidgets("a group's backlog names each line by who said it, not by the group", (tester) async {
    TavernVnCast? cast(String id) => null;
    await _show(
      tester,
      [
        _page('a', TavernRole.character, '欢迎光临。', speakerId: 'lin'),
        _page('b', TavernRole.character, '今晚有雨。', speaker: '星图', speakerId: 'star'),
        _page('c', TavernRole.user, '那我留下。'),
        _page('d', TavernRole.narrator, '门外响起了雷声。', speaker: ''),
      ],
      _sprites,
      castFor: cast,
      name: '林晚、星图',
    );
    await tester.tap(find.byKey(const ValueKey('tavern-vn-log')));
    await tester.pumpAndSettle();
    final log = tester.widget<CompanionLog>(find.byType(CompanionLog));
    expect([for (final e in log.entries) e.who], ['林晚', '星图', null, '旁白']);
    Finder inLog(String text) => find.descendant(of: find.byType(CompanionLog), matching: find.text(text));
    expect(inLog('林晚、星图'), findsNothing);
    expect(inLog('林晚'), findsOneWidget);
    expect(inLog('星图'), findsOneWidget);
    expect(inLog('旁白'), findsOneWidget);
    // Each in the colour the chat gives them, not all in the one accent.
    final tones = {
      for (final e in log.entries)
        if (e.who != null) e.who: e.tone,
    };
    expect(tones.values, everyElement(isNotNull));
    expect(tones['林晚'], isNot(tones['星图']));

    // One character: her lines are just hers, as before.
    await _show(tester, [_page('e', TavernRole.character, '早。')], _sprites);
    await tester.tap(find.byKey(const ValueKey('tavern-vn-log')));
    await tester.pumpAndSettle();
    expect(tester.widget<CompanionLog>(find.byType(CompanionLog)).entries.single.who, isNull);
  });

  testWidgets('no sprites: the card face, as before', (tester) async {
    await _show(tester, [_page('a', TavernRole.character, '她笑着递过来一杯茶。')], const {});
    expect(find.byKey(const ValueKey('tavern-vn-face')), findsOneWidget);
    expect(find.byType(Image), findsNothing);
  });
}
