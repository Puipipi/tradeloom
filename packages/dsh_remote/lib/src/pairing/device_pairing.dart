// SPDX-FileCopyrightText: 2026 DSH Remote contributors
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.
// Device pairing v1, the phone side: scan the computer's QR code, confirm the
// computer on the phone, show the 8-digit code that the person types into the
// computer's Remote plugin, then receive this phone's own device credentials.
//
// Wire: upstream `docs/device-pairing-v1.md` and `docs/dsh-go-pairing-integration.md`
// (plugin 0.6.4 line, `cc9fafd` + `ffefd4f`). Proof vectors:
// `fixtures/pairing/v1/proof.json` (copied into this package's tests).
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as hashes;

import '../crypto/noise_ik.dart' show x25519;
import '../server/server_api.dart' show DeviceTokenPair, normalizeServerUrl;
import '../util/bytes.dart';

/// `capabilities.devicePairing` of `GET /api/v1/auth/oauth/providers`.
const String devicePairingProtocol = 'dsh-pairing-v1';

/// `capabilities.devicePairingQr`: `https://<server>/pair#v1.<ticket>`.
const String devicePairingQrFormat = 'fragment-ticket-v1';

/// Scanned text past this is refused before parsing (the short code is
/// about 80 bytes; the legacy JSON code well under 1 KiB).
const int maxPairingScanBytes = 4096;

/// A pairing step the Server or the phone refused. [code] is the Server's
/// (`PAIRING_NOT_FOUND`, `PAIRING_CLOSED`, ...) or a local one:
/// `PAIRING_SCAN_INVALID`, `PAIRING_UNSUPPORTED`, `PAIRING_SERVER_MISMATCH`,
/// `PAIRING_IDENTITY_MISMATCH`, `PAIRING_CODE_REJECTED`, `PAIRING_FAILED`,
/// `PAIRING_CANCELLED`, `PAIRING_EXPIRED`, `PAIRING_ACCOUNT_CONFLICT`.
class PairingException implements Exception {
  const PairingException(this.code, this.message, {this.origin});

  final String code;
  final String message;

  /// For `PAIRING_SERVER_MISMATCH`: the Server the code belongs to.
  final Uri? origin;

  @override
  String toString() => 'PairingException($code): $message';
}

// ---------------------------------------------------------------------------
// Scanning

/// What a scanned code says, before anything is sent anywhere.
sealed class PairingScan {
  const PairingScan(this.origin);

  /// The Server the code belongs to. Show it and let the person confirm it
  /// before sending anything there.
  final Uri origin;
}

/// The short code: only a 256-bit ticket; the session comes from
/// `POST /api/v1/device-pairing/resolve`.
final class PairingTicketScan extends PairingScan {
  const PairingTicketScan(super.origin, this.ticket);

  /// Secret: never log it, copy it or put it in a URL.
  final String ticket;
}

/// The legacy JSON code, which carries the whole session (older plugins and
/// Servers without `devicePairingQr`).
final class PairingLegacyScan extends PairingScan {
  const PairingLegacyScan(super.origin, this.offer);

  final PairingOffer offer;
}

final RegExp _ticketFragment = RegExp(r'^v1\.([A-Za-z0-9_-]{43})$');

/// Parses scanned text strictly; anything else is `PAIRING_SCAN_INVALID`.
/// The text is never opened as a page and redirects are never followed.
PairingScan parsePairingScan(String text, {DateTime? now}) {
  if (utf8.encode(text).length > maxPairingScanBytes) {
    throw const PairingException('PAIRING_SCAN_INVALID', 'The scanned code is too long.');
  }
  final value = text.trim();
  if (value.startsWith('{')) return _parseLegacyScan(value, now ?? DateTime.now());
  final uri = Uri.tryParse(value);
  final match = uri == null ? null : _ticketFragment.firstMatch(uri.fragment);
  if (uri == null ||
      (uri.scheme != 'https' && uri.scheme != 'http') ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.path != '/pair' ||
      uri.hasQuery ||
      match == null ||
      !_isKey32(match.group(1)!)) {
    throw const PairingException('PAIRING_SCAN_INVALID', 'This is not a DSH Go pairing code.');
  }
  return PairingTicketScan(_origin(uri.origin), match.group(1)!);
}

