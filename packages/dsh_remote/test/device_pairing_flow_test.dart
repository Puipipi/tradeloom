// RemoteAccount's phone side of device pairing v1 against a Server stand-in
// that checks every proof the way the real one does (X25519 is symmetric:
// the Server derives the same key from its private key and the phone's
// public key).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:dsh_remote/src/util/bytes.dart' show fromBase64Url, toBase64Url;
import 'package:test/test.dart';

const ticket = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const sessionId = '019a0000-0000-7000-8000-000000000001';
const hostId = '019a0000-0000-7000-8000-0000000000aa';

class _PairingServer {
  _PairingServer._(this._server) {
    _server.listen(_handle);
  }

  static Future<_PairingServer> start() async => _PairingServer._(await HttpServer.bind('127.0.0.1', 0));

  final HttpServer _server;
  final serverKeys = X25519KeyPair.generate();
  final hostKeys = X25519KeyPair.generate();
  Uri get url => Uri.parse('http://127.0.0.1:${_server.port}');

  Map<String, Object?>? capabilities = {'devicePairing': 'dsh-pairing-v1', 'devicePairingQr': 'fragment-ticket-v1'};

  /// What `mobile/status` answers next.
  String state = 'claimed';
  String? failureReason;
  String account = 'dsh-device:019a0000-0000-7000-8000-0000000000cc';

  /// Answers the first claims with 503 (the response "got lost").
  int claimOutages = 0;
  final claims = <String>[];
  final requests = <String>[];
  final proofFailures = <String>[];
  Map<String, Object?>? mobile;

  Future<void> close() => _server.close(force: true);

  Map<String, Object?> get host => {
    'deviceId': hostId,
    'name': 'Studio Mac',
    'role': 'host',
    'platform': 'desktop',
    'identityKey': hostKeys.publicKeyBase64Url,
    'clientVersion': null,
    'harnessVersion': null,
  };

  Map<String, Object?> get session => {
    'v': 1,
    'sessionId': sessionId,
    'expiresAt': DateTime.now().add(const Duration(seconds: 170)).millisecondsSinceEpoch,
    'serverPublicKey': serverKeys.publicKeyBase64Url,
    'scanSecret': ticket,
    'host': host,
  };

  Future<void> _handle(HttpRequest request) async {
    final path = request.uri.path;
    final raw = await utf8.decodeStream(request);
    requests.add('${request.method} $path');
    Future<void> reply(int status, Object? body) async {
      request.response
        ..statusCode = status
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(body));
      await request.response.close();
    }

    Future<void> error(int status, String code) => reply(status, {
      'error': {'code': code, 'message': code, 'requestId': 'r', 'retryable': status >= 500},
    });

