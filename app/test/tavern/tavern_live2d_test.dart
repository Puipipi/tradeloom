import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:dsh_app/companion/companion_pack.dart';
import 'package:dsh_app/tavern/tavern_live2d.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_vn_view.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// A stand-in runtime: what the app checks is its digest, not what it runs.
final _runtime = {
  'runtime/live2dcubismcore.min.js': utf8.encode('core'),
  'runtime/cubism-framework.js': utf8.encode('framework'),
};
final _runtimeDigest = runtimeDigest({
  for (final MapEntry(:key, :value) in _runtime.entries) key: sha256.convert(value).toString(),
});

/// A model's folder zipped, as people have it.
Uint8List _bareModel() => ZipEncoder().encodeBytes(
  Archive()
    ..add(ArchiveFile.bytes('lin/lin.model3.json', utf8.encode('{"Version":3}')))
    ..add(ArchiveFile.bytes('lin/lin.moc3', [1, 2, 3]))
    ..add(ArchiveFile.bytes('lin/lin.4096/texture_00.png', [0x89, 0x50])),
);

/// A whole pack: the runtime and a character.
Uint8List _wholePack() {
  final archive = Archive();
  for (final MapEntry(:key, :value) in _runtime.entries) {
    archive.add(ArchiveFile.bytes(key, value));
  }
  archive
    ..add(ArchiveFile.bytes('character/whale.model3.json', utf8.encode('{"Version":3}')))
    ..add(ArchiveFile.bytes('character/whale.moc3', [4, 5]));
  return ZipEncoder().encodeBytes(archive);
}

/// Cues as lists, which compare by their contents.
List<List<Object?>> _plain(List<(String, Map<String, Object?>)> cues) => [
  for (final (type, args) in cues) [type, args],
];

void _writeRuntime(Directory pack) {
  for (final MapEntry(:key, :value) in _runtime.entries) {
    File('${pack.path}/$key')
      ..createSync(recursive: true)
      ..writeAsBytesSync(value);
  }
}

