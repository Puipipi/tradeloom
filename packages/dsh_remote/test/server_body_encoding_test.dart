import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

final _invalidBody = <int>[...utf8.encode('{"status":"ok","extra":"'), 0xc3, 0x28, ...utf8.encode('"}')];

Future<({HttpServer server, Uri url})> _server(int status, List<int> bytes) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) async {
    await request.drain<void>();
    request.response
      ..statusCode = status
      ..headers.contentType = ContentType.json
      ..bufferOutput = false;
    final split = bytes.length ~/ 2;
    request.response.add(bytes.sublist(0, split));
    await request.response.flush();
    request.response.add(bytes.sublist(split));
    await request.response.close();
  });
  return (server: server, url: Uri.parse('http://127.0.0.1:${server.port}'));
}

Matcher _apiError(String code, int status, bool retryable) => isA<RemoteApiException>()
    .having((error) => error.code, 'code', code)
    .having((error) => error.status, 'status', status)
    .having((error) => error.retryable, 'retryable', retryable);

void main() {
  for (final (status, code, retryable) in [
    (200, 'INVALID_MESSAGE', false),
    (401, 'AUTH_INVALID', false),
    (429, 'RATE_LIMITED', true),
    (503, 'CONNECTION_FAILED', true),
  ]) {
    test('malformed UTF8 HTTP $status follows the existing response error contract', () async {
      final fixture = await _server(status, _invalidBody);
      final api = RemoteServerApi(fixture.url);
      addTearDown(() async {
        api.close();
        await fixture.server.close(force: true);
      });
      await expectLater(api.health(), throwsA(_apiError(code, status, retryable)));
    });
  }
  test('public account caller classifies malformed success as final bad response', () async {
    final fixture = await _server(200, _invalidBody);
    final account = RemoteAccount(secrets: MemorySecretStore(), serverUrl: fixture.url);
    addTearDown(() async {
      await account.close();
      await fixture.server.close(force: true);
    });
    await expectLater(
      account.loginProviders(),
      throwsA(
        isA<RemoteConnectException>()
            .having((error) => error.code, 'code', 'INVALID_MESSAGE')
            .having((error) => error.failure.retryable, 'retryable', false),
      ),
    );
  });
  test('valid UTF8 split writes retain Unicode and BOM response acceptance', () async {
    final fixture = await _server(200, [0xef, 0xbb, 0xbf, ...utf8.encode('{"account":"用户😀"}')]);
    final api = RemoteServerApi(fixture.url);
    addTearDown(() async {
      api.close();
      await fixture.server.close(force: true);
    });
    expect(await api.accountMe('fixture-token'), '用户😀');
  });
  test('valid UTF8 malformed JSON preserves success and error status fallbacks', () async {
    for (final (status, code, retryable) in [
      (200, 'INVALID_MESSAGE', false),
      (401, 'AUTH_INVALID', false),
      (503, 'CONNECTION_FAILED', true),
    ]) {
      final fixture = await _server(status, utf8.encode('not JSON'));
      final api = RemoteServerApi(fixture.url);
      try {
        await expectLater(api.health(), throwsA(_apiError(code, status, retryable)));
      } finally {
        api.close();
        await fixture.server.close(force: true);
      }
    }
  });
  test('valid structured error envelope keeps server code and retry advice', () async {
    final fixture = await _server(
      401,
      utf8.encode('{"error":{"code":"TOKEN_EXPIRED","message":"fixture","retryable":true}}'),
    );
    final api = RemoteServerApi(fixture.url);
    addTearDown(() async {
      api.close();
      await fixture.server.close(force: true);
    });
    await expectLater(api.health(), throwsA(_apiError('TOKEN_EXPIRED', 401, true)));
  });
  test('truncated HTTP body remains a transport failure rather than bad encoding', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      await request.drain<void>();
      request.response
        ..statusCode = 200
        ..contentLength = 100;
      final socket = await request.response.detachSocket(writeHeaders: true);
      socket.add(utf8.encode('{}'));
      await socket.flush();
      await socket.close();
    });
    final api = RemoteServerApi('http://127.0.0.1:${server.port}');
    addTearDown(() async {
      api.close();
      await server.close(force: true);
    });
    await expectLater(
      api.health(),
      throwsA(
        isA<RemoteApiException>()
            .having((error) => error.code, 'code', 'CONNECTION_FAILED')
            .having((error) => error.retryable, 'retryable', true),
      ),
    );
  });
}
