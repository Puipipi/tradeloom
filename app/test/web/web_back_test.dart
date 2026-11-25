// System back on a web page: one press, one step. What the page has open
// goes first (assets/web/dsh_web_back.js answers for DSH Web), then the
// WebView's history, then out — off the page, or out of the app when the page
// is the home (网页模式). DSH Web keeps settings, menus and pages in component
// state, never in its history: before this, back from its settings sheet
// left the app.

// ignore_for_file: depend_on_referenced_packages

import 'dart:async';

import 'package:dsh_app/ui/shell/page_frame.dart';
import 'package:dsh_app/ui/web/web_back.dart';
import 'package:dsh_app/ui/web/web_view_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import '../chat/support/harness.dart';
import 'support/fake_webview.dart';

final _url = Uri.parse('http://127.0.0.1:3080/?token=t');

final _backButton = find.byWidgetPredicate((w) => w is GlassIconButton && w.tooltip == '返回');

/// A page with [layers] open, closed top first by `__dshAppBack()`, and
/// [history] entries behind it; records what each press did.
class _Page {
  _Page({List<String>? layers, this.history = 0}) : layers = layers ?? [];

  final List<String> layers;
  int history;
  final log = <String>[];
  int asking = 0;
  int maxAsking = 0;

  /// Holds each answer until [release] (a page busy for a moment).
  Completer<void>? hold;

  void release() {
    final h = hold;
    hold = null;
    h?.complete();
  }

  Future<Object?> ask() async {
    asking++;
    if (asking > maxAsking) maxAsking = asking;
    try {
      log.add('ask');
      if (hold case final h?) await h.future;
      // Android hands strings back JSON-quoted.
      return layers.isEmpty ? '"none"' : '"${layers.removeLast()}"';
    } finally {
      asking--;
    }
  }

  WebBackDispatcher dispatcher({bool Function()? active, bool canAsk = true}) => WebBackDispatcher(
    askPage: () => canAsk ? ask() : null,
    canGoBack: () async => history > 0,
    goBack: () async {
      history--;
      log.add('history');
    },
    leave: () async => log.add('leave'),
    isActive: active,
  );
}

