import 'package:dsh_app/companion/companion_initiative.dart';
import 'package:flutter_test/flutter_test.dart';

typedef C = CompanionInitiativeController;
typedef E = CompanionInitiativeEvent;
const gap = CompanionInitiativeRules.inviteGapMs;
const day = CompanionInitiativeRules.windowMs;
final start = DateTime.utc(2026, 11, 5, 8).millisecondsSinceEpoch;

CompanionInitiativeView view({bool blocked = false, String key = 'room', bool accessible = false}) =>
    CompanionInitiativeView(
      visible: true,
      resumed: true,
      blocked: blocked,
      enabled: true,
      accessible: accessible,
      contextKey: key,
    );
CompanionInitiativeClock clock(int ms, {int? wall, int offset = 0}) =>
    CompanionInitiativeClock(wallMs: wall ?? start + ms, monoMs: ms, offsetMinutes: offset);
Map<String, Object?> v1({List<int> invites = const [], int declined = 0, int? greeting}) => {
  'v': 1,
  'lastGreetingAtMs': greeting ?? start,
  'inviteAtMs': invites,
  'declinedUntilMs': declined,
};
C ready({Map<String, Object?>? ledger, int? wall, int offset = 0}) {
  final c = C(
    now: clock(0, wall: wall, offset: offset),
    restored: CompanionInitiativeRestore.loaded(ledger ?? v1(greeting: wall)),
  );
  c.handle(E.enter(view()), clock(0, wall: wall, offset: offset));
  return c;
}

CompanionInitiativeSignal signal(String id, int now, {String key = 'room', String? nightKey, int ttl = 120000}) =>
    CompanionInitiativeSignal(id: id, contextKey: key, expiresAtMonoMs: now + ttl, nightKey: nightKey);
void commit(C c, CompanionInitiativeClock now) {
  final staged = c.stagePresentation(c.offer!.id, now)!;
  expect(c.commitPresentation(staged).where((e) => e.type == CompanionInitiativeEffectType.show), hasLength(1));
}

