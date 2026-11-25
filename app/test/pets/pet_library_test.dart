import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:dsh_app/l10n/gen/app_localizations.dart';
import 'package:dsh_app/pets/pet_library.dart';
import 'package:dsh_app/pets/pet_pack.dart';
import 'package:dsh_app/pets/pet_pack_validator.dart' show petArchiveByteCap;
import 'package:dsh_app/ui/pets/pet_picker.dart' show codexImportWarnings, codexWarningText;
import 'package:flutter/widgets.dart' show Locale;
import 'package:flutter_test/flutter_test.dart';

/// A real (transparent) PNG of [w] × [h]; [data] replaces its image data
/// (filter bytes included), [interlace] sets IHDR's interlace method,
/// [chunks] are empty chunks of those types after IHDR.
Uint8List png(int w, int h, {List<int>? data, int interlace = 0, List<String> chunks = const []}) {
  List<int> chunk(String type, List<int> data) {
    final body = [...ascii.encode(type), ...data];
    final length = ByteData(4)..setUint32(0, data.length);
    final crc = ByteData(4)..setUint32(0, getCrc32(body));
    return [...length.buffer.asUint8List(), ...body, ...crc.buffer.asUint8List()];
  }

  final header = ByteData(13)
    ..setUint32(0, w)
    ..setUint32(4, h)
    ..setUint8(8, 8) // bit depth
    ..setUint8(9, 6) // RGBA
    ..setUint8(12, interlace);
  final rows = <int>[
    for (var y = 0; y < h; y++) ...[0, ...List.filled(w * 4, 0)],
  ];
  return Uint8List.fromList([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, //
    ...chunk('IHDR', header.buffer.asUint8List()),
    for (final type in chunks) ...chunk(type, const []),
    ...chunk('IDAT', ZLibCodec().encode(data ?? rows)),
    ...chunk('IEND', const []),
  ]);
}

/// A small valid pack: one idle animation, two 16×16 cells side by side.
Map<String, Object?> packJson({String id = 'cat', String name = '小猫', String sheet = 'idle.png', int frames = 2}) => {
  'schema': 1,
  'id': id,
  'name': name,
  'author': '阿周',
  'license': 'CC0',
  'canvas': {'w': 16, 'h': 16},
  'contentBox': {'x': 2, 'y': 2, 'w': 12, 'h': 12},
  'animations': {
    'idle': {
      'sheet': sheet,
      'frameW': 16,
      'frameH': 16,
      'cols': 2,
      'box': {'x': 0, 'y': 0, 'w': 16, 'h': 16},
      'frames': [
        for (var i = 0; i < frames; i++) {'i': i, 'ms': 200},
      ],
    },
  },
  'states': {
    'idle': ['idle'],
  },
};

