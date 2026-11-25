import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/plugins/native/native_state.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/drawer_view_state.dart';
import 'package:dsh_app/state/models_state.dart';
import 'package:dsh_app/state/plugins_state.dart';
import 'package:dsh_app/state/providers_state.dart';
import 'package:dsh_app/state/session_attention_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/state/subscriptions_state.dart';
import 'package:dsh_app/state/workspaces_state.dart';
import 'package:dsh_app/ui/chat/model_sheet.dart';
import 'package:dsh_app/ui/common/list_page_row.dart';
import 'package:dsh_app/ui/common/segmented_pill.dart';
import 'package:dsh_app/ui/plugins/installed_tab.dart';
import 'package:dsh_app/ui/plugins/plugins_screen.dart';
import 'package:dsh_app/ui/providers/provider_detail_page.dart';
import 'package:dsh_app/ui/providers/providers_page.dart';
import 'package:dsh_app/ui/shell/drawer/drawer_filter_bar.dart';
import 'package:dsh_app/ui/shell/drawer/drawer_list.dart';
import 'package:dsh_app/ui/shell/sessions_drawer.dart';
import 'package:dsh_app/ui/workspace/workspace_switcher.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../account/support.dart' show FixedAccount;
import '../chat/support/harness.dart' show testApp, usePhoneView;
import '../drawer/support.dart' show FixedPending;
import '../plugins/native/support.dart' show FakeBridge, contributions;
import '../plugins/support/fake_plugin_host.dart' show bundleJson, sampleIndex;
import '../providers/support.dart' show FakeProviderBackend;
import '../shell/golden_harness.dart' show FakeRuntime, FakeSettings, runningStatus;
import 'read_list_refresh_test.dart'
    show ListHost, listOverrides, switchConnectionProvider, SwitchWorkspaces, SwitchWorkspacePrefs;

List<Override> _chrome() => [
  localRuntimeProvider.overrideWith(() => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus))),
  settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
  accountProvider.overrideWith(() => FixedAccount(const AccountState(phase: AccountPhase.signedOut))),
  subscriptionsProvider.overrideWithValue(const AsyncData(SubscriptionsSnapshot(available: false))),
  nativeBridgeProvider.overrideWithValue(FakeBridge(contributions([]))),
  pendingInteractionsProvider.overrideWith(() => FixedPending(const {})),
  unreadSessionIdsProvider.overrideWithValue(const {}),
  marketIndexFetcherProvider.overrideWithValue((uri) async => parseMarketIndex(sampleIndex, uri)),
];

ScrollableState _scroll(WidgetTester tester) => tester
    .stateList<ScrollableState>(find.byType(Scrollable))
    .firstWhere((s) => s.widget.axisDirection == AxisDirection.down && s.position.maxScrollExtent > 0);

Finder _scrollFinder(ScrollableState scroll) => find.byWidgetPredicate((widget) => identical(widget, scroll.widget));

