import 'dart:async';

import 'package:dsh_app/tavern/deferred_tavern.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter_test/flutter_test.dart';

const _lin = 'sample-innkeeper';
const _star = 'sample-navigator';

/// What a batch said, by kind: the outer progress phases and who spoke.
String _shape(List<TavernGroupEvent> events) => [
  for (final e in events)
    switch (e) {
      TavernGroupStarted() => 'started',
      TavernGroupProgressChanged(:final progress) =>
        progress.speakerCharacterId == null
            ? progress.phase.name
            : '${progress.phase.name}:${progress.speakerCharacterId}',
      TavernGroupMemberEvent(:final event) when event is TavernTurnDone => 'done',
      TavernGroupMemberEvent() => null,
      TavernGroupSnapshot() => 'snapshot',
      TavernGroupFinished(:final reason) => 'finished:${reason.name}',
    },
].whereType<String>().join(' ');

void main() {
  test('a group keeps its roster and settings; its chat is listed as a group, under each member', () async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await tavern.createGroupChat([_lin, _star], activation: TavernGroupActivation.listOrder);
    final group = (await tavern.groupChat(chat))!;
    expect(group.hostCharacterId, _lin);
    expect(group.members.map((m) => m.characterId), [_lin, _star]);
    expect(group.maxSpeakersPerTurn, 3);
    expect(group.title, '林晚、星图');

    final summary = (await tavern.watchChats(characterId: _star).first).single;
    expect(summary.kind, TavernChatKind.group);
    expect(summary.memberCharacterIds, [_lin, _star]);
    // Each member's greeting opens it, said by that member.
    expect((await tavern.path(chat)).map((m) => m.speakerCharacterId), [_lin, _star]);

    final updated = await tavern.updateGroupMember(chat, _star, muted: true, modelRole: TavernGroupModelRole.helper);
    expect(updated.members.last.muted, isTrue);
    expect(updated.members.last.modelRole, TavernGroupModelRole.helper);
    expect((await tavern.reorderGroupMembers(chat, [_star, _lin])).members.first.characterId, _star);
    expect((await tavern.updateGroupChat(chat, title: '旅店', maxSpeakersPerTurn: 1)).title, '旅店');
    expect((await tavern.removeGroupMember(chat, _star)).members.map((m) => m.characterId), [_lin]);

    Future<void> refused(Future<Object?> call, TavernGroupError code) =>
        expectLater(call, throwsA(isA<TavernGroupException>().having((e) => e.code, 'code', code)));
    await refused(tavern.addGroupMember(chat, _lin), TavernGroupError.memberExists);
    await refused(tavern.updateGroupMember(chat, _star), TavernGroupError.memberNotFound);
    await refused(tavern.reorderGroupMembers(chat, [_lin, _lin]), TavernGroupError.invalidOrder);
    await refused(tavern.addGroupMember(chat, _star, talkativeness: 2), TavernGroupError.invalidTalkativeness);
    await refused(
      tavern.groupChat('nope').then((g) => g ?? (throw TavernGroupException(TavernGroupError.notGroup))),
      TavernGroupError.notGroup,
    );
  });

  test('a batch: your line once, then each planned member in turn on the shared path', () async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await tavern.createGroupChat(
      [_lin, _star],
      activation: TavernGroupActivation.listOrder,
      addGreetings: false,
    );
    final events = await tavern.sendGroup(chat, '大家好').toList();
    expect(
      _shape(events),
      'started ready speaking:$_lin done settling:$_lin speaking:$_star done settling:$_star finished:completed',
    );
    final path = await tavern.path(chat);
    expect(path.map((m) => (m.role, m.speakerCharacterId)), [
      (TavernRole.user, null),
      (TavernRole.character, _lin),
      (TavernRole.character, _star),
    ]);
    final end = events.last as TavernGroupFinished;
    expect(end.progress!.userNodeId, path.first.nodeId);
    expect(end.progress!.completedNodeIds, [path[1].nodeId, path[2].nodeId]);
    // Progress says who is next and how many are left.
    final first = events.whereType<TavernGroupProgressChanged>().firstWhere(
      (e) => e.progress.speakerCharacterId == _lin,
    );
    expect(first.progress.nextCharacterId, _star);
    expect(first.progress.remainingCount, 1);
  });

  test('手动 replies only when someone is named; a named member speaks even when muted', () async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await tavern.createGroupChat(
      [_lin, _star],
      activation: TavernGroupActivation.manual,
      addGreetings: false,
    );
    await tavern.updateGroupMember(chat, _star, muted: true);
    expect(_shape(await tavern.sendGroup(chat, '有人吗').toList()), 'started finished:noSpeakers');
    expect((await tavern.path(chat)).single.role, TavernRole.user); // your line stays
    expect(
      _shape(await tavern.sendGroup(chat, '', speakerCharacterId: _star).toList()),
      'started ready speaking:$_star done settling:$_star finished:completed',
    );
  });

  test('stop ends the whole batch: the one speaking keeps what it wrote, the rest never start', () async {
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 5));
    final chat = await tavern.createGroupChat(
      [_lin, _star],
      activation: TavernGroupActivation.listOrder,
      addGreetings: false,
    );
    final events = <TavernGroupEvent>[];
    final done = Completer<void>();
    tavern.sendGroup(chat, '开始').listen(events.add, onDone: done.complete);
    // A page coming back mid-reply sees where it is, then what follows.
    while (!events.any((e) => e is TavernGroupMemberEvent && e.event is TavernTextDelta)) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    final rejoined = tavern.resumeGroupTurn(chat).toList();
    tavern.stop(chat);
    await done.future;
    expect((events.last as TavernGroupFinished).reason, TavernGroupEndReason.cancelled);
    expect((events.last as TavernGroupFinished).attemptedCharacterId, _lin);
    expect(events.any((e) => e is TavernGroupProgressChanged && e.progress.speakerCharacterId == _star), isFalse);
    final back = await rejoined;
    expect(back.first, isA<TavernGroupSnapshot>());
    expect((back.first as TavernGroupSnapshot).message!.speakerCharacterId, _lin);
    expect(back.last, isA<TavernGroupFinished>());
    // Nothing runs now: resuming gives nothing.
    expect(await tavern.resumeGroupTurn(chat).toList(), isEmpty);
  });

  test('DeferredTavern copies the member lists when called, before the engine opens', () async {
    final opening = Completer<Tavern>();
    final deferred = DeferredTavern(opening.future);
    final ids = [_lin, _star];
    final created = deferred.createGroupChat(ids, activation: TavernGroupActivation.listOrder, addGreetings: false);
    ids.removeLast();
    final preview = PreviewTavern(tick: Duration.zero);
    opening.complete(preview);
    final chat = await created;
    expect((await deferred.groupChat(chat))!.members.map((m) => m.characterId), [_lin, _star]);

    final order = [_star, _lin];
    final reordered = deferred.reorderGroupMembers(chat, order);
    order.clear();
    expect((await reordered).members.map((m) => m.characterId), [_star, _lin]);
    expect(_shape(await deferred.sendGroup(chat, '').toList()), contains('finished:completed'));
    expect((await deferred.watchGroupChat(chat).first)!.chatId, chat);
  });

  test('one message taken out of a group chat: the replies under it keep who wrote them', () async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await tavern.createGroupChat(
      [_lin, _star],
      activation: TavernGroupActivation.listOrder,
      addGreetings: false,
    );
    await tavern.sendGroup(chat, '大家好').toList();
    final path = await tavern.path(chat);
    await tavern.deleteMessage(chat, path[1].nodeId);
    expect((await tavern.path(chat)).map((m) => (m.role, m.speakerCharacterId)), [
      (TavernRole.user, null),
      (TavernRole.character, _star),
    ]);
  });

  test('a randomPool group takes turns: after one member answered, the next line goes to another', () async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await tavern.createGroupChat(
      [_lin, _star],
      activation: TavernGroupActivation.randomPool,
      addGreetings: false,
    );
    await tavern.sendGroup(chat, '你好').toList();
    await tavern.sendGroup(chat, '还有谁').toList();
    final speakers = [
      for (final m in await tavern.path(chat))
        if (m.role == TavernRole.character) m.speakerCharacterId,
    ];
    expect(speakers, [_lin, _star]);
  });
}
