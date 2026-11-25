import 'package:dsh_app/diagnostics/automatic_diagnostics.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/notify_state.dart' show FlagController, appForegroundProvider;
import 'package:dsh_app/state/settings_state.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Settings extends SettingsController {
  _Settings(this.initial);
  final AppSettings initial;
  @override
  AppSettings build() => initial;
  void emit(AppSettings next) => state = next;
}

class _Runtime extends LocalRuntimeController {
  _Runtime(this.initial);
  final LocalRuntimeState initial;
  @override
  LocalRuntimeState build() => initial;
}

class _Host extends ActiveHostController {
  _Host(this.initial);
  final HostRef initial;
  @override
  HostRef build() => initial;
}

class _Local extends LocalConnectionController {
  _Local(this.onBuild);
  final void Function() onBuild;
  @override
  Future<HostConnection?> build() async {
    onBuild();
    return null;
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final scenario in [
    (
      name: 'default off',
      settings: const AppSettings(loaded: true),
      host: HostRef.local,
      phase: RuntimePhase.running,
      loaded: true,
      foreground: true,
    ),
    (
      name: 'settings not loaded',
      settings: const AppSettings(automaticDiagnostics: true),
      host: HostRef.local,
      phase: RuntimePhase.running,
      loaded: true,
      foreground: true,
    ),
    (
      name: 'first-install failure',
      settings: const AppSettings(loaded: true, automaticDiagnostics: true),
      host: HostRef.local,
      phase: RuntimePhase.error,
      loaded: true,
      foreground: true,
    ),
    (
      name: 'runtime not loaded',
      settings: const AppSettings(loaded: true, automaticDiagnostics: true),
      host: HostRef.local,
      phase: RuntimePhase.running,
      loaded: false,
      foreground: true,
    ),
    (
      name: 'remote host',
      settings: const AppSettings(loaded: true, automaticDiagnostics: true),
      host: const HostRef.ssh('remote'),
      phase: RuntimePhase.running,
      loaded: true,
      foreground: true,
    ),
    (
      name: 'background',
      settings: const AppSettings(loaded: true, automaticDiagnostics: true),
      host: HostRef.local,
      phase: RuntimePhase.running,
      loaded: true,
      foreground: false,
    ),
  ]) {
    testWidgets('real automatic provider initializes zero connections when ${scenario.name}', (tester) async {
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      var activeBuilds = 0;
      var localBuilds = 0;
      final container = ProviderContainer(
        overrides: [
          settingsProvider.overrideWith(() => _Settings(scenario.settings)),
          localRuntimeProvider.overrideWith(
            () => _Runtime(
              LocalRuntimeState(
                loaded: scenario.loaded,
                status: RuntimeStatus(phase: scenario.phase),
              ),
            ),
          ),
          activeHostProvider.overrideWith(() => _Host(scenario.host)),
          appForegroundProvider.overrideWith(() => FlagController(scenario.foreground)),
          activeConnectionProvider.overrideWith((ref) {
            activeBuilds++;
            return const AsyncData(null);
          }),
          localConnectionProvider.overrideWith(
            () => _Local(() {
              localBuilds++;
            }),
          ),
        ],
      );
      addTearDown(container.dispose);
      final automatic = container.read(automaticDiagnosticsProvider);
      await tester.pump();
      expect(activeBuilds, 0);
      expect(localBuilds, 0);
      expect(automatic.eligible, isFalse);
      expect(container.read(automaticDiagnosticsProvider), same(automatic));
    });
  }

  testWidgets('connections attach lazily and detach without rebuilding the coordinator', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    var activeBuilds = 0;
    var localBuilds = 0;
    final container = ProviderContainer(
      overrides: [
        settingsProvider.overrideWith(() => _Settings(const AppSettings(loaded: true))),
        localRuntimeProvider.overrideWith(
          () => _Runtime(const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.running))),
        ),
        activeHostProvider.overrideWith(() => _Host(HostRef.local)),
        activeConnectionProvider.overrideWith((ref) {
          activeBuilds++;
          return const AsyncData(null);
        }),
        localConnectionProvider.overrideWith(
          () => _Local(() {
            localBuilds++;
          }),
        ),
      ],
    );
    addTearDown(container.dispose);
    final automatic = container.read(automaticDiagnosticsProvider);
    final settings = container.read(settingsProvider.notifier) as _Settings;
    expect(activeBuilds, 0);
    expect(localBuilds, 0);
    settings.emit(const AppSettings(loaded: true, automaticDiagnostics: true));
    await tester.pump();
    expect(activeBuilds, 1);
    expect(localBuilds, 1);
    expect(container.read(automaticDiagnosticsProvider), same(automatic));
    settings.emit(const AppSettings(loaded: true));
    container.invalidate(activeConnectionProvider);
    container.invalidate(localConnectionProvider);
    await tester.pump();
    expect(activeBuilds, 1, reason: 'disabled subscriptions no longer initialize invalidated connections');
    expect(localBuilds, 1);
    expect(container.read(automaticDiagnosticsProvider), same(automatic));
    settings.emit(const AppSettings(loaded: true, automaticDiagnostics: true));
    await tester.pump();
    expect(activeBuilds, 2);
    expect(localBuilds, 2);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    container.invalidate(activeConnectionProvider);
    container.invalidate(localConnectionProvider);
    await tester.pump();
    expect(activeBuilds, 2);
    expect(localBuilds, 2);
    expect(container.read(automaticDiagnosticsProvider), same(automatic));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(activeBuilds, 3);
    expect(localBuilds, 3);
    expect(container.read(automaticDiagnosticsProvider), same(automatic));
  });
}
