// The dsh_remote adapter's failure mapping, and RelayHostLink following the
// relay client's own reconnect states.

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/relay/dsh_remote_backend.dart';
import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:dsh_remote/dsh_remote.dart' as remote;
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_relay.dart';
import 'support/wait.dart';

/// Lets a test push relay states after the connect resolved.
class _StatefulRelay extends FakeRelayBackend {
  _StatefulRelay() : super(user: sampleRelayUser);

  RelayStateCallback? onState;
  int connects = 0;

  @override
  Future<DshClient> connectHost(RelayHost host, {RelayStateCallback? onState}) async {
    this.onState = onState;
    connects++;
    return super.connectHost(host, onState: onState);
  }
}

void main() {
  group('failure mapping', () {
    HostLinkError map(String code, {bool retryable = false}) =>
        DshRemoteRelayBackend.describe(remote.RemoteFailure(code, 'x', retryable: retryable), '家里的 Mac');

    test('offline host is retryable and says what to check', () {
      final e = map('HOST_OFFLINE');
      expect(e.kind, HostLinkErrorKind.hostOffline);
      expect(e.retryable, isTrue);
      expect(e.message, '主机现在不在线');
    });

    test('changed identity fails closed', () {
      final e = map('PEER_IDENTITY_MISMATCH');
      expect(e.kind, HostLinkErrorKind.hostKeyMismatch);
      expect(e.retryable, isFalse);
    });

    test('expired sign-in asks to log in again', () {
      expect(map('ACCOUNT_AUTH_REQUIRED').kind, HostLinkErrorKind.notLoggedIn);
      expect(map('DEVICE_REVOKED').kind, HostLinkErrorKind.notLoggedIn);
    });

    test('a protocol or version mismatch stops with what to update', () {
      for (final code in ['PROTOCOL_MISMATCH', 'FRAME_TOO_LARGE']) {
        final e = map(code);
        expect(e.retryable, isFalse, reason: code);
        expect(e.message, '版本不匹配，请更新 DSH Go 和主机上的远程插件');
        expect(e.detail, contains(code));
      }
      // Explicit incompatibility is final even when the transport called it retryable.
      for (final code in ['PROTOCOL_MISMATCH', 'UNSUPPORTED_VERSION', 'CAPABILITY_NOT_SUPPORTED']) {
        final e = map(code, retryable: true);
        expect(e.retryable, isFalse, reason: code);
        expect(e.message, '版本不匹配，请更新 DSH Go 和主机上的远程插件');
      }
      final host = map('HARNESS_VERSION_INCOMPATIBLE', retryable: true);
      expect(host.retryable, isFalse);
      expect(host.message, '主机上的 DSH 或远程插件需要更新');
    });

    test('a retryable malformed frame (a reconnect race) reads as a connection problem', () {
      final e = map('INVALID_MESSAGE', retryable: true);
      expect(e.kind, HostLinkErrorKind.unreachable);
      expect(e.retryable, isTrue);
      expect(e.message, isNot(contains('版本')));
    });

    test('a reply that was not JSON (a captive portal) is not blamed on versions', () {
      final e = map('INVALID_MESSAGE');
      expect(e.retryable, isFalse);
      expect(e.message, '远程连接失败');
    });

    test('unknown transient codes stay retryable network errors', () {
      final e = map('SECURE_CHANNEL_FAILED', retryable: true);
      expect(e.kind, HostLinkErrorKind.unreachable);
      expect(e.retryable, isTrue);
      expect(e.detail, contains('SECURE_CHANNEL_FAILED'));
    });
  });

  group('DshRemoteRelayBackend', () {
    test('server addresses normalize to an origin; bad ones explain themselves', () {
      expect(DshRemoteRelayBackend.normalizeServer('remote.example.com/'), 'https://remote.example.com');
      expect(DshRemoteRelayBackend.normalizeServer('http://192.168.1.5:8080'), 'http://192.168.1.5:8080');
      expect(() => DshRemoteRelayBackend.normalizeServer('http://example.com'), throwsA(isA<HostLinkError>()));
      expect(() => DshRemoteRelayBackend.normalizeServer('https://x.com/path'), throwsA(isA<HostLinkError>()));
    });

    test('first-use trust pins only the fingerprint the person confirmed', () {
      final backend = DshRemoteRelayBackend(secrets: MemorySecretStore());
      addTearDown(backend.close);
      expect(backend.approves('mac', '3F2A 9C41 07BE'), isFalse);
      backend.approveHost(sampleRelayHosts.first);
      expect(backend.approves('mac', '3F2A 9C41 07BE'), isTrue);
      expect(backend.approves('mac', '0000 0000 0000'), isFalse, reason: 'key swapped after the prompt');
      expect(backend.approves('mac', null), isFalse);
      expect(backend.serverLabel, 'dsh.r2049.cn');
    });
  });

  group('RelayHostLink', () {
    late _StatefulRelay relay;
    late RelayHostLink link;

    setUp(() {
      relay = _StatefulRelay();
      link = RelayHostLink(
        backend: relay,
        hostId: 'mac',
        resolveHost: () async => sampleRelayHosts.first,
        backoff: Backoff(initial: const Duration(milliseconds: 5), maxAttempts: 2),
      );
    });

    tearDown(() => link.close());

    test('connects, then mirrors the client\'s own reconnects', () async {
      final steps = <HostLinkStep>{};
      link.statuses.listen((s) {
        if (s.step != null) steps.add(s.step!);
      });
      await link.open();
      expect(link.status.isConnected, isTrue);
      expect(steps, containsAll([HostLinkStep.connect, HostLinkStep.login]));

      relay.onState!(
        RelayConnectionState.reconnecting,
        const HostLinkError(HostLinkErrorKind.unreachable, 'x', retryable: true),
      );
      expect(link.status.phase, HostLinkPhase.reconnecting);
      expect(link.status.attempt, 1);
      relay.onState!(RelayConnectionState.connected, null);
      expect(link.status.isConnected, isTrue);
      expect(relay.connects, 1, reason: 'the relay client reconnects by itself');
    });

    test('a terminal failure stops; 重新连接 restarts the same client in place', () async {
      final first = await link.open();
      final published = <DshClient>[];
      link.clients.listen(published.add);
      relay.onState!(RelayConnectionState.failed, const HostLinkError(HostLinkErrorKind.other, 'replaced'));
      expect(link.status.phase, HostLinkPhase.failed);
      link.retry();
      expect(relay.reconnected, [first], reason: 'client.remoteCarrier.reconnect()');
      expect(link.status.phase, HostLinkPhase.reconnecting);
      relay.onState!(RelayConnectionState.connected, null);
      expect(link.status.isConnected, isTrue);
      expect(relay.connects, 1);
      expect(published, isEmpty);
    });

    test('kick skips a new attempt backoff after closing the previous client', () async {
      final first = await link.open();
      relay.onState!(
        RelayConnectionState.failed,
        const HostLinkError(HostLinkErrorKind.unreachable, '断开', retryable: true),
      );
      relay.connectErrors.add(const HostLinkError(HostLinkErrorKind.unreachable, '暂时不可用', retryable: true));
      final backingOff = nextStatus(link, (s) => s.phase == HostLinkPhase.reconnecting, what: '新连接退避');
      final opening = link.open();
      await backingOff;
      expect(relay.closedClients, contains(first));
      link.kick();
      expect(await opening, isNot(same(first)));
      expect(relay.connects, 3);
    });

    test('kick restarts after the retry budget was exhausted', () async {
      relay.connectErrors.addAll(
        List.filled(3, const HostLinkError(HostLinkErrorKind.unreachable, '暂时不可用', retryable: true)),
      );
      await expectLater(link.open(), throwsA(isA<HostLinkError>()));
      expect(link.status.phase, HostLinkPhase.failed);
      final connected = nextStatus(link, (s) => s.isConnected, what: '手动重连成功');
      link.kick();
      await connected;
      expect(relay.connects, 4);
    });

    test('old disconnected callbacks are ignored; current disconnect becomes idle', () async {
      await link.open();
      final stale = relay.onState!;
      stale(RelayConnectionState.failed, const HostLinkError(HostLinkErrorKind.other, '停止'));
      final published = link.clients.first;
      final second = await link.open();
      expect(await published, same(second));
      stale(RelayConnectionState.disconnected, null);
      expect(link.status.isConnected, isTrue);
      relay.onState!(RelayConnectionState.disconnected, null);
      expect(link.status.phase, HostLinkPhase.idle);
      expect(link.currentClient, isNull);
    });

    test('a connected kick probes the tunnel', () async {
      await link.open();
      link.kick();
      expect(relay.probes, 1);
    });

    test('a version mismatch fails at once; a network change leaves it, 重试 tries again', () async {
      final mismatch = DshRemoteRelayBackend.describe(
        const remote.RemoteFailure('PROTOCOL_MISMATCH', 'Unknown Control frame type.', retryable: false),
      );
      relay.connectErrors.add(mismatch);
      await expectLater(link.open(), throwsA(isA<HostLinkError>()));
      expect(link.status.phase, HostLinkPhase.failed);
      expect(link.status.error?.message, '版本不匹配，请更新 DSH Go 和主机上的远程插件');
      expect(relay.connects, 1, reason: 'no backoff loop');
      link.kick();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(relay.connects, 1, reason: 'a network change does not fix a version mismatch');
      final connected = nextStatus(link, (s) => s.isConnected, what: '手动重试');
      link.retry();
      await connected;
      expect(relay.connects, 2);
    });

    test('a dropped connection still retries on its own', () async {
      relay.connectErrors.add(const HostLinkError(HostLinkErrorKind.unreachable, '暂时不可用', retryable: true));
      final connected = nextStatus(link, (s) => s.isConnected, what: '自动重连');
      await link.open();
      await connected;
      expect(relay.connects, 2);
    });

    test('offline host: retries, then fails with the reason', () async {
      final offline = RelayHostLink(
        backend: relay,
        hostId: 'nas',
        resolveHost: () async => sampleRelayHosts.last,
        backoff: Backoff(initial: const Duration(milliseconds: 5), maxAttempts: 2),
      );
      addTearDown(offline.close);
      await expectLater(offline.open(), throwsA(isA<HostLinkError>()));
      expect(offline.status.phase, HostLinkPhase.failed);
      expect(offline.status.error?.kind, HostLinkErrorKind.hostOffline);
      expect(relay.connected, isEmpty);
    });
  });
}
