import 'dart:async';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/read_list_epoch.dart';
import 'package:dsh_app/state/read_list_identity.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Bridge extends RuntimeBridge {
  final statusResult = Completer<RuntimeStatus>();
  final logsResult = Completer<RuntimeLogSnapshot>();
  final calls = <String>[];
  @override
  Stream<RuntimeEvent> get events => const Stream.empty();
  @override
  Future<RuntimeStatus> status() {
    calls.add('status');
    return statusResult.future;
  }

  @override
  Future<RuntimeLogSnapshot> logSnapshot({int lines = 300}) {
    calls.add('logs');
    return logsResult.future;
  }

  @override
  Future<void> start({
    Map<String, String> env = const {},
    bool phoneStorage = false,
    EngineMode? mode,
    bool visualReplies = true,
  }) async => calls.add('start');
  @override
  Future<void> install({bool dropKept = false}) async => calls.add('install');
  @override
  Future<void> reset({ResetKeep keep = const ResetKeep()}) async => calls.add('reset');
}

class _Local extends ActiveHostController {
  @override
  HostRef build() => HostRef.local;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('identity metadata read does not start engine; status may return after disposal', () async {
    final bridge = _Bridge();
    final c = ProviderContainer(
      overrides: [
        activeHostProvider.overrideWith(_Local.new),
        activeConnectionProvider.overrideWithValue(const AsyncData(null)),
        runtimeBridgeProvider.overrideWithValue(bridge),
        localReadListRootProvider.overrideWithValue(const AsyncData('/rootfs')),
      ],
    );
    expect(c.read(readListIdentityProvider), isNull);
    expect(bridge.calls, ['logs', 'status']);
    c.dispose();
    bridge.statusResult.complete(const RuntimeStatus(phase: RuntimePhase.installed, installedVersion: 'v'));
    await Future<void>.delayed(Duration.zero);
    expect(bridge.calls, ['logs', 'status'], reason: 'no start after disposal');
  });

  test('logs and status failure returning after disposal are discarded', () async {
    final bridge = _Bridge();
    final c = ProviderContainer(overrides: [runtimeBridgeProvider.overrideWithValue(bridge)]);
    c.read(localRuntimeProvider);
    bridge.statusResult.complete(const RuntimeStatus(phase: RuntimePhase.installed, installedVersion: 'v'));
    await Future<void>.delayed(Duration.zero);
    expect(bridge.calls, ['logs', 'status']);
    c.dispose();
    bridge.logsResult.completeError(StateError('late platform error'));
    await Future<void>.delayed(Duration.zero);
    expect(bridge.calls, isNot(contains('start')));
  });

  test('root installation invalidates display epoch without a local identity reader', () async {
    final bridge = _Bridge();
    final c = ProviderContainer(overrides: [runtimeBridgeProvider.overrideWithValue(bridge)]);
    final runtime = c.read(localRuntimeProvider.notifier);
    final before = c.read(readListCredentialEpochProvider);
    await runtime.install();
    expect(c.read(readListCredentialEpochProvider), greaterThan(before));
    expect(bridge.calls, ['logs', 'status', 'install']);
    c.dispose();
    bridge.statusResult.complete(const RuntimeStatus(phase: RuntimePhase.installed, installedVersion: 'v'));
    await Future<void>.delayed(Duration.zero);
  });
}
