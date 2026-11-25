import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/ssh/ssh_host_config.dart';
import 'package:dsh_app/remote/ssh/ssh_link.dart';
import 'package:dsh_app/remote/ssh/ssh_transport.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_ssh.dart';

const _params = SshConnectParams(
  host: 'ssh.example.invalid',
  port: 22,
  username: 'test',
  auth: SshAuthMethod.privateKey,
  secrets: SshSecrets(privateKey: 'synthetic-only'),
);

final _config = sampleSsh.copyWith(auth: SshAuthMethod.privateKey);

// Exercise the dependency's actual pre-authentication failure propagation;
// no SSH server, credentials, external address or wall-clock delay is used.
class _MemorySocket extends SSHSocket {
  _MemorySocket() {
    outgoing.stream.listen((_) {});
  }

  final incoming = StreamController<Uint8List>();
  final outgoing = StreamController<List<int>>();
  final _closed = Completer<void>();

  @override
  Stream<Uint8List> get stream => incoming.stream;
  @override
  StreamSink<List<int>> get sink => outgoing.sink;
  @override
  Future<void> get done => _closed.future;

  @override
  Future<void> close() {
    if (_closed.isCompleted) return done;
    _closed.complete();
    if (!incoming.isClosed) unawaited(incoming.close());
    if (!outgoing.isClosed) unawaited(outgoing.close());
    return done;
  }

  @override
  void destroy() => unawaited(close());
}