    if (path == '/api/v1/auth/oauth/providers') {
      return reply(200, {'capabilities': ?capabilities, 'items': <Object?>[]});
    }
    if (path == '/api/v1/device-pairing/resolve') {
      return jsonDecode(raw)['ticket'] == ticket ? reply(200, session) : error(404, 'PAIRING_NOT_FOUND');
    }
    final prefix = '/api/v1/device-pairing/sessions/$sessionId/';
    if (!path.startsWith(prefix)) return error(404, 'NOT_FOUND');
    final operation = path.substring(prefix.length);
    if (operation == 'claim') {
      claims.add(raw);
      mobile = (jsonDecode(raw) as Map<String, Object?>)['device']! as Map<String, Object?>;
    }
    final device = mobile;
    if (device == null) return error(409, 'PAIRING_NOT_CLAIMED');
    final expected = pairingProof(
      devicePrivateKey: serverKeys.privateKey,
      serverPublicKey: device['identityKey']! as String,
      sessionId: sessionId,
      side: 'mobile',
      path: path,
      rawJson: raw,
    );
    if (request.headers.value('X-DSH-Pairing-Proof') != expected) {
      proofFailures.add(operation);
      return error(401, 'PAIRING_PROOF_INVALID');
    }
    switch (operation) {
      case 'claim':
        if (claimOutages > 0) {
          claimOutages--;
          return error(503, 'AUTHORIZATION_SYNC_PENDING');
        }
        return reply(200, {'state': 'claimed', 'verificationCode': '00123456', 'expiresAt': session['expiresAt']});
      case 'mobile/status':
        final later = DateTime.now().add(const Duration(days: 30)).millisecondsSinceEpoch;
        return reply(200, {
          'v': 1,
          'sessionId': sessionId,
          'state': state,
          'expiresAt': session['expiresAt'],
          'recoverUntil': DateTime.now().add(const Duration(minutes: 5)).millisecondsSinceEpoch,
          'failureReason': failureReason,
          'attemptConsumed': state != 'claimed',
          'submissionId': null,
          'host': host,
          'mobile': {...device, 'clientVersion': null, 'harnessVersion': null},
          'credentials': state != 'completed'
              ? null
              : {
                  'account': account,
                  'accountKind': 'device_only',
                  'device': device,
                  'inboundOnly': false,
                  'pairingRestricted': true,
                  'tokens': {
                    'accessToken': 'access-${'a' * 24}',
                    'accessTokenExpiresAt': later,
                    'refreshToken': 'refresh-${'r' * 24}',
                    'refreshTokenExpiresAt': later,
                  },
                },
        });
      case 'mobile/cancel':
        state = 'cancelled';
        return reply(200, {'state': 'cancelled'});
    }
    return error(404, 'NOT_FOUND');
  }
}

/// Storage that can fail: reads of the credentials, or writes of the pins.
class _FlakySecrets extends MemorySecretStore {
  int failCredentialReads = 0;
  bool failPinWrites = false;
  bool failPinWritesOnce = false;
  int credentialWrites = 0;

  @override
  Future<String?> read(String key) async {
    if (key.endsWith('.credentials') && failCredentialReads > 0) {
      failCredentialReads--;
      throw StateError('keystore unavailable');
    }
    return super.read(key);
  }

  @override
  Future<void> write(String key, String value) async {
    if (key.endsWith('.pins') && failPinWrites) throw StateError('keystore unavailable');
    if (key.endsWith('.pins') && failPinWritesOnce) {
      failPinWritesOnce = false;
      throw StateError('keystore unavailable');
    }
    if (key.endsWith('.credentials')) credentialWrites++;
    await super.write(key, value);
  }
}

