// The web pages in landscape and on tablets: where the app's controls sit,
// where the page's content may go, and which layout DSH Web gets. Measured
// on real window shapes from the emulator (a side punch-hole in landscape)
// and a vivo phone (no bottom inset reported in landscape). The app hands
// every page the cutout's inset on both sides (MirroredSideInsets), as the
// test harness does.

// ignore_for_file: depend_on_referenced_packages

import 'dart:convert';

import 'package:dsh_app/ui/chat/render/mermaid_preview.dart';
import 'package:dsh_app/ui/common/side_insets.dart';
import 'package:dsh_app/ui/shell/page_frame.dart';
import 'package:dsh_app/ui/web/web_handle.dart';
import 'package:dsh_app/ui/web/web_view_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import '../chat/support/harness.dart';
import 'support/fake_webview.dart';

final _url = Uri.parse('http://127.0.0.1:3080/?token=t');

/// A window: logical size and system padding (status bar, gesture bar, cutout).
typedef _Window = ({Size size, EdgeInsets padding});

/// Pixel 7 emulator (dpr 2.625), punch-hole on the left in landscape.
const _phonePortrait = (size: Size(411.4, 914.3), padding: EdgeInsets.fromLTRB(0, 52, 0, 24));
const _phoneLandscape = (size: Size(914.3, 411.4), padding: EdgeInsets.fromLTRB(52, 28, 0, 24));

/// A vivo phone in landscape: no bottom inset, though the handle shows.
const _vivoLandscape = (size: Size(800, 360), padding: EdgeInsets.fromLTRB(0, 42, 0, 0));

/// Tablets (dpr 2): 600 and 840 wide in portrait, 1280 in landscape.
const _tablet600 = (size: Size(600, 960), padding: EdgeInsets.fromLTRB(0, 24, 0, 32));
const _tablet840 = (size: Size(840, 1200), padding: EdgeInsets.fromLTRB(0, 24, 0, 32));
const _tablet1280 = (size: Size(1280, 800), padding: EdgeInsets.fromLTRB(0, 24, 0, 32));

void _useWindow(WidgetTester tester, _Window w) {
  const dpr = 2.0;
  tester.view.devicePixelRatio = dpr;
  tester.view.physicalSize = w.size * dpr;
  final p = FakeViewPadding(
    left: w.padding.left * dpr,
    top: w.padding.top * dpr,
    right: w.padding.right * dpr,
    bottom: w.padding.bottom * dpr,
  );
  tester.view.padding = p;
  tester.view.viewPadding = p;
  addTearDown(tester.view.reset);
}

/// What a page sees of [w]: the side insets mirrored, as at the app's root.
WebPageInsets _resolve(_Window w, {bool dshWeb = true, bool adapt = true, double keyboard = 0}) =>
    WebPageInsets.resolve(
      size: w.size,
      padding: MirroredSideInsets.mirror(w.padding),
      keyboard: keyboard,
      dshWeb: dshWeb,
      adapt: adapt,
    );

/// The cutout's inset, on both sides in landscape.
const _side = 52.0;

Finder _button(String tooltip) => find.byWidgetPredicate(
  (w) => w is GlassIconButton && w.tooltip == tooltip,
  description: 'GlassIconButton($tooltip)',
);

late FakeWebViewPlatform _platform;

Future<void> _pump(
  WidgetTester tester,
  _Window window, {
  bool dshWeb = true,
  bool phoneLayout = true,
  Brightness brightness = Brightness.light,
}) async {
  _useWindow(tester, window);
  await tester.pumpWidget(
    testApp(
      WebViewPage(
        url: _url,
        title: '远程控制台',
        subtitle: 'dsh.r2049.cn',
        allowOpenExternal: true,
        dshWeb: dshWeb,
        phoneLayout: phoneLayout,
      ),
      brightness: brightness,
    ),
  );
  // The WebView loads once it is set up and guarded.
  for (var i = 0; i < 20 && _platform.controller.loads.isEmpty; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump();
  }
  _platform.controller.finish();
  await tester.pump();
}

