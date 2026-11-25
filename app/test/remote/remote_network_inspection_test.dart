import 'dart:async';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_relay.dart';

class _Backend extends FakeRelayBackend implements RelayNetworkBackend {
  _Backend() : super(user: sampleRelayUser);
  final pending = Completer<RemoteNetworkStatus?>();
  int inspections = 0;
  RelayStateCallback? stateChanged;
  @override
  Future<DshClient> connectHost(RelayHost host, {RelayStateCallback? onState}) {
    stateChanged = onState;
    return super.connectHost(host, onState: onState);
  }

  @override
  RemoteNetworkStatus? networkOf(DshClient client) => const RemoteNetworkStatus(path: RelayPath.p2p);
  @override
  Future<RemoteNetworkStatus?> inspectNetwork(DshClient client) {
    inspections++;
    return pending.future;
  }
}

void main() {
  test('network diagnostic reasons never export arbitrary exception text', () {
    expect(const RemoteNetworkStatus(fallbackReason: 'token=private candidate address').safeFallbackReason, 'unknown');
    expect(const RemoteNetworkStatus(fallbackReason: 'directTimeout').safeFallbackReason, 'directTimeout');
    expect(const RemoteNetworkStatus().safeFallbackReason, isNull);
  });
  Future<RelayHostLink> open(_Backend backend) async {
    final link = RelayHostLink(backend: backend, hostId: 'mac', resolveHost: () async => sampleRelayHosts.first);
    addTearDown(link.close);
    await link.open();
    return link;
  }

  test('network measurements are explicit, deduplicated, and update actual path', () async {
    final backend = _Backend();
    final link = await open(backend);
    expect(backend.inspections, 0);
    final first = link.inspectNetwork();
    final second = link.inspectNetwork();
    expect(identical(first, second), isTrue);
    expect(backend.inspections, 1);
    const value = RemoteNetworkStatus(path: RelayPath.turn, roundTripTime: Duration(milliseconds: 37));
    backend.pending.complete(value);
    expect(await first, same(value));
    expect(link.status.network, same(value));
    expect(link.status.path, RelayPath.turn);
    expect(link.status.phase, HostLinkPhase.connected);
  });

  test('late measurement cannot cross a reconnect even when the client is reused', () async {
    final backend = _Backend();
    final link = await open(backend);
    final client = link.currentClient;
    final result = link.inspectNetwork();
    backend.pending.complete(
      const RemoteNetworkStatus(path: RelayPath.turn, roundTripTime: Duration(milliseconds: 99)),
    );
    backend.stateChanged!(RelayConnectionState.reconnecting, null);
    backend.stateChanged!(RelayConnectionState.connected, null);
    expect(await result, isNull);
    expect(link.currentClient, same(client));
    expect(link.status.network?.roundTripTime, isNull);
  });

  test('an inspection finishing after close cannot revive a connection', () async {
    final backend = _Backend();
    final link = await open(backend);
    final result = link.inspectNetwork();
    await link.close();
    backend.pending.complete(const RemoteNetworkStatus(path: RelayPath.turn));
    expect(await result, isNull);
    expect(await link.inspectNetwork(), isNull);
    expect(backend.inspections, 1);
  });

  test('measurement failure keeps the authenticated connection healthy', () async {
    final backend = _Backend();
    final link = await open(backend);
    final result = link.inspectNetwork();
    backend.pending.completeError(StateError('private candidate address'));
    expect(await result, isNull);
    expect(link.status.phase, HostLinkPhase.connected);
    expect(link.status.error, isNull);
  });
}
