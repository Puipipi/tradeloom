import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/read_list_epoch.dart';
import 'package:dsh_app/state/read_list_identity.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../plugins/support/fake_plugin_host.dart';
import 'read_list_refresh_test.dart' show SwitchConnection, switchConnectionProvider;

class _Host extends ActiveHostController {
  _Host(this.initial);
  final HostRef initial;
  @override
  HostRef build() => initial;
}

class _Hosts extends HostsController {
  _Hosts(this.initial);
  final HostsState initial;
  @override
  HostsState build() => initial;
  void set(HostsState value) => state = value;
}

class _Runtime extends LocalRuntimeController {
  _Runtime(this.initial);
  final RuntimeStatus initial;
  @override
  LocalRuntimeState build() => LocalRuntimeState(loaded: true, status: initial);
  void set(RuntimeStatus value) => state = LocalRuntimeState(loaded: true, status: value);
}

class _Settings extends SettingsController {
  @override
  AppSettings build() => const AppSettings(loaded: true);
}

class _Account extends AccountController {
  @override
  AccountState build() => const AccountState(phase: AccountPhase.signedOut);
  @override
  bool get readListIdentityKnown => true;
  void set(AccountState value) => state = value;
}

class _Relay extends RelayAccountController {
  _Relay(this.initial);
  final RelayAccountState initial;
  @override
  Future<RelayAccountState> build() async => initial;
  void set(RelayAccountState value) => state = AsyncData(value);
}

class _Server extends RelayServerController {
  _Server(this.value);
  final String? value;
  @override
  String? build() => value;
  void set(String? value) => state = value;
}

