import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/state/workspaces_state.dart';
import 'package:dsh_app/ui/engine/engine_screen.dart';
import 'package:dsh_app/ui/remote/remote_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../remote/support/fake_relay.dart';
import '../safe_mode/support.dart';
import '../shell/golden_harness.dart';

const _tile = ValueKey('workspace-recovery');
const _confirm = ValueKey('workspace-recovery-confirm');
const _channel = MethodChannel('dsh/runtime');

class _Active extends ActiveHostController {
  @override
  HostRef build() => HostRef.local;
  @override
  void select(HostRef host) => state = host;
}

class _Runtime extends LocalRuntimeController {
  _Runtime({RuntimePhase phase = RuntimePhase.running, bool? recovery, bool safe = false})
    : wire = {
        'phase': phase.name,
        'bundledVersion': 'test-runtime',
        if (phase != RuntimePhase.notInstalled) 'installedVersion': 'test-runtime',
        'mode': safe ? 'safe' : 'normal',
        'safeState': safe ? 'on' : 'off',
        if (phase == RuntimePhase.running) 'baseUrl': 'http://127.0.0.1:3080',
        if (phase == RuntimePhase.running) 'token': 'synthetic-local-token',
        'workspaceRecovery': ?recovery,
      };
  final Map<String, Object?> wire;
  final calls = <String>[];
  bool finishStop = true;
  Object? stopError;
  Object? startError;

  @override
  LocalRuntimeState build() => LocalRuntimeState(loaded: true, status: RuntimeStatus.fromMap(wire));

  void emit(Map<String, Object?> change) {
    wire.addAll(change);
    state = LocalRuntimeState(loaded: true, status: RuntimeStatus.fromMap(wire));
  }

  @override
  Future<void> stop() async {
    calls.add('stop');
    if (stopError case final error?) throw error;
    emit({'phase': finishStop ? 'installed' : 'stopping'});
  }

  @override
  Future<void> start() async {
    calls.add('start');
    if (startError case final error?) throw error;
    emit({'phase': 'running'});
  }
}

class _Fixture {
  _Fixture(this.runtime);
  final _Runtime runtime;
  final native = <Map<Object?, Object?>>[];
  Object? nativeError;
  Completer<void>? holdNative;
  bool supported = true;
  late ProviderContainer container;

