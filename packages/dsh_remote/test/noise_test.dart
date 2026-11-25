// Golden vectors: fixtures/noise-ik.json is copied verbatim from
// ds-harness-remote `fixtures/crypto/v1/noise-ik.json` (MIT, synthetic keys).
import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/src/crypto/noise_ik.dart';
import 'package:dsh_remote/src/util/bytes.dart';
import 'package:test/test.dart';

Map<String, Object?> _vector() {
  final json = jsonDecode(File('test/fixtures/noise-ik.json').readAsStringSync()) as Map<String, Object?>;
  expect(json['suite'], noiseIkProtocol);
  expect(json['fixtureFormatVersion'], 1);
  return ((json['vectors']! as List).single as Map).cast<String, Object?>();
}

Map<String, Object?> _m(Object? value) => (value! as Map).cast<String, Object?>();

void main() {
  group('Noise IK golden vectors (fixtures/crypto/v1)', () {
    late Map<String, Object?> vector;
    late NoiseIkSession initiator;
    late NoiseIkSession responder;

    setUp(() {
      vector = _vector();
      final statics = _m(vector['staticKeys']);
      final ini = _m(statics['initiator']);
      final res = _m(statics['responder']);
      final eph = _m(vector['ephemeralPrivateKeys']);
      final prologue = _m(vector['prologue']);
      final bytes = createNoisePrologue(
        prologue['connectionId']! as String,
        prologue['hostDeviceId']! as String,
        prologue['clientDeviceId']! as String,
      );
      expect(toBase64Url(bytes), prologue['bytes']);
      initiator = NoiseIkSession(
        role: NoiseRole.initiator,
        localPrivateKey: ini['privateKey']! as String,
        localPublicKey: ini['publicKey']! as String,
        remotePublicKey: res['publicKey']! as String,
        prologue: bytes,
        ephemeralPrivateKey: fromBase64Url(eph['initiator']! as String),
      );
      responder = NoiseIkSession(
        role: NoiseRole.responder,
        localPrivateKey: res['privateKey']! as String,
        localPublicKey: res['publicKey']! as String,
        remotePublicKey: ini['publicKey']! as String,
        prologue: bytes,
        ephemeralPrivateKey: fromBase64Url(eph['responder']! as String),
      );
    });

    test('static public keys derive from the private keys', () {
      final statics = _m(vector['staticKeys']);
      for (final side in ['initiator', 'responder']) {
        final pair = _m(statics[side]);
        final derived = X25519KeyPair.fromPrivateKey(fromBase64Url(pair['privateKey']! as String));
        expect(derived.publicKeyBase64Url, pair['publicKey'], reason: side);
      }
    });

    test('handshake and transport reproduce every byte and counter', () {
      final handshake = _m(vector['handshake']);
      final m1 = _m(handshake['message1']);
      final m2 = _m(handshake['message2']);

      expect(initiator.canWriteHandshake, isTrue);
      expect(responder.canWriteHandshake, isFalse);
      final message1 = initiator.writeHandshake(fromBase64Url(m1['payload']! as String));
      expect(toBase64Url(message1), m1['message'], reason: 'message1');
      expect(toBase64Url(responder.readHandshake(message1)), m1['payload']);

      final message2 = responder.writeHandshake(fromBase64Url(m2['payload']! as String));
      expect(toBase64Url(message2), m2['message'], reason: 'message2');
      expect(responder.complete, isTrue);
      expect(toBase64Url(initiator.readHandshake(message2)), m2['payload']);
      expect(initiator.complete, isTrue);

      void expectCounters(Map<String, Object?> counters) {
        expect('${initiator.sendingCounter}', counters['initiatorSending']);
        expect('${initiator.receivingCounter}', counters['initiatorReceiving']);
        expect('${responder.sendingCounter}', counters['responderSending']);
        expect('${responder.receivingCounter}', counters['responderReceiving']);
      }

      expectCounters(_m(vector['countersAfterHandshake']));
      for (final raw in vector['transport']! as List) {
        final step = _m(raw);
        final plaintext = fromBase64Url(step['plaintext']! as String);
        final (sender, receiver) = step['sender'] == 'initiator' ? (initiator, responder) : (responder, initiator);
        final ciphertext = sender.encrypt(plaintext);
        expect(toBase64Url(ciphertext), step['ciphertext'], reason: 'transport ${step['plaintext']}');
        expect(receiver.decrypt(ciphertext), plaintext);
        expectCounters(_m(step['countersAfter']));
      }
    });

    test('responder rejects an initiator whose static key is not pinned', () {
      final statics = _m(vector['staticKeys']);
      final res = _m(statics['responder']);
      final stranger = X25519KeyPair.generate();
      final impostor = NoiseIkSession(
        role: NoiseRole.initiator,
        localPrivateKey: stranger.privateKeyBase64Url,
        localPublicKey: stranger.publicKeyBase64Url,
        remotePublicKey: res['publicKey']! as String,
        prologue: createNoisePrologue('noise-vector-connection', 'noise-vector-host', 'noise-vector-client'),
      );
      expect(
        () => responder.readHandshake(impostor.writeHandshake()),
        throwsA(isA<NoiseSessionError>().having((e) => e.code, 'code', 'PEER_IDENTITY_MISMATCH')),
      );
      expect(responder.isDestroyed, isTrue);
    });

    test('initiator rejects a responder holding a different static key', () {
      final statics = _m(vector['staticKeys']);
      final ini = _m(statics['initiator']);
      final rogue = X25519KeyPair.generate();
      final message1 = initiator.writeHandshake();
      // The rogue cannot even read message 1 (es/ss use the pinned key), so
      // it answers with its own fresh session to the pinned static key.
      final rogueSide = NoiseIkSession(
        role: NoiseRole.responder,
        localPrivateKey: rogue.privateKeyBase64Url,
        localPublicKey: rogue.publicKeyBase64Url,
        remotePublicKey: ini['publicKey']! as String,
        prologue: createNoisePrologue('noise-vector-connection', 'noise-vector-host', 'noise-vector-client'),
      );
      expect(() => rogueSide.readHandshake(message1), throwsA(isA<NoiseSessionError>()));
    });

    test('a different prologue (connection binding) fails authentication', () {
      final statics = _m(vector['staticKeys']);
      final ini = _m(statics['initiator']);
      final res = _m(statics['responder']);
      final other = NoiseIkSession(
        role: NoiseRole.responder,
        localPrivateKey: res['privateKey']! as String,
        localPublicKey: res['publicKey']! as String,
        remotePublicKey: ini['publicKey']! as String,
        prologue: createNoisePrologue('another-connection', 'noise-vector-host', 'noise-vector-client'),
      );
      expect(
        () => other.readHandshake(initiator.writeHandshake()),
        throwsA(isA<NoiseSessionError>().having((e) => e.code, 'code', 'NOISE_DECRYPT_FAILED')),
      );
    });

    test('replayed, reordered and tampered transport messages fail closed', () {
      responder.readHandshake(initiator.writeHandshake());
      initiator.readHandshake(responder.writeHandshake());
      final a = initiator.encrypt(utf8.encode('first'));
      final b = initiator.encrypt(utf8.encode('second'));
      expect(utf8.decode(responder.decrypt(a)), 'first');
      // Replay of `a` after it was consumed.
      expect(
        () => responder.decrypt(a),
        throwsA(isA<NoiseSessionError>().having((e) => e.code, 'code', 'NOISE_DECRYPT_FAILED')),
      );
      expect(responder.isDestroyed, isTrue);
      expect(
        () => responder.decrypt(b),
        throwsA(isA<NoiseSessionError>().having((e) => e.code, 'code', 'NOISE_DESTROYED')),
      );
    });

    test('handshake order is enforced', () {
      expect(
        () => responder.writeHandshake(),
        throwsA(isA<NoiseSessionError>().having((e) => e.code, 'code', 'NOISE_HANDSHAKE_ORDER')),
      );
      expect(
        () => initiator.encrypt([1]),
        throwsA(isA<NoiseSessionError>().having((e) => e.code, 'code', 'NOISE_NOT_READY')),
      );
    });
  });

  group('Noise IK random sessions', () {
    (NoiseIkSession, NoiseIkSession) pair() {
      final client = X25519KeyPair.generate();
      final host = X25519KeyPair.generate();
      final prologue = createNoisePrologue('c', 'h', 'k');
      final initiator = NoiseIkSession(
        role: NoiseRole.initiator,
        localPrivateKey: client.privateKeyBase64Url,
        localPublicKey: client.publicKeyBase64Url,
        remotePublicKey: host.publicKeyBase64Url,
        prologue: prologue,
      );
      final responder = NoiseIkSession(
        role: NoiseRole.responder,
        localPrivateKey: host.privateKeyBase64Url,
        localPublicKey: host.publicKeyBase64Url,
        remotePublicKey: client.publicKeyBase64Url,
        prologue: prologue,
      );
      responder.readHandshake(initiator.writeHandshake());
      initiator.readHandshake(responder.writeHandshake());
      return (initiator, responder);
    }

    test('reordered messages are rejected', () {
      final (initiator, responder) = pair();
      initiator.encrypt([1]);
      final second = initiator.encrypt([2]);
      expect(() => responder.decrypt(second), throwsA(isA<NoiseSessionError>()));
    });

    test('a flipped bit is rejected', () {
      final (initiator, responder) = pair();
      final message = initiator.encrypt(utf8.encode('payload'));
      message[3] ^= 0x01;
      expect(() => responder.decrypt(message), throwsA(isA<NoiseSessionError>()));
    });

    test('maximum-size transport message round-trips', () {
      final (initiator, responder) = pair();
      final big = List<int>.generate(65535 - 16, (i) => i & 0xff);
      expect(responder.decrypt(initiator.encrypt(big)), big);
      expect(() => initiator.encrypt(List<int>.filled(65535 - 15, 0)), throwsA(isA<NoiseSessionError>()));
    });

    test('fingerprint is the first 6 SHA-256 bytes in upper-case hex', () {
      // sha256(32 zero bytes) = 66687aadf862bd776c8fc18b8e9f8e20...
      expect(identityFingerprint(toBase64Url(List<int>.filled(32, 0))), '66687AADF862');
      expect(formatFingerprint('66687AADF862'), '6668 7AAD F862');
    });
  });
}
