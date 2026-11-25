// The 7a R3 list cache over a real localhost HTTP engine double, read by the
// W4-02 background worker (W4-03 diagnostic). The startup fan-out must keep
// provider metadata on both paths; a 3-second read must leave cached rows,
// scrolling and controls usable, and keep the scroll position on replace.
import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/plugins/native/native_state.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/bots_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/drawer_view_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/models_state.dart';
import 'package:dsh_app/state/plugins_state.dart';
import 'package:dsh_app/state/providers_state.dart';
import 'package:dsh_app/state/read_list_identity.dart';
import 'package:dsh_app/state/session_attention_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/state/subscriptions_state.dart';
import 'package:dsh_app/state/workspaces_state.dart';
import 'package:dsh_app/ui/account/account_page.dart';
import 'package:dsh_app/ui/chat/model_sheet.dart';
import 'package:dsh_app/ui/common/segmented_pill.dart';
import 'package:dsh_app/ui/plugins/plugins_screen.dart';
import 'package:dsh_app/ui/providers/providers_page.dart';
import 'package:dsh_app/ui/shell/sessions_drawer.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../account/support.dart' show FixedAccount;
import '../chat/support/harness.dart' show testApp, usePhoneView, loadTestFonts;
import '../drawer/support.dart' show FixedPending;
import '../plugins/native/support.dart' show FakeBridge, contributions;
import '../plugins/support/fake_plugin_host.dart' show bundleJson, sampleIndex, emptyOfficialMarket;
import '../shell/golden_harness.dart' show FakeRuntime, FakeSettings, runningStatus;
import 'read_list_refresh_test.dart'
    show FixedHost, SwitchConnection, switchConnectionProvider, SwitchWorkspaces, SwitchWorkspacePrefs;

class _RealHttpBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

class _HttpLists {
  _HttpLists(this.server);
  final HttpServer server;
  final sockets = <WebSocket>[];
  final slowEndpoints = <String>{};
  final calls = <String>[];
  final elapsed = <Map<String, Object?>>[];
  var revision = 'A';
  int slowStarted = 0;
  int slowCompleted = 0;
  Uri get uri => Uri.parse('http://127.0.0.1:${server.port}');

  static Future<_HttpLists> start() async {
    final host = _HttpLists(await HttpServer.bind(InternetAddress.loopbackIPv4, 0));
    host.server.listen(host.handle);
    return host;
  }

  Future<void> handle(HttpRequest request) async {
    if (request.uri.path == '/api/remote.mux') {
      final ws = await WebSocketTransformer.upgrade(request);
      sockets.add(ws);
      ws.listen((data) {
        final frame = jsonDecode(data as String) as Map;
        if (frame['type'] == 'open' && frame['endpoint'] == r'$events') {
          ws.add(
            jsonEncode({
              'type': 'item',
              'streamId': frame['streamId'],
              'value': {
                'type': 'ready',
                'clientId': 'fixture-client',
                'host': {'home': '/fixture'},
              },
            }),
          );
        }
      });
      return;
    }
    final body = jsonDecode(await utf8.decoder.bind(request).join()) as Map;
    if (body['method'] is! String) {
      request.response.statusCode = 404;
      await request.response.close();
      return;
    }
    final endpoint = body['method'] as String;
    calls.add(endpoint);
    if (slowEndpoints.contains(endpoint)) {
      slowStarted++;
      final watch = Stopwatch()..start();
      await Future<void>.delayed(const Duration(seconds: 3));
      slowCompleted++;
      elapsed.add({'endpoint': endpoint, 'requestedDelayMs': 3000, 'observedElapsedUs': watch.elapsedMicroseconds});
    }
    request.response.headers.contentType = ContentType.json;
    request.response.write(
      jsonEncode({
        'type': 'server-response',
        'rpcId': body['rpcId'],
        'result': {'ok': true, 'value': value(endpoint)},
      }),
    );
    await request.response.close();
  }

  Object? value(String endpoint) => switch (endpoint) {
    'session/modelCatalog' => {
      'groups': [
        for (final p in ['p', 'q'])
          {
            'id': p,
            'name': p == 'p' ? 'Provider' : 'Secondary',
            'models': [
              for (var i = 0; i < 45; i++)
                {'id': '$p-$i', 'name': '$revision $p Model $i', 'description': 'Description'},
            ],
          },
      ],
      'routableProviders': ['p', 'q'],
      'failures': <Object?>[],
    },
    'pluginManager/listBundles' => [
      for (var i = 0; i < 45; i++) bundleJson('plugin-$i', title: '$revision Plugin $i', description: 'Description'),
    ],
    'settings/describe' => {
      'writable': true,
      'namespaces': [
        {
          'ns': piAiSettingsNs,
          'revision': 3,
          'value': {
            'providers': {
              for (var i = 0; i < 45; i++)
                'custom-p-$i': {
                  'displayName': '$revision Provider $i',
                  'api': 'openai-completions',
                  'baseURL': 'https://example.invalid',
                  'models': [
                    {'id': 'm-$i'},
                  ],
                  'apiKeyEnv': 'CUSTOM_P_${i}_API_KEY',
                },
            },
          },
        },
      ],
    },
    'llm/listProviders' => [
      for (var i = 0; i < 45; i++) {'id': 'custom-p-$i', 'name': '$revision Provider $i'},
    ],
    'llm/listConfigurableProviders' => [
      {'provider': 'custom-p-0', 'settingsNs': piAiSettingsNs, 'error': 'fixture configuration diagnostic'},
    ],
    'credentials/describe' => {
      for (var i = 0; i < 45; i++) 'CUSTOM_P_${i}_API_KEY': {'configured': true, 'writable': true},
    },
    'session/list' => {
      'items': [
        for (var i = 0; i < 50; i++)
          {
            'sessionId': 'session-$i',
            'updatedAt': 1793000000000 - i * 1000,
            'running': false,
            'blank': false,
            'agentAvailable': false,
            'projections': {
              'values': {'title': '$revision Session $i'},
            },
          },
      ],
    },
    _ => null,
  };

