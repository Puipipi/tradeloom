import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/ui/remote/pairing_page.dart';
import 'package:dsh_app/ui/tradeloom/tradeloom_mesh_page.dart';
import 'package:dsh_app/ui/tradeloom/tradeloom_workbench_page.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../chat/support/harness.dart' show testApp;
import '../shell/adaptive/support.dart' show useWindow;

const _invitation = 'dshmesh://relay.example.test/pair?v=1&code=TEST0000';

class _LocalEngineController extends LocalConnectionController {
  _LocalEngineController(this.client);
  final DshClient client;

  @override
  Future<HostConnection?> build() async => HostConnection(client: client, isLocal: true);
}

class _Engine extends DshConnection {
  _Engine() : super(Uri.parse('http://127.0.0.1:3080'));

  bool paired = false;
  bool legacyPlugin = false;
  bool denied = false;
  bool relayOffline = false;
  bool badPin = false;
  int pairRequests = 0;
  final consent = <bool>[];

  DshHttpResponse _reply(Object? value, [int code = 200]) =>
      DshHttpResponse(code, 'application/json', Uint8List.fromList(utf8.encode(jsonEncode(value))));

  @override
  Future<DshHttpResponse> get(
    String path, {
    Map<String, String>? query,
    Map<String, String>? headers,
    Duration? timeout,
    bool followRedirects = true,
    int? maxResponseBytes,
  }) async {
    expect(followRedirects, isFalse);
    return switch (path) {
      '/.dsh-mesh/v1/status' => _reply({
        'paired': paired,
        'tradeLoomReadOnly': 1,
        if (!legacyPlugin) 'liveReadAuthorization': 1,
      }),
      '/.dsh-mesh/v1/nodes' when relayOffline => _reply({'error': 'relay_unavailable'}, 503),
      '/.dsh-mesh/v1/nodes' => _reply({
        'items': [
          {'nodeId': 'self', 'name': '本机', 'online': true, 'self': true},
          {'nodeId': 'desktop', 'name': '合成电脑', 'online': true, 'clientDeviceId': 'desktop-reader'},
        ],
      }),
      '/.dsh-mesh/v1/prefs' => _reply({
        'allowIncoming': consent.lastOrNull == true,
        'allowedCallers': consent.lastOrNull == true ? ['desktop-reader'] : [],
      }),
      '/.dsh-mesh/v1/access' when denied => _reply({'error': 'not_connected'}, 403),
      '/.dsh-mesh/v1/access' when relayOffline => _reply({'error': 'offline'}, 503),
      '/.dsh-mesh/v1/access' => _reply({'allowed': true}),
      '/.dsh-mesh/v1/tree' when denied => _reply({'error': 'not_connected'}, 403),
      '/.dsh-mesh/v1/tree' when query?['nodeId'] == 'desktop' => _reply({
        'nodes': [
          {
            'nodeId': 'desktop',
            'workspaces': [
              {
                'title': '合成工作区',
                'sessions': [
                  {'sessionId': 'session-one', 'title': '真实协议格式会话', 'controllable': false},
                ],
              },
            ],
          },
        ],
      }),
      '/.dsh-mesh/v1/sessions/desktop/session-one/page' when denied => _reply({'error': 'not_connected'}, 403),
      '/.dsh-mesh/v1/sessions/desktop/session-one/page' => _reply({
        'cursor': 6,
        'hasMore': true,
        'records': [
          {
            'event': {
              'seq': 6,
              'type': 'assistant/message',
              'data': {
                'message': {
                  'role': 'assistant',
                  'content': [
                    {'type': 'text', 'text': '只读合成会话正文'},
                    {'type': 'thinking', 'thinking': 'PRIVATE-REASONING'},
                  ],
                },
              },
            },
          },
        ],
      }),
      _ => _reply({'error': 'not_found'}, 404),
    };
  }

  @override
  Future<DshHttpResponse> postBytes(
    String path,
    List<int> bytes, {
    Map<String, String>? query,
    String contentType = 'application/octet-stream',
    Duration? timeout,
    bool followRedirects = true,
    int? maxResponseBytes,
    DshHttpAbort? abort,
  }) async {
    expect(followRedirects, isFalse);
    expect(contentType, 'application/json');
    final body = jsonDecode(utf8.decode(bytes));
    switch (path) {
      case '/.dsh-mesh/v1/pair':
        expect(body, {'pairing': _invitation, 'confirmed': true});
        pairRequests += 1;
        if (badPin) return _reply({'error': 'fingerprint_mismatch'}, 400);
        paired = true;
      case '/.dsh-mesh/v1/unpair':
        expect(body, isEmpty);
        paired = false;
      case '/.dsh-mesh/v1/consent':
        expect(body['deviceId'], 'desktop-reader');
        consent.add(body['allow'] as bool);
      default:
        fail('Unexpected mutation route: $path');
    }
    return _reply({});
  }
}

