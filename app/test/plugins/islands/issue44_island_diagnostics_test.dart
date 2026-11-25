// ignore_for_file: depend_on_referenced_packages

import 'package:dsh_app/plugins/seams/seams.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/plugins/islands/islands.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_app/ui/web/web_view_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import 'support/fakes.dart';
import '../../chat/support/harness.dart' show testApp;
import '../../web/support/fake_webview.dart' as full_web;

void main() {
  testWidgets('debug diagnostics identify the provider and resource failure without logging credentials', (
    tester,
  ) async {
    final web = FakeWebViewPlatform();
    WebViewPlatform.instance = web;
    final messages = <String>[];
    final previousPrint = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) {
      if (message != null) messages.add(message);
    };
    final host = IslandHost(
      platform: FakeIslandPlatform(
        deviceInfo: const IslandDevice(totalMem: 8 << 30, webView: 'test.webview 123.4'),
      ),
      assets: TestIslandAssets(),
    );
    try {
      const spec = IslandSpec(host: HostRef.local, form: IslandForm.page, slot: Slots.settingsSection, cell: 'models');
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            islandHostProvider.overrideWith((ref) => host),
            islandHostUrlProvider.overrideWith((ref, host) => Uri.parse('http://127.0.0.1:3080/?token=DO_NOT_LOG')),
          ],
          child: MaterialApp(
            theme: buildLightTheme(),
            home: Scaffold(
              body: IslandView(spec: spec, fallback: (_) => const Text('web fallback')),
            ),
          ),
        ),
      );
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 10));
      }
      expect(messages.any((line) => line.contains('webView=test.webview 123.4')), isTrue);
      final page = web.controllers.single;
      void fail({required bool mainFrame}) => page.delegate!.onWebResourceError!(
        WebResourceError(
          errorCode: -2,
          errorType: WebResourceErrorType.hostLookup,
          isForMainFrame: mainFrame,
          url: 'http://127.0.0.1:3080/?token=DO_NOT_LOG',
          description: 'DO_NOT_LOG',
        ),
      );
      fail(mainFrame: false);
      await tester.pump();
      expect(host.live.single.phase, IslandPhase.loading);
      expect(find.text('web fallback'), findsNothing);
      expect(messages.any((line) => line.contains('code=-2 type=hostLookup mainFrame=false')), isTrue);

      fail(mainFrame: true);
      await tester.pump();
      await tester.pump();
      expect(find.text('web fallback'), findsOneWidget);
      expect(messages.any((line) => line.contains('code=-2 type=hostLookup mainFrame=true')), isTrue);
      expect(messages.join('\n'), isNot(contains('DO_NOT_LOG')));
    } finally {
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      await tester.pump();
      debugPrint = previousPrint;
    }
  });

  testWidgets('the full web fallback reports resource codes without changing its error UI', (tester) async {
    final web = full_web.FakeWebViewPlatform();
    WebViewPlatform.instance = web;
    final messages = <String>[];
    final previousPrint = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) {
      if (message != null) messages.add(message);
    };
    try {
      await tester.pumpWidget(
        testApp(
          WebViewPage(
            url: Uri.parse('http://127.0.0.1:3080/?token=DO_NOT_LOG'),
            title: 'Plugin web settings',
            dshWeb: true,
          ),
        ),
      );
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      void fail({required bool mainFrame}) => web.controller.delegate!.onWebResourceError!(
        WebResourceError(
          errorCode: -2,
          errorType: WebResourceErrorType.hostLookup,
          isForMainFrame: mainFrame,
          url: 'http://127.0.0.1:3080/?token=DO_NOT_LOG',
          description: 'DO_NOT_LOG',
        ),
      );
      fail(mainFrame: false);
      await tester.pump();
      expect(find.text('页面没有打开'), findsNothing);
      fail(mainFrame: true);
      await tester.pumpAndSettle();
      expect(find.text('页面没有打开'), findsOneWidget);
      expect(
        messages.any((line) => line.contains('[webview] resource: code=-2 type=hostLookup mainFrame=false')),
        isTrue,
      );
      expect(
        messages.any((line) => line.contains('[webview] resource: code=-2 type=hostLookup mainFrame=true')),
        isTrue,
      );
      expect(messages.join('\n'), isNot(contains('DO_NOT_LOG')));
    } finally {
      await tester.pumpWidget(const SizedBox());
      debugPrint = previousPrint;
    }
  });
}
