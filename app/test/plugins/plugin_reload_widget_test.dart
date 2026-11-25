import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/plugin_reload.dart';
import 'package:dsh_app/state/plugins_state.dart';
import 'package:dsh_app/ui/common/list_page_row.dart';
import 'package:dsh_app/ui/plugins/plugin_reload_action.dart';
import 'package:dsh_app/ui/plugins/plugins_screen.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../chat/support/harness.dart';
import '../safe_mode/support.dart' show RecordingRuntime;
import 'support/fake_plugin_host.dart';

const _bundle = PluginBundle(
  name: 'example',
  installed: true,
  enabled: true,
  source: 'file:../example',
  meta: PluginDisplayMeta(title: LocalizedText({'zh': '示例', 'en': 'Example'})),
);
const _running = LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.running));

class _Runtime extends RecordingRuntime {
  _Runtime(super.initial, {this.fail = false});
  final bool fail;
  @override
  Future<void> start() async {
    if (fail) throw StateError('restart failed');
    await super.start();
    emit(_running);
  }
}

class _Active extends ActiveHostController {
  _Active(this.initial);
  final HostRef initial;
  @override
  HostRef build() => initial;
  void use(HostRef next) => state = next;
}

class _Bundles extends InstalledPluginsController {
  _Bundles(this.bundle);
  final PluginBundle bundle;
  @override
  Future<List<PluginBundle>?> build() async => [bundle];
}

