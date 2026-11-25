// The real island host/view/handle and shared chooser, with only WebView and
// Android's document-picker channel replaced. This does not run Android UI.
// ignore_for_file: depend_on_referenced_packages

import 'dart:async';

import 'package:dsh_app/plugins/seams/seat_models.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/plugins/islands/islands.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import 'support/fakes.dart';

const _channel = MethodChannel('dsh/web-files');
const _file = 'content://documents/document/picked';
const _params = FileSelectorParams(isCaptureEnabled: false, acceptTypes: ['.json'], mode: FileSelectorMode.open);
final _url = Uri.parse('https://island.test/');

class _AndroidPlatform extends FakeWebViewPlatform {
  _AndroidController get controller => controllers.single as _AndroidController;

  @override
  PlatformWebViewController createPlatformWebViewController(PlatformWebViewControllerCreationParams params) {
    final controller = _AndroidController(params);
    controllers.add(controller);
    return controller;
  }

  @override
  PlatformNavigationDelegate createPlatformNavigationDelegate(PlatformNavigationDelegateCreationParams params) =>
      _Navigation(params);
}

class _AndroidController extends FakeWebViewController implements AndroidWebViewController {
  _AndroidController(super.params);

  final calls = <String>[];
  Future<List<String>> Function(FileSelectorParams)? selector;
  Future<String?> Function()? readUrl;

  @override
  int get webViewIdentifier => 332;

  @override
  Future<void> loadRequest(LoadRequestParams params) async {
    calls.add('loadRequest');
    await super.loadRequest(params);
  }

  @override
  Future<void> setOnShowFileSelector(Future<List<String>> Function(FileSelectorParams)? callback) async {
    calls.add('setOnShowFileSelector');
    selector = callback;
  }

  @override
  Future<String?> currentUrl() => readUrl?.call() ?? Future.value(loads.last.toString());

