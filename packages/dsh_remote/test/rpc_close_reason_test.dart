import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

String _frame(String type, Map<String, Object?> payload) =>
    jsonEncode({'v': 1, 'id': 'test-$type', 'type': type, 'timestamp': 1, 'payload': payload});

class _Fixture {
  final clientKey = X25519KeyPair.generate();
  final hostKey = X25519KeyPair.generate();
  late final NoiseIkSession peer;
  late final HttpServer server;
  late final WebSocket socket;
  late final SecureChannel channel;
  late final RemoteRpcClient rpc;
  final request = Completer<RemoteMessage>();
  final incoming = SecureMessageCodec();
  final streamDone = Completer<void>();
  final observations = <({bool rpcClosed, bool channelClosed, String? code})>[];
  final events = <String>[];
  Future<void> start() async {
    peer = NoiseIkSession(
      role: NoiseRole.responder,
      localPrivateKey: hostKey.privateKeyBase64Url,
      localPublicKey: hostKey.publicKeyBase64Url,
      remotePublicKey: clientKey.publicKeyBase64Url,
      prologue: createNoisePrologue('connection-568', 'host', 'phone'),
    );
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      socket = await WebSocketTransformer.upgrade(req);
      socket.listen((raw) {
        final input = jsonDecode(raw as String) as Map<String, dynamic>;
        final p = input['payload'] as Map<String, dynamic>;
        switch (input['type']) {
          case 'hello':
            socket.add(
              _frame('hello.ack', {
                'protocol': 1,
                'serverVersion': 'test',
                'connectionSessionId': 'cs568',
                'heartbeatIntervalMs': 25000,
                'maxControlFrameBytes': 65536,
                'maxRelayFrameBytes': 262144,
                'capabilities': ['transport.relay'],
              }),
            );
          case 'connect.request':
            socket.add(_frame('connect.accepted', {'connectionId': 'connection-568'}));
          case 'secure.handshake':
            peer.readHandshake(base64Url.decode(base64Url.normalize(p['data'] as String)));
            socket.add(
              _frame('secure.handshake', {
                'connectionId': 'connection-568',
                'sourceDeviceId': 'host',
                'targetDeviceId': 'phone',
                'step': 2,
                'data': base64Url.encode(peer.writeHandshake()).replaceAll('=', ''),
              }),
            );
          case 'relay':
            expect(p['counter'], peer.receivingCounter);
            final bytes = incoming.decode(
              peer.decrypt(base64Url.decode(base64Url.normalize(p['ciphertext'] as String))),
            );
            if (bytes != null && !request.isCompleted) request.complete(RemoteMessage.decode(bytes));
        }
      });
    });
    final transport = await RelayTransport.connect(
      url: Uri.parse('ws://127.0.0.1:${server.port}/ws/v1/connect'),
      deviceId: 'phone',
      accessToken: 'test-token',
      hostDeviceId: 'host',
    );
    channel = await SecureChannel.establish(
      transport: transport,
      clientDeviceId: 'phone',
      clientPrivateKey: clientKey.privateKeyBase64Url,
      clientPublicKey: clientKey.publicKeyBase64Url,
      hostDeviceId: 'host',
      hostIdentityKey: hostKey.publicKeyBase64Url,
    );
    rpc = RemoteRpcClient(channel);
    rpc.events.listen(
      (event) => events.add(event.event),
      onDone: () {
        observations.add((rpcClosed: rpc.isClosed, channelClosed: channel.isClosed, code: channel.closedReason?.code));
        streamDone.complete();
      },
    );
  }

  void sendBytes(Uint8List bytes) {
    final counter = peer.sendingCounter;
    socket.add(
      _frame('relay', {
        'connectionId': 'connection-568',
        'sourceDeviceId': 'host',
        'targetDeviceId': 'phone',
        'counter': counter,
        'ciphertext': base64Url.encode(peer.encrypt(bytes)).replaceAll('=', ''),
      }),
    );
  }

  Future<void> close() async {
    await rpc.close();
    await socket.close();
    await server.close(force: true);
    peer.destroy();
    clientKey.destroy();
    hostKey.destroy();
  }
}

