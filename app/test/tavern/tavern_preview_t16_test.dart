import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter_test/flutter_test.dart';

/// The preview keeps T16's contract in memory: the whole tree with branch
/// names, one message out with its children kept, lines added without a
/// reply, and the card's own lorebook edited by entry.
void main() {
  Future<(PreviewTavern, String)> chatWithReply() async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await tavern.createChat('sample-innkeeper');
    await tavern.send(chat, '外面怎么了？').drain<void>();
    return (tavern, chat);
  }

  test('the tree has every node, the current path marked, a branch named', () async {
    final (tavern, chat) = await chatWithReply();
    final reply = (await tavern.path(chat)).last;
    await tavern.regenerate(chat, reply.nodeId).drain<void>();
    final tree = await tavern.tree(chat);
    expect(tree, hasLength(5)); // two greetings, your line, two replies
    expect(tree.where((n) => n.isCurrentPath), hasLength(3));
    expect(tree.firstWhere((n) => n.nodeId == reply.nodeId).isCurrentPath, isFalse);
    expect(tree.last.siblingCount, 2);

    await tavern.nameBranch(chat, reply.nodeId, '  她先说了地下室 ');
    expect((await tavern.tree(chat)).firstWhere((n) => n.nodeId == reply.nodeId).branchName, '她先说了地下室');
    await tavern.nameBranch(chat, reply.nodeId, '');
    expect((await tavern.tree(chat)).firstWhere((n) => n.nodeId == reply.nodeId).branchName, isNull);
  });

  test('deleting one message keeps what came after it, moved up', () async {
    final (tavern, chat) = await chatWithReply();
    final [greeting, yours, reply] = await tavern.path(chat);
    await tavern.deleteMessage(chat, yours.nodeId);
    final path = await tavern.path(chat);
    expect(path.map((m) => m.nodeId), [greeting.nodeId, reply.nodeId]);
    expect(path.last.parentId, greeting.nodeId);
  });

  test('a line goes in without a reply; narration as the narrator', () async {
    final (tavern, chat) = await chatWithReply();
    final mine = await tavern.sendOnly(chat, '（我没说话，只是坐下。）');
    final told = await tavern.narrate(chat, '  雨停了。 ');
    final path = await tavern.path(chat);
    expect(path.map((m) => m.nodeId).skip(3), [mine.nodeId, told.nodeId]);
    expect(told.role, TavernRole.narrator);
    expect(told.text, '雨停了。');
    expect(await tavern.readVariables(chat), isEmpty);
  });

  test("the card's own lorebook gains, changes and loses entries by index", () async {
    final tavern = PreviewTavern(tick: Duration.zero);
    Future<List<Map<String, Object?>>> entries() async => [
      for (final e
          in (((await tavern.characterFields('sample-innkeeper'))!['character_book']! as Map)['entries']! as List))
        e as Map<String, Object?>,
    ];
    final had = await entries();
    await tavern.addCharacterBookEntry('sample-innkeeper', {
      'keys': ['地下室'],
      'content': '锁着。',
    });
    await tavern.addCharacterBookEntry('sample-innkeeper', {
      'keys': ['码头'],
      'content': '有船。',
    });
    final now = await entries();
    expect(now, hasLength(had.length + 2));
    // Each new entry an id of its own.
    expect({for (final e in now) e['id']}, hasLength(now.length));

    final first = had.length;
    await tavern.updateCharacterBookEntry('sample-innkeeper', first, {'content': '钥匙在她身上。'});
    expect((await entries())[first]['content'], '钥匙在她身上。');
    expect((await entries())[first]['keys'], ['地下室']);
    expect(() => tavern.updateCharacterBookEntry('sample-innkeeper', first, {'id': 9}), throwsArgumentError);
    expect(() => tavern.updateCharacterBookEntry('sample-innkeeper', first + 5, {}), throwsRangeError);

    await tavern.deleteCharacterBookEntry('sample-innkeeper', first);
    expect((await entries()).skip(had.length).map((e) => e['content']), ['有船。']);
  });
}
