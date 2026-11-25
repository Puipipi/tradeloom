// Shared fakes for the "local runtime is optional" tests: a runtime that
// records what it was asked to do, onboarding prefs with a chosen start, and
// fixed device figures.

import 'package:dsh_app/runtime/local_footprint.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../shell/golden_harness.dart';

const bundled = 'r5-dsh0.2.1-rc.2-node24.22.1-ubuntu24.04.5-b3f6c96ee2f2';

/// Android's report of a phone without the runtime.
const missingStatus = RuntimeStatus(phase: RuntimePhase.notInstalled, bundledVersion: bundled, abi: 'arm64-v8a');

/// Installed and stopped (打开 App 时自动启动 off).
const stoppedStatus = RuntimeStatus(
  phase: RuntimePhase.installed,
  bundledVersion: bundled,
  installedVersion: bundled,
  abi: 'arm64-v8a',
  dshVersion: '0.2.1-rc.2',
  nodeVersion: '24.22.1',
);

class RecordingLocalRuntime extends FakeRuntime {
  RecordingLocalRuntime(super.initial);

  /// `install`, `start`, `reset:` + what was kept, in call order.
  final calls = <String>[];

  @override
  Future<void> install() async => calls.add('install');

  @override
  Future<void> start() async => calls.add('start');

  @override
  Future<void> resetKeeping(ResetKeep keep) async {
    calls.add('reset:${keep.wire.join(',')}');
    state = const LocalRuntimeState(loaded: true, status: missingStatus);
  }

  void emit(RuntimeStatus status) => state = state.copyWith(status: status);
}

/// A 8 GB phone with room to spare; 749 MB unpacked (the arm64 r5 runtime).
const roomyPhone = LocalFootprint(totalMemoryMb: 7600, freeStorageMb: 40000, unpackedMb: 749);

/// A 4 GB phone.
const smallPhone = LocalFootprint(totalMemoryMb: 3700, freeStorageMb: 40000, unpackedMb: 749);

/// Plenty of memory, 600 MB free.
const fullPhone = LocalFootprint(totalMemoryMb: 7600, freeStorageMb: 600, unpackedMb: 749);

Override footprint(LocalFootprint value) => localFootprintProvider.overrideWith((ref) async => value);
