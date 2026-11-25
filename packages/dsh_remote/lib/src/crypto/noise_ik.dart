// SPDX-FileCopyrightText: 2026 DSH Remote contributors
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.
// Noise_IK_25519_ChaChaPoly_SHA256 for ds-harness-remote. The IK state machine
// (Noise Protocol Framework revision 34) is our own implementation, written
// with the upstream author's agreement; it must reproduce the upstream golden
// vectors byte for byte (test/noise_test.dart).
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as hashes;
import 'package:cryptography/cryptography.dart'
    show KeyPairType, Mac, SecretBox, SecretBoxAuthenticationError, SecretKeyData, SimpleKeyPairData, SimplePublicKey;
import 'package:cryptography/dart.dart' show DartChacha20, DartX25519;

import '../util/bytes.dart';

const String noiseIkProtocol = 'Noise_IK_25519_ChaChaPoly_SHA256';

/// Noise transport messages are capped at 65535 bytes including the tag.
const int maxNoiseMessageBytes = 65535;
const int _tagBytes = 16;
const int _dhLen = 32;

class NoiseSessionError implements Exception {
  const NoiseSessionError(this.code, this.message);

  /// `INVALID_KEY`, `NOISE_HANDSHAKE_ORDER`, `NOISE_ALREADY_READY`,
  /// `NOISE_NOT_READY`, `NOISE_DESTROYED`, `NOISE_DECRYPT_FAILED`,
  /// `NOISE_MESSAGE_INVALID`, `NOISE_NONCE_EXHAUSTED`,
  /// `PEER_IDENTITY_MISMATCH`.
  final String code;
  final String message;

  @override
  String toString() => 'NoiseSessionError($code): $message';
}

// ---------------------------------------------------------------------------
// X25519

const DartX25519 _x25519 = DartX25519();

final Uint8List _basePoint = () {
  final point = Uint8List(32);
  point[0] = 9;
  return point;
}();

/// Raw X25519 key pair. [privateKey] is stored as generated (unclamped);
/// clamping happens inside the scalar multiplication.
class X25519KeyPair {
  X25519KeyPair._(this.privateKey, this.publicKey);

  factory X25519KeyPair.fromPrivateKey(List<int> privateKey) {
    if (privateKey.length != 32) {
      throw const NoiseSessionError('INVALID_KEY', 'X25519 private keys must be 32 bytes.');
    }
    final private = Uint8List.fromList(privateKey);
    return X25519KeyPair._(private, x25519(private, _basePoint, allowZero: true));
  }

  factory X25519KeyPair.generate() => X25519KeyPair.fromPrivateKey(randomBytes(32));

  final Uint8List privateKey;
  final Uint8List publicKey;

  String get publicKeyBase64Url => toBase64Url(publicKey);
  String get privateKeyBase64Url => toBase64Url(privateKey);

  void destroy() => privateKey.fillRange(0, privateKey.length, 0);
}

/// X25519(k, u). Rejects an all-zero result (low-order peer point) unless
/// [allowZero].
Uint8List x25519(List<int> privateKey, List<int> publicKey, {bool allowZero = false}) {
  if (privateKey.length != 32 || publicKey.length != 32) {
    throw const NoiseSessionError('INVALID_KEY', 'X25519 keys must be 32 bytes.');
  }
  final secret = _x25519.sharedSecretSync(
    keyPairData: SimpleKeyPairData(
      privateKey,
      publicKey: SimplePublicKey(_basePoint, type: KeyPairType.x25519),
      type: KeyPairType.x25519,
    ),
    remotePublicKey: SimplePublicKey(publicKey, type: KeyPairType.x25519),
  );
  final bytes = Uint8List.fromList((secret as SecretKeyData).bytes);
  if (!allowZero && bytes.every((b) => b == 0)) {
    throw const NoiseSessionError('INVALID_KEY', 'X25519 produced a low-order shared secret.');
  }
  return bytes;
}