  Future<Object?> handle(MethodCall call) async {
    if (call.method != 'setWorkspaceRecovery' || !supported) throw MissingPluginException();
    final args = (call.arguments as Map).cast<Object?, Object?>();
    native.add(args);
    runtime.calls.add('set:${args['enabled']}');
    if (holdNative case final wait?) await wait.future;
    if (nativeError case final error?) throw error;
    runtime.emit({'workspaceRecovery': args['enabled']});
    return null;
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, null),
  );

  Future<_Fixture> pump(
    WidgetTester tester, {
    _Runtime? runtime,
    Widget home = const EngineScreen(),
    double scale = 1,
    bool narrow = false,
  }) async {
    final f = _Fixture(runtime ?? _Runtime());
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, f.handle);
    usePhoneSurface(tester);
    if (narrow) tester.view.physicalSize = const Size(320 * 2, 640 * 2);
    final relay = FakeRelayBackend(user: null);
    await tester.pumpWidget(
      goldenApp(
        home: Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
            child: home,
          ),
        ),
        brightness: Brightness.light,
        overrides: [
          localRuntimeProvider.overrideWith(() => f.runtime),
          runtimeBridgeProvider.overrideWithValue(FakeBridge()),
          localRuntimeLogsProvider.overrideWithBuild((ref, notifier) => const []),
          settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
          activeHostProvider.overrideWith(_Active.new),
          secretStoreProvider.overrideWithValue(MemorySecretStore()),
          relayBackendProvider.overrideWithValue(relay),
          networkKicksProvider.overrideWithValue(const Stream.empty()),
          hostLinkStatusProvider.overrideWith((ref, host) => const Stream.empty()),
          activeConnectionProvider.overrideWith(
            (ref) => AsyncError<HostConnection?>(StateError('workspace registry pending'), StackTrace.empty),
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    f.container = ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
    return f;
  }

  // The row sits near the foot of the page, below what the list builds up front.
  Future<void> toBottom(WidgetTester tester) async {
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -6000));
    await tester.pumpAndSettle();
  }

  Future<void> open(WidgetTester tester) async {
    await toBottom(tester);
    expect(
      find.byKey(_tile),
      findsOneWidget,
      reason: 'installed local runtime must expose index rescue without DSH RPC',
    );
    await tester.ensureVisible(find.byKey(_tile));
    await tester.tap(find.byKey(_tile));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
  }

  Future<void> confirm(WidgetTester tester) async {
    await tester.ensureVisible(find.byKey(_confirm));
    await tester.tap(find.byKey(_confirm));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  testWidgets('running without a RuntimeFailure still exposes the local rescue entry', (tester) async {
    final f = await pump(tester);
    expect(f.container.read(localRuntimeProvider).status.isRunning, true);
    expect(f.container.read(activeConnectionProvider).hasError, true);
    await open(tester);
    expect(find.descendant(of: find.byType(AlertDialog), matching: find.text('启用工作区索引救援')), findsOneWidget);
    expect(find.textContaining('原索引'), findsWidgets);
    expect(find.textContaining('空工作区'), findsOneWidget);
    expect(find.textContaining('未修复原索引'), findsOneWidget);
    expect(f.runtime.calls, isEmpty);
    expect(f.native, isEmpty);
  });

  testWidgets('cancelling confirmation never stops or changes the runtime', (tester) async {
    final f = await pump(tester);
    await open(tester);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(f.runtime.calls, isEmpty);
    expect(f.native, isEmpty);
  });

  testWidgets('confirmed enable uses the actual platform bridge in stop set start order', (tester) async {
    final f = await pump(tester);
    await open(tester);
    await confirm(tester);
    expect(f.runtime.calls, ['stop', 'set:true', 'start']);
    expect(f.native, [
      {'enabled': true},
    ]);
    expect(find.text('恢复使用原索引'), findsOneWidget);
    expect(find.textContaining('已选择独立救援索引'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an already stopped local runtime switches once without another stop', (tester) async {
    final f = await pump(tester, runtime: _Runtime(phase: RuntimePhase.installed));
    await open(tester);
    await confirm(tester);
    expect(f.runtime.calls, ['set:true', 'start']);
    expect(f.native, [
      {'enabled': true},
    ]);
  });

  testWidgets('a safe running profile must also stop before the index mode changes', (tester) async {
    final f = await pump(tester, runtime: _Runtime(safe: true));
    await open(tester);
    await confirm(tester);
    expect(f.runtime.calls, ['stop', 'set:true', 'start']);
    expect(f.runtime.wire['mode'], 'safe');
    expect(f.runtime.wire['safeState'], 'on');
  });

  testWidgets('an incomplete stop cannot change the mode or request another start', (tester) async {
    final runtime = _Runtime()..finishStop = false;
    final f = await pump(tester, runtime: runtime);
    await open(tester);
    await confirm(tester);
    await tester.pump(const Duration(seconds: 20));
    await tester.pump();
    expect(runtime.calls, ['stop']);
    expect(f.native, isEmpty);
    expect(find.textContaining('未更改配置'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a stop error cannot reach the native mode write or start', (tester) async {
    final runtime = _Runtime()..stopError = PlatformException(code: 'stop_failed');
    final f = await pump(tester, runtime: runtime);
    await open(tester);
    await confirm(tester);
    expect(runtime.calls, ['stop']);
    expect(f.native, isEmpty);
    expect(find.textContaining('操作未完成'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  for (final code in ['runtime_not_stopped', 'workspace_recovery_save_failed']) {
    testWidgets('native rejection $code never requests a new start', (tester) async {
      final f = await pump(tester);
      f.nativeError = PlatformException(code: code);
      await open(tester);
      await confirm(tester);
      expect(f.runtime.calls, ['stop', 'set:true']);
      expect(f.native, [
        {'enabled': true},
      ]);
      expect(find.text('恢复使用原索引'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('a missing native method is visible and cannot start the engine', (tester) async {
    final f = await pump(tester);
    f.supported = false;
    await open(tester);
    await confirm(tester);
    expect(f.runtime.calls, ['stop']);
    expect(f.native, isEmpty);
    expect(find.textContaining('当前版本尚不支持'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed start keeps the reported mode without claiming engine readiness', (tester) async {
    final runtime = _Runtime()..startError = PlatformException(code: 'start_failed');
    final f = await pump(tester, runtime: runtime);
    await open(tester);
    await confirm(tester);
    expect(runtime.calls, ['stop', 'set:true', 'start']);
    expect(f.native, [
      {'enabled': true},
    ]);
    expect(find.text('恢复使用原索引'), findsOneWidget);
    expect(find.textContaining('操作未完成'), findsOneWidget);
    expect(find.textContaining('已恢复健康'), findsNothing);
  });

  testWidgets('disable explains the original fault and preserves the rescue domain', (tester) async {
    final f = await pump(tester, runtime: _Runtime(recovery: true));
    await open(tester);
    expect(find.text('恢复使用原索引'), findsWidgets);
    expect(find.textContaining('原故障可能再次出现'), findsOneWidget);
    expect(find.descendant(of: find.byType(AlertDialog), matching: find.textContaining('救援索引都会保留')), findsOneWidget);
    await confirm(tester);
    expect(f.runtime.calls, ['stop', 'set:false', 'start']);
    expect(f.native, [
      {'enabled': false},
    ]);
    expect(find.text('启用工作区索引救援'), findsOneWidget);
  });

  testWidgets('old native status without the new field defaults to the original index', (tester) async {
    final f = await pump(tester, runtime: _Runtime(phase: RuntimePhase.installed));
    expect(f.runtime.wire.containsKey('workspaceRecovery'), false);
    await open(tester);
    expect(find.descendant(of: find.byType(AlertDialog), matching: find.text('启用工作区索引救援')), findsOneWidget);
    expect(find.text('恢复使用原索引'), findsNothing);
    expect(f.native, isEmpty);
  });

  testWidgets('a double tap during the native write submits only one local transaction', (tester) async {
    final f = await pump(tester);
    f.holdNative = Completer<void>();
    await open(tester);
    await confirm(tester);
    expect(f.native, hasLength(1));
    await tester.ensureVisible(find.byKey(_tile));
    await tester.tap(find.byKey(_tile));
    await tester.pump();
    expect(find.byType(AlertDialog), findsNothing);
    expect(f.native, hasLength(1));
    f.holdNative!.complete();
    await tester.pumpAndSettle();
    expect(f.runtime.calls, ['stop', 'set:true', 'start']);
  });

  testWidgets('host changes while confirmation is open retire the pending action', (tester) async {
    final f = await pump(tester);
    await open(tester);
    final active = f.container.read(activeHostProvider.notifier) as _Active;
    active.select(const HostRef.ssh('other-host'));
    active.select(HostRef.local);
    await confirm(tester);
    expect(f.native, isEmpty);
    expect(f.runtime.calls, isEmpty);
  });

  testWidgets('runtime replacement while confirmation is open retires the pending action', (tester) async {
    final f = await pump(tester);
    await open(tester);
    f.runtime.emit({'phase': 'installing'});
    f.runtime.emit({'phase': 'installed', 'installedVersion': 'different-runtime'});
    await confirm(tester);
    expect(f.native, isEmpty);
    expect(f.runtime.calls, isEmpty);
  });

  testWidgets('not installed has no rescue action', (tester) async {
    final f = await pump(tester, runtime: _Runtime(phase: RuntimePhase.notInstalled));
    await toBottom(tester);
    expect(find.byKey(_tile), findsNothing);
    expect(f.native, isEmpty);
  });

  testWidgets('the remote page exposes no local workspace recovery action', (tester) async {
    final f = await pump(tester, home: const RemoteScreen());
    expect(find.byKey(_tile), findsNothing);
    expect(f.runtime.calls, isEmpty);
    expect(f.native, isEmpty);
  });

  testWidgets('the full confirmation remains reachable on a narrow large-text screen', (tester) async {
    final f = await pump(tester, scale: 2, narrow: true);
    await open(tester);
    expect(find.byKey(_confirm), findsOneWidget);
    await confirm(tester);
    expect(f.native, [
      {'enabled': true},
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a successful toggle does not clear original local workspace preferences', (tester) async {
    final key = WorkspacePrefsController.keyFor(HostRef.local);
    final original = jsonEncode({
      'selected': 'old-workspace',
      'pinned': ['old-workspace'],
      'groups': {'old-workspace': 'old-group'},
    });
    SharedPreferences.setMockInitialValues({key: original});
    final f = await pump(tester);
    expect(await f.container.read(workspacePrefsProvider.notifier).selection(), 'old-workspace');
    await open(tester);
    await confirm(tester);
    expect(f.native, [
      {'enabled': true},
    ]);
    expect((await SharedPreferences.getInstance()).getString(key), original);
    expect(f.container.read(workspacePrefsProvider).selected, 'old-workspace');
    expect(f.container.read(workspacePrefsProvider).pinned, ['old-workspace']);
    expect(f.container.read(workspacePrefsProvider).groups, {'old-workspace': 'old-group'});
  });
}
