import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:flutter_test/flutter_test.dart';

/// The preview keeps T24's contract in memory: a deletion returns a token
/// that undoes it; search is literal, newest first.
void main() {
  Future<(PreviewTavern, String)> chatWithReply() async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await tavern.createChat('sample-innkeeper');
    await tavern.send(chat, '外面怎么了？').drain<void>();
    return (tavern, chat);
  }

  test('a deletion comes back with its token, path and all', () async {
    final (tavern, chat) = await chatWithReply();
    final before = await tavern.path(chat);
    expect(before, hasLength(3));

    final token = await tavern.deleteFrom(chat, before[1].nodeId);
    expect((await tavern.path(chat)).map((m) => m.nodeId), [before[0].nodeId]);

    expect(await tavern.undoDeleteFrom(chat, token), isTrue);
    expect((await tavern.path(chat)).map((m) => m.nodeId), before.map((m) => m.nodeId));
    // Used once.
    expect(await tavern.undoDeleteFrom(chat, token), isFalse);
  });

  test('a token undoes nothing in another chat, or when unknown', () async {
    final (tavern, chat) = await chatWithReply();
    final other = await tavern.createChat('sample-innkeeper');
    final token = await tavern.deleteFrom(chat, (await tavern.path(chat)).last.nodeId);
    expect(await tavern.undoDeleteFrom(other, token), isFalse);
    expect(await tavern.undoDeleteFrom(chat, 'deletion-404'), isFalse);
    expect(await tavern.undoDeleteFrom(chat, token), isTrue);
  });

  test('search is literal and newest first; blank finds nothing; limit cuts', () async {
    final (tavern, chat) = await chatWithReply();
    await tavern.send(chat, '地下室在哪？').drain<void>();
    final hits = await tavern.searchChat(chat, '地下室');
    // The newest reply (it mentions the cellar too), then your line, then the
    // first reply.
    expect(hits.map((m) => m.text), hasLength(3));
    expect(hits[1].text, '地下室在哪？');
    expect(hits[2].nodeId, isNot(hits[0].nodeId));
    expect(await tavern.searchChat(chat, '地下室', limit: 1), hasLength(1));
    expect(await tavern.searchChat(chat, '  '), isEmpty);
    expect(await tavern.searchChat(chat, '%'), isEmpty);
    expect(() => tavern.searchChat(chat, '地下室', limit: -1), throwsArgumentError);
  });

  test('there is no turn to rejoin, and nothing to back up', () async {
    final (tavern, chat) = await chatWithReply();
    expect(await tavern.resumeTurn(chat).toList(), isEmpty);
    expect(() => tavern.backup('x.zip'), throwsUnsupportedError);
  });
}