/// Display fingerprint of an identity key: first 6 bytes of SHA-256 as 12
/// upper-case hex digits (upstream `identityFingerprint`).
String identityFingerprint(String publicKeyBase64Url) {
  final digest = hashes.sha256.convert(fromBase64Url(publicKeyBase64Url)).bytes;
  return digest.sublist(0, 6).map((b) => b.toRadixString(16).padLeft(2, '0')).join().toUpperCase();
}

/// Same fingerprint grouped for reading aloud: `ABCD EF01 2345`.
String formatFingerprint(String fingerprint) =>
    RegExp(r'.{1,4}').allMatches(fingerprint).map((m) => m.group(0)).join(' ');

// ---------------------------------------------------------------------------
// Noise primitives (Noise spec §4-§5)

Uint8List _hash(List<int> data) => Uint8List.fromList(hashes.sha256.convert(data).bytes);

Uint8List _hmac(List<int> key, List<int> data) =>
    Uint8List.fromList(hashes.Hmac(hashes.sha256, key).convert(data).bytes);

/// HKDF(chaining_key, input_key_material, 2) from Noise §4.3.
(Uint8List, Uint8List) _hkdf2(List<int> chainingKey, List<int> inputKeyMaterial) {
  final tempKey = _hmac(chainingKey, inputKeyMaterial);
  final output1 = _hmac(tempKey, const [0x01]);
  final output2 = _hmac(tempKey, [...output1, 0x02]);
  return (output1, output2);
}

const DartChacha20 _aead = DartChacha20.poly1305Aead();

/// Highest nonce used before the session must be rebuilt (2^64-1 is
/// reserved by Noise; Dart ints are 64-bit signed, so stop well before).
const int _maxNonce = 0x3fffffffffffffff;

class _CipherState {
  _CipherState([this._key]);

  Uint8List? _key;
  int nonce = 0;

  bool get hasKey => _key != null;

  void initializeKey(Uint8List key) {
    _key = key;
    nonce = 0;
  }

  static List<int> _nonceBytes(int n) {
    final out = Uint8List(12);
    final view = ByteData.sublistView(out);
    view.setUint32(4, n & 0xffffffff, Endian.little);
    view.setUint32(8, (n >> 32) & 0xffffffff, Endian.little);
    return out;
  }

  Uint8List encryptWithAd(List<int> ad, List<int> plaintext) {
    final key = _key;
    if (key == null) return Uint8List.fromList(plaintext);
    if (nonce >= _maxNonce) {
      throw const NoiseSessionError('NOISE_NONCE_EXHAUSTED', 'The Noise nonce space is exhausted.');
    }
    final box = _aead.encryptSync(plaintext, secretKey: SecretKeyData(key), nonce: _nonceBytes(nonce), aad: ad);
    nonce++;
    return concatBytes([box.cipherText, box.mac.bytes]);
  }

  Uint8List decryptWithAd(List<int> ad, List<int> ciphertext) {
    final key = _key;
    if (key == null) return Uint8List.fromList(ciphertext);
    if (ciphertext.length < _tagBytes) {
      throw const NoiseSessionError('NOISE_MESSAGE_INVALID', 'Noise ciphertext is shorter than its tag.');
    }
    if (nonce >= _maxNonce) {
      throw const NoiseSessionError('NOISE_NONCE_EXHAUSTED', 'The Noise nonce space is exhausted.');
    }
    final split = ciphertext.length - _tagBytes;
    final List<int> plaintext;
    try {
      plaintext = _aead.decryptSync(
        SecretBox(ciphertext.sublist(0, split), nonce: _nonceBytes(nonce), mac: Mac(ciphertext.sublist(split))),
        secretKey: SecretKeyData(key),
        aad: ad,
      );
    } on SecretBoxAuthenticationError {
      throw const NoiseSessionError('NOISE_DECRYPT_FAILED', 'Noise message authentication failed.');
    }
    nonce++;
    return Uint8List.fromList(plaintext);
  }

