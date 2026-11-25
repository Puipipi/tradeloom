// A Control frame this client cannot parse, or a protocol it does not speak,
// is final (no reconnect loop); a well-formed frame out of turn is not.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/src/transport/relay_transport.dart';
import 'package:dsh_remote/src/transport/transport.dart';
import 'package:test/test.dart';

String _frame(String type, Map<String, Object?> payload, {Object? v = 1}) => jsonEncode({
  'v': v,
  'id': 'f-$type',
  'type': type,
  'timestamp': DateTime.now().millisecondsSinceEpoch,
  'payload': payload,
});

Map<String, Object?> _ack({List<String>? capabilities = const ['transport.relay']}) => {
  'protocol': 1,
  'serverVersion': 'test',
  'connectionSessionId': 'cs1',
  'heartbeatIntervalMs': 25000,
  'maxControlFrameBytes': 65536,
  'maxRelayFrameBytes': 262144,
  'capabilities': ?capabilities,
};

/// A Control endpoint that answers `hello` with [replies].
Future<Uri> _server(List<String> replies, {required List<HttpServer> keep}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  keep.add(server);
  server.listen((request) async {
    final ws = await WebSocketTransformer.upgrade(request);
    ws.listen((data) {
      final frame = jsonDecode(data as String) as Map<String, Object?>;
      if (frame['type'] == 'hello') replies.forEach(ws.add);
    });
  });
  return Uri.parse('ws://127.0.0.1:${server.port}/ws/v1/connect');
}

Future<RemoteTransportException> _connectError(List<String> replies, List<HttpServer> keep) async {
  final url = await _server(replies, keep: keep);
  try {
    final transport = await RelayTransport.connect(
      url: url,
      deviceId: 'phone',
      accessToken: 'token',
      hostDeviceId: 'host',
      timeout: const Duration(seconds: 5),
    );
    await transport.close();
    fail('connected');
  } on RemoteTransportException catch (error) {
    return error;
  }
}

void main() {
  final servers = <HttpServer>[];
  tearDown(() async {
    for (final s in servers) {
      await s.close(force: true);
    }
    servers.clear();
  });

  test('a frame that is not JSON is final', () async {
    final error = await _connectError(['not json'], servers);
    expect(error.code, 'PROTOCOL_MISMATCH');
    expect(error.retryable, isFalse);
  });

  test('an unknown frame type is final', () async {
    final error = await _connectError([_frame('server.notice', {})], servers);
    expect(error.code, 'PROTOCOL_MISMATCH');
    expect(error.retryable, isFalse);
  });

  test('a newer Control protocol version is final', () async {
    final error = await _connectError([_frame('hello.ack', _ack(), v: 2)], servers);
    expect(error.code, 'UNSUPPORTED_VERSION');
    expect(error.retryable, isFalse);
  });

  test('a Server without the relay capability is final', () async {
    final error = await _connectError([_frame('hello.ack', _ack(capabilities: const []))], servers);
    expect(error.code, 'CAPABILITY_NOT_SUPPORTED');
    expect(error.retryable, isFalse);
  });

  test('a Server selecting a capability it was not offered is final', () async {
    final error = await _connectError([
      _frame('hello.ack', _ack(capabilities: const ['transport.relay', 'transport.webrtc'])),
    ], servers);
    expect(error.code, 'CAPABILITY_NOT_SUPPORTED');
    expect(error.retryable, isFalse);
  });

  test('a well-formed frame out of turn stays retryable', () async {
    final error = await _connectError([
      _frame('relay', {'connectionId': 'other', 'targetDeviceId': 'phone', 'counter': 0, 'ciphertext': 'AA'}),
    ], servers);
    expect(error.code, 'INVALID_MESSAGE');
    expect(error.retryable, isTrue);
  });

  test('a Host that is asleep is rejected as retryable', () async {
    final error = await _connectError([
      _frame('hello.ack', _ack()),
      _frame('connect.rejected', {'connectionId': 'c1', 'code': 'HOST_OFFLINE', 'message': 'Host is offline.'}),
    ], servers);
    expect(error.code, 'HOST_OFFLINE');
    expect(error.retryable, isTrue);
  });

  test('a Host refusing the connection is final', () async {
    final error = await _connectError([
      _frame('hello.ack', _ack()),
      _frame('connect.rejected', {'connectionId': 'c1'}),
    ], servers);
    expect(error.code, 'CONNECTION_REJECTED');
    expect(error.retryable, isFalse);
  });

  group('Relay node attach', () {
    /// Control answers hello with an assignment; the node answers
    /// `relay.attach` with [node] (or refuses the ticket when empty).
    Future<RemoteTransportException> attachError(List<String> node) async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      servers.add(server);
      server.listen((request) async {
        final ws = await WebSocketTransformer.upgrade(request);
        ws.listen((data) {
          final type = (jsonDecode(data as String) as Map<String, Object?>)['type'];
          if (type == 'relay.attach') {
            if (node.isEmpty) unawaited(ws.close(4001, 'RELAY_TICKET_INVALID'));
            node.forEach(ws.add);
          } else if (type == 'hello') {
            ws.add(_frame('hello.ack', _ack(capabilities: const ['transport.relay', 'transport.relay.attach'])));
          } else if (type == 'connect.request') {
            ws.add(
              _frame('connect.accepted', {
                'connectionId': 'c1',
                'relayEndpoint': 'ws://127.0.0.1:${server.port}/relay',
                'relayTicket': 'dshrt.payload.signature',
                'relayNodeId': 'relay-1',
                'relayEpoch': 4,
              }),
            );
          }
        });
      });
      try {
        final transport = await RelayTransport.connect(
          url: Uri.parse('ws://127.0.0.1:${server.port}/ws/v1/connect'),
          deviceId: 'phone',
          accessToken: 'token',
          hostDeviceId: 'host',
          timeout: const Duration(seconds: 5),
        );
        await transport.close();
        fail('connected');
      } on RemoteTransportException catch (error) {
        return error;
      }
    }

    test('a refused ticket stays retryable', () async {
      final error = await attachError(const []);
      expect(error.code, 'CONNECTION_FAILED');
      expect(error.retryable, isTrue);
    });

    test('relay.ready for another epoch stays retryable', () async {
      final error = await attachError([_frame('relay.ready', {'connectionId': 'c1', 'epoch': 5})]);
      expect(error.code, 'INVALID_MESSAGE');
      expect(error.retryable, isTrue);
    });

    test('a malformed Relay data frame is final', () async {
      final error = await attachError(['{"v":1,"v":1,"id":"r","type":"relay.ready","timestamp":1,"payload":{}}']);
      expect(error.code, 'PROTOCOL_MISMATCH');
      expect(error.retryable, isFalse);
    });
  });

  test('a dropped socket stays retryable', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    servers.add(server);
    server.listen((request) async {
      final ws = await WebSocketTransformer.upgrade(request);
      ws.listen((_) => unawaited(ws.close()));
    });
    try {
      await RelayTransport.connect(
        url: Uri.parse('ws://127.0.0.1:${server.port}/ws/v1/connect'),
        deviceId: 'phone',
        accessToken: 'token',
        hostDeviceId: 'host',
        timeout: const Duration(seconds: 5),
      );
      fail('connected');
    } on RemoteTransportException catch (error) {
      expect(error.retryable, isTrue);
    }
  });
}
