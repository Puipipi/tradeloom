// SPDX-FileCopyrightText: 2026 DSH Remote contributors
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.
// REST client for a ds-harness-remote Server (`/api/v1/*`).
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../transport/peer_connection.dart' show RemoteIceServer;
import '../util/bytes.dart';

/// Default hosted Server (李国宝's deployment).
final Uri defaultRemoteServer = Uri.parse('https://dsh.r2049.cn');

/// Normalizes a user-entered Server address to an origin without a trailing
/// slash. HTTPS is required except for loopback / private-network hosts
/// (development and self-hosting on a LAN).
Uri normalizeServerUrl(Object input) {
  var text = (input is Uri ? input.toString() : input.toString()).trim();
  while (text.endsWith('/')) {
    text = text.substring(0, text.length - 1);
  }
  if (text.isEmpty) throw ArgumentError.value(input, 'serverUrl', 'is empty');
  if (!RegExp(r'^[a-z][a-z\d+.-]*://', caseSensitive: false).hasMatch(text)) text = 'https://$text';
  final uri = Uri.parse(text);
  if (uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment || (uri.path.isNotEmpty && uri.path != '/')) {
    throw ArgumentError.value(input, 'serverUrl', 'must be a bare origin');
  }
  final scheme = uri.scheme.toLowerCase();
  if (scheme != 'https' && !(scheme == 'http' && _isPrivateHost(uri.host))) {
    throw ArgumentError.value(input, 'serverUrl', 'must use HTTPS (HTTP only for local/private hosts)');
  }
  return Uri(scheme: scheme, host: uri.host, port: uri.hasPort ? uri.port : null);
}

bool _isPrivateHost(String host) {
  // Uri.host keeps brackets around IPv6 literals; parse bytes rather than
  // prefixes so expanded, compressed and uppercase spellings agree.
  final literal = host.startsWith('[') && host.endsWith(']') ? host.substring(1, host.length - 1) : host;
  final address = InternetAddress.tryParse(literal);
  if (address == null) {
    return host == 'localhost' || host.endsWith('.local') || host.endsWith('.test') || host.endsWith('.localhost');
  }
  final bytes = address.rawAddress;
  if (address.type == InternetAddressType.IPv6) {
    return (bytes[0] & 0xfe) == 0xfc ||
        (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80) ||
        (bytes.last == 1 && bytes.take(15).every((byte) => byte == 0));
  }
  final a = bytes[0];
  final b = bytes[1];
  return a == 10 ||
      a == 127 ||
      (a == 172 && b >= 16 && b <= 31) ||
      (a == 192 && b == 168) ||
      (a == 169 && b == 254) ||
      (a == 100 && b >= 64 && b <= 127);
}

/// `wss://<host>/ws/v1/connect` for [server].
Uri controlSocketUrl(Uri server) =>
    server.replace(scheme: server.scheme == 'https' ? 'wss' : 'ws', path: '/ws/v1/connect');

/// A Server REST failure, from the `{error: {code, message, retryable}}`
/// envelope or the HTTP status. Codes: `AUTH_INVALID`, `TOKEN_EXPIRED`,
/// `ACCOUNT_AUTH_REQUIRED`, `DEVICE_NOT_FOUND`, `DEVICE_REVOKED`,
/// `MEMBERSHIP_REQUIRED`, `PEER_IDENTITY_MISMATCH`, `RATE_LIMITED`,
/// `CONNECTION_FAILED` (network), `INVALID_MESSAGE` (bad response), ...
class RemoteApiException implements Exception {
  const RemoteApiException(this.code, this.message, {this.status, this.retryable = false});

  final String code;
  final String message;
  final int? status;
  final bool retryable;

  bool get isAuthFailure =>
      code == 'AUTH_INVALID' || code == 'TOKEN_EXPIRED' || code == 'AUTH_REQUIRED' || code == 'ACCOUNT_AUTH_REQUIRED';

  @override
  String toString() => 'RemoteApiException($code${status == null ? '' : ', HTTP $status'}): $message';
}

