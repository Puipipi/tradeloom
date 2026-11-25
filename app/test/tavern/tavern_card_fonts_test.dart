import 'dart:io';
import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_card_theme.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/chat/render/markdown_body.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_ink.dart';
import 'package:dsh_app/ui/tavern/tavern_reading.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// A real TrueType file of the app's own.
final _ttf = File('assets/fonts/JetBrainsMono-Regular.ttf').absolute.path;

TavernCharacter _card({Object? theme, List<TavernCharacterAsset> assets = const []}) =>
    TavernCharacter(id: 'c', name: 'C', theme: theme, assets: assets);

/// The preview, its sample card with [theme] and [assets].
class _Themed extends PreviewTavern {
  _Themed(this.theme, this.assets) : super(tick: Duration.zero);

  final Object? theme;
  final List<TavernCharacterAsset> assets;

  @override
  Future<TavernCharacter?> character(String id) async {
    final c = (await super.character(id))!;
    return TavernCharacter(
      id: c.id,
      name: c.name,
      description: c.description,
      greetings: c.greetings,
      hasLorebook: c.hasLorebook,
      theme: theme,
      assets: assets,
    );
  }
}

void main() {
  test("a theme's fonts: font files among its own local assets, by name", () {
    const body = TavernCharacterAsset(type: 'font', name: '宋体', localPath: '/f/song.ttf');
    const title = TavernCharacterAsset(
      type: 'other',
      name: 'Title',
      uri: 'embeded://fonts/title.otf',
      localPath: '/f/t.otf',
    );
    const picture = TavernCharacterAsset(type: 'background', name: 'Pic', localPath: '/f/pic.png');
    const remote = TavernCharacterAsset(type: 'font', name: 'Far', uri: 'https://example.invalid/far.ttf');
    const assets = [body, title, picture, remote];

    final both = TavernCardTheme.of(
      _card(
        theme: {
          'fonts': {'body': '宋体', 'names': 'embeded://fonts/title.otf'},
        },
        assets: assets,
      ),
    );
    expect(both.bodyFont, '/f/song.ttf');
    expect(both.nameFont, '/f/t.otf');
    expect(both.isEmpty, isFalse);

    // A string is the text's font; other spellings of the two keys.
    expect(TavernCardTheme.of(_card(theme: {'fonts': '宋体'}, assets: assets)).bodyFont, '/f/song.ttf');
    final spelled = TavernCardTheme.of(
      _card(
        theme: {
          'fonts': {'text': 'Title', 'title': '宋体'},
        },
        assets: assets,
      ),
    );
    expect((spelled.bodyFont, spelled.nameFont), ('/f/t.otf', '/f/song.ttf'));

    // A picture, a remote file, a name not there: none.
    for (final named in ['Pic', 'Far', 'missing', '', 3]) {
      final theme = TavernCardTheme.of(
        _card(
          theme: {
            'fonts': {'body': named, 'names': named},
          },
          assets: assets,
        ),
      );
      expect((theme.bodyFont, theme.nameFont), (null, null), reason: '$named');
    }
    expect(TavernCardTheme.of(_card(assets: assets)).bodyFont, isNull);
  });

  test('a font file is told by its first bytes', () {
    Uint8List head(List<int> start) => Uint8List.fromList([...start, ...List.filled(12, 0)]);
    expect(tavernLooksLikeFont(head([0, 1, 0, 0])), isTrue);
    expect(tavernLooksLikeFont(head('OTTO'.codeUnits)), isTrue);
    expect(tavernLooksLikeFont(head('ttcf'.codeUnits)), isTrue);
    expect(tavernLooksLikeFont(head('true'.codeUnits)), isTrue);
    expect(tavernLooksLikeFont(head([0x89, 0x50, 0x4e, 0x47])), isFalse); // PNG
    expect(tavernLooksLikeFont(head('wOFF'.codeUnits)), isFalse); // WOFF: Flutter can't load it
    expect(tavernLooksLikeFont(Uint8List(4)), isFalse);
  });

  testWidgets('a font file loads once as a family; anything else is no font', (tester) async {
    final dir = (await tester.runAsync(() => Directory.systemTemp.createTemp('dsh-card-font-')))!;
    addTearDown(() => tester.runAsync(() => dir.delete(recursive: true)));
    final notFont = File('${dir.path}/fake.ttf');
    await tester.runAsync(() => notFont.writeAsString('not a font at all, really'));
    final container = ProviderContainer();
    addTearDown(container.dispose);

    final family = await tester.runAsync(() => container.read(tavernCardFontProvider(_ttf).future));
    expect(family, startsWith('tavern-card-font-'));
    expect(await tester.runAsync(() => container.read(tavernCardFontProvider(_ttf).future)), family);
    expect(await tester.runAsync(() => container.read(tavernCardFontProvider(notFont.path).future)), isNull);
    expect(await tester.runAsync(() => container.read(tavernCardFontProvider('${dir.path}/gone.ttf').future)), isNull);
  });

  testWidgets("the story's text and the names take the card's fonts", (tester) async {
    late BuildContext inner;
    Future<void> show({String? body, String? names}) async {
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            theme: withTestFonts(buildLightTheme()),
            home: TavernReading(
              bodyFont: body,
              nameFont: names,
              child: Builder(
                builder: (context) {
                  inner = context;
                  return const SizedBox();
                },
              ),
            ),
          ),
        ),
      );
    }

    await show(body: 'CardBody', names: 'CardNames');
    expect(Theme.of(inner).textTheme.bodyLarge?.fontFamily, 'CardBody');
    expect(tavernNameFont(inner), 'CardNames');
    await show();
    expect(Theme.of(inner).textTheme.bodyLarge?.fontFamily, isNot('CardBody'));
    expect(tavernNameFont(inner), isNull);
  });

  testWidgets("in a chat, the card's own font file draws the story", (tester) async {
    SharedPreferences.setMockInitialValues({});
    final tavern = _Themed(
      {
        'fonts': {'body': 'Mono'},
      },
      [TavernCharacterAsset(type: 'font', name: 'Mono', localPath: _ttf)],
    );
    final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
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
    String? font() {
      final story = find.byType(MarkdownBody);
      return story.evaluate().isEmpty ? null : Theme.of(tester.element(story.first)).textTheme.bodyLarge?.fontFamily;
    }

    for (var i = 0; i < 40 && !(font()?.startsWith('tavern-card-font-') ?? false); i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
    }
    expect(font(), startsWith('tavern-card-font-'));
    await tester.pumpAndSettle();
  });
}