  Future<void> close() async {
    for (final socket in sockets) {
      await socket.close();
    }
    await server.close(force: true);
  }
}

List<Override> _overrides(DshClient client) => [
  activeHostProvider.overrideWith(FixedHost.new),
  switchConnectionProvider.overrideWith(() => SwitchConnection(HostConnection(client: client, isLocal: true))),
  activeConnectionProvider.overrideWith((ref) => ref.watch(switchConnectionProvider)),
  readListIdentityProvider.overrideWithValue(ReadListIdentity.of(['wave7-real-http-fixture'])),
  localSafeModeProvider.overrideWithValue(false),
  workspacesProvider.overrideWith(
    () => SwitchWorkspaces(
      WorkspacesState(
        status: WorkspacesStatus.ready,
        workspaces: [
          Workspace(
            workspaceId: 'w',
            path: '/fixture',
            title: '研究工作区',
            sessionIds: [for (var i = 0; i < 50; i++) 'session-$i'],
          ),
        ],
      ),
    ),
  ),
  workspacePrefsProvider.overrideWith(() => SwitchWorkspacePrefs(const WorkspacePrefs(loaded: true, selected: 'w'))),
  dsBotOwnedSessionsProvider.overrideWithValue(const {}),
  dsBotApiFactoryProvider.overrideWithValue((_) => null),
  localRuntimeProvider.overrideWith(() => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus))),
  settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
  accountProvider.overrideWith(() => FixedAccount(const AccountState(phase: AccountPhase.signedOut))),
  subscriptionsProvider.overrideWithValue(const AsyncData(SubscriptionsSnapshot(available: false))),
  nativeBridgeProvider.overrideWithValue(FakeBridge(contributions([]))),
  pendingInteractionsProvider.overrideWith(() => FixedPending(const {})),
  unreadSessionIdsProvider.overrideWithValue(const {}),
  marketIndexFetcherProvider.overrideWithValue((uri) async => parseMarketIndex(sampleIndex, uri)),
  officialMarketFetcherProvider.overrideWithValue(() async => emptyOfficialMarket),
];

Future<void> _until(WidgetTester tester, bool Function() condition) async {
  final watch = Stopwatch()..start();
  while (!condition()) {
    if (watch.elapsed > const Duration(seconds: 15)) fail('real HTTP fixture did not settle');
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump();
  }
}

bool _ready(ProviderContainer c, String kind) => switch (kind) {
  'models' => !c.read(modelListViewProvider).readOnly,
  'plugins' => !c.read(pluginListViewProvider).readOnly,
  'providers' => !c.read(providerListViewProvider).readOnly,
  _ => c.read(drawerScopeProvider)?.readOnly == false,
};

ScrollableState _scroll(WidgetTester tester) => tester
    .stateList<ScrollableState>(find.byType(Scrollable))
    .firstWhere((s) => s.widget.axisDirection == AxisDirection.down && s.position.maxScrollExtent > 0);