/// Server-owned OAuth provider (ids are opaque).
class OAuthProvider {
  const OAuthProvider({required this.id, required this.displayName, required this.startUrl, this.qrStartUrl});

  final String id;
  final String displayName;
  final String startUrl;

  /// `null` when the provider cannot be used for the QR/poll sign-in.
  final String? qrStartUrl;

  bool get supportsQrLogin => qrStartUrl != null;
}

/// A started QR sign-in session.
class QrLoginSession {
  const QrLoginSession({required this.qrId, required this.scanUrl, required this.expiresIn, this.provider});

  final String qrId;

  /// Same-origin page to open in a browser / Custom Tab (or show as QR).
  final Uri scanUrl;
  final Duration expiresIn;
  final String? provider;
}

sealed class QrPollResult {
  const QrPollResult();
}

final class QrPending extends QrPollResult {
  const QrPending();
}

final class QrExpired extends QrPollResult {
  const QrExpired();
}

final class QrComplete extends QrPollResult {
  const QrComplete(this.accountToken);

  /// One-time web account token: register the device, then discard it.
  final String accountToken;
}

class AccountLogin {
  const AccountLogin({required this.token, required this.account, this.expiresAt});

  final String token;
  final String account;
  final DateTime? expiresAt;
}

/// Device descriptor sent at registration. Client descriptors never
/// carry `harnessVersion`.
class DeviceDescriptor {
  const DeviceDescriptor({
    required this.deviceId,
    required this.name,
    required this.role,
    required this.platform,
    required this.identityKey,
    required this.clientVersion,
  });

  final String deviceId;
  final String name;
  final String role;
  final String platform;
  final String identityKey;
  final String clientVersion;

  JsonMap toJson() => {
    'deviceId': deviceId,
    'name': name,
    'role': role,
    'platform': platform,
    'identityKey': identityKey,
    'clientVersion': clientVersion,
  };

  /// Throws [ArgumentError] unless the descriptor is valid for registration.
  void validate() {
    final uuid = RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      caseSensitive: false,
    );
    final ulid = RegExp(r'^[0-9A-HJKMNP-TV-Z]{26}$', caseSensitive: false);
    if (!uuid.hasMatch(deviceId) && !ulid.hasMatch(deviceId)) {
      throw ArgumentError.value(deviceId, 'deviceId', 'must be a UUID or ULID');
    }
    final nameBytes = utf8.encode(name).length;
    if (name.trim().isEmpty || nameBytes > 128) {
      throw ArgumentError.value(name, 'name', 'must be 1..128 bytes of visible text');
    }
    if (role != 'client' && role != 'host') throw ArgumentError.value(role, 'role');
    if (platform.length > 64 || !RegExp(r'^[a-z0-9][a-z0-9._-]*$').hasMatch(platform)) {
      throw ArgumentError.value(platform, 'platform', 'must match [a-z0-9][a-z0-9._-]* (≤ 64)');
    }
    if (!identityKeyPattern.hasMatch(identityKey)) {
      throw ArgumentError.value(identityKey, 'identityKey');
    }
    final versionBytes = utf8.encode(clientVersion).length;
    if (versionBytes < 1 || versionBytes > 64) {
      throw ArgumentError.value(clientVersion, 'clientVersion');
    }
  }
}

/// Device access + refresh credentials. The refresh token rotates on
/// every use; reusing an old one revokes the whole token family.
class DeviceTokenPair {
  const DeviceTokenPair({
    required this.accessToken,
    required this.accessTokenExpiresAt,
    required this.refreshToken,
    required this.refreshTokenExpiresAt,
  });

