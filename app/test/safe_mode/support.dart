// Fakes for the safe-mode tests: a runtime controller that records how it was
// started, and a bridge that answers the safe-mode calls without a device.

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';

class RecordingRuntime extends LocalRuntimeController {
  RecordingRuntime(this.initial);

  final LocalRuntimeState initial;

  /// `start` (mode kept) or the [EngineMode] name, in call order.
  final starts = <String>[];
  int stops = 0;

  @override
  LocalRuntimeState build() => initial;

  @override
  Future<void> install() async {}

  @override
  Future<void> start() async => starts.add('start');

  @override
  Future<void> startIn(EngineMode mode) async => starts.add(mode.name);

  @override
  Future<void> stop() async {
    stops++;
    final s = state.status;
    state = state.copyWith(
      status: RuntimeStatus(
        phase: RuntimePhase.installed,
        mode: s.mode,
        safeState: s.safeState,
        safeReason: s.safeReason,
        strikes: s.strikes,
        autoSafe: s.autoSafe,
        failure: s.failure,
        mainFailure: s.mainFailure,
      ),
    );
  }

  void emit(LocalRuntimeState next) => state = next;
}

class FakeBridge extends RuntimeBridge {
  FakeBridge({
    this.lkg = const LastKnownGood.none(),
    this.hazards = const [],
    this.log = const ['dsh: startup failed: 1 required plugin did not activate'],
  });

  LastKnownGood lkg;
  List<SafeHazard> hazards;
  List<String> log;
  final calls = <String>[];
  final moved = <List<String>>[];

  @override
  Stream<RuntimeEvent> get events => const Stream.empty();

  @override
  Future<LastKnownGood> lastKnownGood() async {
    calls.add('lastKnownGood');
    return lkg;
  }

  @override
  Future<LastKnownGood> restoreLastKnownGood() async {
    calls.add('restoreLastKnownGood');
    return lkg;
  }

  @override
  Future<List<SafeHazard>> safePreflight() async {
    calls.add('safePreflight');
    return hazards;
  }

  @override
  Future<List<String>> moveAside(List<String> paths) async {
    calls.add('moveAside');
    moved.add(paths);
    return [for (final p in paths) '$p.off-20261023-153000'];
  }

  @override
  Future<void> clearFailure() async => calls.add('clearFailure');

  @override
  Future<void> setAutoSafe(bool enabled) async => calls.add('setAutoSafe:$enabled');

  @override
  Future<List<String>> failureLog() async {
    calls.add('failureLog');
    return log;
  }
}

final failedAt = DateTime(2026, 10, 23, 15, 30);

RuntimeFailure startupFailure({List<String> recent = const ['break-required'], bool safeMode = false}) =>
    RuntimeFailure(
      kind: FailureKind.startupFailed,
      at: failedAt,
      exitCode: 1,
      safeMode: safeMode,
      summary: 'startup failed: 1 required plugin did not activate',
      requiredRows: const ['agent-loop'],
      recent: recent,
      diagnostics: '/root/.dsh/logs/startup-2026-10-23T07-30-00.000Z.log',
    );

const lkgUseful = LastKnownGood(available: true, disable: ['break-required'], empty: false);

RuntimeStatus failedStatus({RuntimeFailure? failure, int strikes = 1, bool autoSafe = true}) {
  final f = failure ?? startupFailure();
  return RuntimeStatus(
    phase: RuntimePhase.error,
    bundledVersion: 'r4',
    installedVersion: 'r4',
    dshVersion: '0.2.1-rc.2',
    nodeVersion: '24.22.1',
    abi: 'arm64-v8a',
    error: 'DSH exited unexpectedly (code 1)',
    strikes: strikes,
    autoSafe: autoSafe,
    failure: f,
    mainFailure: f.safeMode ? null : f,
  );
}

RuntimeStatus safeStatus({RuntimePhase phase = RuntimePhase.running, String reason = 'auto'}) => RuntimeStatus(
  phase: phase,
  bundledVersion: 'r4',
  installedVersion: 'r4',
  dshVersion: '0.2.1-rc.2',
  nodeVersion: '24.22.1',
  abi: 'arm64-v8a',
  baseUrl: phase == RuntimePhase.running ? 'http://127.0.0.1:3080' : null,
  token: phase == RuntimePhase.running ? 't' : null,
  mode: EngineMode.safe,
  safeState: SafeModeState.on,
  safeReason: reason,
  strikes: 2,
  mainFailure: startupFailure(),
);