Future<({ProviderContainer container, _Runtime runtime})> _pump(
  WidgetTester tester, {
  Locale locale = AppLocale.zhCN,
  Brightness brightness = Brightness.light,
  HostRef host = HostRef.local,
  PluginBundle bundle = _bundle,
  RuntimeStatus status = const RuntimeStatus(phase: RuntimePhase.running),
  bool safeMode = false,
  bool fail = false,
  int copies = 1,
  double width = 390,
  double scale = 1,
}) async {
  usePhoneView(tester);
  tester.view.physicalSize = Size(width * 2, 1688);
  AppLocale.use(locale);
  final runtime = _Runtime(LocalRuntimeState(loaded: true, status: status), fail: fail);
  final client = DshClient.withCarrier(FakePluginCarrier());
  addTearDown(client.close);
  await tester.pumpWidget(
    ProviderScope(
      key: UniqueKey(),
      overrides: [
        activeHostProvider.overrideWith(() => _Active(host)),
        installedPluginsProvider.overrideWith(() => _Bundles(bundle)),
        pluginHostProvider.overrideWithValue(
          PluginHost(client: client, label: 'Host', kind: host.kind, safeMode: safeMode),
        ),
        localRuntimeProvider.overrideWith(() => runtime),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        locale: locale,
        supportedLocales: AppLocale.supported,
        localizationsDelegates: L10n.localizationsDelegates,
        theme: testTheme(brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(children: [for (var i = 0; i < copies; i++) PluginReloadAction(bundle: bundle)]),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  final container = ProviderScope.containerOf(tester.element(find.byType(PluginReloadAction).first));
  await container.read(installedPluginsProvider.future);
  await tester.pump();
  return (container: container, runtime: runtime);
}

void main() {
  setUpAll(loadTestFonts);
  tearDown(() => AppLocale.use(AppLocale.zhCN));

  testWidgets('an installed local source exposes reload through the actual detail sheet', (tester) async {
    final carrier = FakePluginCarrier();
    final client = DshClient.withCarrier(carrier);
    addTearDown(client.close);
    carrier.handlers['pluginManager/listBundles'] = (_) => [
      {...bundleJson('example'), 'source': 'file:../example'},
    ];
    final runtime = _Runtime(_running);
    usePhoneView(tester);
    await tester.pumpWidget(
      testApp(
        const PluginsScreen(),
        overrides: [
          ...pluginOverrides(fakeHost(client), selectHost: false),
          activeHostProvider.overrideWith(() => _Active(HostRef.local)),
          localRuntimeProvider.overrideWith(() => runtime),
        ],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('example'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('重启内核以重载'));
    await tester.tap(find.text('重启内核以重载'));
    await pumpFrames(tester);
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.text('将重启本机内核，重新加载插件。正在运行的任务会中断。'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(runtime.stops, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('reload asks about interrupting tasks; cancel leaves the engine running', (tester) async {
    final f = await _pump(tester);
    await tester.tap(find.text('重启内核以重载'));
    await pumpFrames(tester);
    expect(find.text('重载「示例」？'), findsOneWidget);
    expect(find.text('将重启本机内核，重新加载插件。正在运行的任务会中断。'), findsOneWidget);
    expect(f.runtime.stops, 0);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(f.runtime.stops, 0);
    expect(f.runtime.starts, isEmpty);
    expect(f.container.read(localPluginReloadProvider), isFalse);
  });

  testWidgets('confirmation calls the existing restart and reports only a request', (tester) async {
    final f = await _pump(tester);
    await tester.tap(find.text('重启内核以重载'));
    await pumpFrames(tester);
    await tester.tap(find.widgetWithText(FilledButton, '重启并重载'));
    await tester.pumpAndSettle();
    expect(f.runtime.stops, 1);
    expect(f.runtime.starts, ['start']);
    expect(find.text('已请求重启内核'), findsOneWidget);
  });

  testWidgets('every entry is disabled while one confirmation is open', (tester) async {
    await _pump(tester, copies: 2);
    await tester.tap(find.text('重启内核以重载').first);
    await pumpFrames(tester);
    for (final row in tester.widgetList<ListPageRow>(find.byType(ListPageRow))) {
      expect(row.onTap, isNull);
    }
    expect(find.byType(AlertDialog), findsOneWidget);
  });

  testWidgets('switching hosts during confirmation cancels the local restart', (tester) async {
    final f = await _pump(tester);
    await tester.tap(find.text('重启内核以重载'));
    await pumpFrames(tester);
    (f.container.read(activeHostProvider.notifier) as _Active).use(const HostRef.ssh('other'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '重启并重载'));
    await tester.pumpAndSettle();
    expect(f.runtime.stops, 0);
    expect(find.text('主机或插件状态已变化，请重试'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('restart failure is contained and the busy guard is released', (tester) async {
    final f = await _pump(tester, fail: true);
    await tester.tap(find.text('重启内核以重载'));
    await pumpFrames(tester);
    await tester.tap(find.widgetWithText(FilledButton, '重启并重载'));
    await tester.pumpAndSettle();
    expect(find.text('未能重启内核，请查看引擎日志'), findsOneWidget);
    expect(f.container.read(localPluginReloadProvider), isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('remote, safe, registry and stopped engines have no reload entry', (tester) async {
    await _pump(tester, host: const HostRef.ssh('remote'));
    expect(find.byType(ListPageRow), findsNothing);
    await _pump(tester, safeMode: true);
    expect(find.byType(ListPageRow), findsNothing);
    await _pump(
      tester,
      bundle: const PluginBundle(name: 'registry', installed: true, enabled: true, source: '^1.0.0'),
    );
    expect(find.byType(ListPageRow), findsNothing);
    await _pump(tester, status: const RuntimeStatus(phase: RuntimePhase.installed));
    expect(find.byType(ListPageRow), findsNothing);
  });

  for (final locale in AppLocale.supported) {
    for (final brightness in Brightness.values) {
      final suffix = '${locale.languageCode}_${brightness.name}';
      testWidgets('reload entry and confirmation fit 320 dp at 2x ($suffix)', (tester) async {
        await _pump(tester, locale: locale, brightness: brightness, width: 320, scale: 2);
        final row = tester.getRect(find.byType(ListPageRow));
        final card = tester.getRect(find.byKey(const ValueKey('plugin-reload-action')));
        expect(card.left, 20);
        expect(320 - card.right, 20);
        expect(row.height, greaterThanOrEqualTo(48));
        final l10n = lookupL10n(locale);
        await tester.tap(find.text(l10n.pluginsReloadLocal));
        await pumpFrames(tester);
        expect(find.text(l10n.pluginsReloadExplanation), findsOneWidget);
        expect(tester.takeException(), isNull);
      });

      testWidgets('golden local reload confirmation ($suffix)', (tester) async {
        await _pump(tester, locale: locale, brightness: brightness);
        await tester.tap(find.text(lookupL10n(locale).pluginsReloadLocal));
        await pumpFrames(tester);
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/plugin_reload_$suffix.png'));
      }, tags: ['golden']);
    }
  }
}
