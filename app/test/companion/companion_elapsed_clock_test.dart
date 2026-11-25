import 'dart:ffi';

import 'package:dsh_app/companion/companion_elapsed_clock.dart';
import 'package:dsh_app/companion/companion_initiative.dart';
import 'package:dsh_app/companion/companion_initiative_owner.dart';
import 'package:dsh_app/companion/companion_signals.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

// Compilable wiring example: both the existing initiative provider and this
// gate watch the same clock provider. This does not install any Page wiring.
final _sharedGateProvider = Provider<CompanionSignalGate>((ref) {
  final clock = ref.watch(companionInitiativeClockProvider);
  final gate = CompanionSignalGate(
    monotonicMs: () => clock().monoMs,
    utcNow: () => DateTime.fromMillisecondsSinceEpoch(clock().wallMs, isUtc: true),
  );
  ref.onDispose(gate.retire);
  return gate;
});

void main() {
  test('gate expiry and initiative candidate share the same BOOTTIME domain', () {
    var mono = 987654321;
    final wall = DateTime.utc(2026, 11, 5, 23, 30);
    CompanionInitiativeClock clock() => CompanionInitiativeClock(wallMs: wall.millisecondsSinceEpoch, monoMs: mono);
    final container = ProviderContainer(overrides: [companionInitiativeClockProvider.overrideWithValue(clock)]);
    addTearDown(container.dispose);
    final gate = container.read(_sharedGateProvider);
    final source = CompanionSignalSource.local(owner: Object(), isAttached: () => true);
    gate.enter(recipientContext: Object(), ownerEpoch: Object());
    gate.setConsent(source, const CompanionSignalConsent(state: true, optionalSpeech: true, nightCare: true));
    final late = CompanionSignalV1.fromJson({
      'v': 1,
      'id': 'night-domain',
      'kind': 'app.late_use',
      'source': {'type': 'device'},
      'observedAt': wall.toIso8601String(),
      'freshness': 'live',
      'payload': {
        'nightKey': '2026-11-05',
        'utcOffsetMinutes': 0,
        'recentInteraction': true,
        'activeMinutesBucket': '15plus',
      },
    });
    expect(gate.receive(gate.openIngress(source)!, late), CompanionSignalAdmission.accepted);
    final slot = gate.slots.single, speech = gate.speechCandidate(gate.slots.single)!;
    expect(slot.receivedAtMonoMs, mono);
    final candidate = CompanionInitiativeSignal(
      id: speech.id,
      contextKey: 'room',
      expiresAtMonoMs: speech.expiresAtMonoMs,
      nightKey: speech.nightKey,
    );
    final controller = CompanionInitiativeController(
      now: clock(),
      restored: const CompanionInitiativeRestore.newLedger(),
    );
    const view = CompanionInitiativeView(
      visible: true,
      resumed: true,
      blocked: false,
      enabled: true,
      accessible: false,
      contextKey: 'room',
    );
    controller.handle(const CompanionInitiativeEvent.enter(view), clock());
    controller.handle(CompanionInitiativeEvent.signal(candidate, nightCareEnabled: true), clock());
    expect(controller.pendingSignal, same(candidate));
    expect(candidate.expiresAtMonoMs - clock().monoMs, 120000);
    mono += 120000;
    expect(gate.slotCurrent(slot), isFalse);
  });

  test('Android elapsed failure is sticky and never falls back to uptime', () {
    var value = 100, reads = 0, fallbacks = 0;
    final clock = CompanionElapsedClock(
      android: true,
      bootTimeMilliseconds: () {
        reads++;
        return value;
      },
      stopwatchMilliseconds: () {
        fallbacks++;
        return 9000;
      },
    );
    expect(clock.readMilliseconds(), 100);
    value = 99;
    expect(clock.readMilliseconds(), -1);
    value = 101;
    expect(clock.readMilliseconds(), -1);
    expect(reads, 2);
    expect(fallbacks, 0);
    final throwsClock = CompanionElapsedClock(
      android: true,
      bootTimeMilliseconds: () => throw StateError('unavailable'),
    );
    expect(throwsClock.readMilliseconds(), -1);
    expect(throwsClock.readMilliseconds(), -1);
  });

  test('non-Android owner retains its Stopwatch path', () {
    var uptime = 10;
    final clock = CompanionElapsedClock(
      android: false,
      bootTimeMilliseconds: () => throw StateError('must not read BOOTTIME'),
      stopwatchMilliseconds: () => uptime,
    );
    expect(clock.readMilliseconds(), 10);
    uptime = 120;
    expect(clock.readMilliseconds(), 120);
  });

  test('native BOOTTIME rejects unsupported ABI layouts', () {
    for (final abi in Abi.values) {
      expect(
        CompanionBootTimeClock.supportsAbi(abi),
        const {Abi.androidArm64, Abi.androidX64, Abi.linuxArm64, Abi.linuxX64}.contains(abi),
        reason: '$abi',
      );
    }
  });

  test('actual native BOOTTIME reads are nonnegative and monotonic on the test host', () {
    if (!CompanionBootTimeClock.supportsAbi(Abi.current())) {
      expect(CompanionBootTimeClock.open, throwsUnsupportedError);
      return;
    }
    final native = CompanionBootTimeClock.open();
    var previous = native.readMilliseconds();
    expect(previous, greaterThanOrEqualTo(0));
    for (var i = 0; i < 256; i++) {
      final now = native.readMilliseconds();
      expect(now, greaterThanOrEqualTo(previous));
      previous = now;
    }
  });

  test('sampler retries a suspend window then delivers paired wall and elapsed time', () {
    final origin = DateTime.utc(2026, 11, 5, 10);
    var mono = 100, wall = origin, reads = 0, suspend = false;
    final sampler = CompanionClockSampler(
      elapsedMilliseconds: () {
        reads++;
        return mono;
      },
      wallNow: () {
        final captured = wall;
        if (suspend) {
          suspend = false;
          mono += 5000;
          wall = wall.add(const Duration(seconds: 5));
        }
        return captured;
      },
    );
    final start = sampler.read();
    final controller = CompanionInitiativeController(
      now: start,
      restored: const CompanionInitiativeRestore.newLedger(),
    );
    suspend = true;
    final resumed = sampler.read();
    expect(resumed.wallMs - start.wallMs, 5000);
    expect(resumed.monoMs - start.monoMs, 5000);
    expect(reads, 6, reason: 'one original sample and two resume attempts');
    controller.handle(const CompanionInitiativeEvent.check(), resumed);
    expect(controller.fault, isNull);
    // Re-sampling never resets the between-observation wall jump detector.
    wall = wall.add(const Duration(seconds: 2));
    controller.handle(const CompanionInitiativeEvent.check(), sampler.read());
    expect(controller.fault, 'clock-invalid-or-regressed');
  });

  test('sampling is bounded and unavailable readings never recover implicitly', () {
    var reads = 0;
    final sampler = CompanionClockSampler(
      elapsedMilliseconds: () => ++reads * 101,
      wallNow: () => DateTime.utc(2026, 11, 5),
    );
    expect(sampler.read().monoMs, -1);
    expect(reads, 6);
    expect(sampler.read().monoMs, -1);
    expect(reads, 6);
    final unavailable = CompanionClockSampler(
      elapsedMilliseconds: () => -1,
      wallNow: () => throw StateError('must not sample wall'),
    );
    expect(unavailable.read().monoMs, -1);
    final regressed = [10, 9].iterator;
    final backwards = CompanionClockSampler(
      elapsedMilliseconds: () {
        regressed.moveNext();
        return regressed.current;
      },
    );
    expect(backwards.read().monoMs, -1);
  });
}
