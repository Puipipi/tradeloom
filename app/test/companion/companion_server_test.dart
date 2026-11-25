import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/companion/companion_server.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class _Assets extends CachingAssetBundle {
  @override
  Future<ByteData> load(String key) async {
    if (key != 'assets/companion/index.html' && key != 'assets/companion/stage.js' &&
        key != 'assets/companion/float.js') {
      throw FlutterError('no asset $key');
    }
    return ByteData.sublistView(utf8.encode('asset:$key'));
  }
}

class _DelayedAssets extends _Assets {
  final entered = Completer<void>();
  final release = Completer<void>();
  @override
  Future<ByteData> load(String key) async {
    entered.complete();
    await release.future;
    return super.load(key);
  }
}

void main() {
  late Directory root;
  late Directory pack;
  late CompanionServer server;
  late HttpClient client;

  Future<(int, String, HttpHeaders)> get(Uri uri, {String method = 'GET'}) async {
    final request = await client.openUrl(method, uri);
    final response = await request.close();
    return (response.statusCode, await utf8.decodeStream(response), response.headers);
  }

  /// A URL on the server with [path] appended raw, past Uri's normalising.
  Uri at(String path) {
    final page = server.pageUrl();
    final token = page.pathSegments.first;
    return Uri.parse('http://127.0.0.1:${page.port}/$token/$path');
  }

  setUp(() async {
    root = Directory.systemTemp.createTempSync('companion-server');
    pack = Directory('${root.path}/pack')..createSync();
    File('${pack.path}/ok.png').writeAsStringSync('png');
    Directory('${pack.path}/character/贴图 1').createSync(recursive: true);
    File('${pack.path}/character/贴图 1/t.png').writeAsStringSync('tex');
    File('${root.path}/secret.txt').writeAsStringSync('secret');
    server = await CompanionServer.start(_Assets(), pack);
    client = HttpClient();
  });

  tearDown(() async {
    client.close(force: true);
    await server.close();
    root.deleteSync(recursive: true);
  });

  test('serves the page and the pack', () async {
    final (status, body, headers) = await get(server.pageUrl());
    expect(status, 200);
    expect(body, 'asset:assets/companion/index.html');
    expect(headers.contentType?.mimeType, 'text/html');
    expect(headers.value('x-content-type-options'), 'nosniff');
    expect((await get(at('app/stage.js'))).$1, 200);
    expect((await get(at('app/float.js'))).$1, 200);
    expect((await get(at('pack/ok.png'))).$2, 'png');
  });

  test('serves names with spaces and Chinese', () async {
    final uri = at('pack/character/${Uri.encodeComponent('贴图 1')}/t.png');
    expect((await get(uri)).$2, 'tex');
  });

  test('binds to loopback only', () {
    expect(server.pageUrl().host, '127.0.0.1');
  });

  test('without the token, nothing', () async {
    final page = server.pageUrl();
    for (final path in ['/', '/app/index.html', '/wrong/app/index.html', '/wrong/pack/ok.png']) {
      expect((await get(Uri.parse('http://127.0.0.1:${page.port}$path'))).$1, 404, reason: path);
    }
  });

  test('only the page\'s own files from the assets', () async {
    expect((await get(at('app/secret.js'))).$1, 404);
  });

  test('nothing outside the pack', () async {
    for (final path in [
      'pack/%2e%2e/secret.txt',
      'pack/..%2fsecret.txt',
      'pack/character/%2e%2e/%2e%2e/secret.txt',
      'pack/..%5csecret.txt',
    ]) {
      final (status, body, _) = await get(at(path));
      expect(status, 404, reason: path);
      expect(body, isNot(contains('secret')), reason: path);
    }
  });

  test('folders and missing files are not found', () async {
    expect((await get(at('pack/character'))).$1, 404);
    expect((await get(at('pack/none.png'))).$1, 404);
  });

  test('reads only', () async {
    expect((await get(at('pack/ok.png'), method: 'POST')).$1, 404);
    expect((await get(at('pack/ok.png'), method: 'DELETE')).$1, 404);
    expect(File('${pack.path}/ok.png').existsSync(), isTrue);
  });

  test('knows its own URLs', () {
    final page = server.pageUrl();
    expect(server.ownsUrl(page.toString()), isTrue);
    expect(server.ownsUrl(at('pack/ok.png').toString()), isTrue);
    expect(server.ownsUrl('https://example.com/'), isFalse);
    expect(server.ownsUrl('http://127.0.0.1:${page.port}/other/app/index.html'), isFalse);
    expect(server.ownsUrl('http://127.0.0.1:1/${page.pathSegments.first}/app/index.html'), isFalse);
  });

  test('close waits for late handlers before a pack can be replaced', () async {
    await server.close();
    final assets = _DelayedAssets();
    server = await CompanionServer.start(assets, pack);
    final request = await client.getUrl(server.pageUrl());
    final response = request.close().then<void>((_) {}, onError: (Object _) {});
    Future<void>? closingSettled;
    try {
      await assets.entered.future;
      var finished = false;
      final closing = server.close().then((_) => finished = true);
      // Observe errors immediately; the original Future still fails the test.
      closingSettled = closing.then<void>((_) {}, onError: (Object _) {});
      await Future<void>.delayed(Duration.zero);
      expect(finished, isFalse);
      assets.release.complete();
      await closing;
      await response;
      expect(finished, isTrue);
      await server.close(); // Shared close future is idempotent.
    } finally {
      if (!assets.release.isCompleted) {
        assets.release.complete();
      }
      if (closingSettled != null) {
        await closingSettled;
      }
      await response;
    }
  });
}