void _measure(String page, WidgetTester tester, DateTime start, ScrollableState scroll, double before) {
  // Controlled clock/request latency, not wall-clock device or engine speed.
  // ignore: avoid_print
  print(
    jsonEncode({
      'measurement': '7a-controlled-page',
      'page': page,
      'elapsedVirtualMs': tester.binding.clock.now().difference(start).inMilliseconds,
      'pixelsBefore': before,
      'pixelsAfter': scroll.position.pixels,
      'requestCompleted': false,
      'latencyVirtualMs': 3000,
    }),
  );
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('model page keeps filter and scroll identity through a 3-second refresh', (tester) async {
    usePhoneView(tester);
    final host = ListHost('A');
    addTearDown(host.client.close);
    final response = ListHost.models('A', count: 40);
    (response['groups']! as List).add({
      'id': 'q',
      'name': 'Secondary',
      'models': [
        for (var i = 0; i < 40; i++) {'id': 'q-$i', 'name': 'Q Model $i', 'description': 'Description'},
      ],
    });
    host.carrier.handlers['session/modelCatalog'] = (_) => host.request('models', response);
    var picks = 0;
    await tester.pumpWidget(
      testApp(
        Consumer(
          builder: (context, ref, _) {
            ref.watch(modelCatalogProvider);
            return Scaffold(
              body: Center(
                child: TextButton(
                  onPressed: () => showModelSheet(context, current: null, onSelected: (_) => picks++),
                  child: const Text('open'),
                ),
              ),
            );
          },
        ),
        overrides: [...listOverrides(host), ..._chrome()],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    final c = ProviderScope.containerOf(tester.element(find.byType(Consumer).first));
    final scroll = _scroll(tester);
    host.paused.add('models');
    c.invalidate(modelCatalogProvider);
    c.read(modelCatalogProvider.future);
    final start = tester.binding.clock.now();
    final waiting = host.requests['models']!.single;
    Timer(const Duration(seconds: 3), () => waiting.complete(response));
    await tester.pump(const Duration(milliseconds: 16));
    expect(find.text('A Model 0'), findsOneWidget);
    expect(find.textContaining('更新中'), findsOneWidget);
    await tester.tap(find.text('A Model 0'));
    expect(picks, 0, reason: 'stale display rows do not select a model');
    await tester.tap(find.text('Secondary'));
    await tester.pump(const Duration(milliseconds: 250));
    final pill = tester.widget<SegmentedPill<String>>(find.byType(SegmentedPill<String>).first);
    expect(pill.selected, 'q');
    final before = scroll.position.pixels;
    await tester.drag(_scrollFinder(scroll), const Offset(0, -300));
    await tester.pump(const Duration(milliseconds: 200));
    expect(scroll.position.pixels, greaterThan(before));
    expect(waiting.isCompleted, isFalse);
    expect(_scroll(tester), same(scroll));
    _measure('models', tester, start, scroll, before);
    final held = scroll.position.pixels;
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(_scroll(tester), same(scroll));
    expect(scroll.position.pixels, closeTo(held, 0.01));
    expect(tester.widget<SegmentedPill<String>>(find.byType(SegmentedPill<String>).first).selected, 'q');
    expect(c.read(modelListViewProvider).readOnly, isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('complete PluginsScreen shows cache offline and during a new client 3-second read', (tester) async {
    usePhoneView(tester);
    final host = ListHost('A');
    final other = ListHost('B')..paused.add('plugins');
    addTearDown(host.client.close);
    addTearDown(other.client.close);
    final response = [for (var i = 0; i < 45; i++) bundleJson('plugin-$i', description: 'Description')];
    host.carrier.handlers['pluginManager/listBundles'] = (_) => response;
    await tester.pumpWidget(testApp(const PluginsScreen(), overrides: [...listOverrides(host), ..._chrome()]));
    await tester.pumpAndSettle();
    final c = ProviderScope.containerOf(tester.element(find.byType(PluginsScreen)));
    final scroll = _scroll(tester);
    c.read(switchConnectionProvider.notifier).set(null);
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump();
    expect(find.widgetWithText(BundleTile, 'plugin-0'), findsOneWidget);
    expect(find.textContaining('离线'), findsWidgets);
    expect(tester.widget<Switch>(find.byType(Switch).first).onChanged, isNull);
    c.read(switchConnectionProvider.notifier).set(other.connection);
    c.read(installedPluginsProvider.future);
    final start = tester.binding.clock.now();
    final waiting = other.requests['plugins']!.single;
    Timer(const Duration(seconds: 3), () => waiting.complete(response));
    await tester.pump(const Duration(milliseconds: 16));
    await tester.tap(find.byTooltip(appL10n.pluginsRefresh));
    await tester.pump();
    expect(other.requests['plugins'], hasLength(1), reason: 'refresh click coalesces while initial read is pending');
    expect(find.widgetWithText(BundleTile, 'plugin-0'), findsOneWidget);
    final before = scroll.position.pixels;
    await tester.drag(_scrollFinder(scroll), const Offset(0, -300));
    await tester.pump(const Duration(milliseconds: 200));
    expect(scroll.position.pixels, greaterThan(before));
    expect(waiting.isCompleted, isFalse);
    expect(_scroll(tester), same(scroll));
    _measure('plugins', tester, start, scroll, before);
    final held = scroll.position.pixels;
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(_scroll(tester), same(scroll));
    expect(scroll.position.pixels, closeTo(held, 0.01));
    expect(c.read(pluginListViewProvider).readOnly, isFalse);
    expect(other.carrier.argsOf('pluginManager/setBundleEnabled'), isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('providers page retains rows across disconnect/new client without restoring edit authority', (
    tester,
  ) async {
    usePhoneView(tester);
    final host = ListHost('A');
    final other = ListHost('B');
    addTearDown(host.client.close);
    addTearDown(other.client.close);
    final first = _PageProviders();
    final next = _PageProviders()..pending = Completer<ProviderSettings?>();
    await tester.pumpWidget(
      testApp(
        const ProvidersPage(),
        overrides: [
          ...listOverrides(host),
          ..._chrome(),
          providerBackendProvider.overrideWith((ref) {
            final connection = ref.watch(switchConnectionProvider).value;
            return connection == null
                ? null
                : identical(connection.client, host.client)
                ? first
                : next;
          }),
        ],
      ),
    );
    await tester.pumpAndSettle();
    final c = ProviderScope.containerOf(tester.element(find.byType(ProvidersPage)));
    final scroll = _scroll(tester);
    c.read(switchConnectionProvider.notifier).set(null);
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump();
    expect(find.text('Provider 0'), findsOneWidget);
    final cachedRow = tester.widget<ListPageRow>(
      find.ancestor(of: find.text('Provider 0'), matching: find.byType(ListPageRow)).first,
    );
    expect(cachedRow.onTap, isNull);
    c.read(switchConnectionProvider.notifier).set(other.connection);
    c.read(customProvidersProvider.future);
    final start = tester.binding.clock.now();
    final waiting = next.pending!;
    Timer(const Duration(seconds: 3), () => waiting.complete(next.snapshot));
    await tester.pump(const Duration(milliseconds: 16));
    expect(find.text('Provider 0'), findsOneWidget);
    expect(find.byType(ProviderDetailPage), findsNothing);
    final before = scroll.position.pixels;
    await tester.drag(_scrollFinder(scroll), const Offset(0, -350));
    await tester.pump(const Duration(milliseconds: 200));
    expect(scroll.position.pixels, greaterThan(before));
    expect(waiting.isCompleted, isFalse);
    _measure('providers', tester, start, scroll, before);
    final held = scroll.position.pixels;
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(_scroll(tester), same(scroll));
    expect(scroll.position.pixels, closeTo(held, 0.01));
    expect(c.read(providerListViewProvider).readOnly, isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('whole drawer keeps workspace label, row and scroll through disconnected 3-second refresh', (
    tester,
  ) async {
    usePhoneView(tester);
    final host = ListHost('A');
    final other = ListHost('B')..paused.add('sessions');
    addTearDown(host.client.close);
    addTearDown(other.client.close);
    final response = ListHost.sessions('A', count: 50);
    host.carrier.handlers['session/list'] = (_) => response;
    final workspace = Workspace(
      workspaceId: 'w',
      path: '/project',
      title: '研究工作区',
      sessionIds: [for (var i = 0; i < 50; i++) 'A-$i'],
    );
    final ready = WorkspacesState(status: WorkspacesStatus.ready, workspaces: [workspace]);
    final registry = SwitchWorkspaces(ready);
    final prefs = SwitchWorkspacePrefs(const WorkspacePrefs(loaded: true, selected: 'w'));
    var opened = 0;
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: SizedBox(
            width: 390,
            child: SessionsDrawer(onClose: () => opened++, onOpen: (_) {}),
          ),
        ),
        overrides: [
          ...listOverrides(host, workspaces: registry, prefs: prefs),
          ..._chrome(),
        ],
      ),
    );
    await tester.pumpAndSettle();
    final c = ProviderScope.containerOf(tester.element(find.byType(SessionsDrawer)));
    final scroll = _scroll(tester);
    final workspaceTop = tester.getTopLeft(find.byType(WorkspaceSwitcher)).dy;
    final listTop = tester.getTopLeft(find.byType(DrawerConversationList)).dy;
    c.read(switchConnectionProvider.notifier).set(null);
    registry.set(const WorkspacesState());
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pumpAndSettle();
    expect(find.text('研究工作区'), findsOneWidget);
    expect(tester.getTopLeft(find.byType(WorkspaceSwitcher)).dy, closeTo(workspaceTop, 0.01));
    expect(tester.getTopLeft(find.byType(DrawerConversationList)).dy, closeTo(listTop, 0.01));
    expect(tester.widget<SessionTile>(find.byType(SessionTile).first).onLongPress, isNull);
    c.read(switchConnectionProvider.notifier).set(other.connection);
    c.read(sessionsProvider.future);
    final start = tester.binding.clock.now();
    final waiting = other.requests['sessions']!.single;
    Timer(const Duration(seconds: 3), () {
      registry.set(ready);
      waiting.complete(response);
    });
    await tester.pump(const Duration(milliseconds: 16));
    expect(find.textContaining('上次结果'), findsWidgets);
    final before = scroll.position.pixels;
    await tester.drag(_scrollFinder(scroll), const Offset(0, -250));
    await tester.pump(const Duration(milliseconds: 200));
    expect(scroll.position.pixels, greaterThan(before));
    expect(waiting.isCompleted, isFalse);
    expect(find.byType(DrawerFilterBar), findsOneWidget);
    _measure('sessions', tester, start, scroll, before);
    await tester.tap(find.byType(SessionTile).hitTestable().first);
    await tester.pump();
    expect(opened, 1, reason: 'cached session navigation responds before the engine read');
    final held = scroll.position.pixels;
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(_scroll(tester), same(scroll));
    expect(scroll.position.pixels, closeTo(held, 0.01));
    expect(c.read(drawerScopeProvider)!.readOnly, isFalse);
    await tester.tap(find.byType(SessionTile).hitTestable().first);
    await tester.pump();
    expect(opened, 2);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('back and reopening providers respond while the three-second read is pending', (tester) async {
    usePhoneView(tester);
    final host = ListHost('A');
    addTearDown(host.client.close);
    final backend = _PageProviders();
    await tester.pumpWidget(
      testApp(
        Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () =>
                    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ProvidersPage())),
                child: const Text('open-providers'),
              ),
            ),
          ),
        ),
        overrides: [...listOverrides(host), ..._chrome(), providerBackendProvider.overrideWithValue(backend)],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('open-providers'));
    await tester.pumpAndSettle();
    final c = ProviderScope.containerOf(tester.element(find.byType(ProvidersPage)));
    backend.pending = Completer<ProviderSettings?>();
    c.invalidate(customProvidersProvider);
    c.read(customProvidersProvider.future);
    final waiting = backend.pending!;
    final start = tester.binding.clock.now();
    Timer(const Duration(seconds: 3), () => waiting.complete(backend.snapshot));
    await tester.pump(const Duration(milliseconds: 16));
    await tester.tap(find.byTooltip(appL10n.commonBack));
    await tester.pumpAndSettle();
    expect(find.byType(ProvidersPage), findsNothing);
    expect(waiting.isCompleted, isFalse);
    await tester.tap(find.text('open-providers'));
    await tester.pumpAndSettle();
    expect(find.text('Provider 0'), findsOneWidget);
    expect(find.textContaining('上次结果'), findsOneWidget);
    expect(waiting.isCompleted, isFalse);
    // ignore: avoid_print
    print(
      jsonEncode({
        'measurement': '7a-controlled-reentry',
        'elapsedVirtualMs': tester.binding.clock.now().difference(start).inMilliseconds,
        'requestCompleted': waiting.isCompleted,
        'backCompleted': true,
        'cachedRowVisibleOnReopen': true,
      }),
    );
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(c.read(providerListViewProvider).readOnly, isFalse);
    await tester.pumpWidget(const SizedBox());
  });
}

class _PageProviders extends FakeProviderBackend {
  _PageProviders()
    : super(
        profiles: [
          for (var i = 0; i < 45; i++)
            ProviderProfile(route: 'custom-p-$i', displayName: 'Provider $i', api: 'openai-completions'),
        ],
      );
  Completer<ProviderSettings?>? pending;
  ProviderSettings get snapshot => ProviderSettings(profiles: profiles, revision: 3, writable: true);
  @override
  Future<ProviderSettings?> read() => pending?.future ?? super.read();
}
