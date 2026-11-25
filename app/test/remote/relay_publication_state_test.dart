import 'dart:async';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_relay.dart';

class _PublishingRelay extends FakeRelayBackend {
  _PublishingRelay() : super(user: sampleRelayUser);

  final created = Completer<DshClient>();
  final result = Completer<DshClient>();
  RelayStateCallback? stateChanged;

  @override
  Future<DshClient> connectHost(RelayHost host, {RelayStateCallback? onState}) async {
    stateChanged = onState;
    final client = await super.connectHost(host, onState: onState);
    onState?.call(RelayConnectionState.connected, null);
    created.complete(client);
    return result.future;
  }
}

void main() {
  const lost = HostLinkError(HostLinkErrorKind.unreachable, 'connection lost', retryable: true);
  const refused = HostLinkError(HostLinkErrorKind.hostKeyMismatch, 'identity changed');
  final cases = [
    (RelayConnectionState.reconnecting, HostLinkPhase.reconnecting, lost),
    (RelayConnectionState.failed, HostLinkPhase.failed, refused),
    (RelayConnectionState.disconnected, HostLinkPhase.idle, null),
  ];

  for (final (event, phase, error) in cases) {
    test('ready result cannot overwrite $event before client publication', () async {
      final backend = _PublishingRelay();
      final link = RelayHostLink(backend: backend, hostId: 'mac', resolveHost: () async => sampleRelayHosts.first);
      addTearDown(link.close);
      final statuses = <HostLinkStatus>[];
      final subscription = link.statuses.listen(statuses.add);
      addTearDown(subscription.cancel);
      final opening = link.open();
      final client = await backend.created.future;
      addTearDown(client.close);

      // The backend was ready, but its live state advances before the
      // Future continuation in RelayHostLink can publish the client.
      backend.result.complete(client);
      backend.stateChanged!(event, error);
      expect(await opening, same(client));

      expect(link.status.phase, phase);
      expect(link.status.error, same(error));
      expect(link.currentClient, isNull);
      expect(statuses.where((status) => status.isConnected), isEmpty);
      if (event == RelayConnectionState.reconnecting) {
        expect(link.status.attempt, 1);
        backend.stateChanged!(RelayConnectionState.connected, null);
        expect(link.currentClient, same(client));
        expect(link.status.error, isNull);
      } else if (event == RelayConnectionState.failed) {
        link.kick();
        expect(backend.probes, 0, reason: 'network changes do not clear a terminal refusal');
        expect(backend.reconnected, isEmpty);
        link.retry();
        expect(backend.reconnected, [client], reason: 'explicit retry retains the same client contract');
      }
    });
  }

  test('a recovery before publication supersedes an earlier reconnecting event', () async {
    final backend = _PublishingRelay();
    final link = RelayHostLink(backend: backend, hostId: 'mac', resolveHost: () async => sampleRelayHosts.first);
    addTearDown(link.close);
    final opening = link.open();
    final client = await backend.created.future;
    backend.result.complete(client);
    backend.stateChanged!(RelayConnectionState.reconnecting, lost);
    backend.stateChanged!(RelayConnectionState.connected, null);
    expect(await opening, same(client));
    expect(link.status.phase, HostLinkPhase.connected);
    expect(link.status.error, isNull);
    expect(link.currentClient, same(client));
  });
}