  void start() => (delegate! as _Navigation).onPageStarted?.call(loads.last.toString());

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Navigation extends FakeNavigationDelegate {
  _Navigation(super.params);

  PageEventCallback? onPageStarted;

  @override
  Future<void> setOnPageStarted(PageEventCallback callback) async => onPageStarted = callback;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late _AndroidPlatform web;
  late FakeIslandPlatform platform;
  late IslandHost host;
  late List<MethodCall> calls;
  late IslandSpec spec;

  setUp(() {
    WebViewPlatform.instance = web = _AndroidPlatform();
    platform = FakeIslandPlatform();
    host = IslandHost(platform: platform, assets: TestIslandAssets());
    spec = const IslandSpec(host: HostRef.local, form: IslandForm.page, slot: 'main', cell: 'schedules');
    calls = [];
    messenger.setMockMethodCallHandler(_channel, (call) async {
      calls.add(call);
      return call.method == 'pick' ? [_file] : null;
    });
  });

  Widget app({bool show = true}) => ProviderScope(
    overrides: [
      islandHostProvider.overrideWith((ref) => host),
      islandHostUrlProvider.overrideWith((ref, host) => _url),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: show ? IslandView(spec: spec, fallback: (_) => const Text('fallback')) : const SizedBox(),
      ),
    ),
  );

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 10));
    }
  }

  Future<void> mount(WidgetTester tester, {bool ready = true}) async {
    await tester.pumpWidget(app());
    await settle(tester);
    expect(web.controller.selector, isNotNull, reason: 'the island must register Android document input');
    if (ready) {
      await web.controller.finish();
      await settle(tester);
      web.controller.post('{"t":"ready","slot":"main","found":1}');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(host.live.single.phase, IslandPhase.ready);
    }
  }

  Future<List<String>> pendingPicker(WidgetTester tester, Completer<List<String>> selected) async {
    messenger.setMockMethodCallHandler(_channel, (call) async {
      calls.add(call);
      return call.method == 'pick' ? selected.future : null;
    });
    return web.controller.selector!(_params);
  }

  void scenario(String name, Future<void> Function(WidgetTester) body) {
    testWidgets(name, (tester) async {
      try {
        await body(tester);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        host.dispose();
        await tester.pump();
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        messenger.setMockMethodCallHandler(_channel, null);
      }
    });
  }

  scenario('island document input is attached before loading and returns selected content', (tester) async {
    await mount(tester);
    expect(
      web.controller.calls.indexOf('setOnShowFileSelector'),
      lessThan(web.controller.calls.indexOf('loadRequest')),
    );
    expect(await web.controller.selector!(_params), [_file]);
    final pick = calls.singleWhere((c) => c.method == 'pick');
    expect(pick.arguments, containsPair('webViewId', 332));
    expect(pick.arguments, containsPair('url', web.controller.loads.single.toString()));
    expect(pick.arguments, containsPair('acceptTypes', ['.json']));
  });

  for (final probe in [false, true]) {
    scenario('an invisible island cannot request documents: probe=$probe', (tester) async {
      if (probe) spec = const IslandSpec(host: HostRef.local, form: IslandForm.probe, slot: 'main', cell: 'schedules');
      await mount(tester, ready: probe);
      expect(await web.controller.selector!(_params), isEmpty);
      expect(calls, isEmpty);
    });
  }

  for (final retirement in ['navigation', 'renderer', 'close']) {
    scenario('$retirement retires a pending island document selection', (tester) async {
      await mount(tester);
      final selected = Completer<List<String>>();
      final pending = pendingPicker(tester, selected);
      await tester.pump();
      expect(calls.where((c) => c.method == 'pick'), hasLength(1));
      switch (retirement) {
        case 'navigation':
          web.controller.start();
        case 'renderer':
          platform.emit(const IslandRendererGone(webViewId: 332, crashed: true));
        case 'close':
          unawaited(host.live.single.close());
      }
      await tester.pump();
      expect(calls.where((c) => c.method == 'cancel'), hasLength(1));
      selected.complete([_file]);
      expect(await pending, isEmpty);
    });
  }

  scenario('leaving and reopening a warm island cannot receive its old picker result', (tester) async {
    await mount(tester);
    final handle = host.live.single;
    final selected = Completer<List<String>>();
    final pending = pendingPicker(tester, selected);
    await tester.pump();
    await tester.pumpWidget(app(show: false));
    expect(handle.views, 0);
    await tester.pumpWidget(app());
    await settle(tester);
    expect(host.live.single, same(handle));
    expect(handle.visible, isTrue);
    selected.complete([_file]);
    expect(await pending, isEmpty);
    expect(calls.where((c) => c.method == 'cancel'), hasLength(1));
  });

  scenario('system picker activity pause does not cancel the visible island owner', (tester) async {
    await mount(tester);
    final handle = host.live.single;
    final selected = Completer<List<String>>();
    final pending = pendingPicker(tester, selected);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(handle.paused, isTrue);
    expect(handle.visible, isTrue);
    expect(calls.where((c) => c.method == 'cancel'), isEmpty);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    selected.complete([_file]);
    expect(await pending, [_file]);
  });

  scenario('leaving before the initial URL resolves cannot open the document picker', (tester) async {
    await mount(tester);
    final url = Completer<String?>();
    web.controller.readUrl = () => url.future;
    final pending = web.controller.selector!(_params);
    await tester.pump();
    await tester.pumpWidget(app(show: false));
    url.complete(web.controller.loads.single.toString());
    expect(await pending, isEmpty);
    expect(calls, isEmpty);
  });

  scenario('covering and returning to an island retires a result awaiting its final URL check', (tester) async {
    await mount(tester);
    final url = Completer<String?>();
    var reads = 0;
    web.controller.readUrl = () => ++reads == 1 ? Future.value(web.controller.loads.single.toString()) : url.future;
    final pending = web.controller.selector!(_params);
    await tester.pump();
    expect(reads, 2);
    final handle = host.live.single;
    final navigator = Navigator.of(tester.element(find.byType(IslandView)));
    unawaited(navigator.push<void>(MaterialPageRoute(builder: (_) => const Scaffold(body: Text('another route')))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(handle.visible, isFalse);
    navigator.pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(handle.visible, isTrue);
    url.complete(web.controller.loads.single.toString());
    expect(await pending, isEmpty);
  });
}
