import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/companion/companion_initiative.dart';
import 'package:flutter_test/flutter_test.dart';

const _wall = 864000000;
typedef _Controller = CompanionInitiativeController;
typedef _Event = CompanionInitiativeEvent;
typedef _Effect = CompanionInitiativeEffectType;

CompanionInitiativeClock _now(int mono, [int? wall]) =>
    CompanionInitiativeClock(wallMs: wall ?? _wall + mono, monoMs: mono);

CompanionInitiativeView _room({
  String contextKey = 'full/host-A/connection-1/store-S/view-1',
  String? gate,
  bool accessible = false,
}) => CompanionInitiativeView.room(
  routeVisible: gate != 'route',
  stageReady: gate != 'stage',
  resumed: gate != 'resumed',
  inputBusy: gate == 'input',
  generating: gate == 'generating',
  audioBusy: gate == 'audio',
  activityBusy: gate == 'activity',
  approvalPending: gate == 'approval',
  externalPromptBusy: gate == 'external-prompt',
  quietHoursBlocked: gate == 'quiet-hours',
  enabled: gate != 'enabled',
  accessible: accessible,
  contextKey: contextKey,
);

_Controller _ready() => _Controller(
  enforceLocalQuietHours: false,
  now: _now(0),
  restored: CompanionInitiativeRestore.loaded({
    'v': 1,
    'lastGreetingAtMs': _wall,
    'inviteAtMs': <int>[],
    'declinedUntilMs': 0,
  }),
);

CompanionInitiativeClock _clock(Map<String, dynamic> value) =>
    CompanionInitiativeClock(wallMs: value['wallMs'] as int, monoMs: value['monoMs'] as int);

CompanionInitiativeView _view(Map<String, dynamic> value) => CompanionInitiativeView(
  visible: value['visible'] as bool,
  resumed: value['resumed'] as bool,
  blocked: value['blocked'] as bool,
  enabled: value['enabled'] as bool,
  accessible: value['accessible'] as bool,
  contextKey: value['contextKey'] as String,
);

CompanionInitiativeRestore _restore(Map<String, dynamic> value) => switch (value['status']) {
  'new' => const CompanionInitiativeRestore.newLedger(),
  'loaded' => CompanionInitiativeRestore.loaded(value['value']),
  _ => const CompanionInitiativeRestore.unavailable(),
};

_Event _event(Map<String, dynamic> value) => switch (value['type']) {
  'enter' => _Event.enter(_view(value['view'] as Map<String, dynamic>)),
  'observe' => _Event.observe(_view(value['view'] as Map<String, dynamic>)),
  'leave' => const _Event.leave(),
  'userActivation' => const _Event.userActivation(),
  'check' => const _Event.check(),
  'present' => _Event.present(value['ticketId'] as String),
  'dropOffer' => _Event.dropOffer(value['ticketId'] as String),
  'accept' => _Event.accept(value['ticketId'] as String),
  'decline' => _Event.decline(value['ticketId'] as String?),
  'storageFault' => const _Event.storageFault(),
  _ => throw StateError('Unknown oracle event: ${value['type']}'),
};

_Controller _fromTrace(Map<String, dynamic> initial) => _Controller(
  enforceLocalQuietHours: false,
  now: _clock(initial['now'] as Map<String, dynamic>),
  restored: _restore(initial['restored'] as Map<String, dynamic>),
);

// C212 remains an unchanged legacy oracle. Projection verifies that the new
// signal ledger is empty before comparing its old v1 representation.
Object? _legacy(Object? value) {
  if (value is List) return value.map(_legacy).toList();
  if (value is Map) {
    final copy = <String, Object?>{for (final e in value.entries) e.key as String: _legacy(e.value)};
    if (copy['v'] == 2 && copy.containsKey('inviteAtMs')) {
      expect(copy.remove('signalAtMs'), isEmpty);
      expect(copy.remove('night'), isNull);
      copy['v'] = 1;
    }
    return copy;
  }
  return value;
}

List<Object?> _effects(List<CompanionInitiativeEffect> values) => values.map((e) => _legacy(e.toJson())).toList();

