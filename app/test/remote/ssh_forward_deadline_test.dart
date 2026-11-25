import 'dart:async';
import 'dart:io';

import 'package:dsh_app/remote/ssh/local_forward.dart';
import 'package:dsh_app/remote/ssh/ssh_host_config.dart';
import 'package:dsh_app/remote/ssh/ssh_link.dart';
import 'package:dsh_app/remote/ssh/ssh_transport.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_ssh.dart';

class HeldForward extends FakeTransport {
  HeldForward(super.remote);

  final entered = Completer<void>();
  final release = Completer<TunnelChannel>();

  @override
  Future<TunnelChannel> openTunnel(String host, int port) {
    if (tunnels.isEmpty) return super.openTunnel(host, port);
    entered.complete();
    return release.future;
  }
}

void main() {
  for (final close in [false, true]) {
    test('${close ? 'close' : 'dropConnections'} closes accepted sockets still opening their channel', () async {
      final entered = Completer<void>();
      final release = Completer<TunnelChannel>();
      final forwarder = await LocalForwarder.bind(() {
        entered.complete();
        return release.future;
      });
      addTearDown(forwarder.close);
      final socket = await Socket.connect('127.0.0.1', forwarder.port);
      addTearDown(socket.destroy);
      final eof = socket.drain<void>();
      await entered.future;
      if (close) {
        await forwarder.close();
      } else {
        forwarder.dropConnections();
      }
      final channel = FakeChannel();
      try {
        await expectLater(eof.timeout(const Duration(seconds: 1)), completes);
      } finally {
        release.complete(channel);
        await Future<void>.delayed(Duration.zero);
      }
      expect(channel.destroyed, isTrue);
      expect(forwarder.activeConnections, 0);
    });
  }

  test('forwarded channel-open has a deadline and disposes its late success', () async {
    final transport = HeldForward(FakeRemote()..pid = 500);
    final connector = FakeConnector();
    final link = SshHostLink(
      config: sampleSsh,
      loadSecrets: () async => const SshSecrets(password: 'pw'),
      transportFactory: (_, _) async => transport,
      connectClient: connector.call,
      tunnelProbeTimeout: const Duration(milliseconds: 10),
      keepAliveInterval: const Duration(minutes: 1),
    );
    addTearDown(link.close);
    await link.open();
    final socket = await Socket.connect('127.0.0.1', link.localPort!);
    addTearDown(socket.destroy);
    final eof = socket.drain<void>();
    await transport.entered.future;
    final channel = FakeChannel();
    try {
      await expectLater(eof.timeout(const Duration(seconds: 1)), completes);
    } finally {
      transport.release.complete(channel);
      await Future<void>.delayed(Duration.zero);
    }
    expect(channel.destroyed, isTrue);
    expect(transport.isClosed, isFalse, reason: 'one channel failure does not close a healthy transport');
  });
}
