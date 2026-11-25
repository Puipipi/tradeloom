import 'dart:async';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _Bridge extends RuntimeBridge {
  final resets = <ResetKeep>[];

  @override
  Stream<RuntimeEvent> get events => const Stream.empty();
  @override
  Future<RuntimeStatus> status() async => const RuntimeStatus(phase: RuntimePhase.notInstalled);
  @override
  Future<RuntimeLogSnapshot> logSnapshot({int lines = 300}) async => const RuntimeLogSnapshot([], 0);
  @override
  Future<void> reset({ResetKeep keep = const ResetKeep()}) async => resets.add(keep);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('reset sends the kept parts over the channel', () async {
    const channel = MethodChannel('test/runtime-reset');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return null;
    });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null),
    );
    final bridge = RuntimeBridge(methods: channel);
    await bridge.reset();
    await bridge.reset(keep: ResetKeep.suggested);
    await bridge.reset(keep: const ResetKeep(uiAndSkills: true, pluginsAndSettings: true));
    expect(calls.map((c) => c.method), everyElement('reset'));
    expect(calls.map((c) => (c.arguments as Map)['keep']), [
      <String>[],
      ['uiAndSkills'],
      ['uiAndSkills', 'pluginsAndSettings'],
    ]);
  });

  test('the controller passes the choice through; plain reset keeps nothing', () async {
    final bridge = _Bridge();
    final container = ProviderContainer(overrides: [runtimeBridgeProvider.overrideWithValue(bridge)]);
    addTearDown(container.dispose);
    container.read(localRuntimeProvider);
    final runtime = container.read(localRuntimeProvider.notifier);
    await runtime.resetKeeping(ResetKeep.suggested);
    await runtime.reset();
    expect(bridge.resets, [ResetKeep.suggested, const ResetKeep()]);
  });
}