// Client identity is relevant here; no DSH HTTP traffic is part of this test.
class _OfflineCarrier extends DshCarrier {
  @override
  String get kind => 'ssh-auth-test';
  @override
  DshTracer? get tracer => null;

  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) =>
      throw StateError('unexpected RPC');

  @override
  Future<DshMuxLink> openLink(MuxOptions options) async =>
      throw const DshTransportException('no DSH traffic in this test');

  @override
  Future<void> close() async {}
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final socketError in [false, true]) {
    test('the real SSH client preserves a pre-auth socket loss (error: $socketError)', () async {
      final socket = _MemorySocket();
      final client = SSHClient(
        socket,
        username: 'test',
        onVerifyHostKey: (_, _) => false,
        onPasswordRequest: () => 'unused',
        keepAliveInterval: null,
        handshakeTimeout: null,
        authTimeout: null,
      );
      unawaited(client.done.catchError((Object _) {}));
      addTearDown(() async {
        await client.close();
        await socket.close();
      });
      final aborted = client.authenticated.then<Object>(
        (_) => throw StateError('no authentication response was sent'),
        onError: (Object error) => error,
      );
      if (socketError) {
        socket.incoming.addError(const SocketException('network changed'));
      } else {
        await socket.incoming.close();
      }
      final error = await aborted;
      expect(error, isA<SSHAuthAbortError>());
      expect((error as SSHAuthAbortError).reason, socketError ? isA<SSHSocketError>() : isNull);
      final described = DartSshTransport.describeSshError(error, _params);
      expect(described.kind, HostLinkErrorKind.unreachable);
      expect(described.retryable, isTrue);
      expect(described.detail, contains('Connection closed before authentication'));
      if (socketError) expect(described.detail, contains('network changed'));
    });
  }

  for (final (label, error, kind, retryable) in [
    ('auth deadline', SSHAuthAbortError('Authentication timed out'), HostLinkErrorKind.unreachable, true),
    (
      'a peer reporting the connection lost',
      SSHAuthAbortError('Connection closed before authentication', SSHDisconnectError(10, 'connection lost')),
      HostLinkErrorKind.unreachable,
      true,
    ),
    (
      'credentials rejected',
      SSHAuthFailError('All authentication methods failed'),
      HostLinkErrorKind.authFailed,
      false,
    ),
    (
      'host key rejected during authentication',
      SSHAuthAbortError('Connection closed before authentication', SSHHostkeyError('Hostkey verification failed')),
      HostLinkErrorKind.hostKeyRejected,
      false,
    ),
    for (final reason in [13, 14, 15])
      (
        'peer authentication refusal $reason',
        SSHAuthAbortError('Connection closed before authentication', SSHDisconnectError(reason, 'explicit refusal')),
        HostLinkErrorKind.authFailed,
        false,
      ),
  ]) {
    test('classifies $label without making credential failures retryable', () {
      final described = DartSshTransport.describeSshError(error, _params);
      expect(described.kind, kind);
      expect(described.retryable, retryable);
    });
  }

  test('an interrupted reauthentication recreates SSH and reuses the DSH session', () async {
    final server = FakeSshServer();
    var clientConnections = 0;
    final client = DshClient.withCarrier(_OfflineCarrier());
    final usedSecrets = <SshSecrets>[];
    var attempts = 0;
    final link = SshHostLink(
      config: _config,
      loadSecrets: () async => _params.secrets,
      transportFactory: (params, verify) {
        attempts++;
        usedSecrets.add(params.secrets);
        if (attempts == 2) {
          throw DartSshTransport.describeSshError(
            SSHAuthAbortError('Connection closed before authentication', SSHSocketError(const SocketException('lost'))),
            params,
          );
        }
        return server.connect(params, verify);
      },
      connectClient: ({required baseUri, required token, required hostHeader}) async {
        clientConnections++;
        return client;
      },
      backoff: Backoff(initial: Duration.zero, max: Duration.zero, maxAttempts: 2),
      keepAliveInterval: const Duration(days: 1),
    );
    addTearDown(link.close);
    final original = await link.open();
    final port = link.localPort;
    final outcome = link.statuses.firstWhere((status) => status.isConnected || status.phase == HostLinkPhase.failed);
    server.last.drop();
    final restored = await outcome;
    expect(restored.phase, HostLinkPhase.connected);
    expect(attempts, 3);
    expect(server.transports, hasLength(2));
    expect(link.currentClient, same(original));
    expect(link.localPort, port);
    expect(clientConnections, 1);
    expect(server.remote.launches, 1);
    expect(usedSecrets, hasLength(3));
    expect(usedSecrets.every((secrets) => identical(secrets, _params.secrets)), isTrue);
  });

  testWidgets('network abort retries keep the attempt budget and a later kick can recheck', (tester) async {
    var attempts = 0;
    final link = SshHostLink(
      config: _config,
      loadSecrets: () async => _params.secrets,
      transportFactory: (params, verify) async {
        attempts++;
        throw DartSshTransport.describeSshError(SSHAuthAbortError('Authentication timed out'), params);
      },
      backoff: Backoff(initial: const Duration(seconds: 1), max: const Duration(seconds: 1), maxAttempts: 2),
    );
    addTearDown(link.close);
    Object? failure;
    final opening = link.open().then<void>(
      (_) => fail('the host never becomes reachable'),
      onError: (Object error) {
        failure = error;
      },
    );
    await tester.pump();
    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    await opening;
    expect(failure, isA<HostLinkError>().having((error) => error.kind, 'kind', HostLinkErrorKind.unreachable));
    expect(link.status.phase, HostLinkPhase.failed);
    expect(attempts, 3, reason: 'one initial attempt and two bounded retries');
    await tester.pump(const Duration(days: 1));
    expect(attempts, 3, reason: 'exhaustion does not start a new loop');
    // A burst while the new attempt is connecting still has only one owner.
    for (var i = 0; i < 20; i++) {
      link.kick();
    }
    await tester.pump();
    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    expect(attempts, 6);
    expect(link.status.phase, HostLinkPhase.failed);
    await tester.pump(const Duration(days: 1));
    expect(attempts, 6);
  });

  testWidgets('actual credential rejection stays final across time and network kicks', (tester) async {
    var attempts = 0;
    final kicks = StreamController<void>.broadcast(sync: true);
    final link = SshHostLink(
      config: _config,
      loadSecrets: () async => _params.secrets,
      transportFactory: (params, verify) async {
        attempts++;
        throw DartSshTransport.describeSshError(SSHAuthFailError('All authentication methods failed'), params);
      },
      kicks: kicks.stream,
    );
    addTearDown(() async {
      await link.close();
      await kicks.close();
    });
    await expectLater(
      link.open(),
      throwsA(isA<HostLinkError>().having((error) => error.retryable, 'retryable', false)),
    );
    for (var i = 0; i < 20; i++) {
      kicks.add(null);
    }
    await tester.pump(const Duration(days: 1));
    expect(link.status.phase, HostLinkPhase.failed);
    expect(link.status.error?.kind, HostLinkErrorKind.authFailed);
    expect(attempts, 1);
  });

  testWidgets('closing during authentication ignores a late abort without retrying', (tester) async {
    final connecting = Completer<SshTransport>();
    var attempts = 0;
    final link = SshHostLink(
      config: _config,
      loadSecrets: () async => _params.secrets,
      transportFactory: (params, verify) {
        attempts++;
        return connecting.future;
      },
    );
    addTearDown(link.close);
    var ended = false;
    final opening = link.open().then<void>(
      (_) => fail('the link was closed before authentication completed'),
      onError: (Object _) {
        ended = true;
      },
    );
    await tester.pump();
    expect(attempts, 1);
    await link.close();
    connecting.completeError(
      DartSshTransport.describeSshError(SSHAuthAbortError('Connection closed before authentication'), _params),
    );
    await tester.pump(const Duration(days: 1));
    await opening;
    expect(ended, isTrue);
    expect(attempts, 1);
    expect(link.status.phase, HostLinkPhase.idle);
  });

  for (final kind in [
    HostLinkErrorKind.hostKeyMismatch,
    HostLinkErrorKind.hostKeyUnverified,
    HostLinkErrorKind.hostKeyRejected,
  ]) {
    testWidgets('$kind stays final after network kicks', (tester) async {
      final server = FakeSshServer();
      if (kind == HostLinkErrorKind.hostKeyMismatch) {
        server.hostKey = const PresentedHostKey('ssh-ed25519', 'SHA256:changed');
      }
      var prompts = 0;
      final link = SshHostLink(
        config: kind == HostLinkErrorKind.hostKeyMismatch ? _config : _config.copyWith(hostKeyFingerprint: () => null),
        loadSecrets: () async => _params.secrets,
        transportFactory: server.connect,
        promptHostKey: kind == HostLinkErrorKind.hostKeyRejected
            ? (_) async {
                prompts++;
                return false;
              }
            : null,
      );
      addTearDown(link.close);
      await expectLater(link.open(), throwsA(isA<HostLinkError>().having((error) => error.kind, 'kind', kind)));
      for (var i = 0; i < 20; i++) {
        link.kick();
      }
      await tester.pump(const Duration(days: 1));
      expect(server.connects, hasLength(1));
      expect(server.transports, isEmpty);
      expect(prompts, kind == HostLinkErrorKind.hostKeyRejected ? 1 : 0);
      expect(link.status.error?.kind, kind);
    });
  }

  test('a first connection carries on past a dropped authentication', () async {
    var attempts = 0;
    final link = SshHostLink(
      config: sampleSsh,
      loadSecrets: () async => const SshSecrets(password: 'pw'),
      transportFactory: (connect, _) async {
        attempts++;
        if (attempts == 1) {
          throw DartSshTransport.describeSshError(
            SSHAuthAbortError('Connection closed before authentication'),
            connect,
          );
        }
        return FakeTransport(FakeRemote());
      },
      connectClient: FakeConnector().call,
      backoff: Backoff(
        initial: const Duration(milliseconds: 10),
        max: const Duration(milliseconds: 40),
        maxAttempts: 5,
      ),
    );
    addTearDown(link.close);
    await link.open().timeout(const Duration(seconds: 5));
    expect(attempts, 2);
    expect(link.status.isConnected, isTrue);
  });
}
