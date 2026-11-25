// Conformance: fixtures/protocol-v1 is copied verbatim from ds-harness-remote
// `fixtures/protocol/v1` (MIT, synthetic data).
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dsh_remote/src/protocol/control.dart';
import 'package:dsh_remote/src/protocol/messages.dart';
import 'package:dsh_remote/src/server/server_api.dart';
import 'package:test/test.dart';

List<Map<String, Object?>> _cases(String path) {
  final json = jsonDecode(File('test/fixtures/protocol-v1/$path').readAsStringSync()) as Map<String, Object?>;
  return (json['cases']! as List).map((c) => (c as Map).cast<String, Object?>()).toList();
}

bool _accepts(void Function() action) {
  try {
    action();
    return true;
  } on ProtocolError {
    return false;
  }
}

ControlFrameLimits _limits(Object? raw) {
  final map = (raw as Map?)?.cast<String, Object?>() ?? const {};
  return ControlFrameLimits(
    maxControlFrameBytes: map['maxControlFrameBytes'] as int?,
    maxRelayFrameBytes: map['maxRelayFrameBytes'] as int?,
  );
}

void main() {
  test('fixture manifest format', () {
    final manifest = jsonDecode(File('test/fixtures/protocol-v1/manifest.json').readAsStringSync()) as Map;
    expect(manifest['fixtureFormatVersion'], 1);
  });

  group('control frame conformance', () {
    for (final file in [
      'control/envelope.json',
      'control/hello.json',
      'control/connect.json',
      'control/handshake.json',
      'control/relay.json',
      'control/errors.json',
      'control/limits.json',
    ]) {
      for (final c in _cases(file)) {
        final expected = (c['expect']! as Map)['accepted'] as bool;
        test('$file ${c['name']}', () {
          final input = c['input'];
          switch (c['operation']) {
            case 'parseControlFrame':
              expect(_accepts(() => parseControlFrame(input)), expected);
              final value = (c['expect']! as Map)['value'];
              if (value != null) expect(parseControlFrame(input).toJson(), value);
            case 'encodeControlFrameWithLimits':
              final map = (input! as Map).cast<String, Object?>();
              expect(
                _accepts(() {
                  final frame = parseControlFrame(map['frame']);
                  encodeControlFrame(frame, _limits(map['limits']));
                }),
                expected,
              );
            case 'decodeControlFrameWithLimits':
              final map = (input! as Map).cast<String, Object?>();
              expect(_accepts(() => decodeControlFrame(map['data']! as String, _limits(map['limits']))), expected);
            case 'parseRpcErrorPayload':
              expect(_accepts(() => RpcErrorPayload.parse(input)), expected);
            default:
              fail('unhandled operation ${c['operation']}');
          }
        });
      }
    }
  });

  group('capability negotiation conformance', () {
    for (final c in _cases('negotiation/capabilities.json')) {
      test(c['name'], () {
        final input = (c['input']! as Map).cast<String, Object?>();
        final expect_ = (c['expect']! as Map).cast<String, Object?>();
        List<String> strings(Object? v) => (v! as List).cast<String>();
        switch (c['operation']) {
          case 'selectProtocolVersion':
            expect(
              selectProtocolVersion((input['offered']! as List).cast<int>(), (input['supported']! as List).cast<int>()),
              expect_['selected'],
            );
          case 'selectCapabilities':
            expect(selectCapabilities(strings(input['offered']), strings(input['supported'])), expect_['value']);
          case 'acceptNegotiatedCapabilities':
            final negotiated = input['negotiated'] == null ? null : strings(input['negotiated']);
            final accepted = _accepts(() => acceptNegotiatedCapabilities(strings(input['offered']), negotiated));
            expect(accepted, expect_['accepted']);
            if (accepted) {
              expect(acceptNegotiatedCapabilities(strings(input['offered']), negotiated), expect_['value']);
            }
          default:
            fail('unhandled operation ${c['operation']}');
        }
      });
    }
  });

  group('account authorization conformance (client-relevant subset)', () {
    for (final c in _cases('account/authorization.json')) {
      final op = c['operation'];
      if (op != 'parseDeviceTokenPair' && op != 'parseDeviceRegistrationRequest') continue;
      test(c['name'], () {
        final expected = (c['expect']! as Map)['accepted'] as bool;
        bool accepted;
        try {
          if (op == 'parseDeviceTokenPair') {
            DeviceTokenPair.parse(c['input']);
          } else {
            final input = (c['input']! as Map).cast<String, Object?>();
            if (input['v'] != 1 || input.keys.any((k) => k != 'v' && k != 'device')) {
              throw const FormatException();
            }
            final d = (input['device']! as Map).cast<String, Object?>();
            const allowed = {'deviceId', 'name', 'role', 'platform', 'identityKey', 'clientVersion', 'harnessVersion'};
            if (d.keys.any((k) => !allowed.contains(k))) throw const FormatException();
            if (d['role'] == 'client' && d.containsKey('harnessVersion')) {
              throw const FormatException();
            }
            DeviceDescriptor(
              deviceId: d['deviceId']! as String,
              name: d['name']! as String,
              role: d['role']! as String,
              platform: d['platform']! as String,
              identityKey: d['identityKey']! as String,
              clientVersion: d['clientVersion']! as String,
            ).validate();
          }
          accepted = true;
        } on Object {
          accepted = false;
        }
        expect(accepted, expected);
      });
    }
  });

  group('wire JSON (upstream wire-json.test.ts)', () {
    test('duplicate keys are rejected in Control frames and Remote messages', () {
      final control = jsonEncode(ControlFrame('ping', {'nonce': 'nonce'}).toJson());
      final remote = jsonEncode(RemoteMessage.rpcRequest('harness.transport.describe', <String, Object?>{}).toJson());
      RemoteMessage decodeRemote(String text) => RemoteMessage.decode(utf8.encode(text));
      for (final duplicate in [
        control.replaceFirst('"id":', '"id":"other","id":'),
        control.replaceFirst('"nonce":', '"nonce":"other","nonce":'),
        control.replaceFirst('"nonce":', r'"nonce":"other","nonce":'),
      ]) {
        expect(() => decodeControlFrame(duplicate), throwsA(isA<ProtocolError>()), reason: duplicate);
      }
      expect(
        () => decodeRemote(remote.replaceFirst('"method":', '"method":"other","method":')),
        throwsA(isA<ProtocolError>()),
      );
      expect(
        () => decodeRemote(remote.replaceFirst('"params":{}', '"params":{"outer":{"id":1,"id":2}}')),
        throwsA(isA<ProtocolError>()),
      );
      expect(decodeControlFrame(control).type, 'ping');
      final separate = RemoteMessage.rpcRequest('harness.transport.describe', {
        'left': {'id': 1},
        'right': {'id': 2},
        'list': [
          {'id': 1},
          {'id': 2},
        ],
      });
      expect(decodeRemote(jsonEncode(separate.toJson())).type, 'rpc.request');
      expect(() => RemoteMessage.decode([0x22, 0xc0, 0xaf, 0x22]), throwsA(isA<ProtocolError>()));
    });

    test('Relay data envelopes are bounded and strict', () {
      final relay = encodeRelayDataFrame(
        ControlFrame('relay', {
          'connectionId': 'connection-1',
          'targetDeviceId': 'host-1',
          'counter': 0,
          'ciphertext': 'AQ',
        }),
      );
      expect(decodeRelayDataFrame(relay).type, 'relay');
      expect(decodeRelayDataFrame(encodeRelayDataFrame(ControlFrame('relay.ready', {'epoch': 4}))).type, 'relay.ready');
      for (final invalid in [
        relay.replaceFirst('"id":', '"id":"other","id":'),
        relay.replaceFirst('"counter":0', '"counter":1,"counter":0'),
        relay.replaceFirst('"payload":', '"extra":true,"payload":'),
        relay.replaceFirst('"type":"relay"', '"type":""'),
        relay.replaceFirst('"v":1', '"v":2'),
      ]) {
        expect(() => decodeRelayDataFrame(invalid), throwsA(isA<ProtocolError>()), reason: invalid);
      }
      final oversized = '{"v":1,"id":"x","type":"relay","timestamp":1,"payload":${' ' * maxRelayFrameBytes}}';
      expect(
        () => decodeRelayDataFrame(oversized),
        throwsA(isA<ProtocolError>().having((e) => e.code, 'code', 'FRAME_TOO_LARGE')),
      );
      expect(
        () => decodeRelayDataFrame(relay, ControlFrameLimits(maxRelayFrameBytes: relay.length - 1)),
        throwsA(isA<ProtocolError>().having((e) => e.code, 'code', 'FRAME_TOO_LARGE')),
      );
    });

    test('capability lists are bounded', () {
      Map<String, Object?> hello(int count) => {
        'v': 1,
        'id': 'h',
        'type': 'hello',
        'timestamp': 1786000000000,
        'payload': {
          'role': 'client',
          'deviceId': 'client-1',
          'accessToken': 'token-1',
          'protocols': [1],
          'capabilities': [for (var i = 0; i < count; i++) 'cap.$i'],
        },
      };
      expect(parseControlFrame(hello(maxRemoteCapabilityEntries)).type, 'hello');
      expect(() => parseControlFrame(hello(maxRemoteCapabilityEntries + 1)), throwsA(isA<ProtocolError>()));
    });
  });

  group('DSHF secure fragments', () {
    Uint8List bytes(int n) => Uint8List.fromList(List<int>.generate(n, (i) => (i * 7) & 0xff));

    test('small messages pass through, large ones round-trip in 48 KiB fragments', () {
      final codec = SecureMessageCodec();
      final small = bytes(secureFragmentChunkBytes);
      expect(codec.encode(small).single, same(small));
      final big = bytes(secureFragmentChunkBytes * 3 + 5);
      final fragments = codec.encode(big);
      expect(fragments, hasLength(4));
      expect(ascii.decode(fragments.first.sublist(0, 4)), 'DSHF');
      expect(fragments.first.length, 17 + secureFragmentChunkBytes);
      expect(fragments.last.length, 17 + 5);
      final receiver = SecureMessageCodec();
      expect(receiver.decode(fragments[0]), isNull);
      expect(receiver.decode(fragments[1]), isNull);
      expect(receiver.decode(fragments[2]), isNull);
      expect(receiver.decode(fragments[3]), big);
    });

    test('limits, duplicates and reordering are rejected', () {
      final codec = SecureMessageCodec();
      expect(() => codec.encode(Uint8List(maxSecureMessageBytes + 1)), throwsA(isA<ProtocolError>()));
      final fragments = codec.encode(bytes(secureFragmentChunkBytes * 2 + 1));
      final receiver = SecureMessageCodec();
      expect(() => receiver.decode(fragments[1]), throwsA(isA<ProtocolError>()), reason: 'starts mid-message');
      final again = SecureMessageCodec();
      again.decode(fragments[0]);
      expect(() => again.decode(fragments[0]), throwsA(isA<ProtocolError>()), reason: 'duplicate');
      final tampered = Uint8List.fromList(fragments[0]);
      tampered[16] ^= 0x01; // totalBytes no longer matches total
      expect(() => SecureMessageCodec().decode(tampered), throwsA(isA<ProtocolError>()));
    });

    test('remote messages decode strictly', () {
      final message = RemoteMessage.rpcRequest('harness.transport.describe', const <String, Object?>{});
      final decoded = RemoteMessage.decode(message.encode());
      expect(decoded.type, 'rpc.request');
      expect((decoded.payload! as Map)['method'], 'harness.transport.describe');
      expect(
        () => RemoteMessage.decode(utf8.encode('{"v":1,"id":"x","type":"hello","timestamp":1,"payload":{}}')),
        throwsA(isA<ProtocolError>()),
      );
      expect(() => RemoteMessage.decode([0xff, 0xfe]), throwsA(isA<ProtocolError>()));
    });
  });

  group('server url', () {
    test('normalizes origins and refuses plain HTTP to public hosts', () {
      expect(normalizeServerUrl('dsh.r2049.cn/').toString(), 'https://dsh.r2049.cn');
      expect(normalizeServerUrl('http://127.0.0.1:8080').toString(), 'http://127.0.0.1:8080');
      expect(() => normalizeServerUrl('http://example.com'), throwsArgumentError);
      expect(() => normalizeServerUrl('https://example.com/app'), throwsArgumentError);
      expect(
        controlSocketUrl(normalizeServerUrl('https://dsh.r2049.cn')).toString(),
        'wss://dsh.r2049.cn/ws/v1/connect',
      );
    });
  });
}
