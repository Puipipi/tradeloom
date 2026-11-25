import 'dart:io';
import 'dart:ui' as ui;

import 'package:dsh_app/tavern/tavern_card_theme.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_reading.dart';
import 'package:dsh_app/ui/tavern/tavern_vn_view.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_app/wallpaper/custom_wallpaper.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, its sample card carrying [theme] as extensions.dshgo.theme.
class _Themed extends PreviewTavern {
  _Themed(this.theme) : super(tick: Duration.zero);

  final Object? theme;

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
    );
  }
}

TavernCharacter _card({Object? theme, List<TavernCharacterAsset> assets = const []}) =>
    TavernCharacter(id: 'c', name: 'C', theme: theme, assets: assets);

Future<String> _open(WidgetTester tester, PreviewTavern tavern, {Map<String, Object> prefs = const {}}) async {
  final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
  SharedPreferences.setMockInitialValues({
    for (final MapEntry(:key, :value) in prefs.entries) key.replaceAll('{chat}', chat): value,
  });
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
  return chat;
}

/// The colour the story draws the innkeeper's name in (novel layout).
Color? _nameColor(WidgetTester tester) =>
    tester.widget<Text>(find.descendant(of: find.byType(TavernReading), matching: find.text('林晚')).first).style?.color;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('CSS colours as cards write them; anything else is none', () {
    expect(tavernCssColor('#E91E63'), const Color(0xffe91e63));
    expect(tavernCssColor(' #abc '), const Color(0xffaabbcc));
    expect(tavernCssColor('#abcd'), const Color(0xddaabbcc));
    expect(tavernCssColor('#11223344'), const Color(0x44112233));
    expect(tavernCssColor('rgb(255, 0, 10)'), const Color(0xffff000a));
    expect(tavernCssColor('rgba(0,0,0,0.5)'), const Color(0x80000000));
    expect(tavernCssColor('rgba(0,0,0,50%)'), const Color(0x80000000));
    for (final none in ['red', '', '#12', 'hsl(0, 0%, 0%)', 'var(--x)', 42, null]) {
      expect(tavernCssColor(none), isNull, reason: '$none');
    }
  });

  test('a theme reads leniently: accent, layout, name colours and a local background', () {
    const sunny = TavernCharacterAsset(type: 'background', name: '晴天', localPath: '/a.png');
    const rain = TavernCharacterAsset(type: 'background', name: '雨夜', localPath: '/b.png');
    const remote = TavernCharacterAsset(type: 'background', name: '远方', uri: 'https://example.invalid/x.png');
    final theme = TavernCardTheme.of(
      _card(
        theme: {
          'accent': '#8a2be2',
          'layout': 'vn',
          'names': {'林晚': '#ff0000', 'bad': 'nope', 3: '#fff'},
          'background': '雨夜',
          'fonts': {'body': 'x'},
        },
        assets: [sunny, rain, remote],
      ),
    );
    expect(theme.accent, const Color(0xff8a2be2));
    expect(theme.layout, TavernLayout.visualNovel);
    expect(theme.names, {'林晚': const Color(0xffff0000)});
    expect(theme.background, '/b.png');

    // No background named: the first background on this phone.
    expect(TavernCardTheme.of(_card(theme: const {}, assets: [remote, sunny, rain])).background, '/a.png');
    // Named, but only remote: none, never fetched.
    expect(TavernCardTheme.of(_card(theme: {'background': '远方'}, assets: [remote, sunny])).background, isNull);
    expect(TavernCardTheme.of(_card(theme: {'layout': 'novel'})).layout, TavernLayout.novel);
    expect(TavernCardTheme.of(_card(theme: {'layout': 'bubble'})).layout, TavernLayout.bubble);
    expect(TavernCardTheme.of(_card(theme: {'layout': 'grid'})).layout, isNull);
    expect(TavernCardTheme.of(_card(theme: 'not a map')).isEmpty, isTrue);
    expect(TavernCardTheme.of(_card()).isEmpty, isTrue);
  });

  testWidgets('a chat starts in the card’s layout', (tester) async {
    await _open(tester, _Themed({'layout': 'vn'}));
    expect(find.byType(TavernVisualNovelView), findsOneWidget);
  });

  testWidgets('the chat’s own layout wins over the card’s', (tester) async {
    await _open(tester, _Themed({'layout': 'vn'}), prefs: {'tavern.layout.{chat}': 'bubble'});
    expect(find.byType(TavernVisualNovelView), findsNothing);
  });

  testWidgets('with the card’s look off, 酒馆设置 decides', (tester) async {
    await _open(tester, _Themed({'layout': 'vn'}), prefs: {TavernSettingsController.cardThemeKey: false});
    expect(find.byType(TavernVisualNovelView), findsNothing);
  });

  testWidgets('the card’s accent colours the lead’s name; its own name colour wins', (tester) async {
    await _open(tester, _Themed({'layout': 'novel', 'accent': '#8a2be2'}));
    expect(_nameColor(tester), const Color(0xff8a2be2));
  });

  testWidgets('a name colour of the card’s own', (tester) async {
    await _open(
      tester,
      _Themed({
        'layout': 'novel',
        'accent': '#8a2be2',
        'names': {'林晚': '#123456'},
      }),
    );
    expect(_nameColor(tester), const Color(0xff123456));
  });

  testWidgets('no theme: the app’s own colour', (tester) async {
    await _open(tester, _Themed(null), prefs: {'tavern.layout.{chat}': 'novel'});
    final primary = Theme.of(tester.element(find.byType(TavernChatPage))).colorScheme.primary;
    expect(_nameColor(tester), primary);
  });

  // A plain test: decoding runs on real time, as in launch_import_test.
  test('a card background is read in place, only its size decoded; a missing file is none', () async {
    final dir = Directory.systemTemp.createTempSync('dsh-card-bg-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final path = '${dir.path}/bg.png';
    final recorder = ui.PictureRecorder();
    Canvas(recorder).drawRect(const Rect.fromLTWH(0, 0, 4, 3), Paint()..color = const Color(0xff336699));
    final image = await recorder.endRecording().toImage(4, 3);
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    File(path).writeAsBytesSync(png!.buffer.asUint8List());

    final container = ProviderContainer();
    addTearDown(container.dispose);
    Future<CustomWallpaper?> read(String at) {
      container.listen(tavernCardBackgroundProvider(at), (_, _) {});
      return container.read(tavernCardBackgroundProvider(at).future);
    }

    final picture = (await read(path))!;
    expect((picture.path, picture.width, picture.height), (path, 4, 3));
    expect(File(path).existsSync(), isTrue); // not moved or copied
    expect(await read('${dir.path}/missing.png'), isNull);
  });
}
