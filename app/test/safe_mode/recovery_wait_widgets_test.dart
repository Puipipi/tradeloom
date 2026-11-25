import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/engine/engine_screen.dart';
import 'package:dsh_app/ui/safe_mode/safe_mode_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';
import 'support.dart';

class _WaitingRuntime extends RecordingRuntime {
  _WaitingRuntime(super.initial);

  @override
  Future<void> stop() async {
    stops++;
    final old = state.status;
    emit(
      LocalRuntimeState(
        loaded: true,
        status: RuntimeStatus(
          phase: RuntimePhase.stopping,
          mode: old.mode,
          safeState: old.safeState,
          mainFailure: old.mainFailure,
        ),
      ),
    );
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  const beforeWrite = '还无法确认引擎已停止，未更改配置。请查看引擎日志后重试。';
  const afterWrite = '配置操作已完成，但引擎还未停止，暂未重启。请等待停止完成后再启动。';

  Future<_WaitingRuntime> pump(
    WidgetTester tester, {
    required RuntimeStatus status,
    required FakeBridge bridge,
    required Widget child,
  }) async {
    final runtime = _WaitingRuntime(LocalRuntimeState(loaded: true, status: status));
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        overrides: [
          localRuntimeProvider.overrideWith(() => runtime),
          runtimeBridgeProvider.overrideWithValue(bridge),
          localRuntimeLogsProvider.overrideWithBuild((ref, notifier) => const []),
          settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
        ],
        home: Scaffold(
          body: SafeArea(
            child: Padding(padding: const EdgeInsets.all(16), child: child),
          ),
        ),
      ),
    );
    await tester.pump();
    return runtime;
  }

  testWidgets('real engine restart button waits without an unhandled timeout or another start', (tester) async {
    final runtime = await pump(
      tester,
      status: runningStatus,
      bridge: FakeBridge(),
      child: Consumer(
        builder: (context, ref, child) {
          return EngineActions(phase: ref.watch(localRuntimeProvider).status.phase);
        },
      ),
    );
    await tester.tap(find.text('重启'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 20));
    expect(tester.takeException(), isNull);
    expect(runtime.stops, 1);
    expect(runtime.starts, isEmpty);
  });

  testWidgets('real safe move action reports incomplete stop and leaves files untouched', (tester) async {
    final bridge = FakeBridge(
      hazards: const [SafeHazard(path: '/root/.dsh/cordis.patch.yml', kind: 'homePatch', detail: '配置补丁')],
    );
    final runtime = await pump(tester, status: safeStatus(), bridge: bridge, child: const SafeModeCard());
    await tester.pump();
    await tester.tap(find.text('移开补丁'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 20));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.takeException(), isNull);
    expect(bridge.moved, isEmpty);
    expect(runtime.starts, isEmpty);
    expect(find.text(beforeWrite), findsOneWidget);
  });

  testWidgets('real safe restore action distinguishes restored configuration from an unstarted engine', (tester) async {
    final bridge = FakeBridge(lkg: lkgUseful);
    final runtime = await pump(tester, status: safeStatus(), bridge: bridge, child: const SafeModeCard());
    await tester.pump();
    await tester.tap(find.text('恢复配置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('恢复并启动'));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 20));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.takeException(), isNull);
    expect(bridge.calls.where((call) => call == 'restoreLastKnownGood').length, 1);
    expect(runtime.stops, 1);
    expect(runtime.starts, isEmpty);
    expect(find.text(afterWrite), findsOneWidget);
    expect(find.text('已恢复上次正常的配置，正在启动…'), findsNothing);
    expect(find.text(beforeWrite), findsNothing);
  });
}
