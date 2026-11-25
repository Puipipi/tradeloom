import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';

const _deviceId = '00000000-0000-4000-8000-000000000435';

class _Fixture {
  _Fixture(this.server, this.http, this.api, this.webToken, this.tokens);

  final FakeRemoteServer server;
  final HttpClient http;
  final RemoteServerApi api;
  final String webToken;
  final DeviceTokenPair tokens;

  static Future<_Fixture> open() async {
    final server = await FakeRemoteServer.start();
    final http = HttpClient()..maxConnectionsPerHost = 1;
    final api = RemoteServerApi(server.url, httpClient: http);
    addTearDown(() async {
      api.close();
      http.close(force: true);
      await server.close();
    });
    final webToken = server.mintWebToken();
    final tokens = await api.registerDevice(
      DeviceDescriptor(
        deviceId: _deviceId,
        name: 'request deadline test',
        role: 'client',
        platform: 'test',
        identityKey: base64Url.encode(List<int>.filled(32, 0)).replaceAll('=', ''),
        clientVersion: '0.1.0',
      ),
      webToken,
    );
    server.requests.clear();
    return _Fixture(server, http, api, webToken, tokens);
  }

  Future<void> change(RemoteServerApi caller, {required bool revoke}) async {
    if (revoke) {
      await caller.revokeSelf(tokens.accessToken);
    } else {
      await caller.refresh(_deviceId, tokens.refreshToken);
    }
  }
}

void main() {
  for (final revoke in [false, true]) {
    final operation = revoke ? 'revoke' : 'refresh';
    final route = revoke ? 'DELETE /api/v1/devices/self' : 'POST /api/v1/auth/refresh';

    test('$operation does not start after a queued request has timed out', () async {
      final f = await _Fixture.open();
      final entered = Completer<void>(), release = Completer<void>();
      f.server.beforeAccountLookupResponse = () {
        entered.complete();
        return release.future;
      };
      final occupying = f.api.accountMe(f.webToken);
      await entered.future;
      final expired = RemoteServerApi(f.server.url, httpClient: f.http, timeout: Duration.zero);
      try {
        await expectLater(
          f.change(expired, revoke: revoke),
          throwsA(
            isA<RemoteApiException>()
                .having((e) => e.code, 'code', 'CONNECTION_FAILED')
                .having((e) => e.retryable, 'retryable', isTrue)
                .having((e) => e.message, 'message', 'The server request timed out.'),
          ),
        );
      } finally {
        release.complete();
        await occupying;
      }

      // The same one-connection pool must process the late acquisition
      // before this subsequent request can finish; no quiet-time guess.
      await f.api.health();
      expect(f.server.requests, ['GET /api/v1/auth/me', 'GET /health']);
      expect(f.server.refreshCount, 0);
      expect(f.server.devices[_deviceId]!.revoked, isFalse);
    });

    test('$operation still sends an authenticated request within its deadline', () async {
      final f = await _Fixture.open();
      await f.change(f.api, revoke: revoke);
      await f.api.health();
      expect(f.server.requests, [route, 'GET /health']);
      expect(f.server.refreshCount, revoke ? 0 : 1);
      expect(f.server.devices[_deviceId]!.revoked, revoke);
    });
  }
}
