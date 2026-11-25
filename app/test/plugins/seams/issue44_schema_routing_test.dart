// A native adapter must not claim a namespace that its form renders empty.
// Exercise the real inventory, planner, schema seat, island and web fallback.

// ignore_for_file: depend_on_referenced_packages

import 'package:dsh_app/plugins/seams/seams.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/engine_settings_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/plugins_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/engine_settings/schema_form.dart';
import 'package:dsh_app/ui/plugins/islands/islands.dart';
import 'package:dsh_app/ui/plugins/seats/plugin_seat_page.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import '../../engine_settings/support.dart' show pumpPage, settle;
import '../../shell/golden_harness.dart' show FakeSettings;
import '../islands/support/fakes.dart';

const _package = 'dsh-schema-routing-test';
const _namespace = 'schema-routing-test';
const _request = SeatRequest(slot: Slots.bundleConfig, placement: SeatPlacement.page, package: _package);

class _Settings extends EngineSettingsController {
  _Settings(this.settings);
  final EngineSettings settings;

  @override
  Future<EngineSettings?> build() async => settings;
}

class _Installed extends InstalledPluginsController {
  @override
  Future<List<PluginBundle>?> build() async => [_bundle];
}

class _Host extends ActiveHostController {
  @override
  HostRef build() => const HostRef.ssh('test-host');
}

final _bundle = PluginBundle.fromJson({
  'name': _package,
  'enabled': true,
  'installed': true,
  'rows': [
    {'rowId': _namespace, 'moduleName': _package},
  ],
});

EngineSettings _settings(int nesting, {bool hidden = false}) {
  Map<String, Object?> schema = {
    'type': 'string',
    if (hidden) 'meta': {'hidden': true},
  };
  Object value = 'visible value';
  for (var depth = nesting; depth >= 0; depth--) {
    final key = depth == nesting ? 'message' : 'level$depth';
    schema = {
      'type': 'object',
      'dict': {key: schema},
    };
    value = {key: value};
  }
  final description = SettingsDescription.fromJson({
    'namespaces': [
      {'ns': _namespace, 'autoGenerate': true, 'schema': schema, 'value': value, 'base': value, 'user': {}},
    ],
  });
  return EngineSettings(namespaces: description.namespaces);
}

/// A namespace whose schema the native form has no control for: the form
/// would hold only a web fallback row.
EngineSettings _fallbackOnly() {
  final description = SettingsDescription.fromJson({
    'namespaces': [
      {
        'ns': _namespace,
        'autoGenerate': true,
        'schema': {'type': 'custom-dynamic'},
        'value': 'visible value',
        'base': 'visible value',
        'user': {},
      },
    ],
  });
  return EngineSettings(namespaces: description.namespaces);
}

SeatInventory _inventory(EngineSettings settings, {bool web = true}) => SeatInventory.from(
  ClientInventory.combine(
    bundles: [_bundle],
    boot: WebBootGraph.fromJson({
      'rev': 'test-boot',
      'entries': [
        {'id': _package, 'rev': 'test-plugin'},
      ],
    }),
  ),
  namespaces: settings.namespaces,
  webReachable: web,
);

void main() {
  late FakeWebViewPlatform web;
  late IslandHost host;
  var disposed = false;

  setUp(() {
    disposed = false;
    web = FakeWebViewPlatform();
    WebViewPlatform.instance = web;
    host = IslandHost(platform: FakeIslandPlatform(), assets: TestIslandAssets());
  });
  tearDown(() {
    if (!disposed) host.dispose();
  });

  Future<void> open(WidgetTester tester, EngineSettings settings, {bool islands = true, bool reachable = true}) async {
    await pumpPage(
      tester,
      const PluginSeatPage(title: 'Plugin settings', request: _request),
      overrides: [
        activeHostProvider.overrideWith(_Host.new),
        activeConnectionProvider.overrideWithValue(const AsyncData(null)),
        settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
        installedPluginsProvider.overrideWith(_Installed.new),
        engineSettingsProvider.overrideWith(() => _Settings(settings)),
        seatInventoryProvider.overrideWith((ref) => _inventory(settings, web: reachable)),
        islandBudgetProvider.overrideWithValue(islands ? const OpenIslandBudget() : const NoIslandBudget()),
        islandHostProvider.overrideWith((ref) => host),
        islandHostUrlProvider.overrideWith((ref, host) => Uri.parse('http://127.0.0.1:3080/')),
        bridgeInventoryProvider.overrideWith((ref) async => null),
      ],
    );
  }

  test('hidden-only and fallback-only namespaces are not claimed by the native form', () {
    final hidden = _settings(2, hidden: true);
    expect(schemaFormGroups(schemaSections(hidden[_namespace]!), settings: hidden), isEmpty);
    for (final settings in [hidden, _fallbackOnly()]) {
      expect(hasFormFields(settings[_namespace]!), isFalse);
      expect(_inventory(settings).infoOf(_package).configNamespaces, isEmpty);
    }
  });

  test('a deep namespace is a native form: nested objects have no depth limit', () {
    final settings = _settings(3);
    expect(hasFormFields(settings[_namespace]!), isTrue);
    expect(_inventory(settings).infoOf(_package).configNamespaces, [_namespace]);
  });

  for (final nesting in [2, 3]) {
    testWidgets('fields at depth $nesting use the real native schema seat', (tester) async {
      await open(tester, _settings(nesting));
      expect(find.byType(SchemaConfigSeat), findsOneWidget);
      expect(find.text('visible value'), findsOneWidget);
      expect(find.byType(IslandView), findsNothing);
      expect(web.controllers, isEmpty);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('a fallback-only namespace uses an island and exposes its web fallback on failure', (tester) async {
    await open(tester, _fallbackOnly());
    expect(find.byType(SchemaConfigSeat), findsNothing);
    expect(find.byType(IslandView), findsOneWidget);
    expect(find.byType(IslandSkeleton), findsOneWidget);
    expect(web.controllers, hasLength(1));
    final page = web.controllers.single;
    await page.finish();
    await settle(tester);
    page.post('{"t":"ready","slot":"plugins.bundle.config","found":1}');
    await settle(tester);
    expect(host.live.single.phase, IslandPhase.ready);
    expect(find.byKey(fakeWebViewKey), findsOneWidget);
    page.fail();
    await settle(tester);
    expect(find.text('在网页版打开'), findsOneWidget);
    expect(find.byType(IslandSkeleton), findsNothing);
    await tester.pumpWidget(const SizedBox());
    host.dispose();
    disposed = true;
    await tester.pump();
  });

  testWidgets('a fallback-only namespace has a web entry when islands are unavailable', (tester) async {
    await open(tester, _fallbackOnly(), islands: false);
    expect(find.text('在网页版打开'), findsOneWidget);
    expect(find.byType(SchemaConfigSeat), findsNothing);
    expect(web.controllers, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an unreachable web host does not advertise an empty native form', (tester) async {
    await open(tester, _fallbackOnly(), reachable: false);
    final context = tester.element(find.byType(PluginSeatPage));
    final plan = ProviderScope.containerOf(context).read(seatPlanProvider(_request));
    expect(plan.visible, isEmpty);
    expect(find.byType(SchemaConfigSeat), findsNothing);
    expect(find.byType(IslandView), findsNothing);
    expect(find.text('在网页版打开'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
