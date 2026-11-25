import 'dart:async';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/ssh/remote_shell.dart';
import 'package:dsh_app/remote/ssh/ssh_host_config.dart';
import 'package:dsh_app/remote/ssh/ssh_link.dart';
import 'package:dsh_app/remote/ssh/ssh_transport.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_ssh.dart';

Future<Object?> outcome(Future<DshClient> future) =>
    future.then<Object?>((client) => client, onError: (Object error) => error);

class HeldBootstrap extends FakeTransport {
  HeldBootstrap(super.remote);

  final entered = Completer<void>();
  final release = Completer<void>();

  @override
  Future<RemoteExecResult> run(String script, {Duration timeout = const Duration(seconds: 30)}) async {
    if (!entered.isCompleted) {
      entered.complete();
      await release.future;
    }
    return super.run(script, timeout: timeout);
  }

  @override
  Future<TunnelChannel> openTunnel(String host, int port) async {
    tunnels.add((host, port));
    throw StateError('Stop the test before a local listener can be created');
  }
}

class HeldProbe extends FakeTransport {
  HeldProbe(super.remote);

  final entered = Completer<void>();
  final release = Completer<TunnelChannel>();

  @override
  Future<TunnelChannel> openTunnel(String host, int port) {
    entered.complete();
    return release.future;
  }
}

class TrackedClient extends DshClient {
  TrackedClient() : super(DshConnection(Uri.parse('http://127.0.0.1:9')));

  bool closed = false;

  @override
  Future<void> close() async {
    closed = true;
    await super.close();
  }
}

void main() {
  test('closing while secrets load does not begin a new SSH connection', () async {
    final secrets = Completer<SshSecrets>();
    final server = FakeSshServer();
    final link = SshHostLink(config: sampleSsh, loadSecrets: () => secrets.future, transportFactory: server.connect);
    addTearDown(link.close);
    final opening = outcome(link.open());
    await link.close();
    secrets.complete(const SshSecrets(password: 'pw'));
    expect(await opening, isNot(isA<DshClient>()));
    expect(server.connects, isEmpty);
  });

  test('closing during a trust prompt cannot pin a late acceptance', () async {
    final prompted = Completer<void>();
    final accepted = Completer<bool>();
    final server = FakeSshServer();
    var pins = 0;
    final link = SshHostLink(
      config: sampleSsh.copyWith(hostKeyFingerprint: () => null),
      loadSecrets: () async => const SshSecrets(password: 'pw'),
      transportFactory: server.connect,
      promptHostKey: (_) {
        prompted.complete();
        return accepted.future;
      },
      pinHostKey: (_) async => pins++,
    );
    addTearDown(link.close);
    final opening = outcome(link.open());
    await prompted.future;
    await link.close();
    accepted.complete(true);
    expect(await opening, isNot(isA<DshClient>()));
    expect(pins, 0);
    expect(server.transports, isEmpty);
  });

  test('closing during bootstrap owns and closes the authenticated transport', () async {
    final transport = HeldBootstrap(FakeRemote()..pid = 500);
    final link = SshHostLink(
      config: sampleSsh,
      loadSecrets: () async => const SshSecrets(password: 'pw'),
      transportFactory: (_, _) async => transport,
      retryFirstOpen: false,
    );
    addTearDown(link.close);
    final opening = outcome(link.open());
    await transport.entered.future;
    await link.close();
    final closedBeforeRelease = transport.isClosed;
    transport.release.complete();
    expect(await opening, isNot(isA<DshClient>()));
    expect(closedBeforeRelease, isTrue);
    expect(transport.tunnels, isEmpty);
    expect(link.localPort, isNull);
    expect(link.status.phase, HostLinkPhase.idle);
  });

  test('a late probe cannot create a listener or begin login after close', () async {
    final transport = HeldProbe(FakeRemote()..pid = 500);
    var logins = 0;
    final link = SshHostLink(
      config: sampleSsh,
      loadSecrets: () async => const SshSecrets(password: 'pw'),
      transportFactory: (_, _) async => transport,
      connectClient: ({required baseUri, required token, required hostHeader}) async {
        logins++;
        throw StateError('Unexpected login after cancellation');
      },
      retryFirstOpen: false,
    );
    addTearDown(link.close);
    final opening = outcome(link.open());
    await transport.entered.future;
    await link.close();
    final channel = FakeChannel();
    transport.release.complete(channel);
    expect(await opening, isNot(isA<DshClient>()));
    expect(channel.destroyed, isTrue);
    expect(logins, 0);
    expect(link.localPort, isNull);
    expect(link.status.phase, HostLinkPhase.idle);
  });

  test('a client returned after close is disposed and never published', () async {
    final entered = Completer<void>();
    final release = Completer<DshClient>();
    final transport = FakeTransport(FakeRemote()..pid = 500);
    final client = TrackedClient();
    addTearDown(client.close);
    final link = SshHostLink(
      config: sampleSsh,
      loadSecrets: () async => const SshSecrets(password: 'pw'),
      transportFactory: (_, _) async => transport,
      connectClient: ({required baseUri, required token, required hostHeader}) {
        entered.complete();
        return release.future;
      },
      retryFirstOpen: false,
    );
    addTearDown(link.close);
    final opening = outcome(link.open());
    await entered.future;
    await link.close();
    release.complete(client);
    final result = await opening;
    expect(client.closed, isTrue);
    expect(result, isNot(isA<DshClient>()));
    expect(link.currentClient, isNull);
    expect(link.localPort, isNull);
    expect(link.status.phase, HostLinkPhase.idle);
  });
}