  factory DeviceTokenPair.parse(Object? input) {
    final map = asMap(input);
    if (map == null) {
      throw const RemoteApiException('INVALID_MESSAGE', 'The server returned invalid device credentials.');
    }
    const allowed = {'accessToken', 'accessTokenExpiresAt', 'refreshToken', 'refreshTokenExpiresAt'};
    bool token(Object? v) => v is String && utf8.encode(v).length >= 16 && utf8.encode(v).length <= 8192;
    bool expiry(Object? v) => v is int && v > 0 && v <= maxSafeInteger;
    if (map.keys.any((k) => !allowed.contains(k)) ||
        !token(map['accessToken']) ||
        !token(map['refreshToken']) ||
        !expiry(map['accessTokenExpiresAt']) ||
        !expiry(map['refreshTokenExpiresAt'])) {
      throw const RemoteApiException('INVALID_MESSAGE', 'The server returned invalid device credentials.');
    }
    return DeviceTokenPair(
      accessToken: map['accessToken']! as String,
      accessTokenExpiresAt: DateTime.fromMillisecondsSinceEpoch(map['accessTokenExpiresAt']! as int),
      refreshToken: map['refreshToken']! as String,
      refreshTokenExpiresAt: DateTime.fromMillisecondsSinceEpoch(map['refreshTokenExpiresAt']! as int),
    );
  }

  final String accessToken;
  final DateTime accessTokenExpiresAt;
  final String refreshToken;
  final DateTime refreshTokenExpiresAt;
}

/// A Host as listed by `GET /api/v1/devices` (no identity key there).
class ServerHostListing {
  const ServerHostListing({
    required this.deviceId,
    required this.name,
    required this.platform,
    required this.membershipId,
    required this.online,
    this.clientVersion,
    this.harnessVersion,
    this.lastSeenAt,
  });

  final String deviceId;
  final String name;
  final String platform;
  final String membershipId;
  final bool online;
  final String? clientVersion;
  final String? harnessVersion;
  final DateTime? lastSeenAt;
}

/// `GET /api/v1/devices/{id}`: the authorized peer descriptor, including
/// the Noise identity key to pin.
class AuthorizedPeer {
  const AuthorizedPeer({
    required this.deviceId,
    required this.name,
    required this.role,
    required this.platform,
    required this.identityKey,
    required this.membershipId,
    this.online,
    this.lastSeenAt,
    this.clientVersion,
    this.harnessVersion,
  });

  final String deviceId;
  final String name;
  final String role;
  final String platform;
  final String identityKey;
  final String membershipId;
  final bool? online;
  final DateTime? lastSeenAt;
  final String? clientVersion;
  final String? harnessVersion;
}

/// What login discovery says about device pairing.
class RemoteServerCapabilities {
  const RemoteServerCapabilities({this.devicePairing, this.devicePairingQr});

  /// `dsh-pairing-v1` when the Server pairs devices by scanning.
  final String? devicePairing;

  /// `fragment-ticket-v1` when it resolves the short QR code.
  final String? devicePairingQr;
}

/// Thin, validating REST client. Bearer tokens are passed per call and
/// never logged or put in URLs.
class RemoteServerApi {
  RemoteServerApi(Object serverUrl, {HttpClient? httpClient, this.timeout = const Duration(seconds: 10)})
    : serverUrl = normalizeServerUrl(serverUrl),
      _http = httpClient ?? (HttpClient()..connectionTimeout = timeout),
      _ownsClient = httpClient == null;

  final Uri serverUrl;
  final Duration timeout;
  final HttpClient _http;
  final bool _ownsClient;

  Future<void> health() async {
    final body = asMap(await _request('GET', '/health'));
    if (body?['status'] != 'ok') {
      throw const RemoteApiException('CONNECTION_FAILED', 'The server health check failed.');
    }
  }

