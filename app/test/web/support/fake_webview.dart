// A WebView platform for widget tests: no web engine, just a box where the
// page would be, a record of what the app asked of it, and the navigation
// callbacks so a test can finish a load or fail one.

// The platform interface is what webview_flutter itself builds on; the app
// only depends on webview_flutter.
// ignore_for_file: depend_on_referenced_packages

import 'dart:async';

import 'package:dsh_app/ui/plugins/islands/island_platform.dart';
import 'package:flutter/widgets.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

class FakeWebViewPlatform extends WebViewPlatform {
  final controllers = <FakeWebViewController>[];

  FakeWebViewController get controller => controllers.single;

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
  FakeWebViewController(super.params) : webViewIdentifier = _nextId++, super.implementation();

  static int _nextId = 1;

  /// As webview_flutter_android's: the native WebView's id (WebViewGuard).
  final int webViewIdentifier;

  /// Platform calls in order, for checks like "guarded after the delegate".
  final calls = <String>[];

  final loads = <Uri>[];
  final channels = <String, JavaScriptChannelParams>{};
  final scripts = <String>[];
  int reloads = 0;
  FakeNavigationDelegate? delegate;

  /// The last insets script the page got (it styles `#dsh-app-insets`).
  String? get insetsScript => scripts.lastWhere((s) => s.contains('dsh-app-insets'), orElse: () => '');

  @override
  Future<void> loadRequest(LoadRequestParams params) async {
    calls.add('loadRequest');
    loads.add(params.uri);
  }

  @override
  Future<void> loadHtmlString(String html, {String? baseUrl}) async => calls.add('loadHtmlString');

  @override
  Future<void> setJavaScriptMode(JavaScriptMode javaScriptMode) async {}

  @override
  Future<void> setBackgroundColor(Color color) async {}

  @override
  Future<void> setPlatformNavigationDelegate(PlatformNavigationDelegate handler) async {
    calls.add('setNavigationDelegate');
    delegate = handler as FakeNavigationDelegate;
  }

  @override
  Future<void> addJavaScriptChannel(JavaScriptChannelParams javaScriptChannelParams) async =>
      channels[javaScriptChannelParams.name] = javaScriptChannelParams;

  /// The page posts [message] to the app's [channel].
  void post(String channel, String message) =>
      channels[channel]!.onMessageReceived(JavaScriptMessage(message: message));

  /// Answers for `runJavaScriptReturningResult` (none: null).
  Object Function(String script)? results;

  @override
  Future<Object> runJavaScriptReturningResult(String javaScript) async => results?.call(javaScript) ?? false;

  @override
  Future<void> runJavaScript(String javaScript) async => scripts.add(javaScript);

  /// Entries in the WebView's own history (back pops one).
  int history = 0;
  int goBacks = 0;

  @override
  Future<bool> canGoBack() async => history > 0;

  @override
  Future<void> goBack() async {
    goBacks++;
    history--;
  }

  @override
  Future<void> reload() async => reloads++;

  @override
  Future<String?> currentUrl() async => loads.isEmpty ? null : loads.last.toString();

  /// A load of the last requested page started.
  void start() => delegate!.onPageStarted?.call(loads.last.toString());

  /// The page finished loading.
  void finish() => delegate!.onPageFinished?.call(loads.last.toString());

  /// The page failed to load.
  void fail() => delegate!.onWebResourceError?.call(
    const WebResourceError(errorCode: -2, description: 'net::ERR_CONNECTION_REFUSED', isForMainFrame: true),
  );
}

class FakeNavigationDelegate extends PlatformNavigationDelegate {
  FakeNavigationDelegate(super.params) : super.implementation();

  PageEventCallback? onPageStarted;
  PageEventCallback? onPageFinished;
  ProgressCallback? onProgress;
  WebResourceErrorCallback? onWebResourceError;

  @override
  Future<void> setOnNavigationRequest(NavigationRequestCallback onNavigationRequest) async {}

  @override
  Future<void> setOnPageStarted(PageEventCallback onPageStarted) async => this.onPageStarted = onPageStarted;

  @override
  Future<void> setOnPageFinished(PageEventCallback onPageFinished) async => this.onPageFinished = onPageFinished;

  @override
  Future<void> setOnProgress(ProgressCallback onProgress) async => this.onProgress = onProgress;

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
const fakeWebViewKey = ValueKey('fake-webview');

class _FakeWebViewWidget extends PlatformWebViewWidget {
  _FakeWebViewWidget(super.params) : super.implementation();

  @override
  Widget build(BuildContext context) => const SizedBox.expand(key: fakeWebViewKey);
}

/// The islands' platform side (IslandsPlugin.kt) as WebViewGuard uses it:
/// records what was attached and destroyed; [gone] plays a renderer loss.
class FakeIslandPlatform extends IslandPlatform {
  final attached = <({int id, bool dark, int textZoom})>[];
  final destroyed = <int>[];
  final darkCalls = <(int, bool)>[];
  final _events = StreamController<IslandPlatformEvent>.broadcast();

  /// The renderer of every WebView is gone.
  void gone({int webViewId = 0, bool crashed = true}) =>
      _events.add(IslandRendererGone(webViewId: webViewId, crashed: crashed));

  @override
  Future<bool> attach(int webViewId, {required bool dark, required int textZoom}) async {
    attached.add((id: webViewId, dark: dark, textZoom: textZoom));
    return true;
  }

  @override
  Future<void> destroy(int webViewId) async => destroyed.add(webViewId);

  @override
  Future<void> setDark(int webViewId, bool dark) async => darkCalls.add((webViewId, dark));

  @override
  Future<void> setTextZoom(int webViewId, int percent) async {}

  @override
  Future<void> pause(int webViewId) async {}

  @override
  Future<void> resume(int webViewId) async {}

  @override
  Future<IslandDevice> device() async => IslandDevice.unknown;

  @override
  Future<int?> appPss() async => null;

  @override
  Stream<IslandPlatformEvent> get events => _events.stream;
}