void main() {
  test('declining a displayed signal hides it and shares the six-hour refusal', () {
    final c = ready();
    c.handle(E.signal(signal('s', 0)), clock(0));
    c.handle(const E.check(), clock(45000));
    commit(c, clock(45000));
    final id = c.display!.ticket.id;
    final declined = c.handle(E.decline(id), clock(46000));
    expect(declined.where((e) => e.type == CompanionInitiativeEffectType.hide), hasLength(1));
    expect(c.display, isNull);
    expect(c.record!.declinedUntilMs, start + 46000 + gap);
    expect(c.record!.signalAtMs, [start + 45000]);
    c.handle(E.signal(signal('next', gap + 45999)), clock(gap + 45999));
    expect(c.offer, isNull);
    c.handle(const E.check(), clock(gap + 46000));
    expect(c.offer?.signalId, 'next');
  });

  test('v1 migrates without resetting invitations or six-hour refusal', () {
    final c = ready(
      ledger: v1(invites: [start - 1000], declined: start + gap),
    );
    expect(c.record!.toJson()['v'], 2);
    expect(c.record!.inviteAtMs, [start - 1000]);
    expect(c.record!.signalAtMs, isEmpty);
    c.handle(E.signal(signal('s', 45000)), clock(45000));
    expect(c.offer, isNull);
    expect(c.pendingSignal?.id, 's');
  });

  test('staging never spends; commit is single-use and bound to its controller and state', () {
    final c = ready();
    c.handle(E.signal(signal('s', 0)), clock(0));
    c.handle(const E.check(), clock(45000));
    final staged = c.stagePresentation(c.offer!.id, clock(45000))!;
    expect(staged.display.ticket.signalId, 's');
    expect(c.record!.optionalAtMs, isEmpty);
    expect(c.display, isNull);
    expect(ready().commitPresentation(staged), isEmpty);
    expect(c.commitPresentation(staged), isNotEmpty);
    expect(c.commitPresentation(staged), isEmpty);
    expect(c.record!.signalAtMs, [start + 45000]);
  });

  test('staged candidate cannot commit after a different observation', () {
    final c = ready();
    c.handle(E.signal(signal('s', 0)), clock(0));
    c.handle(const E.check(), clock(45000));
    final staged = c.stagePresentation(c.offer!.id, clock(45000))!;
    c.handle(E.observe(view(blocked: true)), clock(45001));
    expect(c.commitPresentation(staged), isEmpty);
    expect(c.record!.optionalAtMs, isEmpty);
  });

  test('invitation then signal share six-hour gap and two-per-24-hour ceiling', () {
    final c = ready();
    c.handle(const E.check(), clock(45000));
    expect(c.offer!.kind, CompanionPromptKind.invite);
    commit(c, clock(45000));
    c.handle(const E.check(), clock(53000));
    c.handle(E.signal(signal('too-soon', gap)), clock(gap));
    expect(c.offer, isNull);
    c.handle(E.signal(signal('second', gap + 45000)), clock(gap + 45000));
    expect(c.offer!.kind, CompanionPromptKind.signal);
    commit(c, clock(gap + 45000));
    c.handle(const E.check(), clock(gap + 53000));
    c.handle(E.signal(signal('third', 2 * gap + 45000)), clock(2 * gap + 45000));
    expect(c.offer, isNull);
    expect(c.record!.optionalAtMs, [start + 45000, start + gap + 45000]);
  });

  test('signal first consumes the same invitation budget on the next stay', () {
    final c = ready();
    c.handle(E.signal(signal('s', 0)), clock(0));
    c.handle(const E.check(), clock(45000));
    commit(c, clock(45000));
    c.handle(const E.leave(), clock(46000));
    c.handle(E.enter(view()), clock(31 * 60000));
    if (c.offer != null) c.handle(E.dropOffer(c.offer!.id), clock(31 * 60000));
    c.handle(const E.check(), clock(gap + 44999));
    expect(c.offer, isNull);
    c.handle(const E.check(), clock(gap + 45000));
    expect(c.offer!.kind, CompanionPromptKind.invite);
  });

  test('real interaction retires signal but a later signal can use a fresh quiet stretch', () {
    final c = ready();
    c.handle(E.signal(signal('old', 0)), clock(0));
    c.handle(const E.userActivation(), clock(20000));
    c.handle(E.signal(signal('new', 21000)), clock(21000));
    c.handle(const E.check(), clock(64999));
    expect(c.offer, isNull);
    c.handle(const E.check(), clock(65000));
    expect(c.offer?.signalId, 'new');
  });

  test('busy or context replacement retires rather than extending source TTL', () {
    final c = ready();
    c.handle(E.signal(signal('s', 0, ttl: 45001)), clock(0));
    c.handle(E.observe(view(blocked: true)), clock(1000));
    c.handle(E.observe(view()), clock(2000));
    c.handle(const E.check(), clock(47000));
    expect(c.pendingSignal, isNull);
    c.handle(E.signal(signal('x', 47000)), clock(47000));
    c.handle(E.observe(view(key: 'other')), clock(47001));
    expect(c.pendingSignal, isNull);
    expect(c.record!.optionalAtMs, isEmpty);
  });

  test('screen-reader signal still expires at original metadata TTL', () {
    final c = ready();
    c.handle(E.observe(view(accessible: true)), clock(0));
    c.handle(E.signal(signal('s', 0, ttl: 45001)), clock(0));
    c.handle(const E.check(), clock(45000));
    commit(c, clock(45000));
    expect(c.display!.expiresAtMono, 45001);
    final effects = c.handle(const E.check(), clock(45001));
    expect(effects.where((e) => e.type == CompanionInitiativeEffectType.hide), hasLength(1));
    expect(c.record!.signalAtMs, hasLength(1));
  });

  test('ordinary signals and invitations stay silent from local 23:00 to 07:00', () {
    final night = DateTime.utc(2026, 11, 5, 23).millisecondsSinceEpoch;
    final c = ready(wall: night);
    c.handle(E.signal(signal('s', 0)), clock(0, wall: night));
    c.handle(const E.check(), clock(45000, wall: night + 45000));
    expect(c.offer, isNull);
    expect(c.record!.optionalAtMs, isEmpty);
  });

  test('night care requires separate opt-in and atomically spends night plus shared quota', () {
    final night = DateTime.utc(2026, 11, 5, 23).millisecondsSinceEpoch;
    final c = ready(wall: night);
    c.handle(E.signal(signal('off', 0, nightKey: '2026-11-05')), clock(0, wall: night));
    c.handle(const E.check(), clock(45000, wall: night + 45000));
    expect(c.offer, isNull);
    c.handle(
      E.signal(signal('on', 45000, nightKey: '2026-11-05'), nightCareEnabled: true),
      clock(45000, wall: night + 45000),
    );
    commit(c, clock(45000, wall: night + 45000));
    expect(c.record!.night!.lastNightKey, '2026-11-05');
    expect(c.record!.signalAtMs, [night + 45000]);
    c.handle(const E.check(), clock(gap + 45000, wall: night + gap + 45000));
    c.handle(
      E.signal(signal('again', gap + 45000, nightKey: '2026-11-05'), nightCareEnabled: true),
      clock(gap + 45000, wall: night + gap + 45000),
    );
    expect(c.offer, isNull);
  });

  test('first-ever offset change waits for the next strict local 23:00 boundary', () {
    final wall = DateTime.utc(2026, 11, 5, 22).millisecondsSinceEpoch;
    final c = C(
      now: clock(0, wall: wall),
      restored: const CompanionInitiativeRestore.newLedger(),
    );
    c.handle(E.enter(view()), clock(0, wall: wall, offset: 60));
    if (c.offer != null) c.handle(E.dropOffer(c.offer!.id), clock(0, wall: wall, offset: 60));
    final n = c.record!.night!;
    expect(n.stableAfterMs, wall + day);
    expect(n.offsetMinutes, 60);
    c.handle(
      E.signal(signal('late', 0, nightKey: '2026-11-05'), nightCareEnabled: true),
      clock(0, wall: wall, offset: 60),
    );
    c.handle(const E.check(), clock(45000, wall: wall + 45000, offset: 60));
    expect(c.offer, isNull);
  });

  test('timezone changes preserve prior night use and enforce 24 hours as well as boundary', () {
    final night = DateTime.utc(2026, 11, 5, 23).millisecondsSinceEpoch;
    final c = ready(wall: night);
    c.handle(E.signal(signal('n', 0, nightKey: '2026-11-05'), nightCareEnabled: true), clock(0, wall: night));
    c.handle(const E.check(), clock(45000, wall: night + 45000));
    commit(c, clock(45000, wall: night + 45000));
    c.handle(const E.check(), clock(60000, wall: night + 60000, offset: 60));
    expect(c.record!.night!.lastNightAtMs, night + 45000);
    final before24 = night + day - 60 * 60000;
    expect(c.record!.night!.allows('2026-11-06', clock(day - 60 * 60000, wall: before24, offset: 60)), isFalse);
    expect(c.record!.night!.allows('2026-11-06', clock(day + 45000, wall: night + day + 45000, offset: 60)), isTrue);
  });

  test('forward wall jump and rollback close owner without refreshing quotas', () {
    for (final wall in [start - 1, start + day]) {
      final c = ready();
      c.handle(const E.check(), clock(1, wall: wall));
      expect(c.fault, 'clock-invalid-or-regressed');
      expect(c.offer, isNull);
      expect(c.record!.optionalAtMs, isEmpty);
    }
  });

  test('malformed merged history or night metadata closes restore', () {
    final base = {...v1(), 'v': 2, 'signalAtMs': <int>[], 'night': null};
    for (final invalid in [
      {
        ...base,
        'inviteAtMs': [start - gap],
        'signalAtMs': [start - gap + 1],
      },
      {
        ...base,
        'signalAtMs': [start + 1],
      },
      {
        ...base,
        'night': {'offsetMinutes': 0},
      },
      {...base, 'extra': true},
    ]) {
      final c = ready(ledger: invalid);
      expect(c.fault, isNotNull);
      expect(c.offer, isNull);
    }
  });
}
