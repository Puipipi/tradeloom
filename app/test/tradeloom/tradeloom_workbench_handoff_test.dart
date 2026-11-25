// ignore_for_file: depend_on_referenced_packages

import 'package:dsh_app/state/app_info.dart';
import 'package:dsh_app/ui/plugins/islands/island_platform.dart';
import 'package:dsh_app/ui/tradeloom/tradeloom_orb.dart';
import 'package:dsh_app/ui/tradeloom/tradeloom_workbench_page.dart';
import 'package:dsh_app/ui/web/web_view_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:webview_flutter/webview_flutter.dart' show WebViewWidget;
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import '../chat/support/harness.dart' show testApp;
import '../shell/adaptive/support.dart' show homeApp, useWindow;
import '../web/support/fake_webview.dart';

void main() {
  const origin = 'https://workbench.example.test:8443';
  late FakeWebViewPlatform web;
  late IslandPlatform originalIslands;

  setUp(() {
    WebViewPlatform.instance = web = FakeWebViewPlatform();
    originalIslands = IslandPlatform.instance;
    IslandPlatform.instance = FakeIslandPlatform();
    SharedPreferences.setMockInitialValues({TradeLoomWorkbenchPage.originKey: origin});
  });

  tearDown(() => IslandPlatform.instance = originalIslands);

  testWidgets('the home orb reaches the dedicated same-origin workflow receiver', (tester) async {
    useWindow(tester, const Size(390, 844));
    await tester.pumpWidget(homeApp());
    await tester.tap(find.byType(TradeLoomOrb));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(TradeLoomWorkbenchPage), findsOneWidget);
    await tester.tap(find.text('接收工作流'));
    await _finishWebLoad(tester, web);

    final page = tester.widget<WebViewPage>(find.byType(WebViewPage));
    final receiver = Uri.parse('$origin/enterprise/workflow-handoff/');
    expect(page.url, receiver);
    expect(page.navigationOrigin, Uri.parse(origin));
    expect(page.allowOpenExternal, isFalse);
    expect(web.controller.loads, [receiver]);
  }, skip: !AppInfo.tradeLoomBuild);

  testWidgets('the receiver applies the existing server origin validation', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(testApp(const TradeLoomWorkbenchPage()));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'https://workbench.example.test/another-path');
    await tester.tap(find.text('接收工作流'));
    await tester.pump();

    expect(find.byType(WebViewPage), findsNothing);
    expect(web.controllers, isEmpty);
    expect(tester.widget<TextField>(find.byType(TextField)).decoration?.errorText, isNotNull);
  });

  testWidgets('connect opens the login target with a clear native viewport', (tester) async {
    useWindow(tester, const Size(320, 640));
    await tester.pumpWidget(testApp(const TradeLoomWorkbenchPage()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('连接工作台'));
    await _finishWebLoad(tester, web);

    final page = tester.widget<WebViewPage>(find.byType(WebViewPage));
    final login = Uri.parse('$origin/accounts/login/?next=%2Fenterprise%2F');
    expect(web.controller.loads, [login]);
    expect(page.navigationOrigin, Uri.parse(origin));
    final webView = tester.getRect(find.byType(WebViewWidget));
    final chrome = tester.getRect(find.byKey(const ValueKey('web-controls-bar')));
    expect(chrome.bottom, greaterThan(24));
    expect(webView.top, chrome.bottom);
    expect(webView.bottom, 640 - 16);
    expect(web.controller.scripts.any((script) => script.contains('dsh-app-insets')), isFalse);

    // Keyboard height replaces the gesture inset. The toolbar clearance stays
    // fixed and the portal never gets the same insets through injected CSS.
    tester.view.viewInsets = const FakeViewPadding(bottom: 400);
    await tester.pump();
    await tester.pump(WebKeyboard.rest + const Duration(milliseconds: 1));
    final typing = tester.getRect(find.byType(WebViewWidget));
    expect(typing.top, chrome.bottom);
    expect(typing.bottom, 640 - 200);
    expect(web.controller.scripts.any((script) => script.contains('dsh-app-insets')), isFalse);
  });
}

Future<void> _finishWebLoad(WidgetTester tester, FakeWebViewPlatform web) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  expect(web.controllers, hasLength(1));
  for (var attempt = 0; attempt < 20 && web.controller.loads.isEmpty; attempt++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump();
  }
  expect(web.controller.loads, hasLength(1));
  web.controller.finish();
  await tester.pump();
}