  /// Server-defined OAuth providers; falls back to the legacy per-provider
  /// status endpoints only when the discovery endpoint is 404.
  Future<List<OAuthProvider>> oauthProviders() async {
    Object? body;
    try {
      body = await _request('GET', '/api/v1/auth/oauth/providers');
    } on RemoteApiException catch (error) {
      if (error.status != 404) rethrow;
      final legacy = <OAuthProvider>[];
      for (final (id, name, status, start) in const [
        ('zhihu', '知乎', '/api/v1/auth/oauth/status', '/api/v1/auth/oauth/start'),
        ('github', 'GitHub', '/api/v1/auth/oauth/github/status', '/api/v1/auth/oauth/github/start'),
      ]) {
        try {
          final configured = asMap(await _request('GET', status))?['configured'] == true;
          if (configured) {
            legacy.add(
              OAuthProvider(
                id: id,
                displayName: name,
                startUrl: start,
                qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=$id',
              ),
            );
          }
        } on RemoteApiException catch (reason) {
          if (reason.status == 404) continue;
          rethrow;
        }
      }
      return legacy;
    }
    final items = asMap(body)?['items'];
    if (items is! List) {
      throw const RemoteApiException('INVALID_MESSAGE', 'The server returned invalid OAuth providers.');
    }
    final ids = <String>{};
    return items.map((raw) {
      final item = asMap(raw);
      final id = asString(item?['id']);
      final name = asString(item?['displayName']);
      final start = item?['startUrl'];
      final qr = item?['qrStartUrl'];
      if (id == null ||
          !RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$').hasMatch(id) ||
          !ids.add(id) ||
          name == null ||
          name.trim().isEmpty ||
          name.length > 128 ||
          !_isAuthEntryPath(start) ||
          (qr != null && !_isAuthEntryPath(qr))) {
        throw const RemoteApiException('INVALID_MESSAGE', 'The server returned invalid OAuth providers.');
      }
      return OAuthProvider(id: id, displayName: name, startUrl: start! as String, qrStartUrl: qr as String?);
    }).toList();
  }

  /// `POST <qrStartUrl>` → `{qrId, scanUrl, expiresIn, provider?}`.
  Future<QrLoginSession> startQrLogin(OAuthProvider provider) async {
    final path = provider.qrStartUrl;
    if (path == null) {
      throw const RemoteApiException('INVALID_MESSAGE', 'This provider does not support QR sign-in.');
    }
    final body = asMap(await _request('POST', path, body: const <String, Object?>{}));
    final qrId = asString(body?['qrId']);
    final expiresIn = asInt(body?['expiresIn']);
    final scanUrl = _sameOriginScanUrl(body?['scanUrl']);
    if (qrId == null ||
        qrId.length < 20 ||
        expiresIn == null ||
        expiresIn <= 0 ||
        scanUrl == null ||
        (body!['provider'] != null && body['provider'] != provider.id)) {
      throw const RemoteApiException('INVALID_MESSAGE', 'The server returned an invalid QR sign-in session.');
    }
    return QrLoginSession(
      qrId: qrId,
      scanUrl: scanUrl,
      expiresIn: Duration(seconds: expiresIn),
      provider: provider.id,
    );
  }

  /// `GET /api/v1/auth/oauth/qr/{qrId}`: the token is returned exactly once.
  Future<QrPollResult> pollQrLogin(String qrId) async {
    final body = asMap(await _request('GET', '/api/v1/auth/oauth/qr/${Uri.encodeComponent(qrId)}'));
    switch (body?['status']) {
      case 'pending':
        return const QrPending();
      case 'expired':
        return const QrExpired();
      case 'complete':
        final token = asString(body!['token']);
        if (token != null && token.length >= 16) return QrComplete(token);
    }
    throw const RemoteApiException('INVALID_MESSAGE', 'The server returned an invalid QR sign-in status.');
  }

  /// Email/password sign-in (self-hosted Server; also the hosted one).
  Future<AccountLogin> loginWithPassword(String email, String password) async {
    final body = asMap(
      await _request('POST', '/api/v1/auth/login', body: {'email': email.trim(), 'password': password}),
    );
    final token = asString(body?['token']);
    final account = asString(body?['account']);
    if (token == null || token.length < 16 || account == null || account.isEmpty) {
      throw const RemoteApiException('INVALID_MESSAGE', 'The server returned an invalid account login.');
    }
    final expiresAt = asInt(body!['expiresAt']);
    return AccountLogin(
      token: token,
      account: account,
      expiresAt: expiresAt == null ? null : DateTime.fromMillisecondsSinceEpoch(expiresAt),
    );
  }