const ssh = SshHostConfig(
  id: 'same-id',
  name: 'Work',
  host: 'example.invalid',
  user: 'user',
  hostKeyType: 'ssh-ed25519',
  hostKeyFingerprint: 'SHA256:pinned',
  workingDirectory: '/workspace/a',
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  ProviderContainer container(List<Override> overrides) {
    final c = ProviderContainer(
      overrides: [activeConnectionProvider.overrideWithValue(const AsyncData(null)), ...overrides],
    );
    addTearDown(c.dispose);
    return c;
  }

  test('unknown, unloaded and unpinned SSH identities fail closed', () {
    final hosts = _Hosts(const HostsState());
    final c = container([
      activeHostProvider.overrideWith(() => _Host(const HostRef.ssh('same-id'))),
      hostsProvider.overrideWith(() => hosts),
    ]);
    expect(c.read(readListIdentityProvider), isNull);
    hosts.set(const HostsState(loaded: true));
    expect(c.read(readListIdentityProvider), isNull);
    hosts.set(HostsState(loaded: true, ssh: [ssh.copyWith(hostKeyFingerprint: () => null)]));
    expect(c.read(readListIdentityProvider), isNull);
    hosts.set(const HostsState(loaded: true, ssh: [ssh]));
    expect(c.read(readListIdentityProvider), isNotNull);
  });

  test('SSH connection configuration, pinned key and cwd are distinct under same id', () {
    final hosts = _Hosts(const HostsState(loaded: true, ssh: [ssh]));
    final c = container([
      activeHostProvider.overrideWith(() => _Host(const HostRef.ssh('same-id'))),
      hostsProvider.overrideWith(() => hosts),
    ]);
    final first = c.read(readListIdentityProvider)!;
    for (final changed in [
      ssh.copyWith(user: 'someone-else'),
      ssh.copyWith(launchCommand: 'dsh other-profile'),
      ssh.copyWith(hostKeyFingerprint: () => 'SHA256:new-key'),
      ssh.copyWith(workingDirectory: () => '/workspace/b'),
    ]) {
      hosts.set(HostsState(loaded: true, ssh: [changed]));
      expect(c.read(readListIdentityProvider), isNot(first));
    }
    hosts.set(HostsState(loaded: true, ssh: [ssh.copyWith(name: 'Renamed only')]));
    expect(c.read(readListIdentityProvider), first, reason: 'a label is not the source');
  });

  test('SSH resolved cwd is preserved only for its exact config across client loss', () async {
    final client = DshClient.withCarrier(FakePluginCarrier());
    addTearDown(client.close);
    final hosts = _Hosts(const HostsState(loaded: true, ssh: [ssh]));
    HostConnection connection(String? cwd) =>
        HostConnection(client: client, isLocal: false, kind: HostKind.ssh, hostId: 'same-id', workingDirectory: cwd);
    final c = ProviderContainer(
      overrides: [
        activeHostProvider.overrideWith(() => _Host(const HostRef.ssh('same-id'))),
        hostsProvider.overrideWith(() => hosts),
        switchConnectionProvider.overrideWith(() => SwitchConnection(connection('/resolved/a'))),
        activeConnectionProvider.overrideWith((ref) => ref.watch(switchConnectionProvider)),
      ],
    );
    addTearDown(c.dispose);
    final first = c.read(readListIdentityProvider);
    expect(first, isNotNull);
    c.read(switchConnectionProvider.notifier).set(null);
    expect(c.read(readListIdentityProvider), first);
    c.read(switchConnectionProvider.notifier).set(connection('/resolved/b'));
    expect(c.read(readListIdentityProvider), isNot(first));
    c.read(switchConnectionProvider.notifier).set(connection(null));
    expect(c.read(readListIdentityProvider), isNull, reason: 'configured cwd has no verified resolution');
    c.read(switchConnectionProvider.notifier).set(null);
    hosts.set(HostsState(loaded: true, ssh: [ssh.copyWith(workingDirectory: () => '/another')]));
    expect(c.read(readListIdentityProvider), isNot(first));
    hosts.set(HostsState(loaded: true, ssh: [ssh.copyWith(hostKeyFingerprint: () => '   ')]));
    expect(c.read(readListIdentityProvider), isNull);
  });

  test('credential generation separates identical SSH configs without reading secret values', () async {
    final c = container([
      activeHostProvider.overrideWith(() => _Host(const HostRef.ssh('same-id'))),
      secretStoreProvider.overrideWithValue(MemorySecretStore()),
    ]);
    final hosts = c.read(hostsProvider.notifier);
    await hosts.ready;
    await hosts.saveSsh(ssh, secrets: const SshSecrets(password: 'FIRST-SECRET'));
    final first = c.read(readListIdentityProvider)!;
    final epoch = c.read(readListCredentialEpochProvider);
    await hosts.saveSsh(ssh, secrets: const SshSecrets(password: 'SECOND-SECRET'));
    expect(c.read(readListCredentialEpochProvider), greaterThan(epoch));
    expect(c.read(readListIdentityProvider), isNot(first));
    expect(c.read(readListIdentityProvider)!.digest, matches(RegExp(r'^[0-9a-f]{64}$')));
  });

  test('local source survives start/stop/token changes, not mode/version/reset', () {
    const running = RuntimeStatus(phase: RuntimePhase.running, installedVersion: 'v1', token: 'one');
    final runtime = _Runtime(running);
    final c = container([
      activeHostProvider.overrideWith(() => _Host(HostRef.local)),
      localRuntimeProvider.overrideWith(() => runtime),
      localReadListRootProvider.overrideWithValue(const AsyncData('/canonical/rootfs')),
      settingsProvider.overrideWith(_Settings.new),
      accountProvider.overrideWith(_Account.new),
    ]);
    final first = c.read(readListIdentityProvider)!;
    for (final phase in [RuntimePhase.stopping, RuntimePhase.installed, RuntimePhase.starting, RuntimePhase.running]) {
      runtime.set(RuntimeStatus(phase: phase, installedVersion: 'v1', token: 'new-token'));
      expect(c.read(readListIdentityProvider), first);
    }
    runtime.set(const RuntimeStatus(phase: RuntimePhase.running, installedVersion: 'v1', mode: EngineMode.safe));
    expect(c.read(readListIdentityProvider), isNot(first));
    runtime.set(const RuntimeStatus(phase: RuntimePhase.running, installedVersion: 'v2'));
    expect(c.read(readListIdentityProvider), isNot(first));
    runtime.set(const RuntimeStatus(phase: RuntimePhase.installing, installedVersion: 'v1'));
    expect(c.read(readListIdentityProvider), isNull);
    runtime.set(running);
    expect(c.read(readListIdentityProvider), isNot(first), reason: 'same-version reinstall is a new root generation');
  });

  test('unresolved root/account is not assumed to be a local signed-out identity', () {
    final account = _Account();
    final c = container([
      activeHostProvider.overrideWith(() => _Host(HostRef.local)),
      localRuntimeProvider.overrideWith(
        () => _Runtime(const RuntimeStatus(phase: RuntimePhase.running, installedVersion: 'v')),
      ),
      localReadListRootProvider.overrideWithValue(const AsyncData('/rootfs')),
      settingsProvider.overrideWith(_Settings.new),
      accountProvider.overrideWith(() => account),
    ]);
    expect(c.read(readListIdentityProvider), isNotNull);
    account.set(const AccountState(phase: AccountPhase.unknown));
    expect(c.read(readListIdentityProvider), isNull);
    account.set(const AccountState(phase: AccountPhase.signingIn));
    expect(c.read(readListIdentityProvider), isNull);
  });

  test('relay server/account/pinned device fingerprint all isolate snapshots', () async {
    RelayAccountState relay({
      String user = 'u',
      String key = 'key',
      String? version,
      RelayTrust trust = RelayTrust.pinned,
    }) => RelayAccountState(
      available: true,
      user: RelayUser(id: user, displayName: 'User'),
      hosts: [
        RelayHost(id: 'device', name: 'Device', online: true, fingerprint: key, trust: trust, harnessVersion: version),
      ],
    );
    final account = _Relay(relay());
    final server = _Server('https://relay-one.invalid');
    final c = container([
      activeHostProvider.overrideWith(() => _Host(const HostRef.relay('device'))),
      relayServerProvider.overrideWith(() => server),
      relayAccountProvider.overrideWith(() => account),
    ]);
    expect(c.read(readListIdentityProvider), isNull);
    await c.read(relayAccountProvider.future);
    final first = c.read(readListIdentityProvider)!;
    server.set('https://relay-two.invalid');
    expect(c.read(readListIdentityProvider), isNot(first));
    server.set('https://relay-one.invalid');
    account.set(relay(user: 'another-account'));
    expect(c.read(readListIdentityProvider), isNot(first));
    account.set(relay(version: 'v2'));
    expect(c.read(readListIdentityProvider), isNot(first));
    account.set(relay(key: 'new-key'));
    expect(c.read(readListIdentityProvider), isNot(first));
    for (final trust in [RelayTrust.unknown, RelayTrust.unpinned, RelayTrust.keyChanged]) {
      account.set(relay(trust: trust));
      expect(c.read(readListIdentityProvider), isNull);
    }
  });

  test('unknown SSH local fallback and AsyncLoading previous client are not live proof', () async {
    final client = DshClient.withCarrier(FakePluginCarrier());
    addTearDown(client.close);
    final local = HostConnection(client: client, isLocal: true);
    expect(readListConnection(AsyncData(local), const HostRef.ssh('missing')), isNull);
    expect(readListConnection(AsyncData(local), HostRef.local), same(local));
    expect(readListConnection(const AsyncLoading<HostConnection?>(), HostRef.local), isNull);
    final sshConnection = HostConnection(client: client, isLocal: false, kind: HostKind.ssh, hostId: 'one');
    expect(readListConnection(AsyncData(sshConnection), const HostRef.ssh('two')), isNull);
    expect(readListConnection(AsyncData(sshConnection), const HostRef.ssh('one')), same(sshConnection));
  });
}