PairingLegacyScan _parseLegacyScan(String text, DateTime now) {
  Object? decoded;
  try {
    decoded = decodeWireJson(text);
  } on FormatException {
    decoded = null;
  }
  final map = asMap(decoded);
  final server = asString(map?['serverUrl']);
  if (map == null || map['type'] != 'dsh.remote.pairing' || server == null) {
    throw const PairingException('PAIRING_SCAN_INVALID', 'This is not a DSH Go pairing code.');
  }
  final origin = _origin(server);
  if (origin.toString() != server) {
    throw const PairingException('PAIRING_SCAN_INVALID', 'The pairing code names an invalid Server.');
  }
  return PairingLegacyScan(origin, PairingOffer.parse(map, origin: origin, now: now));
}

Uri _origin(String value) {
  try {
    return normalizeServerUrl(value);
  } on Object {
    throw const PairingException('PAIRING_SCAN_INVALID', 'The pairing code names an insecure or invalid Server.');
  }
}

/// 32 bytes as canonical unpadded base64url (keys, the ticket).
bool _isKey32(String? value) {
  if (value == null || !identityKeyPattern.hasMatch(value)) return false;
  try {
    final bytes = fromBase64Url(value);
    return bytes.length == 32 && toBase64Url(bytes) == value;
  } on FormatException {
    return false;
  }
}

/// A wire timestamp, or null outside what [DateTime] can hold.
DateTime? _date(int? millis) => millis == null || millis < -8640000000000000 || millis > 8640000000000000
    ? null
    : DateTime.fromMillisecondsSinceEpoch(millis);

// ---------------------------------------------------------------------------
// Session and devices

/// A device as pairing describes it (the registration descriptor).
class PairingDevice {
  const PairingDevice({
    required this.deviceId,
    required this.name,
    required this.role,
    required this.platform,
    required this.identityKey,
  });

  final String deviceId;

  /// Untrusted display name (escape / truncate in UI).
  final String name;
  final String role;
  final String platform;
  final String identityKey;

  /// `lowercaseHex(SHA256(key))`, the full fingerprint both sides show.
  String get fingerprint => pairingFingerprint(identityKey);

  static PairingDevice? fromJson(Object? json) {
    final map = asMap(json);
    final id = asString(map?['deviceId']);
    final name = asString(map?['name']);
    final role = asString(map?['role']);
    final platform = asString(map?['platform']);
    final key = asString(map?['identityKey']);
    if (id == null ||
        id.isEmpty ||
        id.length > 128 ||
        name == null ||
        name.length > 256 ||
        (role != 'host' && role != 'client') ||
        platform == null ||
        platform.length > 64 ||
        !_isKey32(key)) {
      return null;
    }
    return PairingDevice(deviceId: id, name: name, role: role!, platform: platform, identityKey: key!);
  }

  JsonMap toJson() => {
    'deviceId': deviceId,
    'name': name,
    'role': role,
    'platform': platform,
    'identityKey': identityKey,
  };

  bool sameIdentity(PairingDevice other) =>
      deviceId == other.deviceId && identityKey == other.identityKey && role == other.role;
}

/// `lowercaseHex(SHA256(decodedIdentityKey))`, grouped for reading by
/// [formatPairingFingerprint]; never a prefix of the raw key.
String pairingFingerprint(String identityKey) => hashes.sha256.convert(fromBase64Url(identityKey)).toString();

/// `1a2b 3c4d ...` (16 groups of 4).
String formatPairingFingerprint(String fingerprint) =>
    RegExp(r'.{1,4}').allMatches(fingerprint).map((m) => m.group(0)).join(' ');

final RegExp _uuid = RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');

/// A resolved pairing session, pinned for its whole life: later status and
/// completion must name the same session, Host and Server key.
class PairingOffer {
  const PairingOffer({
    required this.origin,
    required this.sessionId,
    required this.expiresAt,
    required this.serverPublicKey,
    required this.scanSecret,
    required this.host,
  });

  final Uri origin;
  final String sessionId;
  final DateTime expiresAt;
  final String serverPublicKey;

  /// Secret: never log it.
  final String scanSecret;
  final PairingDevice host;

  /// Tolerated clock difference between the phone and the Server.
  static const clockSkew = Duration(minutes: 2);