  /// `GET /api/v1/auth/me` with an account (web) token → account name.
  Future<String> accountMe(String accountToken) async {
    final account = asString(asMap(await _request('GET', '/api/v1/auth/me', bearer: accountToken))?['account']);
    if (account == null || account.isEmpty) {
      throw const RemoteApiException('INVALID_MESSAGE', 'The server returned an invalid account profile.');
    }
    return account;
  }

  /// `POST /api/v1/devices/register` under an account token.
  Future<DeviceTokenPair> registerDevice(DeviceDescriptor device, String accountToken) async {
    device.validate();
    return DeviceTokenPair.parse(
      await _request(
        'POST',
        '/api/v1/devices/register',
        body: {'v': 1, 'device': device.toJson()},
        bearer: accountToken,
      ),
    );
  }

  /// `POST /api/v1/auth/refresh` (rotates the refresh token).
  Future<DeviceTokenPair> refresh(String deviceId, String refreshToken) async => DeviceTokenPair.parse(
    await _request('POST', '/api/v1/auth/refresh', body: {'deviceId': deviceId, 'refreshToken': refreshToken}),
  );

  /// Hosts this client may reach (same-account membership).
  Future<List<ServerHostListing>> listHosts(String accessToken) async {
    final items = asMap(await _request('GET', '/api/v1/devices', bearer: accessToken))?['items'];
    if (items is! List) {
      throw const RemoteApiException('INVALID_MESSAGE', 'The server returned an invalid device list.');
    }
    final hosts = <ServerHostListing>[];
    for (final raw in items) {
      final item = asMap(raw);
      if (item == null ||
          item['role'] != 'host' ||
          asString(item['deviceId']) == null ||
          asString(item['name']) == null ||
          asString(item['platform']) == null ||
          (asString(item['membershipId']) ?? '').isEmpty) {
        continue;
      }
      final lastSeen = asInt(item['lastSeenAt']);
      hosts.add(
        ServerHostListing(
          deviceId: item['deviceId']! as String,
          name: item['name']! as String,
          platform: item['platform']! as String,
          membershipId: item['membershipId']! as String,
          online: item['online'] == true,
          clientVersion: asString(item['clientVersion']),
          harnessVersion: asString(item['harnessVersion']),
          lastSeenAt: lastSeen == null || lastSeen <= 0 ? null : DateTime.fromMillisecondsSinceEpoch(lastSeen),
        ),
      );
    }
    return hosts;
  }

  /// `GET /api/v1/devices/{id}`: descriptor with the identity key.
  Future<AuthorizedPeer> device(String accessToken, String deviceId) async {
    final item = asMap(await _request('GET', '/api/v1/devices/${Uri.encodeComponent(deviceId)}', bearer: accessToken));
    final role = item?['role'];
    if (item == null ||
        (role != 'host' && role != 'client') ||
        (asString(item['deviceId']) ?? '').isEmpty ||
        (asString(item['name']) ?? '').isEmpty ||
        asString(item['platform']) == null ||
        (asString(item['identityKey']) ?? '').isEmpty ||
        (asString(item['membershipId']) ?? '').isEmpty) {
      throw const RemoteApiException('INVALID_MESSAGE', 'The server returned an invalid peer descriptor.');
    }
    // Older deployments inline presence; newer Servers expose it separately.
    // Absence is not an offline verdict. Never downgrade authentication or
    // malformed responses to an offline Host.
    Map<String, Object?> presence = item;
    if (item['online'] is! bool) {
      final value = asMap(
        await _request('GET', '/api/v1/devices/${Uri.encodeComponent(deviceId)}/presence', bearer: accessToken),
      );
      if (value == null || value['online'] is! bool || (value['deviceId'] != null && value['deviceId'] != deviceId)) {
        throw const RemoteApiException('INVALID_MESSAGE', 'The server returned invalid device presence.');
      }
      presence = value;
    }
    final lastSeen = asInt(presence['lastSeenAt']);
    return AuthorizedPeer(
      deviceId: item['deviceId']! as String,
      name: item['name']! as String,
      role: role! as String,
      platform: item['platform']! as String,
      identityKey: item['identityKey']! as String,
      membershipId: item['membershipId']! as String,
      online: presence['online']! as bool,
      lastSeenAt: lastSeen == null || lastSeen <= 0 ? null : DateTime.fromMillisecondsSinceEpoch(lastSeen),
      clientVersion: asString(item['clientVersion']),
      harnessVersion: asString(item['harnessVersion']),
    );
  }

