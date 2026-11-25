import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:dsh_app/pets/codex_pet_converter.dart';
import 'package:dsh_app/pets/pet_library.dart' hide pngSize;
import 'package:dsh_app/pets/pet_pack_validator.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as image;

// Original test artwork: cell identifiers represented by colored rectangles.
// No built-in or third-party pet artwork is copied into the repository.
image.Image atlas(int version) {
  final result = image.Image(width: 1536, height: version == 1 ? 1872 : 2288, numChannels: 4);
  const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
  for (var row = 0; row < (version == 1 ? 9 : 11); row++) {
    for (var col = 0; col < counts[row]; col++) {
      final i = row * 8 + col;
      image.fillRect(
        result,
        x1: col * 192 + 8,
        y1: row * 208 + 8,
        x2: col * 192 + 23,
        y2: row * 208 + 23,
        color: image.ColorRgba8(i + 1, 127, 255 - i, 255),
      );
    }
  }
  return result;
}

late Uint8List v1Png;
late Uint8List v2Png;
late Uint8List v1Webp;

Map<String, Object?> metadata({int version = 1, String sheet = 'atlas.png'}) => {
  'id': 'test-pet',
  'displayName': '测试宠物',
  'description': 'Original colored-cell fixture',
  'spritesheetPath': sheet,
  'spriteVersionNumber': version,
};

Uint8List zipFiles(Map<String, List<int>> files) {
  final archive = Archive();
  files.forEach((name, data) => archive.add(ArchiveFile.bytes(name, data)));
  return Uint8List.fromList(ZipEncoder().encode(archive));
}

Uint8List petZip(
  Map<String, Object?> meta, {
  Uint8List? bytes,
  String prefix = '',
  String? actualName,
  Map<String, List<int>> extra = const {},
}) => zipFiles({
  '${prefix}pet.json': utf8.encode(jsonEncode(meta)),
  '$prefix${actualName ?? meta['spritesheetPath'] ?? 'spritesheet.webp'}': bytes ?? v1Png,
  ...extra,
});

Matcher rejected([String? code]) => throwsA(
  code == null
      ? isA<PetValidationException>()
      : isA<PetValidationException>().having((error) => error.code, 'code', code),
);

