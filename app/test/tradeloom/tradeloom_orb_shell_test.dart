import 'package:dsh_app/links/launcher_entries.dart';
import 'package:dsh_app/ui/shell/home_shell.dart';
import 'package:dsh_app/ui/tradeloom/tradeloom_orb.dart';
import 'package:dsh_app/ui/tradeloom/tradeloom_workbench_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../chat/support/harness.dart' show testApp;
import '../shell/adaptive/support.dart' show gestureBar, homeApp, homeOverrides, useWindow;

void main() {
  testWidgets('an outside-app button enters the branded workbench settings on a narrow screen', (tester) async {
    useWindow(tester, const Size(320, 640));
    SharedPreferences.setMockInitialValues({
      TradeLoomWorkbenchPage.originKey: 'https://workbench.example',
    });
    final launcher = LauncherBridge();
    addTearDown(launcher.dispose);
    await tester.pumpWidget(
      testApp(
        HomeShell(chatBuilder: (_) => const SizedBox.expand()),
        brightness: Brightness.dark,
        overrides: [...homeOverrides(), launcherBridgeProvider.overrideWithValue(launcher)],
      ),
    );

    launcher.add(const OpenWorkbenchEntry());
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    expect(find.byType(TradeLoomWorkbenchPage), findsOneWidget);
    expect(find.text('https://workbench.example'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('branded small home keeps the orb clear of screen edges', (tester) async {
    useWindow(tester, const Size(390, 844));
    await tester.pumpWidget(homeApp());

    final orb = find.byType(TradeLoomOrb);
    expect(orb, findsOneWidget);
    final rect = tester.getRect(orb);
    expect(rect.right, lessThan(390));
    expect(rect.bottom, lessThan(844 - gestureBar));
  });

  testWidgets('orb is hidden while a shell panel is open or the keyboard is visible', (tester) async {
    useWindow(tester, const Size(390, 844));
    await tester.pumpWidget(
      testApp(HomeShell(chatBuilder: (_) => const SizedBox.expand(), initiallyOpen: true), overrides: homeOverrides()),
    );
    expect(find.byType(TradeLoomOrb), findsNothing);

    await tester.pumpWidget(homeApp());
    tester.view.viewInsets = const FakeViewPadding(bottom: 600);
    await tester.pump();
    expect(find.byType(TradeLoomOrb), findsNothing);
  });
}
