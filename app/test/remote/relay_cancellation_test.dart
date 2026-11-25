import 'dart:async';

import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_relay.dart';

class HeldRelay extends FakeRelayBackend {
  final entered = Completer<void>();
  final release = Completer<void>();

  @override
  Future<DshClient> connectHost(RelayHost host, {RelayStateCallback? onState}) async {
    entered.complete();
    await release.future;
    return super.connectHost(host, onState: onState);
  }
}

void main() {
  test('closing while host presence is pending cannot begin a relay connection', () async {
    final presence = Completer<RelayHost?>();
    final relay = FakeRelayBackend(user: sampleRelayUser);
    final link = RelayHostLink(backend: relay, hostId: 'mac', resolveHost: () => presence.future);
    addTearDown(link.close);
    final opening = link.open().then<Object?>((client) => client, onError: (Object error) => error);
    await link.close();
    presence.complete(sampleRelayHosts.first);
    expect(await opening, isNot(isA<DshClient>()));
    expect(relay.connected, isEmpty);
  });

  test('a relay client returned after cancellation is still closed', () async {
    final relay = HeldRelay();
    final link = RelayHostLink(backend: relay, hostId: 'mac', resolveHost: () async => sampleRelayHosts.first);
    addTearDown(link.close);
    final opening = link.open().then<Object?>((client) => client, onError: (Object error) => error);
    await relay.entered.future;
    await link.close();
    relay.release.complete();
    expect(await opening, isNot(isA<DshClient>()));
    expect(relay.closedClients, hasLength(1));
    expect(link.currentClient, isNull);
  });
}
