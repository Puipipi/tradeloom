// What the draft pages count on from the real engine: applying a draft, the
// newest version being the current one (历史版本 restores against it), and
// 按现在的版本继续 carrying the changes not applied yet.

import 'dart:io';

import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('apply, the newest version is the current one, then continue from it with the rest', () async {
    final dir = await Directory.systemTemp.createTemp('drafts-engine');
    addTearDown(() => dir.delete(recursive: true));
    final tavern = await openTavern(dir.path);
    addTearDown(tavern.close);
    final card = await tavern.importCard(
      await File('assets/tavern/sample_innkeeper.json').readAsBytes(),
      fileName: 'sample_innkeeper.json',
    );
    final target = TavernAuthoringTarget(kind: TavernAuthoringTargetKind.character, id: card.id);
    final resource = target.physicalResourceId;
    TavernAuthoringChange set(String id, String path, String value) => TavernAuthoringChange(
      id: id,
      physicalResourceId: resource,
      path: path,
      operation: TavernAuthoringChangeKind.set,
      value: value,
    );

    final created = await tavern.createAuthoringDraft([target]);
    final draft = await tavern.editAuthoringDraft(
      created.id,
      draftRevision: created.draftRevision,
      changes: [set('greeting', '/data/first_mes', '你又来了。'), set('scene', '/data/scenario', '雨夜')],
    );
    final receipt = await tavern.applyAuthoringChanges(
      draft.id,
      draftRevision: draft.draftRevision,
      physicalResourceId: resource,
      changeIds: ['greeting'],
      expectedAuthorityRevision: draft.sources.single.authorityRevision!,
      operationId: 'op-1',
    );
    expect(receipt.committed, isTrue);
    expect((await tavern.characterFields(card.id))!['first_mes'], '你又来了。');

    // An ordinary edit is a version too; the newest is what restore expects.
    await tavern.updateCharacterFields(card.id, {'personality': '慢'});
    final versions = await tavern.listAuthoringRevisions(resource);
    final current = (await tavern.createAuthoringDraft([target])).sources.single.authorityRevision!;
    expect(TavernAuthorityRevision(domainId: versions.first.domainId, revision: versions.first.revision), current);

    // The draft's base is behind: applying the rest is refused until it
    // continues from now with the change not applied.
    await expectLater(
      tavern.applyAuthoringChanges(
        draft.id,
        draftRevision: draft.draftRevision,
        physicalResourceId: resource,
        changeIds: ['scene'],
        expectedAuthorityRevision: draft.sources.single.authorityRevision!,
        operationId: 'op-2',
      ),
      throwsA(isA<TavernAuthoringException>().having((e) => e.code, 'code', 'authority_conflict')),
    );
    final caught = await tavern.rebaseAuthoringDraft(
      draft.id,
      draftRevision: draft.draftRevision,
      changes: [draft.changes.last],
    );
    final second = await tavern.applyAuthoringChanges(
      caught.id,
      draftRevision: caught.draftRevision,
      physicalResourceId: resource,
      changeIds: ['scene'],
      expectedAuthorityRevision: caught.sources.single.authorityRevision!,
      operationId: 'op-3',
    );
    expect(second.committed, isTrue);
    final fields = (await tavern.characterFields(card.id))!;
    expect(fields['scenario'], '雨夜');
    expect(fields['personality'], '慢');
  });
}