  /// Validates a resolve response (or the legacy QR body) against [origin]
  /// and, for the short code, its [ticket].
  static PairingOffer parse(Object? json, {required Uri origin, String? ticket, DateTime? now}) {
    final map = asMap(json);
    final sessionId = asString(map?['sessionId']);
    final expiresAt = asInt(map?['expiresAt']);
    final serverKey = asString(map?['serverPublicKey']);
    final scanSecret = asString(map?['scanSecret']);
    final host = PairingDevice.fromJson(map?['host']);
    final clock = now ?? DateTime.now();
    if (map == null ||
        map['v'] != 1 ||
        sessionId == null ||
        !_uuid.hasMatch(sessionId) ||
        _date(expiresAt) == null ||
        !_isKey32(serverKey) ||
        !_isKey32(scanSecret) ||
        (ticket != null && scanSecret != ticket) ||
        host == null ||
        host.role != 'host' ||
        host.identityKey == serverKey) {
      throw const PairingException('PAIRING_SCAN_INVALID', 'The Server returned an invalid pairing session.');
    }
    final expires = _date(expiresAt)!;
    // Sessions live 180 s; a far-future deadline is not one.
    if (expires.isBefore(clock.subtract(clockSkew)) || expires.isAfter(clock.add(const Duration(minutes: 10)))) {
      throw const PairingException('PAIRING_EXPIRED', 'This pairing code expired. Show a new code on the computer.');
    }
    return PairingOffer(
      origin: origin,
      sessionId: sessionId,
      expiresAt: expires,
      serverPublicKey: serverKey!,
      scanSecret: scanSecret!,
      host: host,
    );
  }

  String path(String operation) => '/api/v1/device-pairing/sessions/$sessionId/$operation';
}

// ---------------------------------------------------------------------------
// Proof of key possession

/// `X-DSH-Pairing-Proof` for one pairing POST, unpadded base64url of
///
/// ```text
/// HMAC-SHA256(
///   HKDF-SHA256(X25519(device, server), salt=sessionId, info="dsh-pairing-v1/<side>"),
///   "POST\n<path>\n<hex(SHA256(rawJson))>")
/// ```
///
/// [rawJson] must be the exact text sent.
String pairingProof({
  required List<int> devicePrivateKey,
  required String serverPublicKey,
  required String sessionId,
  required String side,
  required String path,
  required String rawJson,
}) {
  final key = pairingProofKey(
    devicePrivateKey: devicePrivateKey,
    serverPublicKey: serverPublicKey,
    sessionId: sessionId,
    side: side,
  );
  final bodyHash = hashes.sha256.convert(utf8.encode(rawJson)).toString();
  final mac = hashes.Hmac(hashes.sha256, key).convert(utf8.encode('POST\n$path\n$bodyHash'));
  return toBase64Url(mac.bytes);
}

/// The HKDF output behind [pairingProof] (exposed for the fixed vectors).
Uint8List pairingProofKey({
  required List<int> devicePrivateKey,
  required String serverPublicKey,
  required String sessionId,
  required String side,
}) {
  if (side != 'mobile' && side != 'host') throw ArgumentError.value(side, 'side');
  final shared = x25519(devicePrivateKey, fromBase64Url(serverPublicKey));
  try {
    return hkdfSha256(shared, salt: utf8.encode(sessionId), info: utf8.encode('dsh-pairing-v1/$side'), length: 32);
  } finally {
    shared.fillRange(0, shared.length, 0);
  }
}

/// RFC 5869 HKDF-SHA256.
Uint8List hkdfSha256(List<int> ikm, {required List<int> salt, required List<int> info, required int length}) {
  if (length < 1 || length > 255 * 32) throw ArgumentError.value(length, 'length');
  final prk = hashes.Hmac(hashes.sha256, salt.isEmpty ? Uint8List(32) : salt).convert(ikm).bytes;
  final out = BytesBuilder(copy: false);
  var previous = <int>[];
  for (var i = 1; out.length < length; i++) {
    previous = hashes.Hmac(hashes.sha256, prk).convert([...previous, ...info, i]).bytes;
    out.add(previous);
  }
  return Uint8List.sublistView(out.takeBytes(), 0, length);
}

// ---------------------------------------------------------------------------
// Claim and status

/// `POST .../claim` → the code to type into the computer.
class PairingClaim {
  const PairingClaim({required this.verificationCode, required this.expiresAt});

  /// Exactly 8 ASCII digits, leading zeros kept. Show it only on the
  /// pairing screen: never log, notify, copy or share it.
  final String verificationCode;
  final DateTime expiresAt;

  static PairingClaim parse(Object? json) {
    final map = asMap(json);
    final code = asString(map?['verificationCode']);
    final expiresAt = asInt(map?['expiresAt']);
    final expires = _date(expiresAt);
    if (map?['state'] != 'claimed' || code == null || !RegExp(r'^[0-9]{8}$').hasMatch(code) || expires == null) {
      throw const PairingException('PAIRING_FAILED', 'The Server returned an invalid pairing claim.');
    }
    return PairingClaim(verificationCode: code, expiresAt: expires);
  }
}

/// Session states (`created → claimed → approved → completed`, or a
/// terminal failure).
enum PairingState {
  created,
  claimed,