Future<void> _tap(WidgetTester tester, String text) async {
  final found = find.text(text);
  await tester.ensureVisible(found.last);
  await tester.tap(found.last);
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final width in [320.0, 390.0, 820.0]) {
    testWidgets('workbench Mesh route, read-only snapshot and consent at ${width.toInt()}px', (tester) async {
      useWindow(tester, Size(width, width > 600 ? 1100 : 840));
      final engine = _Engine();
      addTearDown(engine.close);
      await tester.pumpWidget(
        testApp(
          const TradeLoomWorkbenchPage(),
          overrides: [
            localConnectionProvider.overrideWith(() => _LocalEngineController(DshClient(engine))),
            pairingScannerProvider.overrideWithValue(
              (context, report) => Center(
                child: TextButton(onPressed: () => report(_invitation), child: const Text('合成扫码')),
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('接收工作流'), findsOneWidget);
      await _tap(tester, '设备互联');
      await _tap(tester, '配对设备');
      if (width == 390) {
        await _tap(tester, '扫描邀请');
        await _tap(tester, '合成扫码');
      } else {
        await tester.enterText(find.byType(TextField), _invitation);
        await _tap(tester, '确认');
      }
      expect(engine.pairRequests, 0);
      expect(find.textContaining('https://relay.example.test'), findsOneWidget);
      await _tap(tester, '确认');
      expect(engine.pairRequests, 1);
      expect(find.text('合成电脑'), findsOneWidget);
      expect(find.text('本机'), findsNothing);

      await _tap(tester, '合成电脑');
      await _tap(tester, '真实协议格式会话');
      expect(find.text('只读合成会话正文'), findsOneWidget);
      expect(find.text('此快照只显示最近的记录。'), findsOneWidget);
      expect(find.textContaining('PRIVATE-REASONING'), findsNothing);
      expect(find.byType(TextField), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(PopupMenuButton<bool>));
      await tester.pumpAndSettle();
      await _tap(tester, '允许读取本机');
      expect(engine.consent, isEmpty);
      await _tap(tester, '确认');
      await tester.tap(find.byType(PopupMenuButton<bool>));
      await tester.pumpAndSettle();
      await _tap(tester, '撤销读取权限');
      await _tap(tester, '确认');
      expect(engine.consent, [true, false]);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('transport and consent errors do not become empty device or session lists', (tester) async {
    final engine = _Engine()..badPin = true;
    addTearDown(engine.close);
    await tester.pumpWidget(
      testApp(
        const TradeLoomMeshPage(),
        overrides: [localConnectionProvider.overrideWith(() => _LocalEngineController(DshClient(engine)))],
      ),
    );
    await tester.pumpAndSettle();
    await _tap(tester, '配对设备');
    await tester.enterText(find.byType(TextField), _invitation);
    await _tap(tester, '确认');
    await _tap(tester, '确认');
    expect(find.textContaining('无法验证中继证书'), findsOneWidget);
    expect(find.textContaining('没有其他配对'), findsNothing);

    engine
      ..badPin = false
      ..relayOffline = true;
    await _tap(tester, '配对设备');
    await tester.enterText(find.byType(TextField), _invitation);
    await _tap(tester, '确认');
    await _tap(tester, '确认');
    expect(find.textContaining('暂时无法连接中继'), findsOneWidget);
    expect(find.textContaining('没有其他配对'), findsNothing);

    engine
      ..relayOffline = false
      ..denied = true;
    await _tap(tester, '重试');
    await _tap(tester, '合成电脑');
    expect(find.textContaining('未允许读取'), findsOneWidget);
    expect(find.textContaining('没有可显示的会话'), findsNothing);
  });

  testWidgets('revocation clears the open snapshot and its catalog', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    final engine = _Engine()..paired = true;
    addTearDown(engine.close);
    await tester.pumpWidget(
      testApp(
        const TradeLoomMeshPage(),
        overrides: [localConnectionProvider.overrideWith(() => _LocalEngineController(DshClient(engine)))],
      ),
    );
    await tester.pumpAndSettle();
    await _tap(tester, '合成电脑');
    await _tap(tester, '真实协议格式会话');
    expect(find.text('只读合成会话正文'), findsOneWidget);

    engine.denied = true;
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    expect(find.text('只读合成会话正文'), findsNothing);
    expect(find.text('真实协议格式会话'), findsNothing);
    expect(find.textContaining('未允许读取'), findsOneWidget);

    // The hidden catalog must already be cleared, even if the peer allows
    // a new read by the time the user goes back.
    engine.denied = false;
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.text('真实协议格式会话'), findsNothing);
    expect(find.textContaining('未允许读取'), findsOneWidget);
    await _tap(tester, '重试');
    await _tap(tester, '真实协议格式会话');
    expect(find.text('只读合成会话正文'), findsOneWidget);
  });

  testWidgets('a paired device can leave while the Relay directory is offline', (tester) async {
    final engine = _Engine()..paired = true;
    addTearDown(engine.close);
    await tester.pumpWidget(
      testApp(
        const TradeLoomMeshPage(),
        overrides: [localConnectionProvider.overrideWith(() => _LocalEngineController(DshClient(engine)))],
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('合成电脑'), findsOneWidget);

    engine.relayOffline = true;
    await _tap(tester, '刷新设备');
    expect(find.textContaining('暂时无法连接中继'), findsOneWidget);
    expect(find.text('合成电脑'), findsNothing);
    expect(find.textContaining('没有其他配对'), findsNothing);
    await _tap(tester, '重试');
    expect(find.textContaining('暂时无法连接中继'), findsOneWidget);
    await _tap(tester, '退出互联');
    expect(engine.paired, isTrue);
    await _tap(tester, '确认');
    expect(engine.paired, isFalse);
    expect(find.text('配对设备'), findsOneWidget);
  });

  testWidgets('a legacy plugin cannot accept invitations through the TradeLoom entry', (tester) async {
    final engine = _Engine()..legacyPlugin = true;
    addTearDown(engine.close);
    await tester.pumpWidget(
      testApp(
        const TradeLoomMeshPage(),
        overrides: [localConnectionProvider.overrideWith(() => _LocalEngineController(DshClient(engine)))],
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('未启用织贸只读互联插件'), findsOneWidget);
    expect(find.text('配对设备'), findsNothing);
  });
}