  void destroy() {
    _key?.fillRange(0, _key!.length, 0);
    _key = null;
  }
}

class _SymmetricState {
  _SymmetricState(String protocolName) {
    final name = utf8.encode(protocolName);
    if (name.length <= 32) {
      _h = Uint8List(32)..setRange(0, name.length, name);
    } else {
      _h = _hash(name);
    }
    _ck = Uint8List.fromList(_h);
  }

  late Uint8List _ck;
  late Uint8List _h;
  final _CipherState _cipher = _CipherState();

  void mixKey(List<int> inputKeyMaterial) {
    final (ck, tempKey) = _hkdf2(_ck, inputKeyMaterial);
    _ck = ck;
    _cipher.initializeKey(tempKey);
  }

  void mixHash(List<int> data) => _h = _hash([..._h, ...data]);

  Uint8List encryptAndHash(List<int> plaintext) {
    final ciphertext = _cipher.encryptWithAd(_h, plaintext);
    mixHash(ciphertext);
    return ciphertext;
  }

  Uint8List decryptAndHash(List<int> ciphertext) {
    final plaintext = _cipher.decryptWithAd(_h, ciphertext);
    mixHash(ciphertext);
    return plaintext;
  }

  (_CipherState, _CipherState) split() {
    final (k1, k2) = _hkdf2(_ck, const []);
    return (_CipherState(k1), _CipherState(k2));
  }

  void destroy() {
    _ck.fillRange(0, _ck.length, 0);
    _cipher.destroy();
  }
}

// ---------------------------------------------------------------------------
// IK handshake + transport

enum NoiseRole { initiator, responder }

/// A narrow DSH Remote Noise session: only the fixed v1 IK suite, and the
/// remote static key must equal the locally pinned one before transport
/// messages can be used.
///
/// IK pattern:
/// ```text
/// <- s
/// ...
/// -> e, es, s, ss
/// <- e, ee, se
/// ```
/// The client is the initiator, the Host the responder; both handshake
/// payloads are empty in production.
class NoiseIkSession {
  NoiseIkSession({
    required this.role,
    required String localPrivateKey,
    required String localPublicKey,
    required String remotePublicKey,
    required List<int> prologue,
    List<int>? ephemeralPrivateKey,
  }) : _expectedRemoteStatic = _requireKey(remotePublicKey, 'remote public key'),
       _ephemeralSeed = ephemeralPrivateKey == null ? null : Uint8List.fromList(ephemeralPrivateKey) {
    final private = _requireKey(localPrivateKey, 'local private key');
    final public = _requireKey(localPublicKey, 'local public key');
    _static = X25519KeyPair.fromPrivateKey(private);
    if (!constantTimeEquals(_static.publicKey, public)) {
      throw const NoiseSessionError('INVALID_KEY', 'The local public key does not match the private key.');
    }
    _symmetric.mixHash(prologue);
    // Pre-message `<- s`: the responder's static key is known to both sides.
    _symmetric.mixHash(role == NoiseRole.initiator ? _expectedRemoteStatic : _static.publicKey);
  }

  final NoiseRole role;
  final Uint8List _expectedRemoteStatic;
  final Uint8List? _ephemeralSeed;
  late final X25519KeyPair _static;
  final _SymmetricState _symmetric = _SymmetricState(noiseIkProtocol);
  X25519KeyPair? _ephemeral;
  Uint8List? _remoteEphemeral;
  Uint8List? _remoteStatic;
  int _messageIndex = 0;
  _CipherState? _send;
  _CipherState? _receive;
  bool _destroyed = false;

  String get protocol => noiseIkProtocol;

  bool get complete => _send != null;

  bool get isDestroyed => _destroyed;

  /// Whether the next handshake step is ours to write.
  bool get canWriteHandshake {
    _assertLive();
    return !complete && _isWriteTurn;
  }

  bool get _isWriteTurn => (_messageIndex == 0) == (role == NoiseRole.initiator);