void main() {
  final fixture =
      jsonDecode(File('test/fixtures/companion_initiative_c212.json').readAsStringSync()) as Map<String, dynamic>;
  final cases = (fixture['cases'] as List).cast<Map<String, dynamic>>();

  for (final reference in cases) {
    test('C212 oracle: ${reference['name']}', () {
      for (final trace in (reference['traces'] as List).cast<Map<String, dynamic>>()) {
        final controller = _fromTrace(trace['initial'] as Map<String, dynamic>);
        final transitions = (trace['transitions'] as List).cast<Map<String, dynamic>>();
        for (var index = 0; index < transitions.length; index++) {
          final transition = transitions[index];
          final now = _clock(transition['now'] as Map<String, dynamic>);
          final effects = controller.handle(_event(transition['event'] as Map<String, dynamic>), now);
          final expected = transition['result'] as Map<String, dynamic>;
          expect(_legacy(controller.inspect()), expected['state'], reason: 'state at transition $index');
          expect(_effects(effects), expected['effects'], reason: 'effects at transition $index');
        }
      }
    });
  }

  test('C212 two-owner counterexample remains outside the installation-owner guarantee', () {
    final reference = cases.singleWhere((c) => c.containsKey('violatedPremiseExample'));
    final example = reference['violatedPremiseExample'] as Map<String, dynamic>;
    final trace = (reference['traces'] as List).first as Map<String, dynamic>;
    final transitions = (trace['transitions'] as List).cast<Map<String, dynamic>>();
    var permissions = 0;
    for (final fork in ['first', 'second']) {
      final controller = _fromTrace(trace['initial'] as Map<String, dynamic>);
      // Reconstruct the same pending owner state, without a public state setter.
      for (final transition in transitions.take(2)) {
        controller.handle(
          _event(transition['event'] as Map<String, dynamic>),
          _clock(transition['now'] as Map<String, dynamic>),
        );
      }
      expect(_legacy(controller.inspect()), example['fromState']);
      final expected = example[fork] as Map<String, dynamic>;
      final expectedState = expected['state'] as Map<String, dynamic>;
      final effects = controller.handle(
        _Event.present(controller.offer!.id),
        _clock(expectedState['lastNow'] as Map<String, dynamic>),
      );
      expect(_legacy(controller.inspect()), expectedState);
      expect(_effects(effects), expected['effects']);
      permissions += effects.where((e) => e.type == _Effect.show).length;
    }
    expect(permissions, 2); // This is deliberately not a multiwriter-safe design.
  });

  for (final gate in [
    'route',
    'stage',
    'resumed',
    'enabled',
    'input',
    'generating',
    'audio',
    'activity',
    'approval',
    'external-prompt',
    'quiet-hours',
  ]) {
    test('room gate $gate resets quiet and requires a fresh 45 seconds', () {
      final controller = _ready();
      controller.handle(_Event.enter(_room()), _now(0));
      controller.handle(_Event.observe(_room(gate: gate)), _now(10000));
      controller.handle(const _Event.check(), _now(60000));
      expect(controller.offer, isNull);
      expect(controller.inspect()['quietSinceMono'], isNull);
      controller.handle(_Event.observe(_room()), _now(70000));
      controller.handle(const _Event.check(), _now(114999));
      expect(controller.offer, isNull);
      controller.handle(const _Event.check(), _now(115000));
      expect(controller.offer?.kind, CompanionPromptKind.invite);
    });
  }

  test('light/full and host/view replacement retire tickets but share one stay and ledger', () {
    final controller = _ready();
    const light = 'light/app-root-L/view-1';
    const fullA = 'full/host-A/connection-1/store-A/session-A/view-2';
    const fullB = 'full/host-B/connection-2/store-B/session-B/view-3';
    controller.handle(_Event.enter(_room(contextKey: light)), _now(0));
    controller.handle(const _Event.check(), _now(45000));
    final candidate = controller.offer!.id;
    final stay = controller.inspect()['stay'];
    controller.handle(_Event.observe(_room(contextKey: fullA)), _now(46000));
    final stale = controller.handle(_Event.present(candidate), _now(91000));
    expect(stale.where((e) => e.type == _Effect.offer || e.type == _Effect.show), isEmpty);
    controller.handle(const _Event.check(), _now(91000));
    controller.handle(_Event.present(controller.offer!.id), _now(91000));
    final shown = controller.display!.ticket.id;
    controller.handle(_Event.observe(_room(contextKey: fullB)), _now(92000));
    expect(controller.handle(_Event.accept(shown), _now(93000)).where((e) => e.type == _Effect.restIntent), isEmpty);
    controller.handle(_Event.observe(_room(contextKey: light)), _now(94000));
    controller.handle(const _Event.check(), _now(2 * CompanionInitiativeRules.windowMs));
    expect(controller.offer, isNull);
    expect(controller.record!.inviteAtMs, [_wall + 91000]);
    expect((controller.inspect()['stay'] as Map)['id'], (stay as Map)['id']);
  });

  test('approval arriving between offer and present prevents show without spending quota', () {
    final controller = _ready();
    controller.handle(_Event.enter(_room()), _now(0));
    controller.handle(const _Event.check(), _now(45000));
    final ticket = controller.offer!.id;
    controller.handle(_Event.observe(_room(gate: 'approval')), _now(45001));
    expect(controller.handle(_Event.present(ticket), _now(45002)).where((e) => e.type == _Effect.show), isEmpty);
    expect(controller.record!.inviteAtMs, isEmpty);
    controller.handle(_Event.observe(_room()), _now(50000));
    controller.handle(const _Event.userActivation(), _now(50001));
    controller.handle(const _Event.check(), _now(95000));
    expect(controller.offer, isNull); // A real approval action is also an activation.
  });

  test('special accept replaces generic activation; there is no unconditional rest fallback', () {
    List<CompanionInitiativeEffect> accept({required bool genericFirst}) {
      final controller = _ready();
      controller.handle(_Event.enter(_room()), _now(0));
      controller.handle(const _Event.check(), _now(45000));
      controller.handle(_Event.present(controller.offer!.id), _now(45000));
      final id = controller.display!.ticket.id;
      if (genericFirst) controller.handle(const _Event.userActivation(), _now(46000));
      final accepted = controller.handle(_Event.accept(id), _now(46000));
      expect(controller.handle(_Event.accept(id), _now(46001)).where((e) => e.type == _Effect.restIntent), isEmpty);
      return accepted;
    }

    expect(accept(genericFirst: false).where((e) => e.type == _Effect.restIntent), hasLength(1));
    expect(accept(genericFirst: true).where((e) => e.type == _Effect.restIntent), isEmpty);
  });

  test('restore input, persisted records and diagnostic copies cannot mutate the owner', () {
    final invitations = <int>[_wall - CompanionInitiativeRules.windowMs];
    final input = {'v': 1, 'lastGreetingAtMs': _wall, 'inviteAtMs': invitations, 'declinedUntilMs': 0};
    final controller = _Controller(
      enforceLocalQuietHours: false,
      now: _now(0),
      restored: CompanionInitiativeRestore.loaded(input),
    );
    invitations.add(_wall);
    input['declinedUntilMs'] = _wall + CompanionInitiativeRules.windowMs;
    controller.handle(_Event.enter(_room()), _now(0));
    controller.handle(const _Event.check(), _now(45000));
    final effects = controller.handle(_Event.present(controller.offer!.id), _now(45000));
    final saved = effects.singleWhere((e) => e.type == _Effect.persist).record!;
    expect(saved.inviteAtMs, [_wall + 45000]);
    expect(() => saved.inviteAtMs.add(_wall), throwsUnsupportedError);
    final copy = controller.inspect();
    ((copy['record'] as Map)['inviteAtMs'] as List).clear();
    (copy['stay'] as Map)['invited'] = false;
    expect(controller.record!.inviteAtMs, [_wall + 45000]);
    expect((controller.inspect()['stay'] as Map)['invited'], isTrue);
  });

  group('pace', () {
    _Controller spent(List<int> invites) => _Controller(
      enforceLocalQuietHours: false,
      now: _now(0),
      restored: CompanionInitiativeRestore.loaded({
        'v': 1,
        'lastGreetingAtMs': _wall,
        'inviteAtMs': invites,
        'declinedUntilMs': 0,
      }),
    );

    test('two lines already today: the original pace waits, a livelier one goes on', () {
      final today = [_wall - 20 * 3600000, _wall - 3 * 3600000];
      final rare = spent(today);
      rare.handle(_Event.enter(_room()), _now(0));
      rare.handle(const _Event.check(), _now(60000));
      expect(rare.offer, isNull);

      final often = spent(today)..pace = CompanionInitiativePace.often;
      often.handle(_Event.enter(_room()), _now(0));
      often.handle(const _Event.check(), _now(29999));
      expect(often.offer, isNull);
      often.handle(const _Event.check(), _now(30000));
      expect(often.offer?.kind, CompanionPromptKind.invite);
    });

    test('each pace keeps its own distance from the last line', () {
      final often = spent([_wall - 3600000])..pace = CompanionInitiativePace.often;
      often.handle(_Event.enter(_room()), _now(0));
      often.handle(const _Event.check(), _now(60000));
      expect(often.offer, isNull);

      final chatty = spent([_wall - 3600000])..pace = CompanionInitiativePace.chatty;
      chatty.handle(_Event.enter(_room()), _now(0));
      chatty.handle(const _Event.check(), _now(20000));
      expect(chatty.offer?.kind, CompanionPromptKind.invite);
    });

    test('a ledger written at the chattiest pace still reads at any pace', () {
      final full = [for (var i = 0; i < 12; i++) _wall - 23 * 3600000 + i * 1800000];
      final controller = spent(full);
      expect(controller.fault, isNull);
      expect(controller.record!.inviteAtMs, full);
      controller.handle(_Event.enter(_room()), _now(0));
      controller.handle(const _Event.check(), _now(60000));
      expect(controller.offer, isNull);
    });
  });

  test('invalid ledgers never become a fresh quota, while a future refusal is valid', () {
    final valid = {'v': 1, 'lastGreetingAtMs': null, 'inviteAtMs': <int>[], 'declinedUntilMs': 0};
    final invalid = <Object?>[
      null,
      {...valid}..remove('lastGreetingAtMs'),
      {...valid, 'v': 2},
      {...valid, 'unrecognizedField': true},
      {
        ...valid,
        'inviteAtMs': [_wall - 1, _wall],
      },
      {
        ...valid,
        // More than the chattiest pace ever spends in a day.
        'inviteAtMs': [for (var i = 0; i < 13; i++) i * 3600000],
      },
      {
        ...valid,
        'inviteAtMs': [0, 60000],
      },
      {...valid, 'declinedUntilMs': -1},
      {...valid, 'lastGreetingAtMs': '0'},
    ];
    for (final value in invalid) {
      final controller = _Controller(
        enforceLocalQuietHours: false,
        now: _now(0),
        restored: CompanionInitiativeRestore.loaded(value),
      );
      expect(controller.fault, 'ledger-invalid');
      final effects = controller.handle(_Event.enter(_room()), _now(0));
      expect(effects.where((e) => e.type == _Effect.offer || e.type == _Effect.persist), isEmpty);
      expect(controller.record, isNull);
    }
    final declined = _Controller(
      enforceLocalQuietHours: false,
      now: _now(0),
      restored: CompanionInitiativeRestore.loaded({...valid, 'declinedUntilMs': _wall + 21600000}),
    );
    expect(declined.fault, isNull);
    expect(declined.record!.declinedUntilMs, _wall + 21600000);
  });

  test('malformed context has no partial state commit; invalid clocks stay closed', () {
    final controller = _ready();
    controller.handle(_Event.enter(_room()), _now(0));
    final before = controller.inspect();
    expect(() => controller.handle(_Event.observe(_room(contextKey: '')), _now(1)), throwsArgumentError);
    expect(controller.inspect(), before);
    controller.handle(const _Event.check(), _now(-1));
    expect(controller.fault, 'clock-invalid-or-regressed');
    controller.handle(_Event.observe(_room()), _now(45000));
    expect(controller.offer, isNull);
    expect(
      () => _Controller(
        enforceLocalQuietHours: false,
        now: _now(-1),
        restored: const CompanionInitiativeRestore.newLedger(),
      ),
      throwsArgumentError,
    );
  });
}
