// Goldens for the optional on-device runtime: the first-run choice, the
// install page, a failed install's way out, and 本机 without its runtime on
// the engine page, the host list and the drawer.
//
//   flutter test --update-goldens test/onboarding/local_optional_golden_test.dart

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/runtime/local_footprint.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/engine/engine_screen.dart';
import 'package:dsh_app/ui/onboarding/local_install.dart';
import 'package:dsh_app/ui/onboarding/onboarding_scaffold.dart';
import 'package:dsh_app/ui/onboarding/runtime_setup_page.dart';
import 'package:dsh_app/ui/remote/host_switcher.dart';
import 'package:dsh_app/ui/shell/home_shell.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../remote/support/fake_relay.dart';
import '../remote/support/fake_ssh.dart';
import '../shell/golden_harness.dart';
import '../support/english_preview.dart';
import 'local_optional_support.dart';

class _Hosts extends HostsController {
  @override
  HostsState build() => const HostsState(ssh: [sampleSsh], loaded: true);
}

class _Active extends ActiveHostController {
  @override
  HostRef build() => HostRef.ssh(sampleSsh.id);
}

List<Override> _missing({LocalFootprint phone = roomyPhone, RuntimeStatus status = missingStatus}) => [
  localRuntimeProvider.overrideWith(() => RecordingLocalRuntime(LocalRuntimeState(loaded: true, status: status))),
  settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
  footprint(phone),
];

List<Override> _hostList() => [
  ..._missing(),
  secretStoreProvider.overrideWithValue(MemorySecretStore()),
  networkKicksProvider.overrideWithValue(const Stream.empty()),
  hostsProvider.overrideWith(_Hosts.new),
  activeHostProvider.overrideWith(_Active.new),
  relayBackendProvider.overrideWithValue(FakeRelayBackend()),
  hostLinkStatusProvider.overrideWith(
    (ref, host) => Stream.value(
      host.isLocal
          ? HostLinkStatus.idle
          : const HostLinkStatus(HostLinkPhase.connected, completed: {...HostLinkStep.values}),
    ),
  ),
];

Widget _choice() => OnboardingProgress(
  step: 1,
  steps: 2,
  child: RuntimeSetupPage(onDone: () {}, choose: true, onRemote: () {}),
);

class _SheetLauncher extends StatelessWidget {
  const _SheetLauncher();

  @override
  Widget build(BuildContext context) {
    return AppBackdrop(
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: Center(
          child: Builder(
            builder: (context) => TextButton(
              onPressed: () => showHostSheet(context, onManage: () {}),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
  }
}

Future<void> _openSheet(WidgetTester tester) async {
  await tester.tap(find.text('open'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
}

/// One English golden, light: `goldens/en_<name>_light.png`.
void _english(
  String name,
  Widget Function() home,
  List<Override> Function() overrides, {
  Future<void> Function(WidgetTester tester)? before,
}) {
  testWidgets('$name (en)', (tester) async {
    useEnglish();
    await tester.runAsync(loadGoldenFonts);
    usePhoneSurface(tester);
    await tester.pumpWidget(goldenApp(home: inEnglish(home()), brightness: Brightness.light, overrides: overrides()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    if (before != null) await before(tester);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/en_${name}_light.png'));
  });
}

/// One golden, light only: `goldens/<name>_light.png`.
void _light(String name, Widget Function() home, List<Override> Function() overrides) {
  testWidgets('$name (light)', (tester) async {
    await tester.runAsync(loadGoldenFonts);
    usePhoneSurface(tester);
    await tester.pumpWidget(goldenApp(home: home(), brightness: Brightness.light, overrides: overrides()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/${name}_light.png'));
  });
}

void main() {
  goldenBoth('runtime_choice', _choice, overrides: _missing);
  _english('runtime_choice', _choice, _missing);
  _light('runtime_choice_small', _choice, () => _missing(phone: smallPhone));
  _light('runtime_choice_full', _choice, () => _missing(phone: fullPhone));

  goldenBoth('install_confirm', () => const LocalInstallPage(), overrides: _missing);
  _english('install_confirm', () => const LocalInstallPage(), _missing);

  _light(
    'setup_failed_remote',
    () => OnboardingProgress(
      step: 1,
      steps: 2,
      child: RuntimeSetupPage(onDone: () {}, choose: true, onRemote: () {}),
    ),
    () => _missing(
      status: const RuntimeStatus(
        phase: RuntimePhase.error,
        bundledVersion: bundled,
        error: 'install failed: 存储空间不足：需要约 862 MB，当前可用 600 MB',
      ),
    ),
  );

  goldenBoth('engine_missing', () => const EngineScreen(), overrides: _missing);
  _english('engine_missing', () => const EngineScreen(), _missing);

  goldenBoth('host_sheet_missing', () => const _SheetLauncher(), overrides: _hostList, before: _openSheet);
  _english('host_sheet_missing', () => const _SheetLauncher(), _hostList, before: _openSheet);

  goldenBoth(
    'drawer_missing',
    () => HomeShell(chatBuilder: (_) => const SizedBox.expand(), initiallyOpen: true),
    overrides: () => [..._missing(), sessionsProvider.overrideWith(() => FakeSessions(const []))],
  );
}
