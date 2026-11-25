import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/engine_control.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../safe_mode/support.dart';

class _Runtime extends LocalRuntimeController {
  _Runtime(this.initial, this.order, {this.finishStop = false});

  final RuntimeStatus initial;
  final List<String> order;
  final bool finishStop;

  @override
  LocalRuntimeState build() => LocalRuntimeState(loaded: true, status: initial);

  void emit(RuntimePhase phase) {
    final old = state.status;
    state = LocalRuntimeState(
      loaded: true,
      status: RuntimeStatus(phase: phase, mode: old.mode, safeState: old.safeState),
    );
  }

  @override
  Future<void> stop() async {
    order.add('stop');
    emit(finishStop ? RuntimePhase.installed : RuntimePhase.stopping);
  }

  @override
  Future<void> start() async => order.add('start');

  @override
  Future<void> startIn(EngineMode mode) async => order.add(mode.name);
}

class _Bridge extends FakeBridge {
  _Bridge(this.order, {this.denyRestore = false, this.denyMove = false});

  final List<String> order;
  final bool denyRestore;
  final bool denyMove;

  @override
  Future<LastKnownGood> restoreLastKnownGood() async {
    order.add('restore');
    if (denyRestore) throw PlatformException(code: 'runtime_not_stopped');
    return lkgUseful;
  }