void main() {
  late _PairingServer server;
  late _FlakySecrets secrets;
  late RemoteAccount account;

  setUp(() async {
    server = await _PairingServer.start();
    secrets = _FlakySecrets();
    account = RemoteAccount(
      secrets: secrets,
      serverUrl: server.url,
      deviceName: 'Pixel',
      pairingPollInterval: const Duration(milliseconds: 10),
    );
  });
  tearDown(() async {
    await account.close();
    await server.close();
  });

  PairingScan scan() => parsePairingScan('${server.url}/pair#v1.$ticket');

  Future<void> until(bool Function() condition) async {
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (!condition()) {
      if (DateTime.now().isAfter(deadline)) throw TimeoutException('condition not met');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  test('scan, confirm, show the code, wait for the computer, then store this phone credentials', () async {
    expect(await account.supportsPairing(), isTrue);
    final offer = await account.resolvePairing(scan());
    expect(offer.host.name, 'Studio Mac');
    expect(offer.host.fingerprint, pairingFingerprint(server.hostKeys.publicKeyBase64Url));
    expect(server.claims, isEmpty, reason: 'resolving does not claim');
    expect(await account.currentUser(), isNull);

    server.claimOutages = 1;
    final pairing = await account.claimPairing(offer, deepseekUserId: 'ds-42');
    expect(pairing.verificationCode, '00123456');
    expect(server.claims, hasLength(2));
    expect(server.claims.toSet(), hasLength(1), reason: 'a lost claim is resent byte for byte');
    final claim = jsonDecode(server.claims.first) as Map<String, Object?>;
    expect(claim['deepseekUserId'], 'ds-42');
    expect((claim['device']! as Map)['role'], 'client');
    expect(server.proofFailures, isEmpty);

    final states = <PairingState>[];
    pairing.states.listen(states.add);
    await until(() => server.requests.where((r) => r.endsWith('/mobile/status')).length >= 2);
    expect(await account.currentUser(), isNull, reason: 'no access before the computer confirmed');
    server.state = 'approved';
    await until(() => states.contains(PairingState.approved));
    server.state = 'completed';
    final paired = await pairing.result;
    expect(paired.host.deviceId, hostId);
    expect(paired.user.account, server.account);
    expect(paired.user.provider, 'pairing');
    expect(states, [PairingState.approved, PairingState.completed]);

    final user = await account.currentUser();
    expect(user?.deviceId, (claim['device']! as Map)['deviceId']);
    expect(await account.accessToken(), startsWith('access-'));
    final pins = secrets.values.entries.firstWhere((e) => e.key.endsWith('.pins')).value;
    expect(pins, contains(server.hostKeys.publicKeyBase64Url), reason: 'the Host key from the code is pinned');
    expect(server.proofFailures, isEmpty);
  });

  test('a wrong code on the computer ends the session; nothing is stored', () async {
    final pairing = await account.claimPairing(await account.resolvePairing(scan()));
    server
      ..state = 'failed'
      ..failureReason = 'verification_failed';
    await expectLater(
      pairing.result,
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_CODE_REJECTED')),
    );
    expect(await account.currentUser(), isNull);
    expect(secrets.values.keys.where((k) => k.endsWith('.credentials')), isEmpty);
  });

  test('cancelling tells the Server and stops polling', () async {
    final pairing = await account.claimPairing(await account.resolvePairing(scan()));
    pairing.result.ignore();
    await pairing.cancel();
    await expectLater(
      pairing.result,
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_CANCELLED')),
    );
    expect(server.requests, contains('POST /api/v1/device-pairing/sessions/$sessionId/mobile/cancel'));
    final polls = server.requests.where((r) => r.endsWith('/mobile/status')).length;
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(server.requests.where((r) => r.endsWith('/mobile/status')).length, polls);
  });

  test('paused while in the background: no polling until resumed', () async {
    final pairing = await account.claimPairing(await account.resolvePairing(scan()));
    pairing.paused = true;
    await Future<void>.delayed(const Duration(milliseconds: 40));
    final polls = server.requests.where((r) => r.endsWith('/mobile/status')).length;
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(server.requests.where((r) => r.endsWith('/mobile/status')).length, polls);
    server.state = 'completed';
    pairing.paused = false;
    await pairing.result;
  });

  test('a code from another Server, or a Server without pairing, is refused before any claim', () async {
    final other = parsePairingScan('https://dsh.r2049.cn/pair#v1.$ticket');
    await expectLater(
      account.resolvePairing(other),
      throwsA(
        isA<PairingException>()
            .having((e) => e.code, 'code', 'PAIRING_SERVER_MISMATCH')
            .having((e) => e.origin, 'origin', Uri.parse('https://dsh.r2049.cn')),
      ),
    );
    server.capabilities = {'devicePairing': 'dsh-pairing-v1'};
    await expectLater(
      account.resolvePairing(scan()),
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_UNSUPPORTED')),
      reason: 'the short code needs devicePairingQr',
    );
    server.capabilities = null;
    expect(await account.supportsPairing(), isFalse);
    expect(server.claims, isEmpty);
  });

  test('an expired or unknown ticket says so', () async {
    await expectLater(
      account.resolvePairing(parsePairingScan('${server.url}/pair#v1.${toBase64Url(List.filled(32, 7))}')),
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_NOT_FOUND')),
    );
  });

  test('a sign-in that commits while the code is shown is never overwritten', () async {
    final pairing = await account.claimPairing(await account.resolvePairing(scan()));
    // Another RemoteAccount on the same store signs this identity in to
    // another account; this instance's cache never saw it.
    final identity = jsonDecode(secrets.values.entries.firstWhere((e) => e.key.endsWith('.identity')).value) as Map;
    final key = secrets.values.keys
        .firstWhere((k) => k.endsWith('.identity'))
        .replaceFirst('.identity', '.credentials');
    final later = DateTime.now().add(const Duration(days: 30)).millisecondsSinceEpoch;
    final theirs = jsonEncode({
      'v': 1,
      'deviceId': identity['deviceId'],
      'account': 'someone@example.com',
      'accessToken': 'theirs-${'a' * 24}',
      'accessTokenExpiresAt': later,
      'refreshToken': 'theirs-${'r' * 24}',
      'refreshTokenExpiresAt': later,
      'provider': 'github',
    });
    secrets.values[key] = theirs;
    server.state = 'completed';
    await expectLater(
      pairing.result,
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_ACCOUNT_CONFLICT')),
    );
    expect(secrets.values[key], theirs);
  });

  test('a failed read of the stored sign-in is not "none": it is retried, never overwritten', () async {
    final pairing = await account.claimPairing(await account.resolvePairing(scan()));
    final identity = jsonDecode(secrets.values.entries.firstWhere((e) => e.key.endsWith('.identity')).value) as Map;
    final key = secrets.values.keys
        .firstWhere((k) => k.endsWith('.identity'))
        .replaceFirst('.identity', '.credentials');
    final later = DateTime.now().add(const Duration(days: 30)).millisecondsSinceEpoch;
    final theirs = jsonEncode({
      'v': 1,
      'deviceId': identity['deviceId'],
      'account': 'someone@example.com',
      'accessToken': 'theirs-${'a' * 24}',
      'accessTokenExpiresAt': later,
      'refreshToken': 'theirs-${'r' * 24}',
      'refreshTokenExpiresAt': later,
    });
    secrets.values[key] = theirs;
    secrets.failCredentialReads = 2;
    server.state = 'completed';
    await expectLater(
      pairing.result,
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_ACCOUNT_CONFLICT')),
    );
    expect(secrets.failCredentialReads, 0, reason: 'the failed reads were retried');
    expect(secrets.values[key], theirs);
    expect(secrets.credentialWrites, 0);
  });

  test('a pin that cannot be stored fails the pairing, keeps the sign-in, never rewrites it', () async {
    final pairing = await account.claimPairing(await account.resolvePairing(scan()));
    secrets.failPinWrites = true;
    server.state = 'completed';
    await expectLater(
      pairing.result,
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_PIN_SAVE_FAILED')),
    );
    expect(secrets.credentialWrites, 1);
    expect(await account.currentUser(), isNotNull);
  });

  test('a pin save that fails once is retried and the pairing completes', () async {
    final pairing = await account.claimPairing(await account.resolvePairing(scan()));
    secrets.failPinWritesOnce = true;
    server.state = 'completed';
    await pairing.result;
    expect(secrets.credentialWrites, 1);
    expect(secrets.values.keys.where((k) => k.endsWith('.pins')), hasLength(1));
  });

  test('an account signed in elsewhere keeps its credentials', () async {
    // Sign this identity in to another account first (as if by OAuth).
    final offer = await account.resolvePairing(scan());
    final pairing = await account.claimPairing(offer);
    server.state = 'completed';
    await pairing.result;
    final stored = secrets.values.entries.firstWhere((e) => e.key.endsWith('.credentials')).value;

    final again = await account.claimPairing(await account.resolvePairing(scan()));
    server.account = 'someone@example.com';
    await expectLater(
      again.result,
      throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_ACCOUNT_CONFLICT')),
    );
    expect(secrets.values.entries.firstWhere((e) => e.key.endsWith('.credentials')).value, stored);
    expect(fromBase64Url(offer.serverPublicKey), hasLength(32));
  });
}
