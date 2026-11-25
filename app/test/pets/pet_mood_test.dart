// The mood reducer (docs/design/pets.md §4): every row of the signal → state
// table, priority merging, the turn-end debounce, tiers (up at once, down
// after 5 s), minDisplay / autoReturn, notification holding until handled,
// stopped turns, sleep and waking, the two scopes, bubbles and the most
// relevant conversation.

import 'package:dsh_app/notify/chat_alerts.dart';
import 'package:dsh_app/pets/pet_mood.dart';
import 'package:dsh_app/pets/pet_signals.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/chat/run_info.dart';
import 'package:flutter_test/flutter_test.dart';

final t0 = DateTime(2026, 10, 25, 15);
const local = HostRef.local;
const ssh = HostRef.ssh('box');

PetFocus focus(String id, [PetActivity activity = PetActivity.none, bool compacting = false]) =>
    PetFocus(host: local, sessionId: id, activity: activity, compacting: compacting);

PetRun run(String id, {HostRef host = local, bool sub = false, String? root, DateTime? since}) =>
    PetRun(host, id, subagent: sub, root: root, since: since);

PetPending waiting(String id, {String key = 'evt', HostRef host = local, bool question = false}) =>
    PetPending(host: host, sessionId: id, key: key, question: question);

PetEvent event(
  PetEventKind kind,
  String id,
  DateTime at, {
  HostRef host = local,
  bool bubble = true,
  String? title,
  String key = turnKey,
}) => PetEvent(kind: kind, host: host, sessionId: id, key: key, at: at, title: title, bubble: bubble);

/// Drives the reducer like the controller does, with a hand-moved clock.
class Drive {
  Drive({this.scope = PetScope.global, this.timings = const PetTimings()}) : now = t0, mood = PetMood.initial(t0);

  final PetScope scope;
  final PetTimings timings;
  DateTime now;
  PetMood mood;
  PetSignals signals = PetSignals(lastInteraction: t0);

  /// Sets the signals (keeping the last touch fresh unless given) and reduces.
  PetMood set({
    PetFocus? focus,
    List<PetRun> runs = const [],
    List<PetPending> pending = const [],
    bool viewed = false,
    bool quiet = false,
    bool carrying = false,
    DateTime? touched,
    List<PetEvent> events = const [],
  }) {
    signals = PetSignals(
      focus: focus,
      runs: runs,
      pending: pending,
      viewed: viewed,
      quiet: quiet,
      carrying: carrying,
      lastInteraction: touched ?? now,
    );
    return step(events: events);
  }

  PetMood step({List<PetEvent> events = const []}) =>
      mood = reducePetMood(mood, signals, now, events: events, timings: timings, scope: scope);

  /// Moves the clock, firing the reducer at every wake-up it asked for.
  PetMood wait(Duration d) {
    final end = now.add(d);
    while (true) {
      final next = mood.next;
      if (next == null || next.isAfter(end)) break;
      now = next;
      step();
    }
    now = end;
    return step();
  }

  PetStateName get state => mood.shown;
}

