import 'dart:convert';

import 'package:dsh_app/tavern/tavern_card_sites.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_home_page.dart';
import 'package:dsh_app/ui/tavern/tavern_widgets.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, accepting a card import.
class _Importing extends PreviewTavern {
  _Importing() : super(tick: const Duration(milliseconds: 1));

  final imported = <({String? fileName, Uint8List bytes})>[];

  @override
  Future<TavernCharacter> importCard(Uint8List bytes, {String? fileName}) async {
    imported.add((fileName: fileName, bytes: bytes));
    return TavernCharacter(id: 'sample-innkeeper', name: '林晚', importedAt: DateTime.now());
  }
}

Future<List<Uri>> _importLink(
  WidgetTester tester,
  _Importing tavern,
  String link,
  http.Response Function(Uri url) answer,
) async {
  final asked = <Uri>[];
  // An empty clipboard, answered at once.
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    SystemChannels.platform,
    (call) async => call.method == 'Clipboard.getData' ? <String, Object?>{'text': ''} : null,
  );
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => tavern),
        tavernHttpClientProvider.overrideWithValue(
          MockClient((request) async {
            asked.add(request.url);
            return answer(request.url);
          }),
        ),
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
  await tester.tap(find.byKey(const ValueKey('tavern-import')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('tavern-import-link')));
  await tester.pumpAndSettle();
  await tester.enterText(find.byKey(const ValueKey('tavern-link-field')), link);
  await tester.tap(find.byKey(const ValueKey('tavern-link-go')));
  await tester.pumpAndSettle();
  return asked;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  final card = utf8.encode(
    jsonEncode({
      'spec': 'chara_card_v3',
      'data': {'name': '林晚'},
    }),
  );

  testWidgets('a link to a card file downloads, imports and opens the card', (tester) async {
    final tavern = _Importing();
    final asked = await _importLink(
      tester,
      tavern,
      'https://example.com/cards/innkeeper.json',
      (_) => http.Response.bytes(card, 200, headers: {'content-type': 'application/json'}),
    );

    expect(asked.single.toString(), 'https://example.com/cards/innkeeper.json');
    expect(tavern.imported.single.fileName, 'innkeeper.json');
    expect(tavern.imported.single.bytes, card);
    expect(find.byType(TavernCharacterPage), findsOneWidget);
  });

  testWidgets('a web page instead of a card file says how to get the file', (tester) async {
    final tavern = _Importing();
    await _importLink(
      tester,
      tavern,
      'https://example.com/characters/innkeeper',
      (_) => http.Response('<html></html>', 200, headers: {'content-type': 'text/html; charset=utf-8'}),
    );
    expect(tavern.imported, isEmpty);
    expect(find.textContaining('这是网页，不是卡文件'), findsOneWidget);
  });

  testWidgets('a failed download says the status', (tester) async {
    final tavern = _Importing();
    await _importLink(tester, tavern, 'https://example.com/missing.png', (_) => http.Response('', 404));
    expect(tavern.imported, isEmpty);
    expect(find.text('下载失败（HTTP 404）'), findsOneWidget);
  });

  testWidgets('something that is not a web address is not fetched', (tester) async {
    final tavern = _Importing();
    final asked = await _importLink(tester, tavern, '林晚的卡', (_) => http.Response('', 200));
    expect(asked, isEmpty);
    expect(find.text('这不是一个网址'), findsOneWidget);
  });

  test('character pages on Chub and RisuRealm are known; other pages are not', () {
    for (final (link, id) in [
      ('https://chub.ai/characters/someone/lin-wan-1a2b', 'someone/lin-wan-1a2b'),
      ('https://www.chub.ai/characters/someone/lin-wan-1a2b?tab=main', 'someone/lin-wan-1a2b'),
      ('https://venus.chub.ai/characters/someone/lin-wan/', 'someone/lin-wan'),
      ('https://characterhub.org/characters/someone/lin-wan', 'someone/lin-wan'),
      ('https://chub.ai/someone/lin-wan', 'someone/lin-wan'),
    ]) {
      expect(tavernCardSiteOf(Uri.parse(link)), (site: TavernCardSite.chub, id: id), reason: link);
    }
    const risu = '7adb0ed8d81855c820b3506980fb40f054ceef010ff0c4bab73730c0ebe92279';
    expect(tavernCardSiteOf(Uri.parse('https://realm.risuai.net/character/$risu')), (
      site: TavernCardSite.risu,
      id: risu,
    ));
    for (final link in [
      'https://chub.ai/lorebooks/someone/a-book',
      'https://chub.ai/characters/someone',
      'https://chub.ai/search',
      'https://chub.ai/a/b/c',
      'https://realm.risuai.net/',
      'https://realm.risuai.net/character/not-hex!',
      'https://example.com/characters/someone/lin-wan',
      'https://avatars.charhub.io/avatars/someone/lin-wan/chara_card_v2.png',
    ]) {
      expect(tavernCardSiteOf(Uri.parse(link)), isNull, reason: link);
    }
  });

  test("Chub's description of a character becomes a V2 card, fields crossed over", () {
    final card = chubCardOf({
      'name': '林晚（项目名）',
      'topics': ['旅店', 3, '雨夜'],
      'definition': {
        'name': '林晚',
        'personality': '旅店老板娘，说话慢。',
        'tavern_personality': '温和',
        'description': '作者的话：慢热向。',
        'first_message': '雨下大了，进来坐吧。',
        'example_dialogs': '<START>',
        'scenario': '雨夜的旅店',
        'system_prompt': '',
        'post_history_instructions': '',
        'alternate_greetings': ['又是你啊。'],
        'embedded_lorebook': {'entries': <Object?>[]},
        'extensions': {
          'chub': {'id': 1},
        },
      },
    }, creator: 'someone');
    final data = card['data']! as Map<String, Object?>;
    expect(card['spec'], 'chara_card_v2');
    expect(data['name'], '林晚');
    expect(data['description'], '旅店老板娘，说话慢。');
    expect(data['personality'], '温和');
    expect(data['creator_notes'], '作者的话：慢热向。');
    expect(data['first_mes'], '雨下大了，进来坐吧。');
    expect(data['alternate_greetings'], ['又是你啊。']);
    expect(data['tags'], ['旅店', '雨夜']);
    expect(data['creator'], 'someone');
    expect(data['character_book'], {'entries': <Object?>[]});
  });

  final chubNode = {
    'node': {
      'name': '林晚',
      'topics': ['旅店'],
      'max_res_url': 'https://avatars.charhub.io/avatars/someone/lin-wan/chara_card_v2.png',
      'definition': {'name': '林晚', 'personality': '旅店老板娘。', 'first_message': '进来坐吧。'},
    },
  };
  // 1×1 PNG.
  final picture = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  );

  testWidgets("a Chub page reads the site's card and puts it in the site's picture", (tester) async {
    final tavern = _Importing();
    final asked = await _importLink(
      tester,
      tavern,
      'https://chub.ai/characters/someone/lin-wan',
      (url) => url.host == 'api.chub.ai'
          ? http.Response(jsonEncode(chubNode), 200, headers: {'content-type': 'application/json; charset=utf-8'})
          : http.Response.bytes(picture, 200, headers: {'content-type': 'image/png'}),
    );
    expect(asked.map((u) => u.toString()), [
      'https://api.chub.ai/api/characters/someone/lin-wan?full=true',
      'https://avatars.charhub.io/avatars/someone/lin-wan/chara_card_v2.png',
    ]);
    final imported = tavern.imported.single;
    expect(imported.fileName, '林晚.png');
    final card = const CardCodec().decode(imported.bytes);
    expect(card.name, '林晚');
    expect(card.data['description'], '旅店老板娘。');
    expect(card.data['first_mes'], '进来坐吧。');
    expect(card.png, isNotNull);
    expect(find.byType(TavernCharacterPage), findsOneWidget);
  });

  testWidgets('without its picture the Chub card still comes, as JSON', (tester) async {
    final tavern = _Importing();
    await _importLink(
      tester,
      tavern,
      'https://chub.ai/someone/lin-wan',
      (url) => url.host == 'api.chub.ai'
          ? http.Response.bytes(utf8.encode(jsonEncode(chubNode)), 200)
          : http.Response('', 403),
    );
    expect(tavern.imported.single.fileName, '林晚.json');
    expect(const CardCodec().decode(tavern.imported.single.bytes).data['description'], '旅店老板娘。');
  });

  testWidgets('a character the site does not have says so; the address may come without https', (tester) async {
    final tavern = _Importing();
    final asked = await _importLink(tester, tavern, 'chub.ai/characters/someone/gone', (_) => http.Response('{}', 404));
    expect(asked.single.toString(), 'https://api.chub.ai/api/characters/someone/gone?full=true');
    expect(tavern.imported, isEmpty);
    expect(find.text('站上没有这个角色，可能删了或没公开'), findsOneWidget);
  });

  testWidgets("a RisuRealm page downloads the site's PNG card", (tester) async {
    final tavern = _Importing();
    final asked = await _importLink(
      tester,
      tavern,
      'https://realm.risuai.net/character/7adb0ed8-d818-55c8-20b3-506980fb40f0',
      (_) => http.Response.bytes(picture, 200, headers: {'content-type': 'image/png'}),
    );
    expect(
      asked.single.toString(),
      'https://realm.risuai.net/api/v1/download/png-v3/7adb0ed8-d818-55c8-20b3-506980fb40f0?non_commercial=true',
    );
    expect(tavern.imported.single.bytes, picture);
    expect(tavern.imported.single.fileName, '7adb0ed8-d818-55c8-20b3-506980fb40f0.png');
  });
}