  /// The computer submitted the right code; the Server is still finishing
  /// the binding. No access yet.
  approved,
  completed,
  failed,
  cancelled,
  expired;

  bool get isTerminal => this == completed || this == failed || this == cancelled || this == expired;

  static PairingState? fromWire(Object? value) => switch (value) {
    'created' => created,
    'claimed' => claimed,
    'approved' => approved,
    'completed' => completed,
    'failed' => failed,
    'cancelled' => cancelled,
    'expired' => expired,
    _ => null,
  };
}

/// This phone's credentials from a completed session.
class PairingCredentials {
  const PairingCredentials({
    required this.account,
    required this.accountKind,
    required this.device,
    required this.tokens,
    required this.pairingRestricted,
  });

  /// `dsh-device:<UUID>` for a device-only account, else the existing account.
  final String account;

  /// `device_only` or `standard`.
  final String accountKind;
  final PairingDevice device;
  final DeviceTokenPair tokens;
  final bool pairingRestricted;
}

/// One `mobile/status` answer, checked against the pinned session and this
/// phone's identity: any mismatch fails closed (`PAIRING_IDENTITY_MISMATCH`).
class PairingStatus {
  const PairingStatus({required this.state, this.recoverUntil, this.failureReason, this.credentials});

  final PairingState state;
  final DateTime? recoverUntil;

  /// `verification_failed` (the computer typed a wrong code) or a stable
  /// Server error code (`PAIRING_ACCOUNT_CONFLICT`, ...).
  final String? failureReason;

  /// Only for [PairingState.completed].
  final PairingCredentials? credentials;

  static PairingStatus parse(
    Object? json, {
    required PairingOffer offer,
    required PairingDevice mobile,
    DateTime? now,
  }) {
    final map = asMap(json);
    final state = PairingState.fromWire(map?['state']);
    final host = PairingDevice.fromJson(map?['host']);
    final phone = PairingDevice.fromJson(map?['mobile']);
    if (map == null || map['v'] != 1 || state == null) {
      throw const PairingException('PAIRING_FAILED', 'The Server returned an invalid pairing status.');
    }
    if (map['sessionId'] != offer.sessionId ||
        host == null ||
        !host.sameIdentity(offer.host) ||
        phone == null ||
        !phone.sameIdentity(mobile)) {
      throw const PairingException(
        'PAIRING_IDENTITY_MISMATCH',
        'The pairing session no longer matches this computer or this phone.',
      );
    }
    final recover = asInt(map['recoverUntil']);
    final reason = asString(map['failureReason']);
    PairingCredentials? credentials;
    if (state == PairingState.completed) {
      credentials = _credentials(map['credentials'], mobile, now ?? DateTime.now());
    }
    return PairingStatus(
      state: state,
      recoverUntil: _date(recover),
      failureReason: reason == null || reason.isEmpty || reason.length > 128 ? null : reason,
      credentials: credentials,
    );
  }

  static PairingCredentials _credentials(Object? json, PairingDevice mobile, DateTime now) {
    final map = asMap(json);
    final account = asString(map?['account']);
    final kind = asString(map?['accountKind']);
    final device = PairingDevice.fromJson(map?['device']);
    final restricted = map?['pairingRestricted'];
    DeviceTokenPair? tokens;
    try {
      tokens = DeviceTokenPair.parse(map?['tokens']);
    } on Object {
      tokens = null;
    }
    if (map == null ||
        account == null ||
        account.isEmpty ||
        account.length > 320 ||
        (kind != 'device_only' && kind != 'standard') ||
        device == null ||
        !device.sameIdentity(mobile) ||
        device.role != 'client' ||
        map['inboundOnly'] != false ||
        restricted is! bool ||
        tokens == null ||
        !tokens.accessTokenExpiresAt.isAfter(now) ||
        !tokens.refreshTokenExpiresAt.isAfter(now)) {
      throw const PairingException('PAIRING_IDENTITY_MISMATCH', 'The Server returned invalid device credentials.');
    }
    return PairingCredentials(
      account: account,
      accountKind: kind!,
      device: device,
      tokens: tokens,
      pairingRestricted: restricted,
    );
  }
}

/// The exact claim body, serialized once (its bytes are what the proof signs).
String pairingClaimBody({required String scanSecret, required PairingDevice device, String? deepseekUserId}) {
  if (deepseekUserId != null && (deepseekUserId.isEmpty || deepseekUserId.length > 256)) {
    throw ArgumentError.value(deepseekUserId, 'deepseekUserId', 'must be 1–256 characters');
  }
  return jsonEncode({'scanSecret': scanSecret, 'device': device.toJson(), 'deepseekUserId': ?deepseekUserId});
}
