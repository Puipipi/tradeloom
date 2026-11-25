// 启动画面从头到尾只出现用户选的图标：系统阶段没画图标（Android 8–12、13+ 的第一次启动、或带
// 自定义画面）时首帧也不画，动画开头再把所选图标淡入；系统画了图标（13+ 已换成所选图标的启动
// 主题）时首帧原样接上。四款图标逐款出 golden，自定义画面接在它自己的纯色系统画面后面。
//
//   flutter test --update-goldens test/launch/launch_icon_test.dart

import 'dart:ui' as ui;

import 'package:dsh_app/launch/custom_launch.dart';
import 'package:dsh_app/launch/launch_media.dart';
import 'package:dsh_app/launch/launch_state.dart';
import 'package:dsh_app/ui/launch/launch_overlay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

final _icon = find.byKey(LaunchMark.iconKey);

double _iconOpacity(WidgetTester tester) =>
    tester.widget<Opacity>(find.ancestor(of: _icon, matching: find.byType(Opacity)).first).opacity;

const _systemRect = Rect.fromLTWH(115, 342, 160, 160);

class _Still extends LaunchMedia {
  @override
  Size get size => const Size(90, 160);

  @override
  Widget view() => const ColoredBox(color: Color(0xFF2E5C8A));

  @override
  void play({VoidCallback? onDone}) {}
}

void main() {
  late FakeLaunchChannel channel;
  setUp(() => channel = FakeLaunchChannel());

  Future<LaunchController> start(
    WidgetTester tester, {
    required bool systemIcon,
    String variant = 'mist',
    int sdk = 35,
    bool systemSplash = true,
    bool dark = false,
    bool reduceMotion = false,
    CustomLaunch? custom,
    Color? background,
  }) async {
    usePhone(tester);
    final ui.Image icon = (await tester.runAsync(() => shippedIcon(320, variant: variant)))!;
    final c = LaunchController(
      snapshot: snapshotFor(
        icon: icon,
        sdk: sdk,
        systemSplash: systemSplash,
        dark: dark,
        systemIcon: systemIcon,
        background: background,
      ),
      custom: custom,
      channel: channel,
    );
    await tester.pumpWidget(
      launchApp(c, reduceMotion: reduceMotion, brightness: dark ? Brightness.dark : Brightness.light),
    );
    return c;
  }

  Future<void> finish(WidgetTester tester, LaunchController c) async {
    c.skip();
    c.ready();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
  }

  test('begin says whether the system splash shows the icon', () async {
    Future<LaunchSnapshot?> parse(Object? systemIcon) => LaunchSnapshot.fromMap({
      'active': true,
      'sdk': 35,
      'iconPx': 420,
      'background': 0xFFEBF1FE,
      'systemIcon': ?systemIcon,
    });
    expect((await parse(false))!.systemIcon, isFalse);
    expect((await parse(true))!.systemIcon, isTrue);
  });

  group('the system showed no icon (the page alone)', () {
    testWidgets('first frame: the page, no icon at all; then the chosen icon comes in', (tester) async {
      final c = await start(tester, systemIcon: false);
      expect(c.phase, LaunchPhase.cover);
      expect(_iconOpacity(tester), 0);
      // The blank splash is taken away at once: nothing to redraw.
      await c.handOver(null, removed: true);
      await tester.pump();
      expect(c.phase, LaunchPhase.playing);
      expect(channel.calls, isNot(contains('reveal')));
      await tester.pump();
      // In over 320 ms, as it settles.
      await tester.pump(const Duration(milliseconds: 120));
      final mid = _iconOpacity(tester);
      expect(mid, inExclusiveRange(0.2, 1));
      await tester.pump(const Duration(milliseconds: 220));
      expect(_iconOpacity(tester), 1);
      // In the system's square, settling as before.
      expect(tester.getRect(_icon).center.dx, closeTo(_systemRect.center.dx, 0.01));
      await finish(tester, c);
    });

    testWidgets('Android 8–11: the window was the page alone too; the icon comes in from the first frame', (
      tester,
    ) async {
      final c = await start(tester, systemIcon: false, sdk: 30, systemSplash: false);
      expect(_iconOpacity(tester), 0);
      await tester.pump();
      expect(c.phase, LaunchPhase.playing);
      await tester.pump(const Duration(milliseconds: 400));
      expect(_iconOpacity(tester), 1);
      await finish(tester, c);
    });

    testWidgets('减少动画: no fade, the icon is simply there once the launch screen takes over', (tester) async {
      final c = await start(tester, systemIcon: false, sdk: 30, systemSplash: false, reduceMotion: true);
      expect(_iconOpacity(tester), 0);
      await tester.pump();
      expect(c.phase, LaunchPhase.playing);
      expect(_iconOpacity(tester), 1);
      await finish(tester, c);
    });
  });

  group('the system showed the chosen icon (Android 13+, its own splash theme)', () {
    for (final variant in ['mist', 'night', 'frost', 'ink']) {
      testWidgets('$variant: the first frame is that icon in the system\'s square, whole', (tester) async {
        final c = await start(tester, systemIcon: true, variant: variant);
        expect(rectOf(tester, _icon), _systemRect);
        expect(_iconOpacity(tester), 1);
        await c.handOver(_systemRect, removed: true);
        await tester.pump();
        expect(_iconOpacity(tester), 1);
        await finish(tester, c);
      });
    }
  });

  testWidgets('custom launch screen: its own plain colour from the system on, no icon ever', (tester) async {
    const custom = CustomLaunch(
      kind: LaunchMediaKind.image,
      path: '/x.png',
      width: 90,
      height: 160,
      backdrop: LaunchBackdrop.white,
    );
    final c = await start(tester, systemIcon: false, custom: custom, background: const Color(0xFFFFFFFF));
    final page = tester.widget<ColoredBox>(
      find.descendant(of: find.byType(LaunchBackground), matching: find.byType(ColoredBox)),
    );
    expect(page.color, const Color(0xFFFFFFFF));
    await c.handOver(null, removed: true);
    await tester.pump();
    c.useMedia(_Still());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    // The picture took the icon's place: it never came in.
    expect(_iconOpacity(tester), 0);
    expect(find.byType(CustomLaunchView), findsOneWidget);
    await finish(tester, c);
  });

  // ── Goldens: what each launch looks like at its first frame and as the icon comes in ──

  for (final variant in ['mist', 'night', 'frost', 'ink']) {
    testWidgets('golden: $variant at the hand-over (13+, its own splash theme)', (tester) async {
      final c = await start(tester, systemIcon: true, variant: variant);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/launch_icon_${variant}_handover.png'));
      await finish(tester, c);
    });
  }

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    testWidgets('golden: night, no system icon, coming in ($mode)', (tester) async {
      final c = await start(tester, systemIcon: false, variant: 'night', dark: dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/launch_noicon_start_$mode.png'));
      await c.handOver(null, removed: true);
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 160));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/launch_noicon_in_$mode.png'));
      await finish(tester, c);
    });
  }
}