void main() {
  group('signal → state (§4.2)', () {
    test('idle when nothing runs', () {
      final d = Drive();
      expect(d.set().shown, PetStateName.idle);
      expect(d.set(focus: focus('a')).shown, PetStateName.idle);
    });

    test('thinking: waiting for the model, reasoning, retrying', () {
      for (final kind in [ActivityKind.waiting, ActivityKind.thinking, ActivityKind.retry]) {
        final d = Drive();
        expect(
          d.set(focus: focus('a', petActivityOf(kind)), runs: [run('a')]).shown,
          PetStateName.thinking,
          reason: '$kind',
        );
      }
    });

    test('working: a tool runs or the reply streams', () {
      for (final kind in [ActivityKind.tool, ActivityKind.writing]) {
        final d = Drive();
        final m = d.set(focus: focus('a', petActivityOf(kind)), runs: [run('a')]);
        expect(m.shown, PetStateName.working, reason: '$kind');
        expect(m.tier, 1);
      }
    });

    test('working tiers count running conversations on every host, up to 3', () {
      final d = Drive();
      final f = focus('a', PetActivity.working);
      expect(d.set(focus: f, runs: [run('a')]).tier, 1);
      expect(
        d
            .set(
              focus: f,
              runs: [
                run('a'),
                run('b', host: ssh),
              ],
            )
            .tier,
        2,
      );
      expect(
        d
            .set(
              focus: f,
              runs: [
                run('a'),
                run('b', host: ssh),
                run('c'),
              ],
            )
            .tier,
        3,
      );
      expect(d.set(focus: f, runs: [run('a'), run('b'), run('c'), run('d')]).tier, 3);
    });

    test('another conversation running is working, even with the focus idle', () {
      final d = Drive();
      final m = d.set(
        focus: focus('a'),
        runs: [run('b', host: ssh)],
      );
      expect(m.shown, PetStateName.working);
      expect(m.tier, 1);
    });

    test('the focus counts once, listed or not yet', () {
      final d = Drive();
      expect(d.set(focus: focus('a', PetActivity.working)).tier, 1, reason: 'before its status edge');
      expect(d.set(focus: focus('a', PetActivity.working), runs: [run('a')]).tier, 1);
    });

    test('juggling: subagents run; 1 / 2+', () {
      final d = Drive();
      final f = focus('a', PetActivity.working);
      var m = d.set(
        focus: f,
        runs: [
          run('a'),
          run('s1', sub: true, root: 'a'),
        ],
      );
      expect((m.shown, m.tier), (PetStateName.juggling, 1));
      m = d.set(
        focus: f,
        runs: [
          run('a'),
          run('s1', sub: true, root: 'a'),
          run('s2', sub: true, root: 'a'),
          run('s3', sub: true, root: 'a'),
        ],
      );
      expect((m.shown, m.tier), (PetStateName.juggling, 2));
    });

    test('sweeping while compacting, capped by autoReturn', () {
      final d = Drive(timings: const PetTimings(autoReturn: {'sweeping': 10000}));
      expect(d.set(focus: focus('a', PetActivity.thinking, true), runs: [run('a')]).shown, PetStateName.sweeping);
      expect(d.wait(const Duration(seconds: 9)).shown, PetStateName.sweeping);
      expect(d.wait(const Duration(seconds: 2)).shown, PetStateName.thinking);
    });

    test('notification while something waits, until handled — no fold-back', () {
      final d = Drive();
      final f = focus('a', PetActivity.waiting);
      expect(d.set(focus: f, runs: [run('a')], pending: [waiting('a')]).shown, PetStateName.notification);
      expect(d.wait(const Duration(minutes: 3)).shown, PetStateName.notification);
      // Answered: back to work after its minDisplay.
      d.set(focus: focus('a', PetActivity.working), runs: [run('a')]);
      expect(d.state, PetStateName.working);
    });

    test('a waiting request in another conversation rings too (global)', () {
      final d = Drive();
      expect(
        d
            .set(
              focus: focus('a'),
              pending: [waiting('b', host: ssh)],
            )
            .shown,
        PetStateName.notification,
      );
    });

    test('attention: a finished turn, 1.5 s after (no new round), then back', () {
      final d = Drive();
      d.set(focus: focus('a'), events: [event(PetEventKind.done, 'a', t0)]);
      expect(d.state, PetStateName.idle, reason: 'held for the debounce');
      expect(d.wait(const Duration(milliseconds: 1400)).shown, PetStateName.idle);
      expect(d.wait(const Duration(milliseconds: 200)).shown, PetStateName.attention);
      expect(d.wait(const Duration(milliseconds: 5000)).shown, PetStateName.attention);
      expect(d.wait(const Duration(milliseconds: 400)).shown, PetStateName.idle);
    });

    test('a goal round that starts again within 1.5 s is not celebrated', () {
      final d = Drive();
      d.set(focus: focus('a'), events: [event(PetEventKind.done, 'a', t0)]);
      d.now = d.now.add(const Duration(milliseconds: 600));
      d.set(focus: focus('a', PetActivity.thinking), runs: [run('a')]);
      d.wait(const Duration(seconds: 3));
      expect(d.state, PetStateName.thinking);
      expect(d.mood.held, isEmpty);
      expect(d.mood.bubble, isNull);
    });

    test('error: a failed turn, shown for its autoReturn', () {
      final d = Drive();
      d.set(events: [event(PetEventKind.failed, 'a', t0)]);
      expect(d.state, PetStateName.error);
      expect(d.wait(const Duration(milliseconds: 4700)).shown, PetStateName.error);
      expect(d.wait(const Duration(milliseconds: 200)).shown, PetStateName.idle);
    });

    test('an engine restart is not an error', () {
      final bus = PetEventBus();
      final seen = <PetEvent>[];
      bus.events.listen(seen.add);
      bus.alert(
        ChatAlert(host: local, sessionId: 'a', kind: AlertKind.failed, key: turnKey, title: 't', text: '已中断 · 引擎重启过'),
        t0,
      );
      bus.alert(
        ChatAlert(host: local, sessionId: 'a', kind: AlertKind.failed, key: turnKey, title: 't', text: '这一轮出错了'),
        t0,
      );
      expect(seen.map((e) => e.kind), [PetEventKind.stopped, PetEventKind.failed]);
      bus.dispose();
    });

    test('a stopped turn goes quietly back to idle', () {
      final d = Drive();
      d.set(focus: focus('a', PetActivity.stopping), runs: [run('a')]);
      d.set(focus: focus('a'), events: [event(PetEventKind.done, 'a', t0), event(PetEventKind.stopped, 'a', t0)]);
      d.wait(const Duration(seconds: 3));
      expect(d.state, PetStateName.idle);
      expect(d.mood.bubble, isNull);
    });

    test('stopping keeps what it showed', () {
      final d = Drive();
      d.set(focus: focus('a', PetActivity.working), runs: [run('a')]);
      d.wait(const Duration(seconds: 2));
      expect(d.set(focus: focus('a', PetActivity.stopping), runs: [run('a')]).shown, PetStateName.working);
    });

    test('carrying (reserved)', () {
      expect(Drive().set(carrying: true).shown, PetStateName.carrying);
    });
  });

  group('priority (§4.3)', () {
    test('error > notification > sweeping > attention > juggling > working > thinking > idle > sleeping', () {
      final order = [
        PetStateName.error,
        PetStateName.notification,
        PetStateName.sweeping,
        PetStateName.attention,
        PetStateName.juggling,
        PetStateName.working,
        PetStateName.thinking,
        PetStateName.idle,
        PetStateName.sleeping,
      ];
      for (var i = 0; i + 1 < order.length; i++) {
        expect(petPriority(order[i]), greaterThan(petPriority(order[i + 1])), reason: '${order[i]} > ${order[i + 1]}');
      }
      expect(petPriority(PetStateName.carrying), petPriority(PetStateName.juggling));
    });

    test('several conversations: the highest wins', () {
      final d = Drive();
      final m = d.set(
        focus: focus('a', PetActivity.thinking),
        runs: [
          run('a'),
          run('b'),
          run('s', sub: true, root: 'b'),
        ],
        pending: [waiting('c')],
      );
      expect(m.shown, PetStateName.notification);
    });

    test('a higher state takes over at once; a lower waits for minDisplay', () {
      final d = Drive();
      d.set(focus: focus('a', PetActivity.working), runs: [run('a')]);
      // thinking is lower: working stays its 1 s minDisplay.
      d.now = d.now.add(const Duration(milliseconds: 300));
      expect(d.set(focus: focus('a', PetActivity.thinking), runs: [run('a')]).shown, PetStateName.working);
      expect(d.wait(const Duration(milliseconds: 800)).shown, PetStateName.thinking);
      // working is higher: at once.
      expect(d.set(focus: focus('a', PetActivity.working), runs: [run('a')]).shown, PetStateName.working);
    });

    test('a success never hides a failure still showing', () {
      final d = Drive();
      d.set(events: [event(PetEventKind.failed, 'a', t0), event(PetEventKind.done, 'b', t0)]);
      d.wait(const Duration(milliseconds: 1600));
      expect(d.state, PetStateName.error);
    });
  });

  group('tiers', () {
    test('up at once, down only after 5 s below', () {
      final d = Drive();
      final f = focus('a', PetActivity.working);
      d.set(focus: f, runs: [run('a')]);
      expect(d.set(focus: f, runs: [run('a'), run('b'), run('c')]).tier, 3);
      d.now = d.now.add(const Duration(seconds: 1));
      expect(d.set(focus: f, runs: [run('a')]).tier, 3);
      expect(d.wait(const Duration(milliseconds: 4900)).tier, 3);
      expect(d.wait(const Duration(milliseconds: 200)).tier, 1);
    });

    test('a dip shorter than 5 s never shows', () {
      final d = Drive();
      final f = focus('a', PetActivity.working);
      d.set(focus: f, runs: [run('a'), run('b')]);
      d.now = d.now.add(const Duration(seconds: 1));
      d.set(focus: f, runs: [run('a')]);
      d.now = d.now.add(const Duration(seconds: 3));
      d.set(focus: f, runs: [run('a'), run('b')]);
      expect(d.wait(const Duration(seconds: 10)).tier, 2);
    });
  });

  group('sleep and waking', () {
    test('idle and untouched for 60 s: sleeping; a touch wakes it (waking, then idle)', () {
      final d = Drive();
      d.set();
      expect(d.wait(const Duration(seconds: 59)).shown, PetStateName.idle);
      expect(d.wait(const Duration(seconds: 2)).shown, PetStateName.sleeping);
      d.set(touched: d.now);
      expect(d.state, PetStateName.waking);
      expect(d.wait(const Duration(milliseconds: 1400)).shown, PetStateName.waking);
      expect(d.wait(const Duration(milliseconds: 200)).shown, PetStateName.idle);
    });

    test('an event wakes it, then it shows the event', () {
      final d = Drive();
      d.set(touched: t0);
      d.wait(const Duration(seconds: 61));
      expect(d.state, PetStateName.sleeping);
      d.signals = PetSignals(lastInteraction: t0, runs: [run('b')]);
      expect(d.step().shown, PetStateName.waking);
      expect(d.wait(const Duration(seconds: 2)).shown, PetStateName.working);
    });

    test('a waiting request does not wait for the yawn', () {
      final d = Drive();
      d.set(touched: t0);
      d.wait(const Duration(seconds: 61));
      d.signals = PetSignals(lastInteraction: t0, pending: [waiting('b')]);
      expect(d.step().shown, PetStateName.notification);
    });

    test('busy never sleeps', () {
      final d = Drive();
      d.set(focus: focus('a', PetActivity.working), runs: [run('a')], touched: t0);
      expect(d.wait(const Duration(minutes: 5)).shown, PetStateName.working);
    });
  });

  group('scope', () {
    test('on the strip it speaks for the conversation on screen', () {
      final d = Drive(scope: PetScope.focus);
      final m = d.set(
        focus: focus('a', PetActivity.thinking),
        runs: [
          run('a'),
          run('b'),
          run('s', sub: true, root: 'b'),
        ],
        pending: [waiting('c')],
      );
      expect(m.shown, PetStateName.thinking, reason: 'others do not count on the strip');
    });

    test('its own subagents and requests still count; tiers stay global', () {
      final d = Drive(scope: PetScope.focus);
      var m = d.set(focus: focus('a', PetActivity.working), runs: [run('a'), run('b'), run('c')]);
      expect((m.shown, m.tier), (PetStateName.working, 3));
      m = d.set(
        focus: focus('a', PetActivity.working),
        runs: [
          run('a'),
          run('s', sub: true, root: 'a'),
        ],
      );
      expect(m.shown, PetStateName.juggling);
      m = d.set(focus: focus('a', PetActivity.waiting), runs: [run('a')], pending: [waiting('a')]);
      expect(m.shown, PetStateName.notification);
    });

    test('another conversation’s finish or failure does not move it on the strip', () {
      final d = Drive(scope: PetScope.focus);
      d.set(focus: focus('a', PetActivity.working), runs: [run('a')], events: [event(PetEventKind.failed, 'b', t0)]);
      expect(d.state, PetStateName.working);
    });
  });

  group('bubbles (§2.6)', () {
    test('words, with the title for another conversation', () {
      final d = Drive();
      d.set(events: [event(PetEventKind.failed, 'b', t0, title: '修复登录重复提交')]);
      expect(d.mood.bubble!.text, '修复登录重复提交 · 出错了');
      expect(d.mood.bubble!.target, const PetTarget(local, 'b'));
    });

    test('long titles are cut at 12', () {
      final d = Drive();
      d.set(
        events: [event(PetEventKind.approval, 'b', t0, title: '一二三四五六七八九十十一十二十三', key: 'e1')],
      );
      expect(d.mood.bubble!.text, '一二三四五六七八九十十一… · 等你确认');
    });

    test('nothing for alerts that did not reach the person', () {
      final d = Drive();
      d.set(events: [event(PetEventKind.failed, 'a', t0, bubble: false)]);
      expect(d.mood.bubble, isNull);
      expect(d.state, PetStateName.error, reason: 'it still moves');
    });

    test('done 4 s, failed 6 s, waiting 8 s', () {
      for (final (kind, secs) in [(PetEventKind.done, 4), (PetEventKind.failed, 6), (PetEventKind.approval, 8)]) {
        final d = Drive();
        d.set(
          events: [event(kind, 'b', t0, key: 'k')],
          pending: kind == PetEventKind.approval ? [waiting('b', key: 'k')] : const [],
        );
        if (kind == PetEventKind.done) d.wait(const Duration(milliseconds: 1500));
        final up = d.now;
        expect(d.mood.bubble, isNotNull, reason: '$kind');
        d.wait(Duration(seconds: secs) - const Duration(milliseconds: 100) - d.now.difference(up));
        expect(d.mood.bubble, isNotNull, reason: '$kind still up');
        d.wait(const Duration(milliseconds: 200));
        expect(d.mood.bubble, isNull, reason: '$kind gone');
      }
    });

    test('several within 2 s merge: 「3 个对话做完了」', () {
      final d = Drive();
      d.set(events: [event(PetEventKind.done, 'a', t0), event(PetEventKind.done, 'b', t0)]);
      d.wait(const Duration(milliseconds: 1500));
      d.set(events: [event(PetEventKind.done, 'c', d.now)]);
      d.wait(const Duration(milliseconds: 1600));
      expect(d.mood.bubble!.count, 3);
      expect(d.mood.bubble!.text, '3 个对话做完了');
    });

    test('a waiting request goes first; the earlier one waits its turn', () {
      final d = Drive();
      d.set(events: [event(PetEventKind.failed, 'a', t0, title: 'A')]);
      d.now = d.now.add(const Duration(seconds: 3));
      d.set(
        events: [event(PetEventKind.question, 'b', d.now, key: 'q', title: 'B')],
        pending: [waiting('b', key: 'q', question: true)],
      );
      expect(d.mood.bubble!.kind, PetBubbleKind.question);
      expect(d.mood.queued!.kind, PetBubbleKind.failed);
      // Answered before its 8 s: the bubble goes, the queued one shows.
      d.now = d.now.add(const Duration(seconds: 2));
      d.set();
      expect(d.mood.bubble!.kind, PetBubbleKind.failed);
    });

    test('quiet mode: moves, no bubbles', () {
      final d = Drive();
      d.set(quiet: true, events: [event(PetEventKind.failed, 'b', t0)]);
      expect(d.state, PetStateName.error);
      expect(d.mood.bubble, isNull);
    });

    test('only the global scope keeps bubbles', () {
      final d = Drive(scope: PetScope.focus);
      d.set(focus: focus('a'), events: [event(PetEventKind.failed, 'b', t0)]);
      expect(d.mood.bubble, isNull);
    });
  });

  group('the most relevant conversation (§2.7)', () {
    test('waiting (longest) > failed unseen > done unseen > running (newest) > last looked at', () {
      final d = Drive();
      d.set(
        focus: focus('look'),
        pending: [waiting('w1', key: 'k1')],
      );
      d.now = d.now.add(const Duration(seconds: 5));
      d.set(
        focus: focus('look'),
        pending: [
          waiting('w2', key: 'k2'),
          waiting('w1', key: 'k1'),
        ],
      );
      expect(petTarget(d.mood, d.signals), target('w1'));

      final e = Drive();
      e.set(events: [event(PetEventKind.done, 'done1', t0), event(PetEventKind.failed, 'fail1', t0)]);
      e.wait(const Duration(seconds: 2));
      e.set(
        focus: focus('look'),
        runs: [
          run('r1', since: t0),
          run('r2', since: t0.add(const Duration(seconds: 1))),
        ],
      );
      expect(petTarget(e.mood, e.signals), target('fail1'));
      e.set(
        focus: focus('fail1'),
        viewed: true,
        runs: [
          run('r1', since: t0),
          run('r2', since: t0.add(const Duration(seconds: 1))),
        ],
      );
      expect(petTarget(e.mood, e.signals), target('done1'), reason: 'the failure was looked at');
      e.set(
        focus: focus('done1'),
        viewed: true,
        runs: [
          run('r1', since: t0),
          run('r2', since: t0.add(const Duration(seconds: 1))),
        ],
      );
      expect(petTarget(e.mood, e.signals), target('r2'));
      e.set(focus: focus('look'));
      expect(petTarget(e.mood, e.signals), target('look'));
    });
  });

  group('PetState on the wire', () {
    test('toMap carries target, bubble and settings', () {
      final state = PetState(
        state: PetStateName.working,
        tier: 2,
        bubble: PetBubble(
          id: 'b1',
          kind: PetBubbleKind.done,
          title: '标题',
          target: const PetTarget(local, 's'),
          until: DateTime.fromMillisecondsSinceEpoch(1000),
        ),
        target: const PetTarget(local, 's'),
        active: true,
        foreground: false,
        packId: 'deepy-whale',
      );
      final map = state.toMap();
      expect(map['state'], 'working');
      expect(map['tier'], 2);
      expect(map['packId'], 'deepy-whale');
      expect(map['size'], 'medium');
      expect(map['quiet'], false);
      expect((map['target']! as Map)['sessionId'], 's');
      expect((map['target']! as Map)['host'], local.encode());
      final bubble = map['bubble']! as Map;
      expect(bubble['text'], '标题 · 做完了');
      expect(bubble['untilMs'], 1000);
      expect(bubble.containsKey('approve'), isFalse);
    });
  });
}

PetTarget target(String id) => PetTarget(local, id);