  @override
  Future<List<String>> moveAside(List<String> paths) async {
    order.add('move');
    if (denyMove) throw PlatformException(code: 'runtime_not_stopped');
    return [for (final path in paths) '$path.off-test'];
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  final notStopped = isA<PlatformException>().having((e) => e.code, 'code', 'runtime_not_stopped');
  const paths = ['/root/.dsh/.env'];

  ({ProviderContainer container, _Runtime runtime, List<String> order}) harness(
    RuntimePhase phase, {
    bool safe = false,
    bool finishStop = false,
    bool denyRestore = false,
    bool denyMove = false,
  }) {
    final order = <String>[];
    final runtime = _Runtime(
      RuntimeStatus(
        phase: phase,
        mode: safe ? EngineMode.safe : EngineMode.normal,
        safeState: safe ? SafeModeState.on : SafeModeState.off,
      ),
      order,
      finishStop: finishStop,
    );
    final container = ProviderContainer(
      overrides: [
        localRuntimeProvider.overrideWith(() => runtime),
        runtimeBridgeProvider.overrideWithValue(_Bridge(order, denyRestore: denyRestore, denyMove: denyMove)),
      ],
    );
    addTearDown(container.dispose);
    return (container: container, runtime: runtime, order: order);
  }

  testWidgets('restart does not issue a new start after an incomplete stop', (tester) async {
    final h = harness(RuntimePhase.running);
    final result = EngineControl.restart(h.container);
    await tester.pump();
    expect(h.order, ['stop']);
    await tester.pump(const Duration(seconds: 20));
    await result;
    expect(h.order, ['stop']);
    expect(h.container.read(localRuntimeProvider).status.phase, RuntimePhase.stopping);
  });

  testWidgets('normal profile restore refuses a stop timeout before any write', (tester) async {
    final h = harness(RuntimePhase.running);
    final outcome = EngineControl.restoreLastKnownGood(h.container)
        .then<Object?>((value) => value, onError: (Object error) => error);
    await tester.pump();
    await tester.pump(const Duration(seconds: 20));
    h.runtime.emit(RuntimePhase.installed);
    await tester.pump();
    expect(await outcome, notStopped);
    expect(h.order, ['stop']);
  });

  testWidgets('already stopping restore does not stop twice or write after timeout', (tester) async {
    final h = harness(RuntimePhase.stopping);
    final outcome = EngineControl.restoreLastKnownGood(h.container)
        .then<Object?>((value) => value, onError: (Object error) => error);
    await tester.pump();
    await tester.pump(const Duration(seconds: 20));
    h.runtime.emit(RuntimePhase.installed);
    await tester.pump();
    expect(await outcome, notStopped);
    expect(h.order, isEmpty);
  });

  testWidgets('moving home configuration waits for normal engine exit', (tester) async {
    final h = harness(RuntimePhase.running);
    final result = EngineControl.enterSafeMode(h.container, moveAside: paths);
    await tester.pump();
    final beforeExit = h.order.toList();
    h.runtime.emit(RuntimePhase.installed);
    await tester.pump();
    await result;
    expect(beforeExit, ['stop']);
    expect(h.order, ['stop', 'move', 'safe']);
  });

  testWidgets('moving home configuration also waits for safe engine exit', (tester) async {
    final h = harness(RuntimePhase.running, safe: true);
    final result = EngineControl.enterSafeMode(h.container, moveAside: paths);
    await tester.pump();
    final beforeExit = h.order.toList();
    h.runtime.emit(RuntimePhase.installed);
    await tester.pump();
    await result;
    expect(beforeExit, ['stop']);
    expect(h.order, ['stop', 'move', 'safe']);
  });

  testWidgets('moving home configuration refuses timeout without a move or start', (tester) async {
    final h = harness(RuntimePhase.running);
    final outcome = EngineControl.enterSafeMode(
      h.container,
      moveAside: paths,
    ).then<Object?>((_) => null, onError: (Object error) => error);
    await tester.pump();
    await tester.pump(const Duration(seconds: 20));
    expect(await outcome, notStopped);
    expect(h.order, ['stop']);
  });

  testWidgets('normal restore preserves stop restore normal ordering after confirmed exit', (tester) async {
    final h = harness(RuntimePhase.running);
    final result = EngineControl.restoreLastKnownGood(h.container);
    await tester.pump();
    expect(h.order, ['stop']);
    h.runtime.emit(RuntimePhase.installed);
    await tester.pump();
    expect(await result, same(lkgUseful));
    expect(h.order, ['stop', 'restore', 'normal']);
  });

  testWidgets('safe running restore preserves its main-profile-only exception', (tester) async {
    final h = harness(RuntimePhase.running, safe: true, finishStop: true);
    final result = await EngineControl.restoreLastKnownGood(h.container);
    expect(result, same(lkgUseful));
    expect(h.order, ['restore', 'stop', 'normal']);
  });

  testWidgets('safe restore completed before a stop timeout reports no restart', (tester) async {
    final h = harness(RuntimePhase.running, safe: true);
    final outcome = EngineControl.restoreLastKnownGood(h.container)
        .then<Object?>((value) => value, onError: (Object error) => error);
    await tester.pump();
    expect(h.order, ['restore', 'stop']);
    await tester.pump(const Duration(seconds: 20));
    expect(await outcome, isA<PlatformException>().having((e) => e.code, 'code', 'runtime_not_stopped_after_recovery'));
    expect(h.order, ['restore', 'stop']);
  });

  testWidgets('a stopping safe run does not retain the running-safe restore exception', (tester) async {
    final h = harness(RuntimePhase.stopping, safe: true);
    final outcome = EngineControl.restoreLastKnownGood(h.container)
        .then<Object?>((value) => value, onError: (Object error) => error);
    await tester.pump();
    await tester.pump(const Duration(seconds: 20));
    expect(await outcome, notStopped);
    expect(h.order, isEmpty);
  });

  testWidgets('safe mode without moving files keeps its ordinary restart flow', (tester) async {
    final h = harness(RuntimePhase.running);
    final result = EngineControl.enterSafeMode(h.container);
    await tester.pump();
    expect(h.order, ['stop']);
    h.runtime.emit(RuntimePhase.installed);
    await tester.pump();
    await result;
    expect(h.order, ['stop', 'safe']);
  });

  testWidgets('native refusal after idle status is not converted into a start', (tester) async {
    final h = harness(RuntimePhase.error, denyRestore: true);
    await expectLater(EngineControl.restoreLastKnownGood(h.container), throwsA(notStopped));
    expect(h.order, ['restore']);
  });

  testWidgets('native move refusal after exit is not converted into safe start', (tester) async {
    final h = harness(RuntimePhase.running, finishStop: true, denyMove: true);
    await expectLater(EngineControl.enterSafeMode(h.container, moveAside: paths), throwsA(notStopped));
    expect(h.order, ['stop', 'move']);
  });
}
