import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:dsh_remote/src/util/bytes.dart' show fromBase64Url, toBase64Url;
import 'package:test/test.dart';

/// Upstream `fixtures/pairing/v1/proof.json` (public test keys only).
final Map<String, Object?> vectors =
    jsonDecode(File('test/fixtures/pairing/proof_v1.json').readAsStringSync()) as Map<String, Object?>;

const ticket = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const hostKey = 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw';
const serverKey = 'WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns';
const phoneKey = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const sessionId = '019a0000-0000-7000-8000-000000000001';
final origin = Uri.parse('https://dsh.r2049.cn');
final now = DateTime.fromMillisecondsSinceEpoch(1790000000000);

Map<String, Object?> hostJson({String key = hostKey, String role = 'host'}) => {
  'deviceId': '019a0000-0000-7000-8000-0000000000aa',
  'name': 'My computer',
  'role': role,
  'platform': 'desktop',
  'identityKey': key,
  'clientVersion': null,
  'harnessVersion': null,
};

Map<String, Object?> sessionJson({String secret = ticket, Map<String, Object?>? host, int? expiresAt}) => {
  'v': 1,
  'sessionId': sessionId,
  'expiresAt': expiresAt ?? now.add(const Duration(seconds: 170)).millisecondsSinceEpoch,
  'serverPublicKey': serverKey,
  'scanSecret': secret,
  'host': host ?? hostJson(),
};

const phone = PairingDevice(
  deviceId: '019a0000-0000-7000-8000-0000000000bb',
  name: 'DSH Go',
  role: 'client',
  platform: 'dsh-app-android',
  identityKey: phoneKey,
);

