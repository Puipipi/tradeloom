// Fakes for the islands tests: a WebView platform with no web engine (a box
// where the page would be, a record of the scripts the app ran, and the
// channel / navigation callbacks for the test to drive) and an islands
// platform that records the Android calls.

// The platform interface is what webview_flutter itself builds on; the app
// only depends on webview_flutter.
// ignore_for_file: depend_on_referenced_packages

import 'dart:async';
import 'dart:io';

import 'package:dsh_app/ui/plugins/islands/islands.dart';
import 'package:flutter/widgets.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

class FakeWebViewPlatform extends WebViewPlatform {
  final controllers = <FakeWebViewController>[];

  @override
  PlatformWebViewController createPlatformWebViewController(PlatformWebViewControllerCreationParams params) {
    final controller = FakeWebViewController(params);
    controllers.add(controller);
    return controller;
  }

  @override
  PlatformNavigationDelegate createPlatformNavigationDelegate(PlatformNavigationDelegateCreationParams params) =>
      FakeNavigationDelegate(params);

  @override
  PlatformWebViewWidget createPlatformWebViewWidget(PlatformWebViewWidgetCreationParams params) =>
      _FakeWebViewWidget(params);
}

class FakeWebViewController extends PlatformWebViewController {
  FakeWebViewController(super.params) : super.implementation();

  final loads = <Uri>[];
  final channels = <String, JavaScriptChannelParams>{};
  final scripts = <String>[];
  Color? background;
  FakeNavigationDelegate? delegate;

  @override
  Future<void> loadRequest(LoadRequestParams params) async => loads.add(params.uri);

  @override
  Future<void> setJavaScriptMode(JavaScriptMode javaScriptMode) async {}

  @override
  Future<void> setBackgroundColor(Color color) async => background = color;

  @override
  Future<void> setPlatformNavigationDelegate(PlatformNavigationDelegate handler) async =>
      delegate = handler as FakeNavigationDelegate;

  @override
  Future<void> addJavaScriptChannel(JavaScriptChannelParams javaScriptChannelParams) async =>
      channels[javaScriptChannelParams.name] = javaScriptChannelParams;

  @override
  Future<void> setOnPlatformPermissionRequest(
    void Function(PlatformWebViewPermissionRequest request) onPermissionRequest,
  ) async {}

  /// The page posts [message] on the island channel.
  void post(String message) => channels['DshGoIsland']!.onMessageReceived(JavaScriptMessage(message: message));

  @override
  Future<Object> runJavaScriptReturningResult(String javaScript) async => 'null';

  @override
  Future<void> runJavaScript(String javaScript) async => scripts.add(javaScript);

  /// The page finished loading.
  Future<void> finish() async => delegate!.onPageFinished?.call(loads.last.toString());

  /// The main frame failed to load.
  void fail() => delegate!.onWebResourceError?.call(
    const WebResourceError(errorCode: -2, description: 'net::ERR_CONNECTION_REFUSED', isForMainFrame: true),
  );

  /// What the island's navigation policy says about [url].
  Future<NavigationDecision> navigate(String url, {bool mainFrame = true}) async =>
      await delegate!.onNavigationRequest!(NavigationRequest(url: url, isMainFrame: mainFrame));
}

class FakeNavigationDelegate extends PlatformNavigationDelegate {
  FakeNavigationDelegate(super.params) : super.implementation();

  PageEventCallback? onPageFinished;
  WebResourceErrorCallback? onWebResourceError;
  NavigationRequestCallback? onNavigationRequest;

  @override
  Future<void> setOnNavigationRequest(NavigationRequestCallback onNavigationRequest) async =>
      this.onNavigationRequest = onNavigationRequest;

  @override
  Future<void> setOnPageStarted(PageEventCallback onPageStarted) async {}

  @override
  Future<void> setOnPageFinished(PageEventCallback onPageFinished) async => this.onPageFinished = onPageFinished;

  @override
  Future<void> setOnProgress(ProgressCallback onProgress) async {}

  @override
  Future<void> setOnWebResourceError(WebResourceErrorCallback onWebResourceError) async =>
      this.onWebResourceError = onWebResourceError;

  @override
  Future<void> setOnUrlChange(UrlChangeCallback onUrlChange) async {}

  @override
  Future<void> setOnHttpAuthRequest(HttpAuthRequestCallback onHttpAuthRequest) async {}

  @override
  Future<void> setOnHttpError(HttpResponseErrorCallback onHttpError) async {}

  @override
  Future<void> setOnSSlAuthError(SslAuthErrorCallback onSslAuthError) async {}
}

/// Where the page would be.
const fakeWebViewKey = ValueKey('fake-island-webview');

class _FakeWebViewWidget extends PlatformWebViewWidget {
  _FakeWebViewWidget(super.params) : super.implementation();

  @override
  /// Opaque to touches, like a platform view.
  Widget build(BuildContext context) => const Listener(
    behavior: HitTestBehavior.opaque,
    child: SizedBox.expand(key: fakeWebViewKey),
  );
}

/// The Android side, recorded. Has no WebView identifiers (the fake
/// controller isn't an Android one), so attach / destroy never get called
/// with one; [device] answers what the test sets.
class FakeIslandPlatform extends IslandPlatform {
  FakeIslandPlatform({this.deviceInfo = const IslandDevice(totalMem: 8 << 30)});

  IslandDevice deviceInfo;
  final calls = <String>[];
  final _events = StreamController<IslandPlatformEvent>.broadcast();

  void emit(IslandPlatformEvent event) => _events.add(event);

  @override
  Future<IslandDevice> device() async => deviceInfo;

  @override
  Future<bool> attach(int webViewId, {required bool dark, required int textZoom}) async {
    calls.add('attach $webViewId');
    return true;
  }

  @override
  Future<void> setDark(int webViewId, bool dark) async => calls.add('dark $dark');

  @override
  Future<void> setTextZoom(int webViewId, int percent) async => calls.add('zoom $percent');

  @override
  Future<void> pause(int webViewId) async => calls.add('pause');

  @override
  Future<void> resume(int webViewId) async => calls.add('resume');

  @override
  Future<void> destroy(int webViewId) async => calls.add('destroy');

  @override
  Future<int?> appPss() async => null;

  @override
  Stream<IslandPlatformEvent> get events => _events.stream;
}

/// The real recipes, read synchronously (no real IO inside fake async); the
/// scripts are stand-ins the tests can recognise.
class TestIslandAssets extends IslandAssets {
  TestIslandAssets() : _book = IslandRecipeBook.parse(File('assets/islands/recipes.json').readAsStringSync());

  final IslandRecipeBook _book;

  @override
  Future<String> get openBridge async => '/* open bridge */';

  @override
  Future<String> get runtime async => '/* island runtime */';

  @override
  Future<String> get css async => '/* css */';

  @override
  Future<IslandRecipeBook> get recipes async => _book;
}