void main() {
  setUp(() => WebViewPlatform.instance = _platform = FakeWebViewPlatform());

  group('DSH Web layout follows the official breakpoint', () {
    test('below 1024 the sidebar is a drawer, from 1024 up the official layout stays', () {
      for (final w in [_phonePortrait, _phoneLandscape, _vivoLandscape, _tablet600, _tablet840]) {
        expect(_resolve(w).chrome, WebChrome.inline, reason: '${w.size}');
      }
      expect(_resolve(_tablet1280).chrome, WebChrome.side);
      // The frame is what the official layout measures: the safe area.
      expect(_resolve((size: const Size(1024, 700), padding: EdgeInsets.zero)).chrome, WebChrome.side);
      expect(_resolve((size: const Size(1023.5, 700), padding: EdgeInsets.zero)).chrome, WebChrome.inline);
      expect(
        _resolve((size: const Size(1100, 700), padding: const EdgeInsets.only(left: _side))).chrome,
        WebChrome.inline,
      );
    });

    test('DSH Web as shipped: a seat in its own header on phones, the bar above', () {
      // Below its own drawer breakpoint the official layout keeps a leading
      // seat in the header row: the handle takes the far left of it, with no
      // bar of its own.
      expect(_resolve(_phonePortrait, adapt: false).chrome, WebChrome.seat);
      expect(_resolve(_tablet600, adapt: false).chrome, WebChrome.seat);
      // Wider windows have no seat (an icon rail, then the full layout).
      expect(_resolve(_tablet840, adapt: false).chrome, WebChrome.bar);
      expect(_resolve(_phoneLandscape, adapt: false).chrome, WebChrome.bar);
      expect(_resolve(_tablet1280, adapt: false).chrome, WebChrome.bar);
      // Other sites are not DSH Web: the bar as before.
      expect(_resolve(_phoneLandscape, dshWeb: false, adapt: false).chrome, WebChrome.bar);
    });

    test("DSH Web as shipped on a phone: the handle takes the far left, the page's own opener moves past it", () {
      final i = _resolve(_phonePortrait, adapt: false);
      // The page starts under the status bar: its drawer layout keeps the
      // leading room (11 down, 12 from the side) for the handle.
      expect((i.chrome, i.rootTop, i.left), (WebChrome.seat, 52, 0));
      expect(i.layerTop, 52 + WebChromeMetrics.seatTop + WebChromeMetrics.seatButton + 6);
      // The official seat holds DSH Web's own sidebar opener: it moves past
      // the marker instead of under it (12 → 48), one row.
      expect(i.script, contains('[data-sidebar-drawer]>[data-shell-leading]{left:48.0px!important}'));
      // The reserve covers marker, gap, the official opener and the gap after
      // it: 84 (the official layout's own 48 is 12 + 28 + 8).
      expect(i.script, contains('--dsh-frame-leading-clearance:84.0px'));
      // The fullscreen right panel's tab strip starts past them too.
      expect(i.script, contains('padding-left:84.0px!important'));
      // The official layout stays: no app layout attribute.
      expect(i.script, contains("removeAttribute('data-dsh-app-layout')"));
      expect(i.script, isNot(contains("setAttribute('data-dsh-app-layout'")));
    });
  });

  group('the page stays inside the safe area', () {
    test('a side cutout moves #root, not the page colour', () {
      final i = _resolve(_phoneLandscape);
      expect((i.left, i.right), (_side, _side));
      expect(i.rootTop, 28);
      expect(i.rootBottom, 24);
      expect(i.script, contains('left:52.0px!important;right:52.0px!important'));
      expect(i.script, contains("setAttribute('data-dsh-app-layout', 'drawer')"));
      expect(i.script, contains('--dsh-app-inset-left:52.0px'));
    });

    test('a gesture handle without an inset still gets room', () {
      final i = _resolve(_vivoLandscape);
      expect(i.rootBottom, WebChromeMetrics.gestureFloor);
      expect(i.bottom, WebChromeMetrics.gestureFloor);
      // A reported inset wins; the keyboard takes the place of both: DSH
      // Web's root and its layers end at it (the WebView keeps its size).
      expect(_resolve(_phoneLandscape).bottom, 24);
      expect(_resolve(_vivoLandscape, keyboard: 200).layerBottom, 200);
      final typing = _resolve(_phoneLandscape, keyboard: 260);
      expect((typing.keyboard, typing.layerBottom), (260, 260));
      expect(typing.script, contains(':root #root{bottom:260.0px!important}'));
      expect(typing.script, contains(r'body>[class*=\"_overlay\"]{bottom:260.0px!important}'));
      // Other pages shrink above it instead.
      final other = _resolve(_phoneLandscape, dshWeb: false, adapt: false, keyboard: 260);
      expect((other.rootBottom, other.keyboard, other.layerBottom), (0, 0, 0));
    });

    test('the keyboard leaves the rest of the page alone', () {
      // The --dsh-app-* variables are inherited by every element: changing
      // them restyles the whole page. The keyboard has a style of its own.
      List<String> rest(WebPageInsets i) =>
          i.script.split('\n').where((l) => l.contains('var vars') || l.contains('#root{position:fixed')).toList();
      for (final w in [_phonePortrait, _tablet600, _tablet840]) {
        expect(rest(_resolve(w, keyboard: 200)), rest(_resolve(w)), reason: '${w.size}');
        expect(_resolve(w).script, contains("sheet('dsh-app-keyboard', root ? \"\" : '')"));
      }
      // Tablets in the official layout: the frame stops padding the gesture bar.
      expect(_resolve(_tablet1280, keyboard: 380).script, contains('--dsh-app-frame-bottom:0.0px'));
    });

    test('typing on its side: the header row steps aside for the composer', () {
      // About 120 of page left above the keyboard (the emulator in landscape).
      final typing = _resolve(_phoneLandscape, keyboard: 262);
      expect(typing.compact, isTrue);
      expect((typing.rootTop, typing.lead, typing.layerTop), (28, 0, 28));
      expect((typing.keyboard, typing.layerBottom), (262, 262));
      expect(typing.script, contains("toggleAttribute('data-dsh-app-compact', true)"));
      // Upright, or on a tablet, there is room for all of it.
      expect(_resolve(_phonePortrait, keyboard: 330).compact, isFalse);
      expect(_resolve(_tablet840, keyboard: 400).compact, isFalse);
      expect(_resolve(_phoneLandscape).script, contains("toggleAttribute('data-dsh-app-compact', false)"));
    });

    test('desktop: the page runs under the bars, the frame pads its columns', () {
      final i = _resolve(_tablet1280);
      expect((i.rootTop, i.rootBottom), (0, 0));
      expect((i.status, i.band, i.bottom, i.frameBottom), (24, WebChromeMetrics.band, 32, 32));
      expect(i.layerTop, 24);
      expect(i.script, contains("setAttribute('data-dsh-app-layout', 'desktop')"));
      expect(i.script, contains('--dsh-app-status:24.0px'));
      expect(i.script, contains('--dsh-app-frame-bottom:32.0px'));
      // Typing: the root ends at the keyboard, the frame pads nothing more.
      final typing = _resolve(_tablet1280, keyboard: 380);
      expect((typing.keyboard, typing.layerBottom, typing.frameBottom), (380, 380, 0));
    });

    test('other sites: no layout attribute, body padding only', () {
      final i = _resolve(_phoneLandscape, dshWeb: false, adapt: false);
      expect((i.left, i.right), (0, 0));
      expect(i.script, contains("removeAttribute('data-dsh-app-layout')"));
      expect(i.script, contains('padding-bottom:24.0px'));
    });
  });

  group('controls', () {
    testWidgets('landscape phone: back and menu clear the cutout, in the header row', (tester) async {
      await _pump(tester, _phoneLandscape);
      final back = tester.getRect(_button('返回'));
      final menu = tester.getRect(_button('对话与工作区'));
      expect(back.left, _side + WebChromeMetrics.edge);
      expect(back.top, 28 + WebChromeMetrics.inlineTop);
      expect(back.size, const Size.square(WebChromeMetrics.button));
      expect(menu.size, back.size);
      expect(menu.left - back.right, 8);
      expect(menu.center.dy, back.center.dy);
      // DSH Web runs edge to edge and pads its own root.
      expect(tester.getRect(find.byKey(fakeWebViewKey)), Offset.zero & _phoneLandscape.size);
      expect(_platform.controller.insetsScript, contains('left:52.0px'));
    });

    testWidgets('DSH Web as shipped on a phone: the app\'s mark sits left of the page\'s own opener', (tester) async {
      await _pump(tester, _phonePortrait, phoneLayout: false);
      // Its own drawer layout keeps the leading room; no bar above the page.
      expect(find.byKey(const ValueKey('web-controls-seat')), findsOneWidget);
      expect(find.byKey(const ValueKey('web-controls-bar')), findsNothing);
      // A page with no handle still seats one mark of the app: the same round
      // key, as the page's way back — not an arrow.
      final mark = find.byType(WebMarkButton);
      expect(mark, findsOneWidget);
      expect(tester.widget<WebMarkButton>(mark).tooltip, '返回');
      expect(_button('返回'), findsNothing);
      // The marker is the size of the page's own controls in that row (28)
      // and keeps its measured seat.
      final back = tester.getRect(mark);
      expect(back.left, WebChromeMetrics.seatLeft);
      expect(back.top, 52 + WebChromeMetrics.seatTop);
      expect(back.size, const Size.square(WebChromeMetrics.seatButton));
      // The page's own opener, in its own seat, moves past the marker: the
      // marker never covers it. Both sit in the one header row DSH Web lays
      // out, and the title starts past both.
      expect(
        _platform.controller.insetsScript,
        contains('[data-sidebar-drawer]>[data-shell-leading]{left:48.0px!important}'),
      );
      expect(_platform.controller.insetsScript, contains('--dsh-frame-leading-clearance:84.0px'));
      expect(
        back.right,
        lessThan(WebChromeMetrics.seatLeft + WebChromeMetrics.seatShift),
        reason: 'the marker leaves the official opener its room',
      );
    });

    testWidgets('DSH Web\'s sidebar as a drawer: the marker steps aside, not over it', (tester) async {
      await _pump(tester, _phonePortrait, phoneLayout: false);
      final seat = find.byKey(const ValueKey('web-controls-seat'));
      AnimatedOpacity fade() =>
          tester.widget<AnimatedOpacity>(find.descendant(of: seat, matching: find.byType(AnimatedOpacity)).first);
      IgnorePointer touches() =>
          tester.widget<IgnorePointer>(find.descendant(of: seat, matching: find.byType(IgnorePointer)).first);
      expect(fade().opacity, 1);
      expect(touches().ignoring, isFalse);
      // The page's sidebar drawer goes up: the marker gets out of its way,
      // and touches fall through to the sidebar's mask.
      _platform.controller.post('DshAppSidebar', 'open');
      await tester.pump();
      expect(fade().opacity, 0);
      expect(touches().ignoring, isTrue);
      // Folded away again: the marker comes back.
      _platform.controller.post('DshAppSidebar', 'closed');
      await tester.pump();
      expect(fade().opacity, 1);
      expect(touches().ignoring, isFalse);
    });

    testWidgets("DSH Web's sidebar state reaches the app (dsh_web_sidebar.js)", (tester) async {
      await _pump(tester, _phonePortrait, phoneLayout: false);
      expect(_platform.controller.channels, contains('DshAppSidebar'));
      // The bridge loads from the asset bundle: real time, then frames.
      for (var i = 0; i < 40 && !_platform.controller.scripts.any((s) => s.contains('__dshAppSidebar')); i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await tester.pump();
      }
      expect(_platform.controller.scripts.any((s) => s.contains('__dshAppSidebar')), isTrue);
    });

    testWidgets('tablet: back sits in the band above the sidebar, on the rail column', (tester) async {
      await _pump(tester, _tablet1280);
      expect(_button('对话与工作区'), findsNothing);
      final back = tester.getRect(_button('返回'));
      expect(back.center.dx, WebChromeMetrics.rail / 2);
      expect(back.center.dy, 24 + WebChromeMetrics.band / 2);
      expect(back.size, const Size.square(WebChromeMetrics.button));
      expect(_platform.controller.insetsScript, contains("'desktop'"));
    });

    testWidgets('other sites in landscape: the bar mirrors inside the safe area', (tester) async {
      await _pump(tester, _phoneLandscape, dshWeb: false);
      final back = tester.getRect(_button('返回'));
      final open = tester.getRect(_button('在浏览器打开'));
      final reload = tester.getRect(_button('刷新'));
      const safeLeft = _side;
      final safeRight = _phoneLandscape.size.width - _side;
      // Back and the last action sit the same distance from the safe edges.
      expect(back.left - safeLeft, WebChromeMetrics.edge);
      expect(safeRight - open.right, WebChromeMetrics.edge);
      expect(open.size, back.size);
      expect(open.center.dy, back.center.dy);
      expect(open.left - reload.right, 8);
      // The page itself keeps out of the cutout (fixed elements included).
      final page = tester.getRect(find.byKey(fakeWebViewKey));
      expect(page.left, safeLeft);
      expect(page.right, safeRight);
    });

    testWidgets('typing on its side: the buttons step aside with the header row', (tester) async {
      await _pump(tester, _phoneLandscape);
      tester.view.viewInsets = const FakeViewPadding(bottom: 262 * 2.0);
      await tester.pump();
      await tester.pump(WebKeyboard.rest);
      await tester.pumpAndSettle();
      final buttons = find.byKey(const ValueKey('web-controls-inline'));
      final opacity = tester.widget<AnimatedOpacity>(
        find.descendant(of: buttons, matching: find.byType(AnimatedOpacity)),
      );
      expect(opacity.opacity, 0);
      expect(
        tester.widget<IgnorePointer>(find.descendant(of: buttons, matching: find.byType(IgnorePointer)).first).ignoring,
        isTrue,
      );
      expect(_platform.controller.insetsScript, contains("'data-dsh-app-compact', true"));
      tester.view.resetViewInsets();
      await tester.pump();
      await tester.pump(WebKeyboard.rest);
      await tester.pumpAndSettle();
      expect(
        tester.widget<AnimatedOpacity>(find.descendant(of: buttons, matching: find.byType(AnimatedOpacity))).opacity,
        1,
      );
      expect(_platform.controller.insetsScript, contains("'data-dsh-app-compact', false"));
    });

    testWidgets('rotation re-insets the page without reloading it', (tester) async {
      await _pump(tester, _phonePortrait);
      final controller = _platform.controller;
      expect(controller.insetsScript, contains("'drawer'"));
      expect(controller.insetsScript, contains('left:0.0px'));
      _useWindow(tester, _phoneLandscape);
      await tester.pump();
      await tester.pump();
      expect(_platform.controllers, hasLength(1));
      expect(controller.loads, hasLength(1));
      expect(controller.reloads, 0);
      expect(controller.insetsScript, contains('left:52.0px'));
      // A tablet turned to landscape switches to the official layout.
      _useWindow(tester, _tablet1280);
      await tester.pump();
      await tester.pump();
      expect(controller.insetsScript, contains("'desktop'"));
      expect(controller.loads, hasLength(1));
    });
  });

  group('the keyboard', () {
    setUp(WebKeyboard.forgetHeights);

    test('the page moves once per slide: at rest, or up front when the end is known', () {
      final k = WebKeyboard();
      // The first time: the page stays until the keyboard comes to rest.
      for (final h in <double>[12, 80, 190, 260]) {
        expect(k.report(h, 411), isFalse);
        expect(k.height, 0);
      }
      expect(k.settle(260, 411), isTrue);
      expect(k.height, 260);
      // Closing: down at once, and nothing more on the way.
      expect(k.report(250, 411), isTrue);
      expect(k.height, 0);
      expect(k.report(90, 411), isFalse);
      expect(k.settle(0, 411), isFalse);
      // Opening again in a window this wide: straight to where it ends.
      expect(k.report(10, 411), isTrue);
      expect(k.height, 260);
      expect(k.report(150, 411), isFalse);
      // A different height at rest still wins.
      expect(k.settle(280, 411), isTrue);
      expect(k.height, 280);
      // Another width (the phone on its side) is learnt anew.
      k
        ..report(0, 411)
        ..settle(0, 411);
      expect(k.report(40, 914), isFalse);
      expect(k.height, 0);
    });

    test('the heights outlive the run', () async {
      SharedPreferences.setMockInitialValues({WebKeyboard.prefsKey: '{"411": 300.0, "x": 1}'});
      WebKeyboard.forgetHeights(restore: true);
      await WebKeyboard.restore();
      // A cold start's first keyboard goes straight to where it ends.
      final k = WebKeyboard();
      expect(k.report(10, 411), isTrue);
      expect(k.height, 300);
      k.settle(320, 411);
      await pumpEventQueue();
      final prefs = await SharedPreferences.getInstance();
      expect(jsonDecode(prefs.getString(WebKeyboard.prefsKey)!), {'411': 320.0});
    });

    /// A slide as Flutter reports it, one height per frame.
    Future<void> slide(WidgetTester tester, List<double> heights) async {
      for (final h in heights) {
        tester.view.viewInsets = FakeViewPadding(bottom: h * 2.0);
        await tester.pump(const Duration(milliseconds: 16));
      }
    }

    int insetScripts() => _platform.controller.scripts.where((s) => s.contains('dsh-app-insets')).length;

    testWidgets('DSH Web keeps its size; its root rises once per slide', (tester) async {
      await _pump(tester, _phonePortrait);
      final controller = _platform.controller;
      final full = Offset.zero & _phonePortrait.size;
      final before = insetScripts();
      await slide(tester, [20, 120, 240, 300, 320]);
      // Nothing for the page while the keyboard moves the first time...
      expect(tester.getRect(find.byKey(fakeWebViewKey)), full);
      expect(insetScripts(), before);
      await tester.pump(WebKeyboard.rest);
      await tester.pump();
      // ...then one layout: root and layers above the keyboard.
      expect(insetScripts(), before + 1);
      expect(controller.insetsScript, contains(':root #root{bottom:320.0px!important}'));
      expect(controller.insetsScript, contains('__dshAppKeyboard = 320.0'));
      expect(tester.getRect(find.byKey(fakeWebViewKey)), full);
      // Closing: back down on the first step, once.
      await slide(tester, [300, 200, 80, 0]);
      expect(insetScripts(), before + 2);
      expect(controller.insetsScript, contains('__dshAppKeyboard = 0.0'));
      await tester.pump(WebKeyboard.rest);
      // Opening again: straight to where it ends, before it gets there.
      await slide(tester, [20]);
      expect(insetScripts(), before + 3);
      expect(controller.insetsScript, contains('__dshAppKeyboard = 320.0'));
      await slide(tester, [140, 260, 320]);
      await tester.pump(WebKeyboard.rest);
      await tester.pump();
      expect(insetScripts(), before + 3);
      expect(tester.getRect(find.byKey(fakeWebViewKey)), full);
      tester.view.resetViewInsets();
    });

    testWidgets('other sites shrink above the keyboard once, not on every frame', (tester) async {
      await _pump(tester, _phonePortrait, dshWeb: false);
      final heights = <double>{};
      for (final h in <double>[20, 120, 240, 320]) {
        tester.view.viewInsets = FakeViewPadding(bottom: h * 2.0);
        await tester.pump(const Duration(milliseconds: 16));
        heights.add(tester.getRect(find.byKey(fakeWebViewKey)).height);
      }
      expect(heights, {_phonePortrait.size.height});
      await tester.pump(WebKeyboard.rest);
      await tester.pump();
      expect(tester.getRect(find.byKey(fakeWebViewKey)).bottom, _phonePortrait.size.height - 320);
      tester.view.resetViewInsets();
    });
  });

  group('load error', () {
    for (final (name, window, dshWeb) in [
      ('other sites, landscape', _phoneLandscape, false),
      ('DSH Web, landscape', _phoneLandscape, true),
      ('DSH Web, tablet', _tablet1280, true),
    ]) {
      testWidgets('$name: the way back stays above the message', (tester) async {
        _useWindow(tester, window);
        await tester.pumpWidget(
          testApp(
            Builder(
              builder: (context) => Center(
                child: TextButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => WebViewPage(url: _url, title: '网页', dshWeb: dshWeb),
                    ),
                  ),
                  child: const Text('打开'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('打开'));
        // The progress line runs while loading: no settling until it fails.
        for (var i = 0; i < 4; i++) {
          await tester.pump(const Duration(milliseconds: 200));
        }
        _platform.controller.fail();
        await tester.pumpAndSettle();
        expect(find.text('页面没有打开'), findsOneWidget);
        final back = tester.getRect(_button('返回'));
        final graphic = tester.getRect(find.text('页面没有打开'));
        expect(graphic.top, greaterThan(back.bottom));
        // Centred on the glass (the side insets are mirrored).
        expect(graphic.center.dx, moreOrLessEquals(window.size.width / 2, epsilon: 0.5));
        expect(_button('对话与工作区').evaluate().every((e) => (e.widget as GlassIconButton).onPressed == null), isTrue);
        await tester.tap(_button('返回'));
        await tester.pumpAndSettle();
        expect(find.text('打开'), findsOneWidget);
      });
    }
  });

  testWidgets('chart preview keeps its header and chart out of a side cutout', (tester) async {
    _useWindow(tester, _phoneLandscape);
    await tester.pumpWidget(testApp(const MermaidPreviewPage(source: 'graph LR; A-->B')));
    final back = tester.getRect(_button('返回'));
    final copy = tester.getRect(_button('复制代码'));
    expect(back.left, _side + 12);
    expect(_phoneLandscape.size.width - copy.right, _side + 12);
    expect(back.center.dy, copy.center.dy);
    final chart = tester.getRect(find.byKey(fakeWebViewKey));
    expect(chart.left, _side);
    expect(chart.right, _phoneLandscape.size.width - _side);
    expect(chart.bottom, _phoneLandscape.size.height - 24);
  });
}