  /// `DELETE /api/v1/devices/self`: revokes this device on the Server.
  Future<void> revokeSelf(String accessToken) => _request('DELETE', '/api/v1/devices/self', bearer: accessToken);

  /// `GET /api/v1/turn/credentials?connection_id=`: STUN / TURN servers for
  /// one authorized connection (TURN credentials are short-lived). Entries
  /// without usable `urls` are skipped.
  Future<List<RemoteIceServer>> turnCredentials(String accessToken, String connectionId) async {
    final body = asMap(
      await _request(
        'GET',
        '/api/v1/turn/credentials?connection_id=${Uri.encodeQueryComponent(connectionId)}',
        bearer: accessToken,
      ),
    );
    final servers = body?['iceServers'];
    if (servers is! List) return const [];
    final result = <RemoteIceServer>[];
    for (final raw in servers) {
      final server = asMap(raw);
      final urls = switch (server?['urls']) {
        final String url => [url],
        final List<Object?> list when list.isNotEmpty && list.every((u) => u is String) => list.cast<String>(),
        _ => null,
      };
      if (server == null || urls == null) continue;
      result.add(
        RemoteIceServer(urls, username: asString(server['username']), credential: asString(server['credential'])),
      );
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Device pairing v1 (upstream docs/device-pairing-v1.md)

  /// Login discovery's `capabilities` (`devicePairing`, `devicePairingQr`).
  /// A Server without the discovery endpoint (404) declares none; any other
  /// failure is reported, never read as "unsupported".
  Future<RemoteServerCapabilities> serverCapabilities() async {
    Object? body;
    try {
      body = await _request('GET', '/api/v1/auth/oauth/providers');
    } on RemoteApiException catch (error) {
      if (error.status == 404) return const RemoteServerCapabilities();
      rethrow;
    }
    final map = asMap(body);
    final raw = map?['capabilities'];
    final capabilities = asMap(raw);
    if (map == null || map['items'] is! List || (raw != null && capabilities == null)) {
      throw const RemoteApiException('INVALID_MESSAGE', 'The server returned invalid sign-in capabilities.');
    }
    return RemoteServerCapabilities(
      devicePairing: asString(capabilities?['devicePairing']),
      devicePairingQr: asString(capabilities?['devicePairingQr']),
    );
  }

  /// `POST /api/v1/device-pairing/resolve`: the session behind a short code.
  /// Read-only on the Server (it does not use up the claim), so a lost
  /// response may be asked again with the same ticket.
  Future<Object?> resolvePairing(String ticket) =>
      _request('POST', '/api/v1/device-pairing/resolve', rawJson: jsonEncode({'ticket': ticket}));

  /// One proof-carrying pairing POST; [rawJson] is sent byte for byte.
  Future<Object?> pairingPost(String path, String rawJson, String proof) {
    if (!RegExp(r'^/api/v1/device-pairing/sessions/[0-9a-fA-F-]{36}/[a-z/]+$').hasMatch(path)) {
      throw ArgumentError.value(path, 'path');
    }
    return _request('POST', path, rawJson: rawJson, headers: {'X-DSH-Pairing-Proof': proof});
  }

  void close() {
    if (_ownsClient) _http.close(force: true);
  }

  // ---------------------------------------------------------------------------

  Future<Object?> _request(
    String method,
    String path, {
    Object? body,
    String? rawJson,
    Map<String, String> headers = const {},
    String? bearer,
  }) async {
    final uri = serverUrl.resolve(path);
    if (uri.origin != serverUrl.origin) {
      throw const RemoteApiException('INVALID_MESSAGE', 'Refusing a cross-origin Server request.');
    }
    HttpClientRequest? request;
    TimeoutException? expired;
    Future<(int, String)> run() async {
      request = await _http.openUrl(method, uri);
      final req = request!;
      final deadline = expired;
      if (deadline != null) {
        req.done.ignore();
        req.abort(deadline);
        throw deadline;
      }
      req.followRedirects = false;
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (bearer != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
      headers.forEach(req.headers.set);
      if (body != null || rawJson != null) {
        // [rawJson] goes out byte for byte (a pairing proof signs these bytes).
        final bytes = utf8.encode(rawJson ?? jsonEncode(body));
        req.headers.contentType = ContentType.json;
        req.contentLength = bytes.length;
        req.add(bytes);
      }
      final response = await req.close();
      final String text;
      try {
        text = await utf8.decodeStream(response);
      } on FormatException {
        if (response.statusCode >= 300) return (response.statusCode, '');
        throw RemoteApiException(
          'INVALID_MESSAGE',
          'The server returned an invalid response body.',
          status: response.statusCode,
        );
      }
      return (response.statusCode, text);
    }

    final int status;
    final String text;
    try {
      (status, text) = await run().timeout(timeout);
    } on TimeoutException catch (error) {
      expired = error;
      request?.abort();
      throw const RemoteApiException('CONNECTION_FAILED', 'The server request timed out.', retryable: true);
    } on SocketException catch (error) {
      throw RemoteApiException('CONNECTION_FAILED', 'Server request failed: ${error.message}', retryable: true);
    } on HttpException catch (error) {
      throw RemoteApiException('CONNECTION_FAILED', 'Server request failed: ${error.message}', retryable: true);
    } on HandshakeException catch (error) {
      throw RemoteApiException('CONNECTION_FAILED', 'TLS handshake failed: ${error.message}', retryable: true);
    }
    Object? decoded;
    if (text.isNotEmpty) {
      decoded = tryDecodeJson(text);
      if (decoded == null && status < 300) {
        throw RemoteApiException('INVALID_MESSAGE', 'The server returned invalid JSON.', status: status);
      }
    }
    if (status >= 200 && status < 300) return decoded;
    final error = asMap(asMap(decoded)?['error']);
    final code = asString(error?['code']) ?? asString(asMap(decoded)?['code']) ?? _statusCode(status);
    final message =
        asString(error?['message']) ?? asString(asMap(decoded)?['detail']) ?? 'The server rejected the request.';
    throw RemoteApiException(
      code,
      message,
      status: status,
      retryable: error?['retryable'] == true || status >= 500 || status == 429,
    );
  }

  static String _statusCode(int status) => switch (status) {
    401 => 'AUTH_INVALID',
    403 => 'AUTH_REQUIRED',
    404 => 'DEVICE_NOT_FOUND',
    409 => 'DEVICE_OWNERSHIP_REQUIRED',
    429 => 'RATE_LIMITED',
    _ => status >= 500 ? 'CONNECTION_FAILED' : 'INVALID_MESSAGE',
  };

  /// Only same-origin `/api/v1/auth/` entry paths: a compromised discovery
  /// response must not turn the client into an open request forwarder.
  static bool _isAuthEntryPath(Object? value) {
    if (value is! String ||
        !value.startsWith('/api/v1/auth/') ||
        RegExp(r'[\u0000-\u001f\u007f\s\\#]').hasMatch(value)) {
      return false;
    }
    return !value.split('?').first.split('/').any((s) => s == '.' || s == '..' || s.contains('%'));
  }

  Uri? _sameOriginScanUrl(Object? value) {
    if (value is! String || RegExp(r'[\u0000-\u001f\u007f]').hasMatch(value)) return null;
    final uri = Uri.tryParse(value);
    if (uri == null || !uri.hasScheme || uri.origin != serverUrl.origin) return null;
    return uri;
  }
}