  /// Writes the next handshake message (message 1 for the initiator,
  /// message 2 for the responder).
  Uint8List writeHandshake([List<int> payload = const []]) {
    _assertHandshake(reading: false);
    try {
      final out = BytesBuilder(copy: false);
      final ephemeral = _ephemeral = _ephemeralSeed == null
          ? X25519KeyPair.generate()
          : X25519KeyPair.fromPrivateKey(_ephemeralSeed);
      out.add(ephemeral.publicKey);
      _symmetric.mixHash(ephemeral.publicKey);
      if (role == NoiseRole.initiator) {
        // -> e, es, s, ss
        _symmetric.mixKey(x25519(ephemeral.privateKey, _expectedRemoteStatic));
        out.add(_symmetric.encryptAndHash(_static.publicKey));
        _symmetric.mixKey(x25519(_static.privateKey, _expectedRemoteStatic));
      } else {
        // <- e, ee, se
        _symmetric.mixKey(x25519(ephemeral.privateKey, _remoteEphemeral!));
        _symmetric.mixKey(x25519(ephemeral.privateKey, _remoteStatic!));
      }
      out.add(_symmetric.encryptAndHash(payload));
      final message = out.takeBytes();
      if (message.length > maxNoiseMessageBytes) {
        throw const NoiseSessionError('NOISE_MESSAGE_INVALID', 'Noise handshake message is too large.');
      }
      _messageIndex++;
      _finishIfReady();
      return message;
    } on Object {
      destroy();
      rethrow;
    }
  }

  /// Reads the peer's handshake message and returns its payload.
  Uint8List readHandshake(List<int> message) {
    _assertHandshake(reading: true);
    try {
      if (message.length > maxNoiseMessageBytes) {
        throw const NoiseSessionError('NOISE_MESSAGE_INVALID', 'Noise handshake message is too large.');
      }
      final minimum = role == NoiseRole.responder ? _dhLen + _dhLen + _tagBytes + _tagBytes : _dhLen + _tagBytes;
      if (message.length < minimum) {
        throw const NoiseSessionError('NOISE_MESSAGE_INVALID', 'Noise handshake message is truncated.');
      }
      final remoteEphemeral = _remoteEphemeral = Uint8List.fromList(message.sublist(0, _dhLen));
      _symmetric.mixHash(remoteEphemeral);
      var offset = _dhLen;
      if (role == NoiseRole.responder) {
        // -> e, es, s, ss
        _symmetric.mixKey(x25519(_static.privateKey, remoteEphemeral));
        final encryptedStatic = message.sublist(offset, offset + _dhLen + _tagBytes);
        offset += _dhLen + _tagBytes;
        final remoteStatic = _remoteStatic = _symmetric.decryptAndHash(encryptedStatic);
        _verifyRemoteStatic(remoteStatic);
        _symmetric.mixKey(x25519(_static.privateKey, remoteStatic));
      } else {
        // <- e, ee, se
        _remoteStatic = _expectedRemoteStatic;
        _symmetric.mixKey(x25519(_ephemeral!.privateKey, remoteEphemeral));
        _symmetric.mixKey(x25519(_static.privateKey, remoteEphemeral));
      }
      final payload = _symmetric.decryptAndHash(message.sublist(offset));
      _messageIndex++;
      _finishIfReady();
      return payload;
    } on Object {
      destroy();
      rethrow;
    }
  }

  /// Encrypts one transport message (≤ 65519 bytes of plaintext).
  Uint8List encrypt(List<int> plaintext) {
    _assertLive();
    final send = _send;
    if (send == null) {
      throw const NoiseSessionError('NOISE_NOT_READY', 'The Noise handshake is not complete.');
    }
    if (plaintext.length + _tagBytes > maxNoiseMessageBytes) {
      throw const NoiseSessionError('NOISE_MESSAGE_INVALID', 'Noise transport plaintext is too large.');
    }
    return send.encryptWithAd(const [], plaintext);
  }

