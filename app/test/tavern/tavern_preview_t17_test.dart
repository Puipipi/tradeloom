import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:flutter_test/flutter_test.dart';

/// The preview's part of the engine's T17/T18 surface: what it keeps it does
/// as the engine; what it does not keep it says so, rather than pretending.
void main() {
  test('selectNode stops the path at the node, or keeps what was chosen below it', () async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await tavern.createChat('sample-innkeeper');
    await tavern.sendOnly(chat, '一');
    await tavern.sendOnly(chat, '二');
    await tavern.sendOnly(chat, '三');
    final path = await tavern.path(chat);
    expect(path.map((m) => m.text).skip(1), ['一', '二', '三']);

    final changes = <void>[];
    final listening = tavern.pathChanges(chat).listen(changes.add);
    await tavern.selectNode(chat, path[2].nodeId, restoreDescendants: true);
    expect((await tavern.path(chat)).map((m) => m.text).skip(1), ['一', '二', '三']);

    await tavern.selectNode(chat, path[2].nodeId);
    expect((await tavern.path(chat)).map((m) => m.text).skip(1), ['一', '二']);
    // Nothing deleted: the old continuation is still a branch.
    expect((await tavern.tree(chat)).map((n) => n.nodeId), contains(path[3].nodeId));
    await Future<void>.delayed(Duration.zero);
    expect(changes, hasLength(2));
    await listening.cancel();
  });

  test('state and director read as empty and off; edits and runs are refused', () async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await tavern.createChat('sample-innkeeper');
    final state = await tavern.readState(chat);
    expect((state.legacy, state.initialized, state.valueExists), (true, false, false));
    expect(state.nodeId, (await tavern.path(chat)).last.nodeId);
    await expectLater(tavern.setStateValue(chat, '/x', 1), throwsUnsupportedError);
    expect(await tavern.readAgentRuns(chat), isEmpty);

    final director = await tavern.watchDirector(chat).first;
    expect((director.automaticEnabled, director.pendingJobs, director.running), (false, 0, false));
    expect(director.latestSuccess, isNull);
    await expectLater(tavern.runDirector(chat), throwsUnsupportedError);
    expect(await tavern.readDirectorEvents(chat), isEmpty);
    await expectLater(tavern.readDirectorEvents(chat, limit: -1), throwsArgumentError);
  });
}