void main() {
  late _Fixture f;
  setUp(() async {
    f = _Fixture();
    await f.start();
  });
  tearDown(() async => f.close());
  final malformed = <String, Uint8List>{
    'unknown type': RemoteMessage('not-a-message', {}).encode(),
    'bad JSON': utf8.encode('{broken'),
    'invalid UTF8': Uint8List.fromList([0xc3, 0x28]),
    'missing id': utf8.encode(jsonEncode({'v': 1, 'type': 'event', 'timestamp': 1, 'payload': {}})),
  };
  for (final entry in malformed.entries) {
    test('${entry.key} keeps protocol failure through channel close', () async {
      final pending = f.rpc.call('pending', {}).then<Object?>((v) => v, onError: (Object e) => e);
      await f.request.future;
      f.sendBytes(entry.value);
      final reason = await f.rpc.done;
      final error = await pending;
      await f.streamDone.future;
      expect(reason.code, 'SECURE_CHANNEL_FAILED');
      expect(reason.retryable, isTrue);
      await expectLater(
        f.channel.send(Uint8List(0)),
        throwsA(isA<SecureChannelException>().having((e) => e.code, 'closed send code', 'SECURE_CHANNEL_FAILED')),
      );
      expect(
        error,
        isA<RemoteRpcException>()
            .having((e) => e.code, 'code', 'TRANSPORT_CLOSED')
            .having((e) => e.isLocal, 'local', true)
            .having((e) => e.retryable, 'retryable', true),
      );
      expect(f.observations, [(rpcClosed: true, channelClosed: true, code: 'SECURE_CHANNEL_FAILED')]);
      expect(f.events, isEmpty);
      await f.rpc.close();
      expect(await f.rpc.done, same(reason));
      expect(f.observations, hasLength(1));
    });
  }
  test('explicit local close keeps CLIENT_CLOSED and closes before onDone', () async {
    final pending = f.rpc.call('pending', {}).then<Object?>((v) => v, onError: (Object e) => e);
    await f.request.future;
    await f.rpc.close();
    final reason = await f.rpc.done;
    await f.streamDone.future;
    expect(reason.code, 'CLIENT_CLOSED');
    expect(reason.retryable, isFalse);
    expect(
      await pending,
      isA<RemoteRpcException>()
          .having((e) => e.code, 'code', 'CLIENT_CLOSED')
          .having((e) => e.retryable, 'retryable', false),
    );
    expect(f.observations, [(rpcClosed: true, channelClosed: true, code: 'CLIENT_CLOSED')]);
  });
  test('valid response and event remain usable before explicit close', () async {
    final pending = f.rpc.call('valid', {});
    final request = await f.request.future;
    f.sendBytes(RemoteMessage('event', {'event': 'ready', 'data': 1}).encode());
    f.sendBytes(RemoteMessage('rpc.response', {'requestId': request.id, 'result': 'ok'}).encode());
    expect(await pending, 'ok');
    expect(f.events, ['ready']);
    expect(f.rpc.isClosed, isFalse);
    expect(f.channel.isClosed, isFalse);
    await f.rpc.close();
    await f.streamDone.future;
    expect((await f.rpc.done).code, 'CLIENT_CLOSED');
  });
  test('Host terminal error keeps its original failure and retry class', () async {
    final pending = f.rpc.call('pending', {}).then<Object?>((v) => v, onError: (Object e) => e);
    await f.request.future;
    f.socket.add(
      _frame('error', {
        'connectionId': 'connection-568',
        'code': 'HOST_OFFLINE',
        'message': 'offline',
        'retryable': true,
      }),
    );
    final reason = await f.rpc.done;
    await f.streamDone.future;
    expect(reason.code, 'HOST_OFFLINE');
    expect(reason.retryable, isTrue);
    expect(await pending, isA<RemoteRpcException>().having((e) => e.code, 'code', 'TRANSPORT_CLOSED'));
    expect(f.observations, [(rpcClosed: true, channelClosed: true, code: 'HOST_OFFLINE')]);
  });
}