void main() {
  group('proof (fixed upstream vectors)', () {
    final privateKey = fromBase64Url(vectors['devicePrivateKey']! as String);

    test('the fixture key pair is the one the vectors use', () {
      expect(X25519KeyPair.fromPrivateKey(privateKey).publicKeyBase64Url, vectors['devicePublicKey']);
    });

    for (final raw in vectors['vectors']! as List<Object?>) {
      final v = raw! as Map<String, Object?>;
      test('${v['side']} ${(v['path']! as String).split('/').last}', () {
        final key = pairingProofKey(
          devicePrivateKey: privateKey,
          serverPublicKey: vectors['serverPublicKey']! as String,
          sessionId: vectors['sessionId']! as String,
          side: v['side']! as String,
        );
        expect(toBase64Url(key), v['proofKey']);
        final proof = pairingProof(
          devicePrivateKey: privateKey,
          serverPublicKey: vectors['serverPublicKey']! as String,
          sessionId: vectors['sessionId']! as String,
          side: v['side']! as String,
          path: v['path']! as String,
          rawJson: v['body']! as String,
        );
        expect(proof, v['proof']);
      });
    }

    test('a different body byte changes the proof (not a JSON canonical form)', () {
      String proof(String body) => pairingProof(
        devicePrivateKey: privateKey,
        serverPublicKey: serverKey,
        sessionId: sessionId,
        side: 'mobile',
        path: '/api/v1/device-pairing/sessions/$sessionId/mobile/status',
        rawJson: body,
      );
      expect(proof('{}'), isNot(proof('{ }')));
    });
  });

  group('scanning', () {
    test('the short code yields only its origin and ticket', () {
      final scan = parsePairingScan('  https://dsh.r2049.cn/pair#v1.$ticket\n');
      expect(scan, isA<PairingTicketScan>().having((s) => s.ticket, 'ticket', ticket));
      expect(scan.origin, origin);
    });

    for (final (label, text) in [
      ('a query', 'https://dsh.r2049.cn/pair?x=1#v1.$ticket'),
      ('user info', 'https://a@dsh.r2049.cn/pair#v1.$ticket'),
      ('another path', 'https://dsh.r2049.cn/pair/#v1.$ticket'),
      ('plain HTTP to a public host', 'http://dsh.r2049.cn/pair#v1.$ticket'),
      ('another version', 'https://dsh.r2049.cn/pair#v2.$ticket'),
      ('a non-canonical ticket', 'https://dsh.r2049.cn/pair#v1.${ticket.substring(0, 42)}B'),
      ('a short ticket', 'https://dsh.r2049.cn/pair#v1.${ticket.substring(1)}'),
      ('another scheme', 'dshgo://pair#v1.$ticket'),
      ('no host', 'https:///pair#v1.$ticket'),
      ('no authority', 'https:/pair#v1.$ticket'),
      ('plain text', 'hello'),
      ('an oversized code', 'https://dsh.r2049.cn/pair#v1.$ticket${' ' * 5000}'),
    ]) {
      test('refuses $label', () {
        expect(
          () => parsePairingScan(text),
          throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_SCAN_INVALID')),
        );
      });
    }

    test('plain HTTP is allowed for a private development Server', () {
      expect(parsePairingScan('http://127.0.0.1:5173/pair#v1.$ticket').origin, Uri.parse('http://127.0.0.1:5173'));
    });

    test('the legacy JSON code carries a validated session', () {
      final scan = parsePairingScan(
        jsonEncode({'type': 'dsh.remote.pairing', 'serverUrl': 'https://dsh.r2049.cn', ...sessionJson()}),
        now: now,
      );
      expect(scan, isA<PairingLegacyScan>().having((s) => s.offer.host.name, 'host', 'My computer'));
      expect(
        () => parsePairingScan(
          jsonEncode({'type': 'dsh.remote.pairing', 'serverUrl': 'https://dsh.r2049.cn/', ...sessionJson()}),
          now: now,
        ),
        throwsA(isA<PairingException>()),
        reason: 'serverUrl must be the exact origin',
      );
      expect(
        () => parsePairingScan('{"type":"dsh.remote.pairing","type":"x"}'),
        throwsA(isA<PairingException>()),
        reason: 'duplicate fields',
      );
    });
  });

  group('session', () {
    test('resolve answers are pinned to the ticket and a Host', () {
      final offer = PairingOffer.parse(sessionJson(), origin: origin, ticket: ticket, now: now);
      expect(offer.sessionId, sessionId);
      expect(offer.host.fingerprint, hasLength(64));
      expect(offer.host.fingerprint, offer.host.fingerprint.toLowerCase());
      expect(formatPairingFingerprint(offer.host.fingerprint).split(' '), hasLength(16));
      expect(offer.path('claim'), '/api/v1/device-pairing/sessions/$sessionId/claim');

      PairingException refused(Map<String, Object?> json) {
        try {
          PairingOffer.parse(json, origin: origin, ticket: ticket, now: now);
        } on PairingException catch (e) {
          return e;
        }
        fail('accepted');
      }

      expect(refused(sessionJson(secret: phoneKey)).code, 'PAIRING_SCAN_INVALID', reason: 'another ticket');
      expect(refused(sessionJson(host: hostJson(role: 'client'))).code, 'PAIRING_SCAN_INVALID');
      expect(refused({...sessionJson(), 'v': 2}).code, 'PAIRING_SCAN_INVALID');
      expect(
        refused(sessionJson(expiresAt: now.subtract(const Duration(minutes: 5)).millisecondsSinceEpoch)).code,
        'PAIRING_EXPIRED',
      );
      expect(refused(sessionJson(expiresAt: 9007199254740991)).code, 'PAIRING_SCAN_INVALID', reason: 'past DateTime');
    });

    test('the claim body is serialized once, in a fixed order', () {
      expect(
        pairingClaimBody(scanSecret: ticket, device: phone, deepseekUserId: 'u-1'),
        '{"scanSecret":"$ticket","device":{"deviceId":"${phone.deviceId}","name":"DSH Go","role":"client",'
        '"platform":"dsh-app-android","identityKey":"$phoneKey"},"deepseekUserId":"u-1"}',
      );
      expect(pairingClaimBody(scanSecret: ticket, device: phone), isNot(contains('deepseekUserId')));
      expect(() => pairingClaimBody(scanSecret: ticket, device: phone, deepseekUserId: ''), throwsArgumentError);
    });

    test('a claim keeps the code leading zeros', () {
      final claim = PairingClaim.parse({'state': 'claimed', 'verificationCode': '00123456', 'expiresAt': 1});
      expect(claim.verificationCode, '00123456');
      expect(
        () => PairingClaim.parse({'state': 'claimed', 'verificationCode': 123456, 'expiresAt': 1}),
        throwsA(anything),
      );
      expect(
        () => PairingClaim.parse({'state': 'claimed', 'verificationCode': '00123456', 'expiresAt': -9007199254740991}),
        throwsA(isA<PairingException>()),
      );
    });
  });

  group('status', () {
    final offer = PairingOffer.parse(sessionJson(), origin: origin, ticket: ticket, now: now);
    final later = now.add(const Duration(days: 1)).millisecondsSinceEpoch;

    Map<String, Object?> status(String state, {Map<String, Object?>? host, Map<String, Object?>? credentials}) => {
      'v': 1,
      'sessionId': sessionId,
      'state': state,
      'expiresAt': now.millisecondsSinceEpoch,
      'recoverUntil': now.millisecondsSinceEpoch + 300000,
      'failureReason': state == 'failed' ? 'verification_failed' : null,
      'attemptConsumed': false,
      'host': host ?? hostJson(),
      'mobile': {...phone.toJson(), 'clientVersion': null, 'harnessVersion': null},
      'credentials': credentials,
    };

    Map<String, Object?> credentials({String role = 'client', bool inboundOnly = false}) => {
      'account': 'dsh-device:019a0000-0000-7000-8000-0000000000cc',
      'accountKind': 'device_only',
      'device': {...phone.toJson(), 'role': role},
      'inboundOnly': inboundOnly,
      'pairingRestricted': true,
      'tokens': {
        'accessToken': 'a' * 32,
        'accessTokenExpiresAt': later,
        'refreshToken': 'r' * 32,
        'refreshTokenExpiresAt': later,
      },
    };

    test('states parse; completion yields this phone credentials', () {
      expect(PairingStatus.parse(status('claimed'), offer: offer, mobile: phone, now: now).state, PairingState.claimed);
      final failed = PairingStatus.parse(status('failed'), offer: offer, mobile: phone, now: now);
      expect((failed.state, failed.failureReason), (PairingState.failed, 'verification_failed'));
      final done = PairingStatus.parse(
        status('completed', credentials: credentials()),
        offer: offer,
        mobile: phone,
        now: now,
      );
      expect(done.credentials!.account, startsWith('dsh-device:'));
      expect(done.credentials!.tokens.accessToken, 'a' * 32);
    });

    test('a replaced Host key fails closed', () {
      expect(
        () => PairingStatus.parse(
          status('claimed', host: hostJson(key: phoneKey)),
          offer: offer,
          mobile: phone,
        ),
        throwsA(isA<PairingException>().having((e) => e.code, 'code', 'PAIRING_IDENTITY_MISMATCH')),
      );
    });

    test('Host credentials are never taken for this phone', () {
      for (final bad in [credentials(role: 'host'), credentials(inboundOnly: true), null]) {
        expect(
          () => PairingStatus.parse(
            status('completed', credentials: bad),
            offer: offer,
            mobile: phone,
            now: now,
          ),
          throwsA(isA<PairingException>()),
        );
      }
    });
  });
}
