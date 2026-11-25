import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/ui/tradeloom/tradeloom_mesh_client.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the adapter only invokes the local Mesh read and consent protocol', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final localOrigin = Uri.parse('http://127.0.0.1:${server.port}');
    final engine = DshConnection(
      localOrigin,
      cookie: DshCookie(name: 'synthetic', value: 'cookie', authority: localOrigin.authority),
    );
    addTearDown(engine.close);
    final calls = <(String, Uri, Object?)>[];
    server.listen((request) async {
      final body = await utf8.decoder.bind(request).join();
      calls.add((request.method, request.uri, body.isEmpty ? null : jsonDecode(body)));
      expect(request.headers.value(HttpHeaders.cookieHeader), 'synthetic=cookie');
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode(switch (request.uri.path) {
          '/.dsh-mesh/v1/nodes' => {
            'items': [
              {'nodeId': 'desktop', 'name': 'Desktop', 'online': true, 'clientDeviceId': 'desktop-reader'},
            ],
          },
          '/.dsh-mesh/v1/tree' => {'nodes': []},
          '/.dsh-mesh/v1/sessions/desktop/session-one/page' => {'records': [], 'cursor': 1},
          _ => <String, Object?>{},
        }),
      );
      await request.response.close();
    });
    final mesh = TradeLoomMeshClient(engine);
    const invitation = 'dshmesh://relay.example.test/pair?v=1&code=TEST0000';
    await expectLater(mesh.pair(invitation, confirmed: false), throwsStateError);
    expect(calls, isEmpty);

    await mesh.status();
    await mesh.pair(invitation, confirmed: true);
    final devices = await mesh.devices();
    expect(devices.single.nodeId, 'desktop');
    await mesh.catalog(devices.single.nodeId);
    expect((await mesh.session('desktop', 'session-one'))['cursor'], 1);
    await mesh.setReadConsent('desktop-reader', allow: true);
    await mesh.setReadConsent('desktop-reader', allow: false);
    await mesh.unpair();

    expect(calls.map((call) => '${call.$1} ${call.$2}'), [
      'GET /.dsh-mesh/v1/status',
      'POST /.dsh-mesh/v1/pair',
      'GET /.dsh-mesh/v1/nodes',
      'GET /.dsh-mesh/v1/tree?nodeId=desktop',
      'GET /.dsh-mesh/v1/sessions/desktop/session-one/page',
      'POST /.dsh-mesh/v1/consent',
      'POST /.dsh-mesh/v1/consent',
      'POST /.dsh-mesh/v1/unpair',
    ]);
    expect(calls[1].$3, {'pairing': invitation, 'confirmed': true});
    expect(calls[5].$3, {'deviceId': 'desktop-reader', 'allow': true});
    expect(calls[6].$3, {'deviceId': 'desktop-reader', 'allow': false});
  });

  test('remote origins and Host overrides cannot receive this adapter’s credentials', () {
    for (final engine in [
      DshConnection(Uri.parse('https://remote.example.test')),
      DshConnection(Uri.parse('http://127.0.0.1:1234'), hostHeader: 'remote.example.test'),
    ]) {
      addTearDown(engine.close);
      expect(() => TradeLoomMeshClient(engine), throwsArgumentError);
    }
  });
}
