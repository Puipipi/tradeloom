import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

String _frame(String type, Map<String, Object?> payload) =>
    jsonEncode({'v': 1, 'id': 'test-$type', 'type': type, 'timestamp': 1, 'payload': payload});

class EncodingHost {
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
      prologue: createNoisePrologue('connection-570', 'host', 'phone'),
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
                'connectionSessionId': 'cs570',
                'heartbeatIntervalMs': 25000,
                'maxControlFrameBytes': 65536,
                'maxRelayFrameBytes': 262144,
                'capabilities': ['transport.relay'],
              }),
            );
          case 'connect.request':
            socket.add(_frame('connect.accepted', {'connectionId': 'connection-570'}));
          case 'secure.handshake':
            peer.readHandshake(base64Url.decode(base64Url.normalize(p['data'] as String)));
            socket.add(
              _frame('secure.handshake', {
                'connectionId': 'connection-570',
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
        'connectionId': 'connection-570',
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