void main() {
  setUpAll(() {
    v1Png = image.encodePng(atlas(1));
    v2Png = image.encodePng(atlas(2));
    v1Webp = image.encodeWebP(atlas(1));
  });

  test('v1 preserves its PNG and the 57 occupied cells, with real frame timing', () {
    final converted = CodexPetConverter.convertArchive(petZip(metadata()));
    final pack = converted.validated.pack;
    expect(converted.validated.sheets.keys, ['atlas.png']);
    expect(converted.validated.sheets['atlas.png'], v1Png);
    expect(pack.scale, 1);
    expect(pack.pixelArt, isFalse);
    expect(pack.canvas.width, 192);
    expect(pack.canvas.height, 208);
    expect(pack.animations['idle']!.frames.map((frame) => frame.ms), [1680, 660, 660, 840, 840, 1920]);
    const rows = [
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review',
    ];
    const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6];
    var required = 0;
    for (var row = 0; row < rows.length; row++) {
      final animation = pack.animations[rows[row]]!;
      expect(animation.frames.map((frame) => frame.i), List.generate(counts[row], (col) => row * 8 + col));
      expect(animation.sourceRect(animation.frames.first.i).top, row * 208);
      expect(animation.sourceRect(animation.frames.last.i).left, (counts[row] - 1) * 192);
      expect(pack.playOf(animation), animation.durationMs);
      required += animation.frames.length;
    }
    expect(required, 57);
    expect(converted.warnings, contains('roam-left-mirrors-right-track'));
    expect(converted.warnings, contains('dsh-state-loops-replace-codex-settle-to-idle'));
  });

  test('DSH states, all working tiers, reactions and sleep have explicit mappings', () {
    final pack = CodexPetConverter.convertArchive(petZip(metadata())).validated.pack;
    const expected = {
      'idle': 'idle',
      'thinking': 'waiting',
      'working': 'running',
      'juggling': 'running',
      'notification': 'waiting',
      'attention': 'review',
      'error': 'failed',
      'sweeping': 'running',
      'carrying': 'running',
      'sleeping': 'dsh-sleep',
      'waking': 'jumping',
    };
    for (final state in PetStateName.values) {
      expect(pack.animFor(state).name, expected[state.name]);
    }
    for (var tier = 1; tier <= 3; tier++) {
      expect(pack.animFor(PetStateName.working, tier: tier).name, 'running');
    }
    expect(pack.reaction('tapLeft')!.name, 'waving');
    expect(pack.reaction('tapRight')!.name, 'waving');
    expect(pack.reaction('tickle')!.name, 'jumping');
    expect(pack.reaction('drag')!.name, 'running-right');
    expect(pack.roam.name, 'running-right');
    expect(pack.mirrorWalking(right: false), isTrue);
    expect(pack.animations['dsh-sleep']!.frames.single.i, 0);
  });

  test('v2 keeps all 11 atlas rows and reports unbound 16 look directions', () {
    final result = CodexPetConverter.convertArchive(petZip(metadata(version: 2), bytes: v2Png, prefix: 'pet/'));
    expect(result.spriteVersionNumber, 2);
    expect(result.validated.sheets['atlas.png'], v2Png);
    expect(pngSize(result.validated.sheets['atlas.png']!), (1536, 2288));
    expect(result.warnings, contains('look-directions-not-bound'));
    expect(result.validated.pack.animations.values.expand((a) => a.frames).every((f) => f.i < 72), isTrue);
    expect((result.validated.json['codexImport'] as Map)['profile'], 'work-fixed-v2');
  });

  test('source metadata and missing licensing are preserved without invented permission', () {
    final meta = {
      ...metadata(),
      'author': ' Alice ',
      'license': 'Personal use only',
      'source': 'https://example.test/original',
    };
    final attributed = CodexPetConverter.convertArchive(petZip(meta));
    for (final key in ['author', 'license', 'source', 'description']) {
      expect(attributed.validated.json[key], meta[key]);
    }
    final missing = CodexPetConverter.convertArchive(petZip(metadata()));
    expect(missing.validated.json.containsKey('license'), isFalse);
    expect(missing.warnings, containsAll(['missing-author', 'missing-license', 'missing-source']));
    expect(
      () => CodexPetConverter.convertArchive(petZip(metadata()), profile: PetValidationProfile.market),
      rejected(),
    );
    expect(
      CodexPetConverter.convertArchive(petZip(meta), profile: PetValidationProfile.market).validated.pack.license,
      meta['license'],
    );
    // Match the shared metadata predicate while keeping the author's bytes.
    for (final (text, isMissing) in [('\u001c', true), ('\ufeff', false)]) {
      final result = CodexPetConverter.convertArchive(petZip({...meta, 'license': text}));
      expect((result.validated.json['license'], result.warnings.contains('missing-license')), (text, isMissing));
    }
  });

  test('known CLI manifest defaults are retained and id fallback is deterministic', () {
    final first = CodexPetConverter.convertArchive(petZip({}, bytes: v1Webp));
    final second = CodexPetConverter.convertArchive(petZip({}, bytes: v1Webp));
    expect(first.spriteVersionNumber, 1);
    expect(first.validated.pack.id, second.validated.pack.id);
    expect(first.validated.pack.id, startsWith('codex-'));
    expect(first.validated.pack.name, first.validated.pack.id);
    expect(first.validated.sheets.keys, ['spritesheet.png']);
  });

  test('C907 sheet lookup preserves leading BOM and spaces in authored names', () {
    for (final name in ['\uFEFFatlas.png', ' atlas.png']) {
      final converted = CodexPetConverter.convertArchive(petZip(metadata(sheet: name)));
      expect(converted.validated.sheets.keys, [name]);
      expect(converted.validated.sheets[name], v1Png);
      expect((converted.validated.json['codexImport'] as Map)['sourceSheet'], name);
    }
  });
  test('C907 only absent or whitespace sheet names use the CLI fallback', () {
    for (final raw in [null, '', ' \t\n']) {
      final meta = metadata()..['spritesheetPath'] = raw;
      final converted = CodexPetConverter.convertArchive(petZip(meta, actualName: 'spritesheet.webp', bytes: v1Webp));
      expect(converted.validated.sheets.keys, ['spritesheet.png']);
    }
  });
  test('C907 multibyte Codex output names fail validation before filesystem installation', () {
    final name = '${'界' * 84}.png';
    expect(name.length, lessThanOrEqualTo(120));
    expect(utf8.encode(name), hasLength(256));
    expect(() => CodexPetConverter.convertArchive(petZip(metadata(sheet: name))), rejected('sheet-name'));
  });

  test('a real CLI custom grid covers the unchanged atlas exactly', () {
    final meta = {
      ...metadata(),
      'frame': {'width': 384, 'height': 104, 'columns': 4, 'rows': 18},
    };
    final result = CodexPetConverter.convertArchive(petZip(meta));
    final review = result.validated.pack.animations['review']!;
    expect(review.frameWidth, 384);
    expect(review.frameHeight, 104);
    expect(review.cols, 4);
    expect(review.sourceRect(64).top, 1664);
    expect(result.validated.sheets['atlas.png'], v1Png);
  });

  test('CLI frame order, fps rounding and loop overrides survive conversion', () {
    final meta = {
      ...metadata(),
      'animations': {
        'idle': {
          'frames': [1, 0],
          'fps': 3,
          'loop': true,
        },
        'running': {
          'frames': [61, 60, 60],
          'fps': 60,
          'loop': false,
          'fallback': 'idle',
        },
        'custom': {
          'frames': [42],
          'fps': 2,
          'loop': true,
          'fallback': 'review',
        },
        'dsh-sleep': {
          'frames': [5],
          'fps': 8,
        },
      },
    };
    final result = CodexPetConverter.convertArchive(petZip(meta));
    final pack = result.validated.pack;
    expect(pack.animations['idle']!.frames.map((f) => (f.i, f.ms)), [(1, 333), (0, 333)]);
    expect(pack.animations['running']!.frames.map((f) => (f.i, f.ms)), [(61, 17), (60, 17), (60, 17)]);
    expect(pack.animations['running']!.loop, isFalse);
    expect(pack.animations['custom']!.frames.single.ms, 500);
    expect(pack.animFor(PetStateName.sleeping).name, 'dsh-sleep-');
    expect(pack.animFor(PetStateName.sleeping).frames.single.i, 1);
    expect(
      result.warnings,
      containsAll(['fps-rounded-to-milliseconds', 'one-shot-return-controlled-by-dsh', 'custom-tracks-not-bound']),
    );
  });

  test('unsupported or inconsistent versions and grids are rejected', () {
    for (final version in [0, 3, '2', 1.0, null]) {
      expect(
        () => CodexPetConverter.convertArchive(petZip({...metadata(), 'spriteVersionNumber': version})),
        rejected('codex-version'),
      );
    }
    expect(() => CodexPetConverter.convertArchive(petZip(metadata(), bytes: v2Png)), rejected('codex-atlas-size'));
    for (final frame in [
      {'width': 192, 'height': 208, 'columns': 7, 'rows': 9},
      {'width': 0, 'height': 208, 'columns': 8, 'rows': 9},
      {'width': 8, 'height': 8, 'columns': 192, 'rows': 234},
      {'width': 192.0, 'height': 208, 'columns': 8, 'rows': 9},
    ]) {
      expect(() => CodexPetConverter.convertArchive(petZip({...metadata(), 'frame': frame})), rejected('codex-frame'));
    }
    expect(
      () => CodexPetConverter.convertArchive(
        petZip({
          ...metadata(version: 2),
          'frame': {'width': 384, 'height': 104, 'columns': 4, 'rows': 22},
        }, bytes: v2Png),
      ),
      rejected('codex-frame-version'),
    );
    expect(
      () => CodexPetConverter.convertArchive(
        petZip({
          ...metadata(version: 2),
          'animations': {
            'idle': {
              'frames': [0],
            },
          },
        }, bytes: v2Png),
      ),
      rejected('codex-animations-version'),
    );
  });

  test('malformed overrides, frame indices, fps and unsupported fallback are rejected', () {
    for (final spec in [
      {'frames': []},
      {
        'frames': [0.5],
      },
      {
        'frames': [-1],
      },
      {
        'frames': [256],
      },
      {
        'frames': [1],
        'fps': 0,
      },
      {
        'frames': [1],
        'fps': 61,
      },
      {
        'frames': [1],
        'fps': '8',
      },
      {
        'frames': [1],
        'loop': 1,
      },
      {
        'frames': [1],
        'fallback': null,
      },
    ]) {
      expect(
        () => CodexPetConverter.convertArchive(
          petZip({
            ...metadata(),
            'animations': {'idle': spec},
          }),
        ),
        rejected('codex-animation'),
      );
    }
    for (final spec in [
      {
        'frames': [1],
        'fps': 1e-300,
      },
      {
        'frames': [0, 1, 2],
        'fps': 0.000001,
      },
    ]) {
      expect(
        () => CodexPetConverter.convertArchive(
          petZip({
            ...metadata(),
            'animations': {'idle': spec},
          }),
        ),
        rejected('codex-animation-duration'),
      );
    }
    expect(
      () => CodexPetConverter.convertArchive(
        petZip({
          ...metadata(),
          'animations': {
            'idle': {
              'frames': [72],
            },
          },
        }),
      ),
      rejected('codex-frame-index'),
    );
    expect(
      () => CodexPetConverter.convertArchive(
        petZip({
          ...metadata(),
          'animations': {
            'idle': {
              'frames': [1],
              'fallback': 'missing',
            },
          },
        }),
      ),
      rejected('codex-fallback-reference'),
    );
    expect(
      () => CodexPetConverter.convertArchive(
        petZip({
          ...metadata(),
          'animations': {
            'idle': {
              'frames': [1],
              'loop': false,
              'fallback': 'review',
            },
          },
        }),
      ),
      rejected('codex-fallback-unsupported'),
    );
    expect(
      () => CodexPetConverter.convertArchive(petZip({...metadata(), 'animations': null})),
      rejected('codex-animations'),
    );
  });

  test('metadata cannot escape its own folder or select a remote resource', () {
    for (final path in [
      '../atlas.png',
      '/atlas.png',
      'sub/atlas.png',
      'C:\\atlas.png',
      '.atlas.png',
      'https://example.test/pet.png',
      'bad\u0000.png',
      'a' * 117 + '.png',
    ]) {
      expect(
        () =>
            CodexPetConverter.convertArchive(petZip({...metadata(), 'spritesheetPath': path}, actualName: 'atlas.png')),
        rejected('codex-sheet-name'),
      );
    }
    expect(
      () => CodexPetConverter.convertArchive(
        petZip({...metadata(), 'spritesheetPath': 'missing.png'}, actualName: 'atlas.png'),
      ),
      rejected('sheet-missing'),
    );
    expect(
      () => CodexPetConverter.convertArchive(
        petZip({...metadata(), 'spritesheetPath': 'pet.gif'}, actualName: 'atlas.png'),
      ),
      rejected('codex-sheet-name'),
    );
  });

  test('filename length uses the existing UTF16 limit', () {
    final within = '${'😀' * 58}.png';
    expect(within.length, 120);
    final result = CodexPetConverter.convertArchive(petZip(metadata(sheet: within)));
    expect(result.validated.sheets.keys, [within]);
    final beyond = '${'😀' * 59}.png';
    expect(
      () => CodexPetConverter.convertArchive(petZip(metadata(sheet: beyond), actualName: 'atlas.png')),
      rejected('codex-sheet-name'),
    );
  });

  test('manifest ambiguity, strict duplicate JSON and corrupt PNG are rejected', () {
    expect(
      () => CodexPetConverter.convertArchive(petZip(metadata(), extra: {'other/pet.json': utf8.encode('{}')})),
      rejected('codex-manifest'),
    );
    expect(() => CodexPetConverter.convertArchive(petZip(metadata(), prefix: 'one/two/')), rejected('codex-manifest'));
    expect(
      () => CodexPetConverter.convertArchive(zipFiles({'pet.json': utf8.encode('{"id":"a","id":"b"}')})),
      rejected(),
    );
    final damaged = Uint8List.fromList(v1Png);
    damaged[damaged.length - 1] ^= 1;
    expect(() => CodexPetConverter.convertArchive(petZip(metadata(), bytes: damaged)), rejected());
    final result = CodexPetConverter.convertArchive(
      petZip(
        metadata(),
        extra: {
          'run.js': [1, 2],
          'unused.png': [3],
        },
      ),
    );
    expect(result.validated.dropped, ['run.js', 'unused.png']);
    expect(result.validated.sheets.keys, ['atlas.png']);
  });

  test('static WebP becomes one lossless PNG without changing decoded pixels or layout', () {
    final result = CodexPetConverter.convertArchive(petZip(metadata(sheet: 'atlas.webp'), bytes: v1Webp));
    final decoded = image.decodePng(result.validated.sheets['atlas.png']!)!;
    expect(decoded.width, 1536);
    expect(decoded.height, 1872);
    expect(sha256.convert(decoded.getBytes()).toString(), sha256.convert(atlas(1).getBytes()).toString());
    expect(result.warnings, contains('webp-transcoded-to-png'));
    expect(result.validated.pack.animations.values.every((a) => a.sheet == 'atlas.png'), isTrue);
  });

  test('lossy WebP with alpha retains decoded pixels during PNG conversion', () {
    final bytes = image.encodeWebP(atlas(1), lossless: false, method: 0, quality: 50);
    final sourcePixels = image.decodeWebP(bytes)!;
    final result = CodexPetConverter.convertArchive(petZip(metadata(sheet: 'atlas.webp'), bytes: bytes));
    final outputPixels = image.decodePng(result.validated.sheets['atlas.png']!)!;
    expect(outputPixels.width, 1536);
    expect(outputPixels.height, 1872);
    expect(sha256.convert(outputPixels.getBytes()).toString(), sha256.convert(sourcePixels.getBytes()).toString());
    expect(outputPixels.getPixel(0, 0).a, 0);
  });

  test('WebP checks its complete RIFF structure and rejects hidden animation chunks', () {
    Uint8List withChunk(String tag, List<int> payload) {
      final length = ByteData(4)..setUint32(0, payload.length, Endian.little);
      final bytes = Uint8List.fromList([
        ...v1Webp,
        ...ascii.encode(tag),
        ...length.buffer.asUint8List(),
        ...payload,
        if (payload.length.isOdd) 0,
      ]);
      ByteData.sublistView(bytes).setUint32(4, bytes.length - 8, Endian.little);
      return bytes;
    }

    for (final bytes in [
      Uint8List.fromList([...v1Webp, 0]),
      Uint8List.fromList(v1Webp.sublist(0, v1Webp.length - 1)),
      withChunk('ANIM', [0, 0, 0, 0, 0, 0]),
      withChunk('ANMF', List.filled(16, 0)),
      withChunk('VP8L', [0]),
      withChunk('VP8X', List.filled(10, 0)),
    ]) {
      expect(() => CodexPetConverter.convertArchive(petZip(metadata(sheet: 'atlas.webp'), bytes: bytes)), rejected());
    }
    expect(
      () => CodexPetConverter.convertArchive(petZip(metadata(sheet: 'atlas.webp'), bytes: v1Png)),
      rejected('codex-webp-header'),
    );
    expect(() => CodexPetConverter.convertArchive(petZip(metadata(), bytes: v1Webp)), rejected('codex-atlas-size'));
  });

  test('WebP advertised giant canvas is rejected before allocating its pixels', () {
    final bytes = Uint8List.fromList([
      ...ascii.encode('RIFF'),
      22,
      0,
      0,
      0,
      ...ascii.encode('WEBP'),
      ...ascii.encode('VP8X'),
      10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      255,
      255,
      255,
      255,
      255,
      255,
    ]);
    expect(
      () => CodexPetConverter.convertArchive(petZip(metadata(sheet: 'atlas.webp'), bytes: bytes)),
      rejected('codex-atlas-size'),
    );
    bytes[20] = 2;
    expect(
      () => CodexPetConverter.convertArchive(petZip(metadata(sheet: 'atlas.webp'), bytes: bytes)),
      rejected('codex-webp-animated'),
    );
  });

  test('the App installs the converted pack through its normal transactional library', () async {
    final temp = Directory.systemTemp.createTempSync('codex-import-');
    try {
      final input = File('${temp.path}/pet.zip')
        ..writeAsBytesSync(
          petZip(
            metadata(),
            prefix: 'pet/',
            extra: {
              'run.js': [0],
            },
          ),
        );
      final library = PetLibrary(() async => Directory('${temp.path}/library'));
      final result = await library.install(input);
      expect(result.id, 'user-test-pet');
      final again = await library.install(input);
      expect(again, (id: result.id, replaced: true));
      final kept = File('${temp.path}/library/${result.id}/pack.json');
      final before = kept.readAsBytesSync();
      input.writeAsBytesSync(petZip({...metadata(), 'spriteVersionNumber': 99}));
      await expectLater(library.install(input), throwsA(isA<PetImportException>()));
      expect(kept.readAsBytesSync(), before);
      expect(
        Directory('${temp.path}/library').listSync().where((e) => e.uri.pathSegments.any((s) => s.startsWith('.'))),
        isEmpty,
      );
      final pack = await library.load(result.id);
      expect(pack.animations['waiting']!.frames.first.i, 48);
      expect(
        Directory('${temp.path}/library/${result.id}').listSync().map((file) => file.uri.pathSegments.last).toSet(),
        {'pack.json', 'atlas.png'},
      );
    } finally {
      temp.deleteSync(recursive: true);
    }
  });
}
