// What the 玩法包 pages count on from the real engine: the manifest helpers
// read an installed version, a cast member made into a character maps into
// a binding, and a preview composes for a real character.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:dsh_app/tavern/tavern_packs.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter_test/flutter_test.dart';

Uint8List _pack() {
  final manifest = {
    'formatVersion': 1,
    'packId': 'guards',
    'packVersion': '1',
    'dshgo': {
      'cast': [
        {
          'id': 'guard',
          'card': {'name': '守卫'},
        },
      ],
    },
    'resources': [
      {'localId': 'rules', 'kind': 'regex', 'path': 'regex/rules.json'},
    ],
  };
  final rule = {
    'scriptName': 'Bad',
    'findRegex': '/[/g',
    'replaceString': '',
    'placement': [2],
  };
  final archive = Archive()
    ..addFile(ArchiveFile.string('pack.json', jsonEncode(manifest)))
    ..addFile(ArchiveFile.string('regex/rules.json', jsonEncode(rule)));
  return Uint8List.fromList(ZipEncoder().encode(archive));
}

void main() {
  test('install, make the cast member a character, map it into a binding, preview for a real card', () async {
    final dir = await Directory.systemTemp.createTemp('packs-engine');
    addTearDown(() => dir.delete(recursive: true));
    final tavern = await openTavern(dir.path);
    addTearDown(tavern.close);

    final installed = await tavern.importGameplayPack(_pack());
    final version = installed.version;
    expect(tavernPackTitle(version), 'guards');
    expect([for (final r in tavernPackResources(version)) r['localId']], ['rules']);
    expect(tavernPackResourceIssues(version, 'rules'), isNotEmpty);
    expect(tavernPackIssueLine(tavernPackResourceIssues(version, 'rules').first), isNotEmpty);
    final cast = tavernPackCast(version).single;
    expect((cast.localId, cast.name, cast.resource), ('guard', '守卫', false));
    expect((await tavern.importGameplayPack(_pack())).reused, isTrue);

    final made = await tavern.importDshgoCastMember(
      tavernPackCastSource(version.ref, cast),
      cast.localId,
      operationId: 'op-cast',
    );
    expect(made.receipt.committed, isTrue);
    final mapping = made.mapping!;
    expect((await tavern.watchCharacters().first).map((c) => c.id), contains(mapping.characterId));

    const scope = TavernPackScopeTarget(kind: TavernGameplayScope.global);
    final before = await tavern.readGameplayBindings(scope);
    final receipt = await tavern.updateGameplayBindings(
      scope,
      expected: before.token,
      operationId: 'op-bind',
      edits: [
        TavernPackBindingEdit.create(
          clientKey: 'k',
          packRef: version.ref,
          castImports: {'guard': TavernCastImportRef(domainId: mapping.domainId, operationId: mapping.operationId)},
        ),
      ],
    );
    final binding = receipt.snapshot.bindings.single;
    expect(binding.bindingId, receipt.createdBindings['k']);
    expect(binding.castImports['guard']?.operationId, 'op-cast');

    final resolution = await tavern.resolveGameplayConfig(TavernGameplayContext(characterId: mapping.characterId));
    expect(resolution.sources, isNotEmpty);
  });
}
