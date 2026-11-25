// SshHostLink orchestration with a fake transport and remote: step order,
// host-key TOFU, reconnect / reuse, restart detection, backoff and kicks.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/ssh/local_forward.dart';
import 'package:dsh_app/remote/ssh/ssh_host_config.dart';
import 'package:dsh_app/remote/ssh/ssh_link.dart';
import 'package:dsh_app/remote/ssh/ssh_transport.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_ssh.dart';
import 'support/wait.dart';

/// Fast backoff so reconnect tests take milliseconds.
Backoff quick({int? maxAttempts = 5}) =>
    Backoff(initial: const Duration(milliseconds: 10), max: const Duration(milliseconds: 40), maxAttempts: maxAttempts);

void main() {
  late FakeSshServer server;
  late FakeConnector connector;
  final links = <SshHostLink>[];

  setUp(() {
    server = FakeSshServer();
    connector = FakeConnector();
  });

  tearDown(() async {
    for (final link in links) {
      await link.close();
    }
    links.clear();
  });

  SshHostLink link({
    SshHostConfig config = sampleSsh,
    HostKeyPrompter? prompt,
    HostKeyPinner? pin,
    Backoff? backoff,
    bool retryFirstOpen = true,
    SshSecrets secrets = const SshSecrets(password: 'pw'),
    StreamController<void>? kicks,
  }) {
    final l = SshHostLink(
      config: config,
      loadSecrets: () async => secrets,
      promptHostKey: prompt,
      pinHostKey: pin,
      transportFactory: server.connect,
      connectClient: connector.call,
      backoff: backoff ?? quick(),
      retryFirstOpen: retryFirstOpen,
      kicks: kicks?.stream,
      keepAliveInterval: const Duration(milliseconds: 20),
      keepAliveTimeout: const Duration(milliseconds: 20),
    );
    links.add(l);
    return l;
  }

  test('a mux stuck reconnecting over live SSH restarts a dead DSH', () async {
    final l = link();
    final original = await l.open();
    final replaced = l.clients.first;
    server.remote.killServer();
    // The client points at a closed port: its mux keeps retrying, as through a dead tunnel.
    original.mux.ready().ignore();
    expect(await replaced.timeout(const Duration(seconds: 5)), isNot(same(original)));
    expect(server.remote.launches, 2);
    expect(connector.calls.last.hostHeader, '127.0.0.1:${server.remote.port}');
  });

  test('a live DSH is left alone while the mux retries', () async {
    final l = link();
    final original = await l.open();
    original.mux.ready().ignore();
    // A few keepalive ticks, each probing the DSH port.
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(server.last.tunnels.length, greaterThan(2));
    expect(server.transports, hasLength(1));
    expect(server.remote.launches, 1);
    expect(l.currentClient, same(original));
  });

  test('a refused reused port never replaces a live server', () async {
    server.remote.pid = 500;
    server.remote.tunnelErrors.add(const TunnelRefused());
    final l = link();
    await l.open();
    expect(server.remote.launches, 0);
    expect(l.status.isConnected, isTrue);
  });

  test('one transport login failure does not restart a reusable process', () async {
    server.remote.pid = 500;
    connector.failNext.add(const DshTransportException('temporary'));
    final l = link();
    await l.open();
    expect(server.remote.launches, 0);
    expect(l.status.isConnected, isTrue);
  });

  test('forbidden forwarding never repeatedly restarts the server', () async {
    server.remote.tunnelErrors.addAll(List<Object>.filled(8, StateError('forwarding forbidden')));
    final l = link();
    await expectLater(l.open(), throwsA(isA<HostLinkError>()));
    expect(server.remote.launches, 1);
  });

  test('a token rejected by a reused DSH is final and never kills it', () async {
    server.remote.pid = 500;
    connector.failNext.add(const DshHttpException(401, 'stale'));
    final l = link();
    await expectLater(l.open(), throwsA(isA<HostLinkError>().having((e) => e.retryable, 'retryable', isFalse)));
    expect(connector.calls, hasLength(1));
    expect(server.remote.launches, 0);
    expect(server.remote.pid, 500);
  });

  for (final missingLog in [false, true]) {
    test('live but non-reusable process survives (missing log: $missingLog)', () async {
      server.remote.pid = 500;
      server.remote.sameCommand = missingLog;
      server.remote.hasLaunchLine = !missingLog;
      final l = link();
      await expectLater(l.open(), throwsA(isA<HostLinkError>().having((e) => e.retryable, 'retryable', isFalse)));
      expect(server.remote.launches, 0);
      expect(server.remote.pid, 500);
      expect(server.last.scripts, hasLength(1));
      expect(server.last.tunnels, isEmpty);
    });
  }

  test('explicit managed restart replaces a live instance', () async {
    server.remote.pid = 500;
    final l = link();
    await l.restartManaged();
    expect(server.remote.launches, 1);
    expect(server.last.scripts.single, contains('kill "\$P"'));
  });

  test('one restart action is not reused after a transient login failure', () async {
    server.remote.pid = 500;
    connector.failNext.add(const DshTransportException('temporary'));
    final l = link();
    await l.restartManaged();
    expect(server.remote.launches, 1);
    expect(server.transports.expand((t) => t.scripts).where((s) => s.contains(r'kill "$P"')), hasLength(1));
  });

  test('failed SSH authentication consumes restart consent before ordinary open', () async {
    server.remote.pid = 500;
    server.failNext.add(const HostLinkError(HostLinkErrorKind.authFailed, 'denied'));
    final l = link();
    await expectLater(l.restartManaged(), throwsA(isA<HostLinkError>()));
    await l.open();
    expect(server.remote.pid, 500);
    expect(server.remote.launches, 0);
    expect(server.last.scripts, hasLength(1));
    expect(server.last.scripts.single, isNot(contains(r'kill "$P"')));
  });

  test('a network retry cannot inherit restart consent from the failed SSH attempt', () async {
    server.remote.pid = 500;
    server.failNext.add(const HostLinkError(HostLinkErrorKind.unreachable, 'offline', retryable: true));
    final l = link();
    await l.restartManaged();
    expect(server.connects, hasLength(2));
    expect(server.remote.pid, 500);
    expect(server.remote.launches, 0);
    expect(server.last.scripts.single, isNot(contains(r'kill "$P"')));
  });

  test('compression preference reaches SSH connection parameters', () {
    expect(SshConnectParams.of(sampleSsh, const SshSecrets()).compression, isTrue);
    expect(SshConnectParams.of(sampleSsh.copyWith(compression: false), const SshSecrets()).compression, isFalse);
  });

  test('attach-only opens the fixed loopback port and never executes shell commands', () async {
    server.remote.pid = 500;
    final l = link(
      config: sampleSsh.copyWith(dshMode: SshDshMode.attachOnly, remotePort: server.remote.port),
      secrets: const SshSecrets(password: 'pw', attachToken: 'existing-token'),
    );
    await l.open();
    expect(server.last.scripts, isEmpty);
    expect(server.last.tunnels.single, ('127.0.0.1', server.remote.port));
    expect(connector.calls.single.token, 'existing-token');
    expect(connector.calls.single.hostHeader, '127.0.0.1:${server.remote.port}');
    await expectLater(l.restartManaged(), throwsStateError);
    await l.close();
    expect(server.remote.launches, 0);
    expect(server.remote.pid, 500);
    expect(server.transports.expand((t) => t.scripts), isEmpty);
  });

  test('attach-only missing token fails without bootstrap', () async {
    final l = link(config: sampleSsh.copyWith(dshMode: SshDshMode.attachOnly));
    await expectLater(l.open(), throwsA(isA<HostLinkError>()));
    expect(server.last.scripts, isEmpty);
    expect(server.last.tunnels, isEmpty);
  });

  for (final loginFailure in [false, true]) {
    test('attach-only failure never starts a server (login: $loginFailure)', () async {
      server.remote.pid = 500;
      if (loginFailure) {
        connector.failNext.add(const DshHttpException(401, 'rejected'));
      } else {
        server.remote.tunnelErrors.add(const TunnelRefused());
      }
      final l = link(
        config: sampleSsh.copyWith(dshMode: SshDshMode.attachOnly, remotePort: server.remote.port),
        secrets: const SshSecrets(password: 'pw', attachToken: 'existing-token'),
      );
      await expectLater(l.open(), throwsA(isA<HostLinkError>()));
      expect(server.transports, hasLength(1));
      expect(server.last.scripts, isEmpty);
      expect(server.remote.launches, 0);
      expect(server.remote.pid, 500);
    });
  }

  test('first connect walks every step and logs in through the tunnel', () async {
    final l = link();
    final seen = <HostLinkStatus>[];
    l.statuses.listen(seen.add);

    final client = await l.open();

    expect(l.status.phase, HostLinkPhase.connected);
    expect(
      seen.map((s) => s.step).whereType<HostLinkStep>().toSet().toList(),
      HostLinkStep.values,
      reason: 'connect → 验证主机指纹 → 启动 DSH → 建立隧道 → 登录',
    );
    expect(identical(client, connector.clients.single), isTrue);
    final call = connector.calls.single;
    expect(call.baseUri.host, '127.0.0.1');
    expect(call.baseUri.port, l.localPort);
    expect(call.hostHeader, '127.0.0.1:${server.remote.port}', reason: 'Host fence sees the remote loopback');
    expect(call.token, server.remote.token);
    expect(server.last.tunnels.first, ('127.0.0.1', server.remote.port));
    expect(l.resolvedWorkingDirectory, isNull);
  });

  test('working directory is resolved against the remote HOME', () async {
    final l = link(config: sampleSsh.copyWith(workingDirectory: () => '~/code'));
    await l.open();
    expect(l.resolvedWorkingDirectory, '/home/me/code');
  });

  group('host key (TOFU)', () {
    test('unknown key: asks, pins, connects', () async {
      PresentedHostKey? pinned;
      HostKeyPrompt? asked;
      final l = link(
        config: sampleSsh.copyWith(hostKeyType: () => null, hostKeyFingerprint: () => null),
        prompt: (p) async {
          asked = p;
          return true;
        },
        pin: (k) async => pinned = k,
      );
      await l.open();
      expect(asked?.hostName, '电脑');
      expect(asked?.key.fingerprint, server.hostKey.fingerprint);
      expect(pinned?.fingerprint, server.hostKey.fingerprint);
      expect(l.config.hostKeyFingerprint, server.hostKey.fingerprint);
    });

    test('unknown key without a prompter fails closed', () async {
      final l = link(config: sampleSsh.copyWith(hostKeyFingerprint: () => null));
      await expectLater(
        l.open(),
        throwsA(isA<HostLinkError>().having((e) => e.kind, 'kind', HostLinkErrorKind.hostKeyUnverified)),
      );
      expect(l.status.phase, HostLinkPhase.failed);
      expect(server.transports, isEmpty);
    });

    test('declined key: no connection', () async {
      final l = link(
        config: sampleSsh.copyWith(hostKeyFingerprint: () => null),
        prompt: (_) async => false,
      );
      await expectLater(
        l.open(),
        throwsA(isA<HostLinkError>().having((e) => e.kind, 'kind', HostLinkErrorKind.hostKeyRejected)),
      );
    });

    test('changed key: fails closed with a warning, never prompts, never retries', () async {
      server.hostKey = const PresentedHostKey('ssh-ed25519', 'SHA256:evilevilevilevilevilevilevilevilevil0000');
      var prompted = false;
      final l = link(prompt: (_) async => prompted = true);
      await expectLater(
        l.open(),
        throwsA(
          isA<HostLinkError>()
              .having((e) => e.kind, 'kind', HostLinkErrorKind.hostKeyMismatch)
              .having((e) => e.retryable, 'retryable', isFalse)
              .having((e) => e.detail, 'detail', contains('重置指纹'))
              .having((e) => e.detail, 'detail', contains('SHA256:evil')),
        ),
      );
      expect(prompted, isFalse);
      expect(server.connects, hasLength(1));
      expect(l.status.phase, HostLinkPhase.failed);
      expect(l.status.step, HostLinkStep.verifyHostKey);
    });
  });

  test('missing dsh is reported at 启动 DSH, without retries', () async {
    server.remote.dshInstalled = false;
    final l = link();
    await expectLater(
      l.open(),
      throwsA(isA<HostLinkError>().having((e) => e.kind, 'kind', HostLinkErrorKind.dshNotFound)),
    );
    expect(l.status.step, HostLinkStep.startDsh);
    expect(server.connects, hasLength(1));
  });

  test('auth failure is final', () async {
    server.failNext.add(const HostLinkError(HostLinkErrorKind.authFailed, '登录被拒绝'));
    final l = link();
    await expectLater(l.open(), throwsA(isA<HostLinkError>()));
    expect(l.status.phase, HostLinkPhase.failed);
    expect(server.connects, hasLength(1));
  });

  test('"测试连接" mode reports a network failure instead of retrying', () async {
    server.failNext.add(const HostLinkError(HostLinkErrorKind.unreachable, 'x', retryable: true));
    final l = link(retryFirstOpen: false);
    await expectLater(l.open(), throwsA(isA<HostLinkError>()));
    expect(server.connects, hasLength(1));
  });

  test('first connect retries network errors with backoff', () async {
    server.failNext.addAll(const [
      HostLinkError(HostLinkErrorKind.unreachable, 'a', retryable: true),
      HostLinkError(HostLinkErrorKind.unreachable, 'b', retryable: true),
    ]);
    final l = link();
    final phases = <HostLinkPhase>[];
    l.statuses.listen((s) => phases.add(s.phase));
    await l.open();
    expect(server.connects, hasLength(3));
    expect(phases, contains(HostLinkPhase.reconnecting));
    expect(l.status.isConnected, isTrue);
  });

  test('gives up after the attempt budget', () async {
    server.failNext.addAll(
      List.filled(10, const HostLinkError(HostLinkErrorKind.unreachable, '连不上。', retryable: true)),
    );
    final l = link(backoff: quick(maxAttempts: 2));
    await expectLater(l.open(), throwsA(isA<HostLinkError>().having((e) => e.detail, 'detail', contains('已重试'))));
    expect(l.status.phase, HostLinkPhase.failed);
    expect(server.connects, hasLength(3));
  });

  test('SSH drop: reconnects and keeps the same client when dsh is still running', () async {
    final l = link();
    final first = await l.open();
    final published = <Object>[];
    l.clients.listen(published.add);

    final connected = nextStatus(l, (s) => s.isConnected, what: 'SSH 断线后重连');
    server.last.drop();
    await connected;

    expect(server.transports, hasLength(2));
    expect(l.status.isConnected, isTrue);
    expect(identical(l.currentClient, first), isTrue);
    expect(published, isEmpty);
    expect(server.remote.launches, 1, reason: 'reused the running dsh');
  });

  test('remote dsh restarted: logs in again and publishes the new client', () async {
    final l = link();
    final first = await l.open();
    final published = <Object>[];
    l.clients.listen(published.add);

    final changed = l.clients.first;
    final connected = nextStatus(l, (s) => s.isConnected, what: 'DSH 重启后连接');
    server.remote.killServer();
    server.last.drop();
    await connected;
    await changed;

    expect(server.remote.launches, 2);
    expect(published, hasLength(1));
    expect(identical(published.single, first), isFalse);
    expect(connector.calls.last.hostHeader, '127.0.0.1:${server.remote.port}');
    expect(
      connector.calls.last.baseUri.port,
      connector.calls.first.baseUri.port,
      reason: 'local forward port is stable across reconnects',
    );
  });

  test('missed keepalives trigger a reconnect', () async {
    final l = link();
    await l.open();
    final connected = nextStatus(l, (s) => s.isConnected, what: '保活失败后重连');
    server.last.pingOk = false;
    await connected;
    expect(server.transports.length, greaterThanOrEqualTo(2));
    expect(l.status.isConnected, isTrue);
  });

  test('a network kick skips the backoff wait', () async {
    final kicks = StreamController<void>();
    final l = link(
      kicks: kicks,
      backoff: Backoff(initial: const Duration(seconds: 30), max: const Duration(seconds: 30), maxAttempts: 5),
    );
    await l.open();
    server.failNext.add(const HostLinkError(HostLinkErrorKind.unreachable, 'down', retryable: true));
    final reconnecting = nextStatus(l, (s) => s.phase == HostLinkPhase.reconnecting, what: 'SSH 开始退避');
    server.last.drop();
    await reconnecting;
    expect(l.status.phase, HostLinkPhase.reconnecting);
    // Without the kick the next attempt would be ~15–30 s away.
    final failedAttempt = nextStatus(
      l,
      (s) => s.phase == HostLinkPhase.reconnecting && s.error?.message == 'down',
      what: '第一次立即重试失败',
    );
    kicks.add(null);
    await failedAttempt;
    // The kicked attempt hit failNext; kick again for the one that works.
    final connected = nextStatus(l, (s) => s.isConnected, what: '第二次立即重试成功');
    kicks.add(null);
    await connected;
    expect(l.status.isConnected, isTrue);
    await kicks.close();
  });

  test('close stops everything and releases the local port', () async {
    final l = link();
    await l.open();
    final port = l.localPort!;
    await l.close();
    expect(l.status.phase, HostLinkPhase.idle);
    await expectLater(Socket.connect('127.0.0.1', port), throwsA(isA<SocketException>()));
  });

  test('LocalForwarder pipes bytes both ways', () async {
    final channels = <FakeChannel>[];
    final forwarder = await LocalForwarder.bind(() async {
      final c = FakeChannel(echo: true);
      channels.add(c);
      return c;
    });
    addTearDown(forwarder.close);
    final socket = await Socket.connect('127.0.0.1', forwarder.port);
    socket.add(utf8.encode('GET / HTTP/1.1\r\n\r\n'));
    final echoed = await socket.first.timeout(const Duration(seconds: 2));
    expect(utf8.decode(echoed), 'GET / HTTP/1.1\r\n\r\n');
    expect(forwarder.activeConnections, 1);
    forwarder.dropConnections();
    expect(channels.single.destroyed, isTrue);
    socket.destroy();
  });

  test('fetchHostKey reads the key without logging in', () async {
    final key = await fetchHostKey(sampleSsh, transportFactory: server.connect);
    expect(key.fingerprint, server.hostKey.fingerprint);
    expect(key.shortType, 'ED25519');
    expect(server.transports, isEmpty, reason: 'verifier refused, no session');
  });
}
