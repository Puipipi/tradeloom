import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:dsh_app/companion/companion_pack.dart';
import 'package:flutter_test/flutter_test.dart';

const _core = 'runtime/live2dcubismcore.min.js';

Map<String, List<int>> _runtime() => {_core: utf8.encode('core'), 'runtime/cubism-framework.js': utf8.encode('fw')};

Map<String, List<int>> _character() => {
  'character/m.model3.json': utf8.encode('{}'),
  'character/m.moc3': [1, 2, 3],
  'character/character.json': utf8.encode('{"name":"鲸鱼娘","author":"某人"}'),
  'character/贴图 1/texture_00.png': [4, 5],
};

String _digest(Map<String, List<int>> files) => runtimeDigest({
  for (final e in files.entries)
    if (e.key.startsWith('runtime/')) e.key: sha256.convert(e.value).toString(),
});

void main() {
  late Directory root;
  late CompanionPackStore store;

  String zip(Map<String, List<int>> files) {
    final archive = Archive();
    files.forEach((name, data) => archive.add(ArchiveFile.bytes(name, data)));
    final path = '${root.path}/in-${DateTime.now().microsecondsSinceEpoch}.zip';
    File(path).writeAsBytesSync(ZipEncoder().encode(archive));
    return path;
  }

  Matcher problem(CompanionPackProblem expected) =>
      throwsA(isA<CompanionPackException>().having((e) => e.problem, 'problem', expected));

  setUp(() {
    root = Directory.systemTemp.createTempSync('companion-pack');
    store = CompanionPackStore(root, expectedRuntime: _digest(_runtime()));
  });

  tearDown(() => root.deleteSync(recursive: true));

  test('runtimeDigest does not depend on order', () {
    expect(runtimeDigest({'b': '2', 'a': '1'}), runtimeDigest({'a': '1', 'b': '2'}));
    expect(runtimeDigest({'a': '1'}), isNot(runtimeDigest({'a': '2'})));
  });

  test('isSafePackPath', () {
    for (final ok in ['a', 'a/b.png', '贴图 1/texture.png', 'a..b/c']) {
      expect(isSafePackPath(ok), isTrue, reason: ok);
    }
    for (final bad in ['', '/etc/passwd', '../x', 'a/../b', 'a/./b', r'a\b', 'a//b', 'a/']) {
      expect(isSafePackPath(bad), isFalse, reason: bad);
    }
  });

  test('installs a full pack and reads its character', () async {
    expect(await store.installed(), isFalse);
    await store.install(zip({..._runtime(), ..._character()}));
    expect(await store.installed(), isTrue);
    expect(File('${store.pack.path}/character/贴图 1/texture_00.png').readAsBytesSync(), [4, 5]);
    final index = jsonDecode(File('${store.pack.path}/character/index.json').readAsStringSync()) as List;
    expect(index, contains('m.model3.json'));
    final character = await store.character();
    expect(character.name, '鲸鱼娘');
    expect(character.author, '某人');
    expect(character.license, isNull);
  });

  test('refuses a runtime it does not know, and keeps what was there', () async {
    await store.install(zip({..._runtime(), ..._character()}));
    final other = {
      ..._runtime(),
      _core: utf8.encode('something else'),
      ..._character(),
      'character/other.model3.json': utf8.encode('{}'),
    };
    await expectLater(store.install(zip(other)), problem(CompanionPackProblem.runtimeMismatch));
    expect(File('${store.pack.path}/$_core').readAsStringSync(), 'core');
    expect(File('${store.pack.path}/character/other.model3.json').existsSync(), isFalse);
    expect(Directory('${root.path}/pack.staging').existsSync(), isFalse);
  });

  test('a character alone keeps the installed runtime', () async {
    await store.install(zip({..._runtime(), ..._character()}));
    await store.install(
      zip({'character/new.model3.json': utf8.encode('{}'), 'character/character.json': utf8.encode('{"name":"新角色"}')}),
    );
    expect((await store.character()).name, '新角色');
    expect(File('${store.pack.path}/$_core').readAsStringSync(), 'core');
    expect(File('${store.pack.path}/character/m.moc3').existsSync(), isFalse);
  });

  test('a character alone needs a runtime first', () async {
    await expectLater(store.install(zip(_character())), problem(CompanionPackProblem.noRuntime));
  });

  test('no scripts or pages among character files', () async {
    for (final name in ['character/run.js', 'character/index.html', 'character/x.svg', 'character/noext']) {
      await expectLater(
        store.install(zip({..._runtime(), ..._character(), name: utf8.encode('x')})),
        problem(CompanionPackProblem.forbiddenFile),
        reason: name,
      );
    }
  });

  test('no paths out of the pack', () async {
    for (final name in ['../evil.png', 'character/../../evil.png', 'other/file.png', '/abs/file.png']) {
      await expectLater(
        store.install(zip({..._runtime(), ..._character(), name: utf8.encode('x')})),
        problem(CompanionPackProblem.unsafePath),
        reason: name,
      );
    }
    expect(File('${root.path}/evil.png').existsSync(), isFalse);
  });

  test('needs a model', () async {
    await expectLater(
      store.install(zip({..._runtime(), 'character/character.json': utf8.encode('{}')})),
      problem(CompanionPackProblem.noModel),
    );
  });

  test('something that is not a zip', () async {
    final path = '${root.path}/not.zip';
    File(path).writeAsStringSync('hello');
    await expectLater(store.install(path), problem(CompanionPackProblem.notAPack));
  });

  test('a model as it comes: its folder zipped, beside the installed runtime', () async {
    await store.install(zip({..._runtime(), ..._character()}));
    await store.install(
      zip({
        '大肥鱼/大肥鱼.model3.json': utf8.encode('{}'),
        '大肥鱼/大肥鱼.moc3': [1, 2, 3],
        '大肥鱼/大肥鱼.4096/texture_00.png': [4, 5],
        '大肥鱼/Animation/挥手.motion3.json': utf8.encode('{}'),
        // The editor's files and the archiver's own are left behind.
        '大肥鱼/大肥鱼.cmo3': [6],
        '大肥鱼/notes.psd': [7],
        '大肥鱼/.DS_Store': [8],
        '__MACOSX/大肥鱼/._大肥鱼.moc3': [9],
      }),
    );
    final pack = store.pack.path;
    expect((await store.character()).name, '大肥鱼');
    final character = jsonDecode(File('$pack/character/character.json').readAsStringSync()) as Map;
    expect(character['model'], '大肥鱼.model3.json');
    expect(File('$pack/character/大肥鱼.4096/texture_00.png').existsSync(), isTrue);
    expect(File('$pack/character/Animation/挥手.motion3.json').existsSync(), isTrue);
    expect(File('$pack/character/大肥鱼.cmo3').existsSync(), isFalse);
    expect(File('$pack/character/notes.psd').existsSync(), isFalse);
    expect(Directory('$pack/character/__MACOSX').existsSync(), isFalse);
    expect(File('$pack/$_core').readAsStringSync(), 'core');
    final index = (jsonDecode(File('$pack/character/index.json').readAsStringSync()) as List).cast<String>();
    expect(index, containsAll(['大肥鱼.model3.json', 'Animation/挥手.motion3.json', 'character.json']));
  });

  test('a bare model with no folder, or in folders of its own', () async {
    await store.install(zip({..._runtime(), ..._character()}));
    await store.install(
      zip({
        'm.model3.json': utf8.encode('{}'),
        'm.moc3': [1],
      }),
    );
    expect((await store.character()).name, 'm');
    await store.install(
      zip({
        'a/x.model3.json': utf8.encode('{}'),
        'b/x.moc3': [1],
      }),
    );
    final character = jsonDecode(File('${store.pack.path}/character/character.json').readAsStringSync()) as Map;
    expect(character['model'], 'a/x.model3.json');
    // Whatever case the exporter wrote the suffix in.
    await store.install(
      zip({
        'M.MODEL3.JSON': utf8.encode('{}'),
        'M.MOC3': [1],
      }),
    );
    expect((await store.character()).name, 'M');
  });

  test('a bare model gets the same checks', () async {
    await store.install(zip({..._runtime(), ..._character()}));
    await expectLater(
      store.install(
        zip({
          'm.moc3': [1],
          'readme.txt': [2],
        }),
      ),
      problem(CompanionPackProblem.noModel),
    );
    await expectLater(
      store.install(
        zip({
          'm.model3.json': utf8.encode('{}'),
          '../evil.png': [1],
        }),
      ),
      problem(CompanionPackProblem.unsafePath),
    );
    expect(File('${root.path}/evil.png').existsSync(), isFalse);
    // Scripts never land, even left behind quietly.
    await store.install(zip({'m.model3.json': utf8.encode('{}'), 'run.js': utf8.encode('x')}));
    expect(File('${store.pack.path}/character/run.js').existsSync(), isFalse);
  });

  test('a Cubism 2 model is told apart from a zip with no model', () async {
    await store.install(zip({..._runtime(), ..._character()}));
    await expectLater(
      store.install(
        zip({
          'old/model.json': utf8.encode('{}'),
          'old/old.moc': [1, 2],
        }),
      ),
      problem(CompanionPackProblem.legacyModel),
    );
  });

  test('a bare model needs a runtime first', () async {
    await expectLater(
      store.install(zip({'m.model3.json': utf8.encode('{}')})),
      problem(CompanionPackProblem.noRuntime),
    );
  });

  test('remove', () async {
    await store.install(zip({..._runtime(), ..._character()}));
    await store.remove();
    expect(await store.installed(), isFalse);
    await store.remove();
  });
}