void main() {
  late Directory temp;
  late PetLibrary library;

  setUp(() {
    temp = Directory.systemTemp.createTempSync('pet-library');
    library = PetLibrary(() async => Directory('${temp.path}/pets'));
  });
  tearDown(() => temp.deleteSync(recursive: true));

  File zip(Map<String, List<int>> files) {
    final archive = Archive();
    files.forEach((name, data) => archive.add(ArchiveFile.bytes(name, data)));
    final file = File('${temp.path}/in-${DateTime.now().microsecondsSinceEpoch}.zip');
    file.writeAsBytesSync(ZipEncoder().encode(archive));
    return file;
  }

  Matcher problem(PetImportProblem expected) =>
      throwsA(isA<PetImportException>().having((e) => e.problem, 'problem', expected));

  List<String> leftovers() => [
    for (final e in Directory('${temp.path}/pets').listSync())
      if (e.uri.pathSegments.lastWhere((s) => s.isNotEmpty).startsWith('.')) e.path,
  ];

  test('an id for a folder, after the prefix, and two pets never share one', () {
    // Already a folder name (or exported from here): kept.
    expect(userPetIdFor('cat'), 'user-cat');
    expect(userPetIdFor('user-cat'), 'user-cat');
    expect(userPetIdFor('my-cat'), 'user-my-cat');
    // Anything else: made safe, told apart by a hash of the whole id.
    expect(userPetIdFor('My Cat!'), matches(RegExp(r'^user-my-cat-[0-9a-f]{8}$')));
    expect(userPetIdFor('小猫'), matches(RegExp(r'^user-pet-[0-9a-f]{8}$')));
    expect(userPetIdFor('a' * 60), matches(RegExp('^user-${'a' * 32}-[0-9a-f]{8}\$')));
    final ids = ['小猫', '小狗', 'my cat', 'My Cat', 'my-cat', 'my_cat', 'cat', 'Cat', 'a' * 60, 'a' * 61];
    expect({for (final id in ids) userPetIdFor(id)}, hasLength(ids.length));
    // The same pet again: the same id.
    expect(userPetIdFor('小猫'), userPetIdFor('小猫'));
    expect(isUserPet('user-cat'), isTrue);
    expect(isUserPet('deepy-whale'), isFalse);
  });

  test("a PNG's size from its header", () {
    expect(pngSize(png(32, 16)), (32, 16));
    expect(pngSize(Uint8List.fromList(utf8.encode('not a png at all, really not'))), isNull);
  });

  test('a whole PNG reads through; a cut-off or short one does not', () {
    final whole = png(32, 16);
    expect(pngIntact(whole), isTrue);
    // Cut off: the header still reads, the rest doesn't.
    expect(pngSize(Uint8List.sublistView(whole, 0, whole.length - 20)), (32, 16));
    expect(pngIntact(Uint8List.sublistView(whole, 0, whole.length - 20)), isFalse);
    expect(pngIntact(Uint8List.sublistView(whole, 0, whole.length - 12)), isFalse, reason: 'no IEND');
    // Every chunk whole, but fewer rows than the header says, or more.
    final row = [0, ...List.filled(32 * 4, 0)];
    expect(pngIntact(png(32, 16, data: [for (var y = 0; y < 8; y++) ...row])), isFalse);
    expect(pngIntact(png(32, 16, data: [for (var y = 0; y < 17; y++) ...row])), isFalse);
    // A row with a filter there isn't.
    expect(pngIntact(png(32, 16, data: [9, ...row.skip(1), for (var y = 1; y < 16; y++) ...row])), isFalse);
    // A flipped byte: its CRC no longer matches.
    expect(pngIntact(Uint8List.fromList(whole)..[40] ^= 0xff), isFalse);
    // A chunk a decoder may skip (ancillary: lower-case first letter) is fine; an
    // unknown critical one (upper-case first) or a name that isn't four letters is not.
    expect(pngIntact(png(32, 16, chunks: ['abCd'])), isTrue);
    // One a decoder knows but that is malformed (an empty tEXt has no keyword) is not.
    expect(pngIntact(png(32, 16, chunks: ['tEXt'])), isFalse);
    expect(pngIntact(png(32, 16, chunks: ['ABCD'])), isFalse);
    expect(pngIntact(png(32, 16, chunks: ['ab1d'])), isFalse);
    // Interlaced 2 × 2: Adam7 passes 1, 6 and 7 hold a row each (1, 1 and 2 pixels).
    expect(pngIntact(png(2, 2, interlace: 1, data: List.filled(5 + 5 + 9, 0))), isTrue);
    expect(pngIntact(png(2, 2, interlace: 1, data: List.filled(5 + 5 + 8, 0))), isFalse);
  });

  test('the shipped packs pass every check an import makes', () {
    for (final id in ['deepy-whale', 'whale-girl']) {
      final dir = 'assets/pets/$id';
      final json = jsonDecode(File('$dir/pack.json').readAsStringSync()) as Map<String, Object?>;
      expect(overlayPackProblem(json), isNull, reason: id);
      final sheets = {for (final a in (json['animations']! as Map).values) (a as Map)['sheet'] as String};
      for (final sheet in sheets) {
        expect(pngIntact(File('$dir/$sheet').readAsBytesSync()), isTrue, reason: '$id/$sheet');
      }
    }
  });

  test("what the overlay's parser turns away, PetPack.parse aside", () {
    final idle = (packJson()['animations']! as Map)['idle'] as Map<String, Object?>;
    Map<String, Object?> withIdle(Map<String, Object?> change) => {
      ...packJson(),
      'animations': {
        'idle': {...idle, ...change},
      },
    };
    expect(overlayPackProblem(packJson()), isNull, reason: 'no scale: written out as 1');
    expect(overlayPackProblem({...packJson(), 'scale': 2}), contains('box × scale'));
    expect(overlayPackProblem({...packJson(), 'scale': 1.5}), contains('scale'));
    expect(
      overlayPackProblem({
        ...packJson(),
        'canvas': {'w': 16.5, 'h': 16},
      }),
      contains('canvas'),
    );
    expect(overlayPackProblem(withIdle({'frameW': 15})), contains('box × scale'));
    expect(overlayPackProblem(withIdle({'cols': 1.6})), contains('frames of idle'));
    expect(
      overlayPackProblem(
        withIdle({
          'frames': [
            {'i': 0, 'ms': 200},
            {'i': 1},
          ],
        }),
      ),
      contains('frames of idle'),
      reason: 'the app drops a frame without ms; the overlay refuses the pack',
    );
    // Deepy's 5× cells, as the shipped pack has them.
    expect(
      overlayPackProblem({
        ...withIdle({
          'frameW': 180,
          'frameH': 120,
          'box': {'x': 12, 'y': 26, 'w': 36, 'h': 24},
        }),
        'scale': 5,
        'canvas': {'w': 52, 'h': 52},
      }),
      isNull,
    );
  });

  test('a pack zipped from its folder: kept under its id, only what it uses', () async {
    final result = await library.install(
      zip({
        'cat/pack.json': utf8.encode(jsonEncode(packJson())),
        'cat/idle.png': png(32, 16),
        'cat/readme.txt': utf8.encode('hi'),
        'cat/run.js': utf8.encode('x'),
      }),
    );
    expect(result, (id: 'user-cat', replaced: false));
    final dir = Directory('${temp.path}/pets/user-cat');
    expect(dir.listSync().map((e) => e.uri.pathSegments.last).toSet(), {'pack.json', 'idle.png'});

    final pack = await library.load('user-cat');
    expect(pack.id, 'user-cat');
    expect(pack.name, '小猫');
    expect(pack.author, '阿周');
    expect(pack.dir, dir.path);
    expect((await library.list()).map((p) => p.id), ['user-cat']);
    expect(leftovers(), isEmpty);
    // What the overlay requires (scale) or reads the other way (pixelArt) is spelled out.
    final kept = jsonDecode(File('${dir.path}/pack.json').readAsStringSync()) as Map;
    expect(kept['id'], 'user-cat');
    expect(kept['scale'], 1);
    expect(kept['pixelArt'], isTrue);
  });

  test('two pets whose ids differ only outside a folder name both stay', () async {
    for (final id in ['小猫', '小狗', 'my cat', 'my-cat']) {
      await library.install(
        zip({'pack.json': utf8.encode(jsonEncode(packJson(id: id, name: id))), 'idle.png': png(32, 16)}),
      );
    }
    expect({for (final p in await library.list()) p.name}, {'小猫', '小狗', 'my cat', 'my-cat'});
    // The same one again replaces itself.
    final again = await library.install(
      zip({'pack.json': utf8.encode(jsonEncode(packJson(id: '小猫', name: '大猫'))), 'idle.png': png(32, 16)}),
    );
    expect(again.replaced, isTrue);
    expect({for (final p in await library.list()) p.name}, {'大猫', '小狗', 'my cat', 'my-cat'});
  });

  test('the same pet again replaces it; a different one sits beside it', () async {
    await library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson())), 'idle.png': png(32, 16)}));
    final again = await library.install(
      zip({'pack.json': utf8.encode(jsonEncode(packJson(name: '大猫'))), 'idle.png': png(32, 16)}),
    );
    expect(again.replaced, isTrue);
    expect((await library.load('user-cat')).name, '大猫');
    await library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson(id: 'dog'))), 'idle.png': png(32, 16)}));
    expect((await library.list()).map((p) => p.id), ['user-cat', 'user-dog']);

    await library.remove('user-cat');
    expect((await library.list()).map((p) => p.id), ['user-dog']);
    // Never a built-in one.
    await library.remove('deepy-whale');
    expect(leftovers(), isEmpty);
  });

  group('an interrupted install or removal, put right before the next look', () {
    Directory pets() => Directory('${temp.path}/pets');

    Future<void> installCat() =>
        library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson())), 'idle.png': png(32, 16)}));

    test('killed between the two renames: the old one comes back', () async {
      await installCat();
      // As if the app died after moving the old one aside, before the new one went in.
      Directory('${pets().path}/user-cat').renameSync('${pets().path}/.old-123-user-cat');
      Directory('${pets().path}/.staging-124').createSync();
      expect((await library.list()).map((p) => p.name), ['小猫']);
      expect(leftovers(), isEmpty);
    });

    test('read before it is listed: back too', () async {
      await installCat();
      Directory('${pets().path}/user-cat').renameSync('${pets().path}/.old-123-user-cat');
      expect((await library.load('user-cat')).name, '小猫');
    });

    test('a pet brought back from its backup is announced (the overlay reads it again)', () async {
      final restored = <String>[];
      final watched = PetLibrary(() async => pets(), onRestored: restored.add);
      await installCat();
      Directory('${pets().path}/user-cat').renameSync('${pets().path}/.old-123-user-cat');
      expect((await watched.list()).map((p) => p.id), ['user-cat']);
      expect(restored, ['user-cat']);
      await watched.list();
      expect(restored, ['user-cat'], reason: 'once');
    });

    test('a replacement that landed is never undone; its backup goes', () async {
      await installCat();
      // The old one's folder outlived the swap (it couldn't be deleted then).
      final backup = Directory('${pets().path}/.old-5-user-cat')..createSync();
      File('${backup.path}/pack.json').writeAsStringSync(jsonEncode(packJson(id: 'user-cat', name: '旧猫')));
      expect((await library.list()).map((p) => p.name), ['小猫']);
      expect(leftovers(), isEmpty);
    });

    test('removed while a backup of it is left over: the backup never brings it back', () async {
      await installCat();
      // A replacement whose old folder couldn't be deleted then.
      final backup = Directory('${pets().path}/.old-5-user-cat')..createSync();
      File('${backup.path}/pack.json').writeAsStringSync(jsonEncode(packJson(id: 'user-cat', name: '旧猫')));
      await library.remove('user-cat');
      expect(Directory(backup.path).existsSync(), isFalse);
      expect(await library.list(), isEmpty);
      expect(leftovers(), isEmpty);
    });

    test("a removed pet's trash goes; the pet stays gone", () async {
      await installCat();
      Directory('${pets().path}/user-cat').renameSync('${pets().path}/.trash-9-user-cat');
      expect(await library.list(), isEmpty);
      expect(leftovers(), isEmpty);
    });

    test('a replacement whose sheet will not draw leaves the old one', () async {
      await installCat();
      final cut = png(32, 16);
      await expectLater(
        library.install(
          zip({
            'pack.json': utf8.encode(jsonEncode(packJson(name: '大猫'))),
            'idle.png': Uint8List.sublistView(cut, 0, cut.length - 20),
          }),
        ),
        problem(PetImportProblem.badSheet),
      );
      expect((await library.list()).map((p) => p.name), ['小猫']);
      // Nor one with a critical chunk the phone's decoder may not know.
      await expectLater(
        library.install(
          zip({
            'pack.json': utf8.encode(jsonEncode(packJson(name: '大猫'))),
            'idle.png': png(32, 16, chunks: ['ABCD']),
          }),
        ),
        problem(PetImportProblem.badSheet),
      );
      expect((await library.list()).map((p) => p.name), ['小猫']);
      expect(leftovers(), isEmpty);
    });
  });

  test('schema1 remains authoritative when an extra Codex manifest is present', () async {
    final result = await library.install(
      zip({
        'pack.json': utf8.encode(jsonEncode(packJson())),
        'idle.png': png(32, 16),
        'pet.json': utf8.encode('{not a Codex manifest'),
      }),
    );
    expect(result.id, 'user-cat');
    final dir = await library.folder(result.id);
    expect(dir.listSync().map((e) => e.uri.pathSegments.last).toSet(), {'pack.json', 'idle.png'});
    // Falling back would report a missing Codex atlas. The authored pack's
    // own schema error must remain the reason, and the installed pet survives.
    await expectLater(
      library.install(zip({'pack.json': utf8.encode('{'), 'pet.json': utf8.encode('{}')})),
      problem(PetImportProblem.badPack),
    );
    expect((await library.load('user-cat')).name, '小猫');
  });

  test('failed replacement keeps the previous JSON and sheet byte for byte', () async {
    await library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson())), 'idle.png': png(32, 16)}));
    final dir = await library.folder('user-cat');
    final beforeJson = File('${dir.path}/pack.json').readAsBytesSync();
    final beforePng = File('${dir.path}/idle.png').readAsBytesSync();
    final broken = png(32, 16)..[29] ^= 1;
    await expectLater(
      library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson(name: 'replacement'))), 'idle.png': broken})),
      problem(PetImportProblem.badSheet),
    );
    expect(File('${dir.path}/pack.json').readAsBytesSync(), beforeJson);
    expect(File('${dir.path}/idle.png').readAsBytesSync(), beforePng);
    expect(leftovers(), isEmpty);
  });

  test('oversized archive is rejected before reading its payload', () async {
    // A sparse file exercises the declared-file gate without a large fixture.
    final file = File('${temp.path}/oversized.zip');
    final handle = file.openSync(mode: FileMode.write);
    handle.truncateSync(petArchiveByteCap + 1);
    handle.closeSync();
    await expectLater(library.install(file), problem(PetImportProblem.tooLarge));
    expect(await Directory('${temp.path}/pets').exists(), isFalse);
  });

  group('turned away, nothing left behind', () {
    tearDown(() async {
      if (await Directory('${temp.path}/pets').exists()) expect(leftovers(), isEmpty);
    });

    test('not a zip', () async {
      final file = File('${temp.path}/not.zip')..writeAsStringSync('hello');
      await expectLater(library.install(file), problem(PetImportProblem.notAZip));
    });

    test('no pack.json at its top', () async {
      await expectLater(
        library.install(zip({'a/b/pack.json': utf8.encode('{}'), 'idle.png': png(32, 16)})),
        problem(PetImportProblem.noPack),
      );
    });

    test('a pack.json that does not parse', () async {
      await expectLater(
        library.install(
          zip({
            'pack.json': utf8.encode(jsonEncode({...packJson(), 'schema': 2})),
          }),
        ),
        problem(PetImportProblem.badPack),
      );
      await expectLater(library.install(zip({'pack.json': utf8.encode('{')})), problem(PetImportProblem.badPack));
    });

    test('a sheet it names is missing', () async {
      await expectLater(
        library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson()))})),
        problem(PetImportProblem.missingSheet),
      );
    });

    test('a sheet that climbs out, nests, or is not a PNG', () async {
      for (final sheet in ['../idle.png', 'sheets/idle.png', 'idle.gif', '.idle.png']) {
        await expectLater(
          library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson(sheet: sheet))), sheet: png(32, 16)})),
          problem(PetImportProblem.badSheet),
          reason: sheet,
        );
      }
      await expectLater(
        library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson())), 'idle.png': utf8.encode('GIF89a')})),
        problem(PetImportProblem.badSheet),
      );
    });

    test("what the overlay's parser would turn away", () async {
      final idle = (packJson()['animations']! as Map)['idle'] as Map<String, Object?>;
      final pack = {
        ...packJson(),
        'animations': {
          'idle': {...idle, 'frameW': 15},
        },
      };
      await expectLater(
        library.install(zip({'pack.json': utf8.encode(jsonEncode(pack)), 'idle.png': png(32, 16)})),
        problem(PetImportProblem.badPack),
      );
    });

    test('cells outside the sheet, or a sheet too big to draw', () async {
      // Three cells, two columns: the third needs a second row.
      await expectLater(
        library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson(frames: 3))), 'idle.png': png(32, 16)})),
        problem(PetImportProblem.badSheet),
      );
      await expectLater(
        library.install(zip({'pack.json': utf8.encode(jsonEncode(packJson())), 'idle.png': png(4100, 16)})),
        problem(PetImportProblem.badSheet),
      );
    });
  });

  test('a pet converted from a Codex pet says what did not carry over', () async {
    final dir = Directory.systemTemp.createTempSync('codex-warnings');
    addTearDown(() => dir.deleteSync(recursive: true));
    final json = {
      ...packJson(),
      'codexImport': {
        'warnings': ['roam-left-mirrors-right-track', 'missing-license', 'something-new'],
      },
    };
    File('${dir.path}/pack.json').writeAsStringSync(jsonEncode(json));
    final pack = PetPack.parse(json, dir: dir.path);
    final warnings = codexImportWarnings(pack);
    expect(warnings, ['roam-left-mirrors-right-track', 'missing-license', 'something-new']);
    final l10n = lookupL10n(const Locale('zh'));
    expect(codexWarningText(l10n, warnings[0]), '往左走用的是往右走那一行的镜像');
    expect(codexWarningText(l10n, warnings[1]), '包里没写授权');
    // One this app doesn't know yet: shown as it is.
    expect(codexWarningText(l10n, warnings[2]), 'something-new');
    // Any other pet: nothing to say.
    expect(codexImportWarnings(PetPack.parse(packJson(), dir: dir.path.replaceAll('codex', 'none'))), isEmpty);
  });
}
