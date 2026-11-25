import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/pets/pet_library.dart';
import 'package:dsh_app/pets/pet_pack_validator.dart';
import 'package:dsh_app/workshop/workshop_receipt.dart';
import 'package:flutter_test/flutter_test.dart';

import '../workshop/support.dart';

void main() {
  late Directory temp;
  late PetLibrary library;
  setUp(() {
    temp = Directory.systemTemp.createTempSync('pet-workshop');
    library = PetLibrary(() async => Directory('${temp.path}/pets'));
  });
  tearDown(() => temp.deleteSync(recursive: true));

  File input({String id = 'cat'}) => workshopZip(temp, {
    'pack.json': utf8.encode(jsonEncode(workshopPet(id: id))), 'idle.png': workshopPng(),
  });
  WorkshopReceipt receipt({String id = 'cat', String version = '1.0.0', String? hash}) => WorkshopReceipt(kind: 'pet', id: id,
    version: version, sha256: hash ?? 'a' * 64, origin: workshopTestOrigin);

  test('export strips unknown fields and only referenced sheets round-trip', () async {
    final json = workshopPet();
    json['key'] = 'PRIVATE_TOP_KEY';
    json['sleep'] = {'afterMs': 12345, 'key': 'PRIVATE_SLEEP_KEY'};
    json['timings'] = {'playMs': {'idle': 500}, 'key': 'PRIVATE_TIMING_KEY'};
    final idle = (json['animations'] as Map)['idle'] as Map;
    idle['key'] = 'PRIVATE_ANIMATION_KEY';
    idle['box'] = {...idle['box'] as Map, 'key': 'PRIVATE_BOX_KEY'};
    await library.install(workshopZip(temp, {'pack.json': utf8.encode(jsonEncode(json)), 'idle.png': workshopPng()}));
    final dir = await library.folder('user-cat');
    File('${dir.path}/unrelated.json').writeAsStringSync('{"key":"PRIVATE_FILE_KEY"}');
    final exported = await library.exportZip('user-cat', File('${temp.path}/out.zip'), publicId: 'cat',
      author: 'Public author', license: 'CC-BY-4.0', source: 'https://source.example/pet');
    final members = workshopUnzip(exported);
    expect(members.keys.toSet(), {'pack.json', 'idle.png'});
    final manifest = utf8.decode(members['pack.json']!);
    expect(manifest, isNot(contains('PRIVATE_')));
    final checked = PetPackValidator.validateArchive(exported.readAsBytesSync());
    expect(checked.pack.id, 'cat');
    expect(checked.pack.author, 'Public author');
    expect(checked.pack.sleepAfter.inMilliseconds, 12345);
    expect(checked.pack.playMs['idle'], 500);
    final other = PetLibrary(() async => Directory('${temp.path}/other'));
    expect((await other.install(exported)).id, 'user-cat');
    expect((await other.load('user-cat')).animations['idle']!.frames.map((f) => f.ms), [200, 300]);
    expect(File('${(await other.folder('user-cat')).path}/idle.png').readAsBytesSync(), members['idle.png']);
  });

  test('reactions export as numbered keys: an array becomes tickle, tickle2, tickle3', () async {
    final json = workshopPet();
    final animations = json['animations'] as Map;
    animations['idle-look'] = <String, Object>{
      ...animations['idle'] as Map<String, Object>,
      'frames': [{'i': 1, 'ms': 200}],
    };
    animations['idle-spout'] = <String, Object>{
      ...animations['idle'] as Map<String, Object>,
      'frames': [{'i': 0, 'ms': 200}],
    };
    json['reactions'] = {
      'tickle': ['idle-look', 'idle', 'idle-spout'],
      'tapLeft': 'idle',
    };
    await library.install(workshopZip(temp, {'pack.json': utf8.encode(jsonEncode(json)), 'idle.png': workshopPng()}));
    final exported = await library.exportZip('user-cat', File('${temp.path}/out.zip'));
    final manifest = jsonDecode(utf8.decode(workshopUnzip(exported)['pack.json']!)) as Map<String, Object?>;
    expect(manifest['reactions'], {
      'tapLeft': 'idle',
      'tickle': 'idle-look',
      'tickle2': 'idle',
      'tickle3': 'idle-spout',
    });
    expect(
      (manifest['reactions']! as Map).values,
      everyElement(isA<String>()),
      reason: 'older apps reject a list: the export keeps the plain-string form',
    );
    final checked = PetPackValidator.validateArchive(exported.readAsBytesSync());
    expect(checked.pack.reactions['tickle'], ['idle-look', 'idle', 'idle-spout'], reason: 'the numbered keys merge back');
  });

  test('source receipt is installed with the directory but never exported', () async {
    await library.install(input(), workshop: receipt());
    expect((await library.workshopReceipt('user-cat'))!.same(receipt()), isTrue);
    expect((await library.workshopReceipts()).keys, ['user-cat']);
    final zip = await library.exportZip('user-cat', File('${temp.path}/out.zip'));
    expect(workshopUnzip(zip).keys, isNot(contains(workshopReceiptName)));
    await library.install(input());
    expect(await library.workshopReceipt('user-cat'), isNull, reason: 'a manual replacement is not the old workshop version');
  });

  test('two public ids that normalize to one folder require explicit replacement', () async {
    await library.install(input(), workshop: receipt());
    await expectLater(library.install(input(id: 'user-cat'), workshop: receipt(id: 'user-cat')),
      workshopError('workshop_install_conflict'));
    expect((await library.workshopReceipt('user-cat'))!.id, 'cat');
    await library.install(input(id: 'user-cat'), workshop: receipt(id: 'user-cat'), replaceExisting: true);
    expect((await library.workshopReceipt('user-cat'))!.id, 'user-cat');
  });

  test('same version cannot change its hash; older versions cannot overwrite newer ones', () async {
    await library.install(input(), workshop: receipt());
    await expectLater(library.install(input(), workshop: receipt(hash: 'b' * 64)), workshopError('workshop_version_rewritten'));
    await library.install(input(), workshop: receipt(version: '1.1.0', hash: 'b' * 64));
    await expectLater(library.install(input(), workshop: receipt()), workshopError('workshop_downgrade'));
    expect((await library.workshopReceipt('user-cat'))!.version, '1.1.0');
  });

  test('an old uninstall request cannot remove a newer installed version', () async {
    final old = receipt();
    await library.install(input(), workshop: old);
    final next = receipt(version: '1.1.0', hash: 'b' * 64);
    await library.install(input(), workshop: next);
    await expectLater(library.remove('user-cat', expectedWorkshop: old), workshopError('workshop_install_conflict'));
    expect((await library.load('user-cat')).id, 'user-cat');
    await library.remove('user-cat', expectedWorkshop: next);
    expect(await library.workshopReceipts(), isEmpty);
  });

  test('export cannot replace managed assets or overwrite an existing destination', () async {
    await library.install(input());
    final before = File('${(await library.folder('user-cat')).path}/pack.json');
    await expectLater(library.exportZip('user-cat', before), throwsA(isA<PetImportException>()));
    final newManagedFile = File('${(await library.folder('user-cat')).path}/new-export.zip');
    await expectLater(library.exportZip('user-cat', newManagedFile), throwsA(isA<PetImportException>()));
    expect(newManagedFile.existsSync(), isFalse);
    final alias = Link('${temp.path}/alias')..createSync(Directory('${temp.path}/pets').path);
    await expectLater(library.exportZip('user-cat', File('${alias.path}/new-export.zip')), throwsA(isA<PetImportException>()));
    final target = File('${temp.path}/saved.zip')..writeAsStringSync('keep');
    await expectLater(library.exportZip('user-cat', target), workshopError('workshop_export_exists'));
    expect(target.readAsStringSync(), 'keep');
    expect((await library.load('user-cat')).id, 'user-cat');
  });

  test('a linked pet directory cannot be exported through regular-looking child files', () async {
    await library.install(input());
    final folder = await library.folder('user-cat');
    final moved = folder.renameSync('${temp.path}/outside');
    Link(folder.path).createSync(moved.path);
    final target = File('${temp.path}/linked.zip');
    await expectLater(library.exportZip('user-cat', target), throwsA(isA<PetImportException>()));
    expect(target.existsSync(), isFalse);
  });
}
