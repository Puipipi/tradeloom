// The settings hub's overview card on a phone without the on-device runtime
// that works through a remote host: nothing here to sign in to, so the card
// shows the host instead of 「登录 DeepSeek 账号 / 或填写 API Key」.
//
//   flutter test --update-goldens test/settings/settings_overview_remote_test.dart

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/remote/remote_screen.dart';
import 'package:dsh_app/ui/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../account/support.dart' show FixedAccount;
import '../phone/support.dart' show FixedActiveHost, FixedHosts;
import '../shell/golden_harness.dart';

const _bundled = 'r5-dsh0.2.1-rc.2-node24.22.1-ubuntu24.04.5-b3f6c96ee2f2';
const _missing = RuntimeStatus(phase: RuntimePhase.notInstalled, bundledVersion: _bundled, abi: 'arm64-v8a');
const _lab = HostRef.ssh('lab');

List<Override> _overrides({
  RuntimeStatus runtime = _missing,
  HostRef host = _lab,
  HostLinkPhase link = HostLinkPhase.connected,
  AppSettings settings = const AppSettings(loaded: true),
}) => [
  localRuntimeProvider.overrideWith(() => FakeRuntime(LocalRuntimeState(loaded: true, status: runtime))),
  settingsProvider.overrideWith(() => FakeSettings(settings)),
  accountProvider.overrideWith(() => FixedAccount(const AccountState(phase: AccountPhase.signedOut))),
  activeHostProvider.overrideWith(() => FixedActiveHost(host)),
  hostsProvider.overrideWith(FixedHosts.new),
  hostLinkStatusProvider.overrideWith((ref, host) => Stream.value(HostLinkStatus(link))),
  // The whole hub opens the host's connection: no network, no keystore.
  networkKicksProvider.overrideWithValue(const Stream.empty()),
  secretStoreProvider.overrideWithValue(MemorySecretStore()),
];

Future<void> _pump(WidgetTester tester, List<Override> overrides) async {
  usePhoneSurface(tester);
  await tester.pumpWidget(
    goldenApp(
      home: const Scaffold(body: SettingsOverview()),
      brightness: Brightness.light,
      overrides: overrides,
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('no runtime, remote host: the card is the host', (tester) async {
    await _pump(tester, _overrides());
    expect(find.text('实验室服务器'), findsOneWidget);
    expect(find.text('远程主机 · 已连接'), findsOneWidget);
    expect(find.text('登录 DeepSeek 账号'), findsNothing);
    expect(find.text('或填写 API Key'), findsNothing);
    expect(find.bySemanticsLabel('远程主机：实验室服务器，已连接'), findsOneWidget);
    // The engine line stays: it is where the runtime gets installed.
    expect(find.text('本机引擎 · 未安装'), findsOneWidget);

    await tester.tap(find.text('实验室服务器'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.byType(RemoteScreen), findsOneWidget);
  });

  testWidgets('no runtime, remote host, API Key saved: still the host', (tester) async {
    await _pump(tester, _overrides(settings: const AppSettings(loaded: true, apiKey: 'sk-0123456789abcdef')));
    expect(find.text('实验室服务器'), findsOneWidget);
    expect(find.text('DeepSeek API Key'), findsNothing);
  });

  testWidgets('a link that failed reads as such', (tester) async {
    await _pump(tester, _overrides(link: HostLinkPhase.failed));
    expect(find.text('远程主机 · 连接失败'), findsOneWidget);
  });

  testWidgets('no runtime, still on 本机: sign-in as before', (tester) async {
    await _pump(tester, _overrides(host: HostRef.local));
    expect(find.text('登录 DeepSeek 账号'), findsOneWidget);
    expect(find.text('实验室服务器'), findsNothing);
  });

  testWidgets('runtime installed, remote host: sign-in as before', (tester) async {
    await _pump(tester, _overrides(runtime: runningStatus));
    expect(find.text('登录 DeepSeek 账号'), findsOneWidget);
    expect(find.text('实验室服务器'), findsNothing);
  });

  goldenBoth('settings_remote_only', () => const SettingsScreen(), overrides: _overrides);
}