void main() {
  group('what the stage plays', () {
    test('a feeling the words name first; a cold smile is not a happy one', () {
      expect(tavernEmotionIn('她笑了笑，把杯子推过来。'), 'happy');
      expect(tavernEmotionIn('她冷笑一声。'), isNull);
      expect(tavernEmotionIn('她脸红了，又忍不住笑出声。'), 'shy');
      expect(tavernEmotionIn('*瞪大眼睛* 「你说什么？」'), 'surprised');
      expect(tavernEmotionIn('She blushes and looks away.'), 'shy');
      expect(tavernEmotionIn('「炉子还热着。」'), isNull);
    });

    test('listening to you; for hers, her mouth for as long as the words, and the feeling', () {
      expect(_plain(tavernStageCues(you: true, text: '外面怎么了？')), [
        [
          'mood',
          {'mood': 'listening'},
        ],
      ]);
      expect(_plain(tavernStageCues(you: false, text: '她笑了。')), [
        [
          'mood',
          {'mood': 'idle'},
        ],
        [
          'say',
          {'chars': 4},
        ],
        [
          'emotion',
          {'name': 'happy'},
        ],
      ]);
      expect(_plain(tavernStageCues(you: false, text: '「嗯。」')), [
        [
          'mood',
          {'mood': 'idle'},
        ],
        [
          'say',
          {'chars': 4},
        ],
      ]);
    });
  });

  group('installing a model', () {
    late Directory tmp;
    late File zip;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('tavern-live2d');
      zip = File('${tmp.path}/model.zip')..writeAsBytesSync(_bareModel());
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    Future<CompanionPackStore> store() =>
        tavernLive2dStore(() async => Directory('${tmp.path}/live2d'), 'c1', expectedRuntime: _runtimeDigest);

    test('a model on its own borrows the companion room\'s runtime', () async {
      final companion = Directory('${tmp.path}/companion/pack');
      _writeRuntime(companion);
      final s = await store();
      await installTavernLive2d(s, zip.path, companionPack: () async => companion, bundled: () async => null);
      expect(await s.installed(), isTrue);
      expect(File('${s.pack.path}/character/lin.model3.json').existsSync(), isTrue);
      expect(File('${s.pack.path}/runtime/live2dcubismcore.min.js').readAsStringSync(), 'core');
    });

    test('a runtime that is not the pinned one is never borrowed', () async {
      final companion = Directory('${tmp.path}/companion/pack');
      _writeRuntime(companion);
      File('${companion.path}/runtime/live2dcubismcore.min.js').writeAsStringSync('changed');
      final s = await store();
      await expectLater(
        installTavernLive2d(s, zip.path, companionPack: () async => companion, bundled: () async => null),
        throwsA(isA<CompanionPackException>().having((e) => e.problem, 'problem', CompanionPackProblem.noRuntime)),
      );
      expect(await s.installed(), isFalse);
    });

    test('without the room\'s, the pack inside the app brings the runtime', () async {
      final s = await store();
      await installTavernLive2d(
        s,
        zip.path,
        companionPack: () async => Directory('${tmp.path}/nowhere'),
        bundled: () async => _wholePack(),
      );
      expect(await s.installed(), isTrue);
      // Her own model, not the one the pack came with.
      expect(File('${s.pack.path}/character/lin.model3.json').existsSync(), isTrue);
      expect(File('${s.pack.path}/character/whale.model3.json').existsSync(), isFalse);
    });

    test('taking it away, or the character, leaves nothing behind', () async {
      final companion = Directory('${tmp.path}/companion/pack');
      _writeRuntime(companion);
      final s = await store();
      await installTavernLive2d(s, zip.path, companionPack: () async => companion, bundled: () async => null);
      await forgetTavernLive2d(() async => Directory('${tmp.path}/live2d'), 'c1');
      expect(s.root.existsSync(), isFalse);
    });
  });

  group('the visual novel', () {
    TavernMessage m(String id, TavernRole role, String text) =>
        TavernMessage(nodeId: id, role: role, speaker: '林晚', text: text, at: DateTime(2026));

    testWidgets('stands her model where the card was, and says which page is up', (tester) async {
      final told = <String>[];
      final pages = tavernPages([m('a', TavernRole.character, '「进来吧。」\n\n她笑了。'), m('b', TavernRole.user, '外面怎么了？')]);
      await tester.pumpWidget(
        MaterialApp(
          theme: withTestFonts(buildLightTheme()),
          locale: const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: Scaffold(
            body: TavernVisualNovelView(
              pages: pages,
              name: '林晚',
              avatarPath: null,
              topInset: 0,
              onMenu: (_) {},
              footer: (_, _) => null,
              stage: const ColoredBox(key: ValueKey('her'), color: Colors.pink),
              onPage: (p) => told.add(p.text),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('her')), findsOneWidget);
      expect(told, ['外面怎么了？']); // the newest

      await tester.fling(find.byKey(const ValueKey('tavern-vn-box')), const Offset(400, 0), 1000);
      await tester.pumpAndSettle();
      expect(told, ['外面怎么了？', '她笑了。']);

      await tester.pump();
      expect(told, hasLength(2)); // the same page again says nothing
    });
  });

  testWidgets('a character\'s page imports a model for her, and says when there is no runtime', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final tmp = (await tester.runAsync(() async => Directory.systemTemp.createTemp('tavern-live2d')))!;
    addTearDown(() => tmp.deleteSync(recursive: true));
    final companion = Directory('${tmp.path}/companion/pack');
    var withRuntime = false;
    final tavern = PreviewTavern(tick: Duration.zero);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          tavernProvider.overrideWith((ref) => tavern),
          tavernLive2dRootProvider.overrideWithValue(() async => Directory('${tmp.path}/live2d')),
          tavernCompanionPackProvider.overrideWithValue(() async => companion),
          tavernBundledPackProvider.overrideWithValue(() async => null),
          tavernLive2dRuntimeProvider.overrideWithValue(_runtimeDigest),
          tavernLive2dPickerProvider.overrideWithValue(() async {
            if (withRuntime) _writeRuntime(companion);
            return File('${tmp.path}/pick-${DateTime.now().microsecondsSinceEpoch}.zip')
              ..writeAsBytesSync(_bareModel());
          }),
        ],
        child: MaterialApp(
          theme: withTestFonts(buildLightTheme()),
          locale: const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: const TavernCharacterPage(characterId: 'sample-innkeeper'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    Future<void> drain(bool Function() done) async {
      for (var i = 0; i < 100 && !done(); i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
        await tester.pump();
      }
      await tester.pumpAndSettle();
    }

    // On the 配置 tab, below the fold: built once scrolled to.
    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-character-tabs')), matching: find.text('配置')),
    );
    await tester.pumpAndSettle();
    await tester.dragUntilVisible(
      find.byKey(const ValueKey('tavern-live2d')),
      find.byType(CustomScrollView),
      const Offset(0, -300),
    );
    await tester.pumpAndSettle();
    expect(find.text('未导入'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-live2d')));
    await drain(() => find.textContaining('运行库').evaluate().isNotEmpty);
    expect(find.text('手机上还没有 Live2D 运行库：先在伙伴小屋装一个形象，或者导入完整的素材包。'), findsOneWidget);
    expect(find.text('未导入'), findsOneWidget);

    withRuntime = true;
    await tester.tap(find.byKey(const ValueKey('tavern-live2d')));
    await drain(() => find.text('已导入').evaluate().isNotEmpty);
    expect(find.text('已导入'), findsOneWidget);
    expect(find.text('导入好了，切到视觉小说排版就能看到她。'), findsOneWidget);
  });
}
