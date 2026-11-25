import 'dart:async';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';

void main() {
  late FakeRemoteServer server;
  late FakeRemoteHost host;
  late RemoteAccount account;
  setUp(() async {
    server = await FakeRemoteServer.start();
    host = await FakeRemoteHost.start(server);
    account = RemoteAccount(secrets: MemorySecretStore(), serverUrl: server.url);
    await account.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
  });
  tearDown(() async {
    expect(server.protocolErrors, isEmpty);
    await account.close();
    await host.close();
    await server.close();
  });
  Future<DshClient> connect() async => account.connectHost((await account.listHosts()).single);

  test('old Host receives no new open field and keeps inline frames', () async {
    host.onOpen = (s) {
      s.push('inline');
      s.complete();
    };
    final client = await connect();
    expect(await client.mux.open('session/follow', const {}).items.toList(), ['inline']);
    expect(host.openedStreamParams.every((p) => !p.containsKey('transferFrames')), isTrue);
  });

  test('new Host chunked frame precedes the following inline frame and close', () async {
    host.capabilities.add('harness.remote.stream.transfer.v1');
    final large = 'x' * (5 * 1024 * 1024);
    host.onOpen = (s) {
      s.pushTransferred(large);
      s.push('after');
      s.complete();
    };
    final client = await connect();
    expect(await client.mux.open('session/follow', const {}).items.toList(), [large, 'after']);
    expect(host.openedStreamParams.every((p) => p['transferFrames'] == true), isTrue);
    expect(host.rpcMethods, contains('harness.remote.transfer.close'));
    expect(host.connections.values.every((c) => c.transfers.isEmpty), isTrue);
  });

  test('invalid transferred frame is refused and its Host allocation is released', () async {
    host.capabilities.add('harness.remote.stream.transfer.v1');
    host.onOpen = (s) => s.pushTransferred('bad', changeFrame: (frame) => {...frame, 'streamId': 'another-stream'});
    final client = await connect();
    await expectLater(
      client.mux.open('session/follow', const {}).items.drain<void>(),
      throwsA(isA<DshRemoteException>().having((e) => e.code, 'code', 'INVALID_MESSAGE')),
    );
    expect(host.connections.values.every((c) => c.transfers.isEmpty), isTrue);
  });

  test('oversized descriptor is refused before downloading any bytes', () async {
    host.capabilities.add('harness.remote.stream.transfer.v1');
    host.onOpen = (s) => s.pushTransferred('bad', changeDescriptor: (d) => {...d, 'totalBytes': 288 * 1024 * 1024 + 1});
    final client = await connect();
    await expectLater(
      client.mux.open('session/follow', const {}).items.drain<void>(),
      throwsA(isA<DshRemoteException>()),
    );
    expect(host.rpcMethods, isNot(contains('harness.remote.transfer.read')));
    expect(host.connections.values.every((c) => c.transfers.isEmpty), isTrue);
  });

  test('a malformed chunk releases the transfer without exposing a partial item', () async {
    host.capabilities.add('harness.remote.stream.transfer.v1');
    host.onOpen = (s) => s.pushTransferred('bad');
    host.transferRead = (chunk) async => {...chunk, 'data': '!'};
    final client = await connect();
    await expectLater(
      client.mux.open('session/follow', const {}).items.drain<void>(),
      throwsA(isA<DshRemoteException>()),
    );
    expect(host.connections.values.every((c) => c.transfers.isEmpty), isTrue);
  });

  test('cancellation during a chunk prevents further reads and releases allocation', () async {
    host.capabilities.add('harness.remote.stream.transfer.v1');
    host.onOpen = (s) => s.pushTransferred('x' * (1024 * 1024));
    final reading = Completer<void>();
    final release = Completer<void>();
    var reads = 0;
    host.transferRead = (chunk) async {
      reads++;
      if (!reading.isCompleted) reading.complete();
      await release.future;
      return chunk;
    };
    final client = await connect();
    final stream = client.mux.open('session/follow', const {});
    final values = <Object?>[];
    final sub = stream.items.listen(values.add);
    await reading.future.timeout(const Duration(seconds: 3));
    await sub.cancel();
    release.complete();
    final deadline = DateTime.now().add(const Duration(seconds: 3));
    while (host.connections.values.any((c) => c.transfers.isNotEmpty)) {
      if (DateTime.now().isAfter(deadline)) fail('transfer was not released');
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(reads, 1);
    expect(values, isEmpty);
  });

  test('unnegotiated transfer is never interpreted as a null inline value', () async {
    host.onOpen = (s) => s.pushTransferred('bad');
    final client = await connect();
    await expectLater(
      client.mux.open('session/follow', const {}).items.drain<void>(),
      throwsA(isA<DshRemoteException>()),
    );
    expect(host.rpcMethods, isNot(contains('harness.remote.transfer.read')));
  });
}