void main() {
  _RealHttpBinding();
  setUpAll(loadTestFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));
  for (final background in [false, true]) {
    test('four real list sources retain provider metadata during startup (worker=$background)', () async {
      final host = await _HttpLists.start();
      final client = DshClient(DshConnection(host.uri), backgroundLists: background);
      await client.mux.ready();
      final c = ProviderContainer(overrides: _overrides(client));
      addTearDown(() async {
        c.dispose();
        await client.close();
        await host.close();
      });
      final values = await Future.wait<Object?>([
        c.read(modelCatalogProvider.future),
        c.read(customProvidersProvider.future),
        c.read(installedPluginsProvider.future),
        c.read(sessionsProvider.future),
      ]);
      final providers = values[1] as ProvidersSnapshot;
      // ignore: avoid_print
      print(
        jsonEncode({
          'measurement': 'wave7-startup-fanout',
          'worker': background,
          'calls': host.calls,
          'registered': providers.registered?.length,
          'credentialMetadata': providers.credentials.length,
          'diagnostics': providers.diagnostics,
        }),
      );
      expect(providers.registered, hasLength(45));
      expect(providers.credentials, hasLength(45));
      expect(providers.diagnostics, {'custom-p-0': 'fixture configuration diagnostic'});
    });
  }
  for (final kind in ['models', 'plugins', 'providers', 'sessions']) {
    testWidgets('$kind keeps cached rows and controls during actual 3-second HTTP worker read', (tester) async {
      usePhoneView(tester);
      late _HttpLists host;
      late DshClient first;
      late DshClient next;
      await tester.runAsync(() async {
        host = await _HttpLists.start();
        first = DshClient(DshConnection(host.uri), backgroundLists: true);
        next = DshClient(DshConnection(host.uri), backgroundLists: true);
        expect(first.connection.canReadSessionsInBackground, isTrue);
        await first.mux.ready();
        await next.mux.ready();
      });
      addTearDown(() async {
        await first.close();
        await next.close();
        await host.close();
      });
      var clicked = 0;
      final Widget page = switch (kind) {
        'models' => Consumer(
          builder: (context, ref, _) {
            ref.watch(modelCatalogProvider);
            return Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () => showModelSheet(context, current: null, onSelected: (_) => clicked++),
                  child: const Text('open-models'),
                ),
              ),
            );
          },
        ),
        'plugins' => const PluginsScreen(),
        'providers' => const ProvidersPage(),
        _ => Scaffold(
          body: SizedBox(
            width: 390,
            child: SessionsDrawer(onClose: () => clicked++, onOpen: (_) {}),
          ),
        ),
      };
      await tester.pumpWidget(testApp(page, overrides: _overrides(first)));
      final c = ProviderScope.containerOf(tester.element(find.byType(Scaffold).first));
      await _until(tester, () => _ready(c, kind));
      await tester.pumpAndSettle();
      if (kind == 'models') {
        await tester.tap(find.text('open-models'));
        await tester.pumpAndSettle();
      }
      final scroll = _scroll(tester);
      final endpoint = switch (kind) {
        'models' => 'session/modelCatalog',
        'plugins' => 'pluginManager/listBundles',
        'providers' => 'settings/describe',
        _ => 'session/list',
      };
      host.slowEndpoints.add(endpoint);
      host.revision = 'B';
      c.read(switchConnectionProvider.notifier).set(null);
      await tester.pump();
      c.read(switchConnectionProvider.notifier).set(HostConnection(client: next, isLocal: true));
      await tester.pump();
      await _until(tester, () => host.slowStarted > 0);
      final oldText = switch (kind) {
        'models' => 'A P Model 0',
        'plugins' => 'A Plugin 0',
        'providers' => 'A Provider 0',
        _ => 'A Session 0',
      };
      expect(find.text(oldText), findsOneWidget);
      expect(_ready(c, kind), isFalse);
      expect(host.slowCompleted, 0);
      if (kind == 'models') {
        await tester.tap(find.text('A P Model 0'));
        expect(clicked, 0);
        await tester.tap(find.text('Secondary'));
        await tester.pump(const Duration(milliseconds: 200));
        expect(tester.widget<SegmentedPill<String>>(find.byType(SegmentedPill<String>).first).selected, 'q');
      } else if (kind == 'plugins') {
        await tester.tap(find.byTooltip(appL10n.pluginsRefresh));
        await tester.pump();
        expect(tester.widget<Switch>(find.byType(Switch).first).onChanged, isNull);
      } else if (kind == 'providers') {
        await tester.tap(find.text('DeepSeek').first);
        await tester.pumpAndSettle();
        expect(find.byType(AccountPage), findsOneWidget);
        await tester.tap(find.byTooltip(appL10n.commonBack));
        await tester.pumpAndSettle();
      }
      final before = scroll.position.pixels;
      await tester.drag(find.byWidgetPredicate((w) => identical(w, scroll.widget)), const Offset(0, -280));
      await tester.pump(const Duration(milliseconds: 200));
      expect(scroll.position.pixels, greaterThan(before));
      expect(host.slowCompleted, 0, reason: 'scroll and the control action happened before the real reply');
      if (kind == 'sessions') {
        await tester.tap(find.byType(SessionTile).hitTestable().first);
        await tester.pump(const Duration(milliseconds: 250));
        expect(clicked, 1);
      }
      final held = scroll.position.pixels;
      await _until(tester, () => _ready(c, kind));
      await tester.pumpAndSettle();
      expect(_scroll(tester), same(scroll));
      expect(scroll.position.pixels, closeTo(held, 0.01));
      expect(host.elapsed, isNotEmpty);
      // ignore: avoid_print
      print(
        jsonEncode({
          'measurement': 'wave7-real-http-cache',
          'page': kind,
          'scrollBefore': before,
          'scrollWhilePending': held,
          'scrollAfter': scroll.position.pixels,
          'workerEligible': next.connection.canReadSessionsInBackground,
          'serverDelays': host.elapsed,
          'calls': host.calls,
        }),
      );
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        await first.close();
        await next.close();
        await host.close();
      });
    });
  }
}
