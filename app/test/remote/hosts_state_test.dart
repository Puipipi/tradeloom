// Hosts model: persistence (configs in prefs, secrets in the secret store),
// the active host, relay account flow, and activeConnectionProvider
// resolving to the right connection.

import 'dart:convert';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/relay/dsh_remote_backend.dart';
import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/remote/ssh/ssh_link.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_relay.dart';
import 'support/fake_ssh.dart';
import 'support/wait.dart';

class _NoLocal extends LocalConnectionController {
  @override
  Future<HostConnection?> build() async => null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MemorySecretStore secrets;
  late FakeSshServer server;
  late FakeConnector connector;

  ProviderContainer container({FakeRelayBackend? relay, UrlOpener? opener}) {
    final c = ProviderContainer(
      overrides: [
        secretStoreProvider.overrideWithValue(secrets),
        localConnectionProvider.overrideWith(_NoLocal.new),
        networkKicksProvider.overrideWithValue(const Stream.empty()),
        relayBackendProvider.overrideWithValue(relay ?? FakeRelayBackend()),
        urlOpenerProvider.overrideWithValue(opener ?? (_) async => true),
        sshLinkFactoryProvider.overrideWithValue(
          (ref, config) => SshHostLink(
            config: config,
            loadSecrets: () => ref.read(hostsProvider.notifier).loadSecrets(config.id),
            pinHostKey: (key) => ref.read(hostsProvider.notifier).pinHostKey(config.id, key),
            transportFactory: server.connect,
            connectClient: connector.call,
            backoff: Backoff(initial: const Duration(milliseconds: 5), maxAttempts: 2),
          ),
        ),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  Future<void> loaded(ProviderContainer c) async {
    await c.read(hostsProvider.notifier).ready;
    await Future<void>.delayed(Duration.zero);
  }

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    secrets = MemorySecretStore();
    server = FakeSshServer();
    connector = FakeConnector();
  });

  group('HostRef', () {
    test('round-trips and compares by kind + id', () {
      for (final ref in [HostRef.local, const HostRef.ssh('ssh-1'), const HostRef.relay('mac', name: '家里的 Mac')]) {
        expect(HostRef.decode(ref.encode()), ref);
      }
      expect(HostRef.decode(const HostRef.relay('mac', name: 'A').encode()).name, 'A');
      expect(const HostRef.relay('mac', name: 'A'), const HostRef.relay('mac', name: 'B'));
      expect(HostRef.decode(null), HostRef.local);
      expect(HostRef.decode('{oops'), HostRef.local);
      expect(HostRef.decode('{"kind":"ssh"}'), HostRef.local);
    });

    test('labels read well in the chat header', () {
      expect(hostLabel(HostKind.local, null), '本机');
      expect(hostLabel(HostKind.ssh, '电脑'), '电脑 · SSH');
      expect(hostLabel(HostKind.relay, '家里的 Mac'), '家里的 Mac · 远程');
      expect(hostLabel(HostKind.ssh, '一个名字特别特别特别特别长的服务器'), endsWith('… · SSH'));
    });
  });

  group('SshHostConfig', () {
    test('json round-trip, defaults and validation', () {
      final full = sampleSsh.copyWith(workingDirectory: () => '~/code', launchCommand: '~/.nvm/bin/dsh web');
      expect(SshHostConfig.fromJson(jsonDecode(jsonEncode(full.toJson()))), full);
      final min = SshHostConfig.fromJson({'id': 'ssh-x', 'host': 'h', 'user': 'u', 'port': 99999})!;
      expect(min.port, 22);
      expect(min.name, 'h');
      expect(min.launchCommand, 'dsh web');
      expect(min.auth, SshAuthMethod.password);
      expect(min.dshMode, SshDshMode.managed);
      expect(min.compression, isTrue);
      expect(SshHostConfig.fromJson({'host': 'h'}), isNull);
      expect(SshHostConfig.newId(), matches(RegExp(r'^ssh-[0-9a-f]{16}$')));
    });

    test('attach settings and compression round-trip without secrets', () {
      final config = sampleSsh.copyWith(dshMode: SshDshMode.attachOnly, remotePort: 4080, compression: false);
      expect(SshHostConfig.fromJson(config.toJson()), config);
      expect(config.connectionKey, isNot(sampleSsh.connectionKey));
      expect(sampleSsh.copyWith(compression: false).connectionKey, isNot(sampleSsh.connectionKey));
      expect(config.toJson().containsKey('attachToken'), isFalse);
      expect(SshHostConfig.fromJson({...config.toJson(), 'remotePort': 0}), isNull);
    });

    test('moving to another machine forgets the pinned key; renaming does not', () {
      expect(sampleSsh.copyWith(name: '新名字').hostKeyFingerprint, isNotNull);
      expect(sampleSsh.copyWith(host: '10.0.0.9').hostKeyFingerprint, isNull);
      expect(sampleSsh.copyWith(port: 2222).hostKeyFingerprint, isNull);
      expect(sampleSsh.copyWith(name: 'x').connectionKey, sampleSsh.connectionKey);
      expect(sampleSsh.copyWith(launchCommand: 'dsh --profile w web').connectionKey, isNot(sampleSsh.connectionKey));
    });
  });

  group('HostsController', () {
    test('persists configs to prefs and secrets to the secret store only', () async {
      final c = container();
      await loaded(c);
      await c.read(hostsProvider.notifier).saveSsh(sampleSsh, secrets: const SshSecrets(password: 'hunter2'));

      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(HostsController.prefsKey)!;
      expect(raw, contains('192.168.1.20'));
      expect(raw, isNot(contains('hunter2')));
      expect(secrets.values[SshSecrets.passwordKey(sampleSsh.id)], 'hunter2');

      // A fresh container (app restart) reads the same host back.
      final again = container();
      await loaded(again);
      expect(again.read(hostsProvider).ssh.single, sampleSsh);
      expect((await again.read(hostsProvider.notifier).loadSecrets(sampleSsh.id)).password, 'hunter2');
    });

    test('attach token stays in secure storage and is removed with the host', () async {
      final c = container();
      await loaded(c);
      final hosts = c.read(hostsProvider.notifier);
      final config = sampleSsh.copyWith(dshMode: SshDshMode.attachOnly, remotePort: 4080);
      await hosts.saveSsh(config, secrets: const SshSecrets(password: 'pw', attachToken: 'synthetic-token'));
      final raw = (await SharedPreferences.getInstance()).getString(HostsController.prefsKey)!;
      expect(raw, isNot(contains('synthetic-token')));
      expect((await hosts.loadSecrets(config.id)).attachToken, 'synthetic-token');
      expect(secrets.values[SshSecrets.attachTokenKey(config.id)], 'synthetic-token');
      await hosts.removeSsh(config.id);
      expect(secrets.values, isEmpty);
    });

    test('switching back to managed mode drops the attach token', () async {
      final c = container();
      await loaded(c);
      final hosts = c.read(hostsProvider.notifier);
      await hosts.saveSsh(
        sampleSsh.copyWith(dshMode: SshDshMode.attachOnly),
        secrets: const SshSecrets(password: 'pw', attachToken: 'synthetic-token'),
      );
      await hosts.saveSsh(sampleSsh, secrets: const SshSecrets(password: 'pw'));
      expect((await hosts.loadSecrets(sampleSsh.id)).attachToken, isNull);
    });

    test('switching to key auth drops the stored password', () async {
      final c = container();
      await loaded(c);
      final hosts = c.read(hostsProvider.notifier);
      await hosts.saveSsh(sampleSsh, secrets: const SshSecrets(password: 'pw'));
      await hosts.saveSsh(
        sampleSsh.copyWith(auth: SshAuthMethod.privateKey),
        secrets: const SshSecrets(privateKey: '-----BEGIN KEY-----', passphrase: 'pp'),
      );
      expect(
        secrets.values.keys,
        unorderedEquals([SshSecrets.privateKeyKey(sampleSsh.id), SshSecrets.passphraseKey(sampleSsh.id)]),
      );
    });

    test('a save before the initial load completes keeps what was on disk', () async {
      SharedPreferences.setMockInitialValues({
        HostsController.prefsKey: jsonEncode([sampleSsh.toJson()]),
      });
      final c = container();
      final other = sampleSsh.copyWith(name: '服务器', host: '10.0.0.2');
      final second = SshHostConfig.fromJson({...other.toJson(), 'id': 'ssh-other'})!;
      await c.read(hostsProvider.notifier).saveSsh(second);
      expect(c.read(hostsProvider).ssh.map((h) => h.id), [sampleSsh.id, 'ssh-other']);
    });

    test('pin / reset host key', () async {
      final c = container();
      await loaded(c);
      final hosts = c.read(hostsProvider.notifier);
      await hosts.saveSsh(sampleSsh.copyWith(hostKeyFingerprint: () => null, hostKeyType: () => null));
      await hosts.pinHostKey(sampleSsh.id, const PresentedHostKey('ssh-ed25519', 'SHA256:abc'));
      expect(c.read(hostsProvider).sshById(sampleSsh.id)!.hostKeyFingerprint, 'SHA256:abc');
      await hosts.resetHostKey(sampleSsh.id);
      expect(c.read(hostsProvider).sshById(sampleSsh.id)!.hostKeyFingerprint, isNull);
    });

    test('removing the active host deletes its secrets and falls back to 本机', () async {
      final c = container();
      await loaded(c);
      final hosts = c.read(hostsProvider.notifier);
      await hosts.saveSsh(sampleSsh, secrets: const SshSecrets(password: 'pw'));
      c.read(activeHostProvider.notifier).select(HostRef.ssh(sampleSsh.id));
      await hosts.removeSsh(sampleSsh.id);
      expect(c.read(hostsProvider).ssh, isEmpty);
      expect(secrets.values, isEmpty);
      expect(c.read(activeHostProvider), HostRef.local);
    });
  });

  group('active host', () {
    test('is persisted and switching resets the open conversation', () async {
      final c = container();
      await Future<void>.delayed(Duration.zero);
      c.read(currentSessionProvider.notifier).select('local-session');
      c.read(activeHostProvider.notifier).select(const HostRef.ssh('ssh-test'));
      expect(c.read(currentSessionProvider), isNull);
      await Future<void>.delayed(Duration.zero);
      final prefs = await SharedPreferences.getInstance();
      expect(HostRef.decode(prefs.getString(ActiveHostController.prefsKey)), const HostRef.ssh('ssh-test'));

      final again = container();
      again.read(activeHostProvider);
      await until(again, activeHostProvider, (host) => host == const HostRef.ssh('ssh-test'), what: '已恢复活动主机');
      expect(again.read(activeHostProvider), const HostRef.ssh('ssh-test'));
    });
  });

  group('activeConnectionProvider', () {
    test('本机 → the local connection', () async {
      final c = container();
      final sub = c.listen(activeConnectionProvider, (_, _) {});
      addTearDown(sub.close);
      await until(c, activeConnectionProvider, (s) => !s.isLoading, what: '本机连接状态');
      expect(c.read(activeConnectionProvider).value, isNull);
    });

    test('SSH host → a remote HostConnection with a meaningful label and cwd', () async {
      final c = container();
      await loaded(c);
      await c
          .read(hostsProvider.notifier)
          .saveSsh(
            sampleSsh.copyWith(workingDirectory: () => '~/code'),
            secrets: const SshSecrets(password: 'pw'),
          );
      c.read(activeHostProvider.notifier).select(HostRef.ssh(sampleSsh.id));
      final seen = <AsyncValue<HostConnection?>>[];
      final sub = c.listen(activeConnectionProvider, (_, next) => seen.add(next), fireImmediately: true);
      addTearDown(sub.close);
      final statuses = c.listen(hostLinkStatusProvider(HostRef.ssh(sampleSsh.id)), (_, _) {});
      addTearDown(statuses.close);

      await until(c, activeConnectionProvider, (s) => s.value != null, what: '远程主机连接成功');
      final conn = c.read(activeConnectionProvider).value!;
      expect(conn.isLocal, isFalse);
      expect(conn.kind, HostKind.ssh);
      expect(conn.label, '电脑 · SSH');
      expect(conn.workingDirectory, '/home/me/code');
      expect(seen.first.isLoading, isTrue);
      expect(c.read(hostLinkStatusProvider(HostRef.ssh(sampleSsh.id))).value?.isConnected, isTrue);

      // Switching back to 本机 closes the SSH link (once nothing watches it).
      statuses.close();
      final closed = server.last.done;
      c.read(activeHostProvider.notifier).select(HostRef.local);
      await until(c, activeConnectionProvider, (s) => !s.isLoading && s.value == null, what: '已切回本机');
      await closed.timeout(const Duration(seconds: 5), onTimeout: () => fail('等待超时：旧 SSH 已关闭'));
      expect(c.read(activeConnectionProvider).value, isNull);
      expect(server.last.isClosed, isTrue);
    });

    test('resetting and pinning a changed key recovers the same active link', () async {
      final c = container();
      await loaded(c);
      await c
          .read(hostsProvider.notifier)
          .saveSsh(
            sampleSsh.copyWith(hostKeyFingerprint: () => 'SHA256:old'),
            secrets: const SshSecrets(password: 'pw'),
          );
      final host = HostRef.ssh(sampleSsh.id);
      c.read(activeHostProvider.notifier).select(host);
      final sub = c.listen(activeConnectionProvider, (_, _) {});
      addTearDown(sub.close);
      await until(c, activeConnectionProvider, (s) => s.hasError, what: '指纹不一致');
      final link = c.read(hostLinkProvider(host));
      await c.read(hostsProvider.notifier).resetHostKey(sampleSsh.id);
      await c.read(hostsProvider.notifier).pinHostKey(sampleSsh.id, server.hostKey);
      await until(c, activeConnectionProvider, (s) => s.value != null, what: '新指纹连接成功');
      expect(c.read(hostLinkProvider(host)), same(link));
      expect(c.read(activeConnectionProvider).value?.client, same(link!.currentClient));
    });

    test('cwd changes immediately without reconnecting the transport', () async {
      final c = container();
      await loaded(c);
      await c.read(hostsProvider.notifier).saveSsh(sampleSsh, secrets: const SshSecrets(password: 'pw'));
      final host = HostRef.ssh(sampleSsh.id);
      c.read(activeHostProvider.notifier).select(host);
      final sub = c.listen(activeConnectionProvider, (_, _) {});
      addTearDown(sub.close);
      await until(c, activeConnectionProvider, (s) => s.value != null, what: 'SSH 已连接');
      final client = c.read(activeConnectionProvider).value!.client;
      await c.read(hostsProvider.notifier).saveSsh(sampleSsh.copyWith(workingDirectory: () => '~/new'));
      await until(c, activeConnectionProvider, (s) => s.value?.workingDirectory == '/home/me/new', what: '工作目录已更新');
      expect(server.transports, hasLength(1));
      expect(c.read(activeConnectionProvider).value!.client, same(client));
    });

    test('name and fingerprint changes keep the existing link and transport', () async {
      final c = container();
      await loaded(c);
      await c.read(hostsProvider.notifier).saveSsh(sampleSsh, secrets: const SshSecrets(password: 'pw'));
      final host = HostRef.ssh(sampleSsh.id);
      c.read(activeHostProvider.notifier).select(host);
      final sub = c.listen(activeConnectionProvider, (_, _) {});
      addTearDown(sub.close);
      await until(c, activeConnectionProvider, (s) => s.value != null, what: 'SSH 已连接');
      final link = c.read(hostLinkProvider(host));
      await c
          .read(hostsProvider.notifier)
          .saveSsh(sampleSsh.copyWith(name: '办公室', hostKeyFingerprint: () => 'SHA256:next'));
      await until(c, activeConnectionProvider, (s) => s.value?.label == '办公室 · SSH', what: '主机名已更新');
      expect(c.read(hostLinkProvider(host)), same(link));
      expect(server.transports, hasLength(1));
      expect((link as SshHostLink).config.hostKeyFingerprint, 'SHA256:next');
    });

    test('a failed SSH host surfaces as AsyncError, and retry recovers', () async {
      server.failNext.add(const HostLinkError(HostLinkErrorKind.authFailed, '登录被拒绝'));
      final c = container();
      await loaded(c);
      await c.read(hostsProvider.notifier).saveSsh(sampleSsh, secrets: const SshSecrets(password: 'pw'));
      final host = HostRef.ssh(sampleSsh.id);
      c.read(activeHostProvider.notifier).select(host);
      final sub = c.listen(activeConnectionProvider, (_, _) {});
      addTearDown(sub.close);
      await until(c, activeConnectionProvider, (s) => s.hasError, what: 'SSH 连接失败');
      expect(c.read(activeConnectionProvider).hasError, isTrue);

      c.read(remoteConnectionProvider(host).notifier).retry();
      await until(c, activeConnectionProvider, (s) => s.value != null, what: 'SSH 重试成功');
      expect(c.read(activeConnectionProvider).value?.label, '电脑 · SSH');
    });

    test('an SSH host that no longer exists falls back to 本机', () async {
      final c = container();
      await loaded(c);
      c.read(activeHostProvider.notifier).select(const HostRef.ssh('ssh-gone'));
      final sub = c.listen(activeConnectionProvider, (_, _) {});
      addTearDown(sub.close);
      await until(c, activeConnectionProvider, (s) => !s.isLoading, what: '未知主机回到本机');
      // Same as 本机 (whose fake engine isn't running).
      expect(c.read(activeConnectionProvider), const AsyncData<HostConnection?>(null));
    });

    test('relay host → connects through the backend', () async {
      final relay = FakeRelayBackend(user: sampleRelayUser);
      final c = container(relay: relay);
      await c.read(relayAccountProvider.future);
      c.read(activeHostProvider.notifier).select(const HostRef.relay('mac', name: '家里的 Mac'));
      final sub = c.listen(activeConnectionProvider, (_, _) {});
      addTearDown(sub.close);
      await until(c, activeConnectionProvider, (s) => s.value != null, what: '远程主机连接成功');
      expect(c.read(activeConnectionProvider).value?.label, '家里的 Mac · 远程');
      expect(relay.connected, ['mac']);
    });

    test('offline relay host fails with a clear reason', () async {
      final relay = FakeRelayBackend(user: sampleRelayUser);
      final c = container(relay: relay);
      await c.read(relayAccountProvider.future);
      c.read(activeHostProvider.notifier).select(const HostRef.relay('nas'));
      final sub = c.listen(activeConnectionProvider, (_, _) {});
      addTearDown(sub.close);
      final statuses = c.listen(hostLinkStatusProvider(const HostRef.relay('nas')), (_, _) {});
      addTearDown(statuses.close);
      await until(
        c,
        hostLinkStatusProvider(const HostRef.relay('nas')),
        (s) => s.value?.error?.kind == HostLinkErrorKind.hostOffline,
        what: '主机离线状态',
      );
      final status = c.read(hostLinkStatusProvider(const HostRef.relay('nas'))).value;
      expect(status?.error?.kind, HostLinkErrorKind.hostOffline);
      expect(relay.connected, isEmpty);
    });
  });

  group('relay account', () {
    test('recheck clears a revoked account and its host list', () async {
      final relay = FakeRelayBackend(user: sampleRelayUser);
      final c = container(relay: relay);
      await c.read(relayAccountProvider.future);
      relay.user = null;
      await c.read(relayAccountProvider.notifier).recheck();
      expect(c.read(relayAccountProvider).value!.signedIn, isFalse);
      expect(c.read(relayAccountProvider).value!.hosts, isEmpty);
    });

    test('refresh failure keeps the list, flags it and rechecks the account', () async {
      final relay = FakeRelayBackend(user: sampleRelayUser);
      final c = container(relay: relay);
      await c.read(relayAccountProvider.future);
      relay.listError = StateError('secret server failure');
      await c.read(relayAccountProvider.notifier).refresh();
      expect(c.read(relayAccountProvider).value!.hostsFailed, isTrue);
      expect(c.read(relayAccountProvider).value!.hosts, isNotEmpty);
      expect(c.read(relayAccountProvider).value!.error, isNull);
      relay.user = null;
      await c.read(relayAccountProvider.notifier).refresh();
      expect(c.read(relayAccountProvider).value!.signedIn, isFalse);
    });

    test('initial host-list failure is distinct from an empty account', () async {
      final relay = FakeRelayBackend(user: sampleRelayUser)..listError = StateError('raw');
      final c = container(relay: relay);
      final account = await c.read(relayAccountProvider.future);
      expect(account.signedIn, isTrue);
      expect(account.hostsFailed, isTrue);
      expect(account.hosts, isEmpty);
    });

    test('unavailable backend: not signed in, login disabled', () async {
      final c = ProviderContainer(
        overrides: [
          secretStoreProvider.overrideWithValue(secrets),
          relayBackendProvider.overrideWithValue(const UnavailableRelayBackend()),
        ],
      );
      addTearDown(c.dispose);
      final state = await c.read(relayAccountProvider.future);
      expect(state.available, isFalse);
      expect(state.signedIn, isFalse);
    });

    test('default backend is dsh_remote: available, signed out with an empty store', () async {
      final c = ProviderContainer(overrides: [secretStoreProvider.overrideWithValue(secrets)]);
      addTearDown(c.dispose);
      expect(c.read(relayBackendProvider), isA<DshRemoteRelayBackend>());
      final state = await c.read(relayAccountProvider.future);
      expect(state.available, isTrue);
      expect(state.server, 'dsh.r2049.cn');
      expect(state.signedIn, isFalse);
    });

    test('a signed-out state carries the Server sign-in providers', () async {
      final c = container(relay: FakeRelayBackend());
      final state = await c.read(relayAccountProvider.future);
      expect(state.providers.map((p) => p.id), ['zhihu', 'github', 'google']);
      expect(state.providers.first.displayName, '知乎');
    });

    test('login(providerId) signs in with that provider', () async {
      final relay = FakeRelayBackend();
      final opened = <Uri>[];
      final c = container(
        relay: relay,
        opener: (u) async {
          opened.add(u);
          return true;
        },
      );
      await c.read(relayAccountProvider.future);
      final login = c.read(relayAccountProvider.notifier).login(providerId: 'github');
      await until(c, relayAccountProvider, (s) => s.value?.loginUrl != null, what: 'GitHub 登录已打开');
      expect(relay.loginProviderIds, ['github']);
      expect(opened.single.host, 'dsh.r2049.cn');
      relay.pendingLogin!.complete(sampleRelayUser);
      await login;
      expect(c.read(relayAccountProvider).value!.user!.provider, 'github');
    });

    test('browser login: opens the URL, waits, then lists hosts', () async {
      final relay = FakeRelayBackend();
      final opened = <Uri>[];
      final c2 = container(
        relay: relay,
        opener: (u) async {
          opened.add(u);
          return true;
        },
      );
      await c2.read(relayAccountProvider.future);
      final login = c2.read(relayAccountProvider.notifier).login();
      await until(c2, relayAccountProvider, (s) => s.value?.loginUrl != null, what: '浏览器登录已打开');
      expect(c2.read(relayAccountProvider).value!.loggingIn, isTrue);
      expect(opened.single.host, 'dsh.r2049.cn');
      relay.pendingLogin!.complete(sampleRelayUser);
      await login;
      final state = c2.read(relayAccountProvider).value!;
      expect(state.signedIn, isTrue);
      expect(state.loggingIn, isFalse);
      expect(state.hosts.map((h) => h.name), ['家里的 Mac', '书房 NAS']);
    });

    test('logout while a relay host is active switches back to 本机', () async {
      final c = container(relay: FakeRelayBackend(user: sampleRelayUser));
      await c.read(relayAccountProvider.future);
      c.read(activeHostProvider.notifier).select(const HostRef.relay('mac'));
      await c.read(relayAccountProvider.notifier).logout();
      expect(c.read(activeHostProvider), HostRef.local);
      expect(c.read(relayAccountProvider).value!.signedIn, isFalse);
    });
  });

  test('RelayHost subtitle', () {
    expect(sampleRelayHosts.first.subtitle, 'macOS · Harness 0.2.1-rc.2');
    expect(const RelayHost(id: 'x', name: 'x', online: false).subtitle, '离线');
  });

  test('status summaries', () {
    expect(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 3).summary, contains('第 3 次'));
    expect(HostLinkStatus.idle.summary, '未连接');
    expect(const HostLinkStatus(HostLinkPhase.connecting).withStep(HostLinkStep.tunnel).completed, {
      HostLinkStep.connect,
      HostLinkStep.verifyHostKey,
      HostLinkStep.startDsh,
    });
  });
}