  /// Decrypts the next transport message. Duplicated, reordered, truncated
  /// or forged messages fail authentication; the session is then destroyed
  /// (fail closed).
  Uint8List decrypt(List<int> ciphertext) {
    _assertLive();
    final receive = _receive;
    if (receive == null) {
      throw const NoiseSessionError('NOISE_NOT_READY', 'The Noise handshake is not complete.');
    }
    try {
      if (ciphertext.length > maxNoiseMessageBytes) {
        throw const NoiseSessionError('NOISE_MESSAGE_INVALID', 'Noise transport message is too large.');
      }
      return receive.decryptWithAd(const [], ciphertext);
    } on Object {
      destroy();
      rethrow;
    }
  }

  /// Nonce of the next message this side sends (0 after the handshake).
  int get sendingCounter => _send?.nonce ?? 0;

  /// Nonce the next received message must carry.
  int get receivingCounter => _receive?.nonce ?? 0;

  /// Remote static key learned or confirmed by the handshake.
  Uint8List? get remoteStatic => _remoteStatic == null ? null : Uint8List.fromList(_remoteStatic!);

  void destroy() {
    if (_destroyed) return;
    _destroyed = true;
    _expectedRemoteStatic.fillRange(0, _expectedRemoteStatic.length, 0);
    _ephemeralSeed?.fillRange(0, _ephemeralSeed.length, 0);
    _static.destroy();
    _ephemeral?.destroy();
    _symmetric.destroy();
    _send?.destroy();
    _receive?.destroy();
    _send = null;
    _receive = null;
  }

  void _finishIfReady() {
    if (_messageIndex < 2) return;
    _verifyRemoteStatic(_remoteStatic);
    final (c1, c2) = _symmetric.split();
    if (role == NoiseRole.initiator) {
      _send = c1;
      _receive = c2;
    } else {
      _send = c2;
      _receive = c1;
    }
  }

  void _verifyRemoteStatic(List<int>? actual) {
    if (actual == null || !constantTimeEquals(actual, _expectedRemoteStatic)) {
      destroy();
      throw const NoiseSessionError('PEER_IDENTITY_MISMATCH', 'The Noise peer static key does not match local trust.');
    }
  }

  void _assertHandshake({required bool reading}) {
    _assertLive();
    if (complete) {
      throw const NoiseSessionError('NOISE_ALREADY_READY', 'The Noise handshake is already complete.');
    }
    if (_isWriteTurn == reading) {
      throw const NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'The Noise handshake message arrived out of order.');
    }
  }

  void _assertLive() {
    if (_destroyed) {
      throw const NoiseSessionError('NOISE_DESTROYED', 'The Noise session is closed.');
    }
  }

  static Uint8List _requireKey(String value, String label) {
    final Uint8List key;
    try {
      key = fromBase64Url(value);
    } on FormatException {
      throw NoiseSessionError('INVALID_KEY', '$label is not base64url.');
    }
    if (key.length != 32) {
      throw NoiseSessionError('INVALID_KEY', '$label must be a 32-byte X25519 key.');
    }
    return key;
  }
}

/// UTF-8 `DSH-REMOTE\0v=1\0connection=<id>\0host=<id>\0client=<id>`: binds
/// the handshake to protocol v1, the Server connection and both devices.
Uint8List createNoisePrologue(String connectionId, String hostDeviceId, String clientDeviceId) {
  for (final (name, value) in [
    ('connectionId', connectionId),
    ('hostDeviceId', hostDeviceId),
    ('clientDeviceId', clientDeviceId),
  ]) {
    if (value.isEmpty || value.contains('\u0000')) {
      throw ArgumentError.value(value, name, 'is not safe for a Noise prologue');
    }
  }
  return Uint8List.fromList(
    utf8.encode(
      'DSH-REMOTE\u0000v=1\u0000connection=$connectionId\u0000host=$hostDeviceId\u0000client=$clientDeviceId',
    ),
  );
}
