// 启动画面 goldens, light and dark: the hand-over frame (the system splash redrawn), the light
// halfway across the icon, and the lockup at rest. Drawn with the shipped launcher icon.
//
//   flutter test --update-goldens test/launch/launch_golden_test.dart

import 'dart:ui' as ui;

import 'package:dsh_app/launch/launch_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';

    Future<LaunchController> handedOver(WidgetTester tester) async {
      usePhone(tester);
      final ui.Image icon = (await tester.runAsync(() => shippedIcon(320)))!;
      final c = LaunchController(
        snapshot: snapshotFor(icon: icon, dark: dark),
        channel: FakeLaunchChannel(),
      );
      await tester.pumpWidget(launchApp(c, brightness: dark ? Brightness.dark : Brightness.light));
      final handing = c.handOver(const Rect.fromLTWH(115, 342, 160, 160));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      await handing;
      await tester.pump();
      return c;
    }

    testWidgets('hand-over frame ($mode)', (tester) async {
      await handedOver(tester);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/launch_handover_$mode.png'));
    });

    testWidgets('light across the icon ($mode)', (tester) async {
      await handedOver(tester);
      await tester.pump(const Duration(milliseconds: 920));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/launch_sweep_$mode.png'));
    });

    testWidgets('at rest ($mode)', (tester) async {
      await handedOver(tester);
      await tester.pump(const Duration(milliseconds: 1400));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/launch_rest_$mode.png'));
    });
  }
}