void main() {
  group('the page\'s answer', () {
    test('a step it took, quoted or not', () {
      for (final step in WebBack.steps) {
        expect(WebBack.tookStep('"$step"'), isTrue, reason: step);
        expect(WebBack.tookStep(step), isTrue, reason: step);
      }
    });

    test('nothing to take back, no bridge, no DOM: not a step', () {
      for (final answer in <Object?>['"none"', 'none', '', null, false, true, 0, '"', '"layer', 'null', '"other"']) {
        expect(WebBack.tookStep(answer), isFalse, reason: '$answer');
      }
    });
  });

  group('one press, one step', () {
    test('what the page has open goes first, top first, then out', () async {
      final page = _Page(layers: ['drawer', 'layer']);
      final back = page.dispatcher();
      expect(await back.press(), WebBackOutcome.page);
      expect(await back.press(), WebBackOutcome.page);
      expect(page.log, ['ask', 'ask']);
      expect(await back.press(), WebBackOutcome.leave);
      expect(page.log, ['ask', 'ask', 'ask', 'leave']);
    });

    test('nothing open in the page: its history, then out', () async {
      final page = _Page(history: 1);
      final back = page.dispatcher();
      expect(await back.press(), WebBackOutcome.history);
      expect(await back.press(), WebBackOutcome.leave);
      expect(page.log, ['ask', 'history', 'ask', 'leave']);
    });

    test('a page that can\'t be asked (loading, an error page, another site): history, then out', () async {
      final page = _Page(layers: ['layer'], history: 1);
      final back = page.dispatcher(canAsk: false);
      expect(await back.press(), WebBackOutcome.history);
      expect(await back.press(), WebBackOutcome.leave);
      expect(page.log, ['history', 'leave']);
    });

    test('a page that doesn\'t answer in time is past going back inside', () async {
      final back = WebBackDispatcher(
        askPage: () => Completer<Object?>().future,
        canGoBack: () async => false,
        goBack: () async {},
        leave: () async {},
        answerTimeout: const Duration(milliseconds: 20),
      );
      expect(await back.press(), WebBackOutcome.leave);
    });

    test('a page that throws (no DOM yet) is as if it had nothing open', () async {
      final back = WebBackDispatcher(
        askPage: () => Future<Object?>.error(PlatformException(code: 'js')),
        canGoBack: () async => false,
        goBack: () async {},
        leave: () async {},
      );
      expect(await back.press(), WebBackOutcome.leave);
    });

    test('a quick second press waits for the first: two steps, never one press doing two', () async {
      // Settings open over the drawer; the page is slow to answer.
      final page = _Page(layers: ['drawer', 'layer'])..hold = Completer<void>();
      final back = page.dispatcher();
      final first = back.press();
      final second = back.press();
      await Future<void>.delayed(Duration.zero);
      // The second press hasn't asked the page while the first is in it.
      expect(page.log, ['ask']);
      page.release();
      expect(await first, WebBackOutcome.page);
      expect(await second, WebBackOutcome.page);
      expect(page.maxAsking, 1);
      expect(page.layers, isEmpty);
      expect(page.log, ['ask', 'ask']);
      // Only the next press leaves.
      expect(await back.press(), WebBackOutcome.leave);
    });

    test('presses still waiting when the page goes away do nothing', () async {
      var active = true;
      final page = _Page(layers: ['layer'])..hold = Completer<void>();
      final back = page.dispatcher(active: () => active);
      final first = back.press();
      final second = back.press();
      await Future<void>.delayed(Duration.zero);
      active = false;
      page.release();
      expect(await first, WebBackOutcome.page);
      expect(await second, WebBackOutcome.dropped);
      expect(page.log, ['ask']);
    });
  });

  group('on the page', () {
    late FakeWebViewPlatform platform;
    late List<MethodCall> platformCalls;

    setUp(() => WebViewPlatform.instance = platform = FakeWebViewPlatform());

    FakeWebViewController page() => platform.controllers.last;

    int asks() => page().calls.where((c) => c == 'ask').length;

    /// The page answers [answers] in turn ('none' once they run out).
    void answer(List<String> answers) {
      final queue = [...answers];
      page().results = (script) {
        if (script != WebBack.script) return false;
        page().calls.add('ask');
        return '"${queue.isEmpty ? 'none' : queue.removeAt(0)}"';
      };
    }

    Future<void> load(WidgetTester tester) async {
      for (var i = 0; i < 20 && page().loads.isEmpty; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump();
      }
      page().finish();
      // The bridges load from the asset bundle: real time, then frames.
      for (var i = 0; i < 40 && !page().scripts.any((s) => s.contains('window.__dshAppBack = function')); i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump();
      }
    }

    Future<void> pumpRoot(WidgetTester tester) async {
      usePhoneView(tester);
      platformCalls = [];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        platformCalls.add(call);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      await tester.pumpWidget(testApp(WebViewPage(url: _url, title: '网页版', dshWeb: true, root: true)));
      await load(tester);
    }

    Future<void> pushPage(WidgetTester tester, {bool dshWeb = true}) async {
      usePhoneView(tester);
      await tester.pumpWidget(
        testApp(
          Builder(
            builder: (context) => Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => WebViewPage(url: _url, title: '网页版', dshWeb: dshWeb),
                  ),
                ),
                child: const Text('打开'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('打开'));
      // Not settled: the page shows its loading bar until it has loaded.
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      await load(tester);
      await tester.pumpAndSettle();
    }

    Future<void> systemBack(WidgetTester tester) async {
      await tester.binding.handlePopRoute();
      await pumpFrames(tester, 2);
    }

    bool leftApp() => platformCalls.any((c) => c.method == 'SystemNavigator.pop');

    testWidgets('DSH Web gets the back bridge on every load', (tester) async {
      await pushPage(tester);
      expect(page().scripts.where((s) => s.contains('window.__dshAppBack = function')), hasLength(1));
      page().finish();
      for (var i = 0; i < 10; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump();
      }
      expect(page().scripts.where((s) => s.contains('window.__dshAppBack = function')), hasLength(2));
    });

    testWidgets('as the home: back closes the settings sheet, then the drawer, and only then leaves the app', (
      tester,
    ) async {
      await pumpRoot(tester);
      answer(['layer', 'drawer']);
      await systemBack(tester);
      expect(asks(), 1);
      expect(leftApp(), isFalse);
      await systemBack(tester);
      expect(asks(), 2);
      expect(leftApp(), isFalse);
      await systemBack(tester);
      expect(asks(), 3);
      expect(leftApp(), isTrue);
    });

    testWidgets('as the home: Android\'s predictive back asks the page once per gesture', (tester) async {
      await pumpRoot(tester);
      answer(['layer']);
      Future<void> gesture(String method, [Map<String, Object?>? args]) =>
          tester.binding.defaultBinaryMessenger.handlePlatformMessage(
            'flutter/backgesture',
            const StandardMethodCodec().encodeMethodCall(MethodCall(method, args)),
            (_) {},
          );
      await gesture('startBackGesture', {
        'touchOffset': <double>[5.0, 300.0],
        'progress': 0.0,
        'swipeEdge': 0,
      });
      await gesture('updateBackGestureProgress', {'x': 120.0, 'y': 300.0, 'progress': 0.4, 'swipeEdge': 0});
      await gesture('commitBackGesture');
      await pumpFrames(tester, 2);
      expect(asks(), 1);
      expect(leftApp(), isFalse);
      // A gesture let go of before the end is no back at all.
      await gesture('startBackGesture', {
        'touchOffset': <double>[5.0, 300.0],
        'progress': 0.0,
        'swipeEdge': 0,
      });
      await gesture('cancelBackGesture');
      await pumpFrames(tester, 2);
      expect(asks(), 1);
      expect(leftApp(), isFalse);
    });

    testWidgets('as a page: back steps inside it before the page goes', (tester) async {
      await pushPage(tester);
      answer(['layer']);
      await systemBack(tester);
      await tester.pumpAndSettle();
      expect(find.byType(WebViewPage), findsOneWidget);
      await systemBack(tester);
      await tester.pumpAndSettle();
      expect(find.byType(WebViewPage), findsNothing);
      expect(find.text('打开'), findsOneWidget);
      expect(asks(), 2);
    });

    testWidgets('the page\'s own history before leaving it', (tester) async {
      await pushPage(tester);
      answer([]);
      page().history = 1;
      await systemBack(tester);
      await tester.pumpAndSettle();
      expect(page().goBacks, 1);
      expect(find.byType(WebViewPage), findsOneWidget);
      await systemBack(tester);
      await tester.pumpAndSettle();
      expect(find.byType(WebViewPage), findsNothing);
    });

    testWidgets('the back button takes the same steps', (tester) async {
      await pushPage(tester);
      answer(['popup']);
      await tester.tap(_backButton);
      await tester.pumpAndSettle();
      expect(find.byType(WebViewPage), findsOneWidget);
      await tester.tap(_backButton);
      await tester.pumpAndSettle();
      expect(find.byType(WebViewPage), findsNothing);
      expect(asks(), 2);
    });

    testWidgets('other sites aren\'t asked: their history, then out', (tester) async {
      await pushPage(tester, dshWeb: false);
      var asked = 0;
      page().results = (script) {
        if (script == WebBack.script) asked++;
        return false;
      };
      page().history = 1;
      await systemBack(tester);
      await tester.pumpAndSettle();
      expect(page().goBacks, 1);
      await systemBack(tester);
      await tester.pumpAndSettle();
      expect(find.byType(WebViewPage), findsNothing);
      expect(asked, 0);
      expect(page().scripts.where((s) => s.contains('__dshAppBack')), isEmpty);
    });
  });
}
