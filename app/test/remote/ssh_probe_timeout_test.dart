import 'dart:async';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/ssh/ssh_host_config.dart';
import 'package:dsh_app/remote/ssh/ssh_link.dart';
import 'package:dsh_app/remote/ssh/ssh_transport.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_ssh.dart';

class SilentProbeTransport extends FakeTransport {
  SilentProbeTransport(super.remote);

  final pending = Completer<TunnelChannel>();

  @override
  Future<TunnelChannel> openTunnel(String host, int port) => pending.future;
}

void main() {
  test('a silent first tunnel fails within its budget and destroys a late channel', () async {
    final transport = SilentProbeTransport(FakeRemote());
    final connector = FakeConnector();
    final link = SshHostLink(
      config: sampleSsh,
      loadSecrets: () async => const SshSecrets(password: 'pw'),
      transportFactory: (_, _) async => transport,
      connectClient: connector.call,
      tunnelProbeTimeout: const Duration(milliseconds: 10),
      retryFirstOpen: false,
    );
    addTearDown(link.close);
    await expectLater(
      link.open().timeout(const Duration(seconds: 2)),
      throwsA(
        isA<HostLinkError>()
            .having((error) => error.kind, 'kind', HostLinkErrorKind.tunnelFailed)
            .having((error) => error.retryable, 'retryable', isTrue),
      ),
    );
    expect(link.status.phase, HostLinkPhase.failed);
    expect(link.status.step, HostLinkStep.tunnel);
    expect(transport.isClosed, isTrue);
    expect(connector.calls, isEmpty);
    final late = FakeChannel();
    transport.pending.complete(late);
    await Future<void>.delayed(Duration.zero);
    expect(late.destroyed, isTrue);
  });

  test('a silent probe consumes the existing retry budget without restarting a live DSH', () async {
    final remote = FakeRemote()..pid = 500;
    final transports = <SilentProbeTransport>[];
    final link = SshHostLink(
      config: sampleSsh,
      loadSecrets: () async => const SshSecrets(password: 'pw'),
      transportFactory: (_, _) async {
        final transport = SilentProbeTransport(remote);
        transports.add(transport);
        return transport;
      },
      tunnelProbeTimeout: const Duration(milliseconds: 10),
      backoff: Backoff(initial: const Duration(milliseconds: 1), max: const Duration(milliseconds: 1), maxAttempts: 2),
    );
    addTearDown(link.close);
    await expectLater(link.open().timeout(const Duration(seconds: 2)), throwsA(isA<HostLinkError>()));
    expect(transports, hasLength(3));
    expect(transports.every((transport) => transport.isClosed), isTrue);
    expect(remote.launches, 0);
    expect(link.status.phase, HostLinkPhase.failed);
    for (final transport in transports) {
      transport.pending.completeError(StateError('late transport failure'));
    }
    await Future<void>.delayed(Duration.zero);
  });
}
