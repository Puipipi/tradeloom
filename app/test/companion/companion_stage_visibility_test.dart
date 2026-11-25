// Real CompanionStage and Navigator/lifecycle delivery. The WebView platform
// records scripts; no browser renderer or native Android lifecycle is claimed.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/companion/companion_pack.dart';
import 'package:dsh_app/ui/companion/companion_stage.dart';
import 'package:dsh_app/ui/plugins/islands/island_platform.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../plugins/islands/support/fakes.dart';

class _Room {
  _Room(this.root);
  final Directory root;
  final web = FakeWebViewPlatform();
  final navigator = GlobalKey<NavigatorState>();
  final controller = CompanionStageController();
  final failures = <String>[];
  int readyCount = 0;

  FakeWebViewController get page => web.controllers.single;
  List<String> get commands => [
    for (final script in page.scripts)
      (jsonDecode(script.substring('stage.command('.length, script.length - 1)) as Map)['type'] as String,
  ];

  Future<void> open(WidgetTester tester, {AppLifecycleState lifecycle = AppLifecycleState.resumed}) async {
    WebViewPlatform.instance = web;
    IslandPlatform.instance = FakeIslandPlatform();
    tester.binding.handleAppLifecycleStateChanged(lifecycle);
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigator,
        home: Scaffold(
          body: CompanionStage(
            store: CompanionPackStore(root),
            controller: controller,
            events: CompanionStageEvents(
              onReady: () => readyCount++,
              onFailed: failures.add,
              onTouch: (_, _) {},
              onWake: () {},
              onMood: (_) {},
              onObject: (_) {},
              onActivity: (_) {},
            ),
          ),
        ),
      ),
    );
    for (var i = 0; i < 100 && (web.controllers.isEmpty || page.loads.isEmpty); i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump();
    }
    expect(failures, isEmpty);
    expect(web.controllers, hasLength(1));
    expect(page.loads, hasLength(1));
  }

  void ready() =>
      page.channels['DshCompanion']!.onMessageReceived(const JavaScriptMessage(message: '{"type":"ready"}'));

  Future<void> cover(WidgetTester tester) async {
    unawaited(
      navigator.currentState!.push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('memory')))),
    );
    await tester.pumpAndSettle();
  }

  Future<void> uncover(WidgetTester tester) async {
    navigator.currentState!.pop();
    await tester.pumpAndSettle();
  }

  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump();
  }
}

void main() {
  late Directory root;
  late IslandPlatform previousPlatform;
  setUp(() {
    root = Directory.systemTemp.createTempSync('companion-stage-');
    previousPlatform = IslandPlatform.instance;
  });
  tearDown(() {
    IslandPlatform.instance = previousPlatform;
    root.deleteSync(recursive: true);
  });

  testWidgets('a pause before ready is applied when the real stage becomes ready', (tester) async {
    final room = _Room(root);
    await room.open(tester);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    expect(room.commands, isEmpty, reason: 'the WebView is not ready yet');
    room.ready();
    await tester.pump();
    expect(room.readyCount, 1);
    expect(room.commands, ['pause']);
    await room.close(tester);
  });

  testWidgets('a stage created while already inactive does not miss the lifecycle state', (tester) async {
    final room = _Room(root);
    // Inactive still permits a frame; hidden would prevent constructing the
    // widget, so that setup cannot test a stage's captured initial state.
    await room.open(tester, lifecycle: AppLifecycleState.inactive);
    room.ready();
    await tester.pump();
    expect(room.commands, ['pause']);
    await room.close(tester);
  });

  testWidgets('covering and uncovering the route pauses and resumes the stage', (tester) async {
    final room = _Room(root);
    await room.open(tester);
    room.ready();
    await tester.pump();
    room.page.scripts.clear();
    await room.cover(tester);
    await room.uncover(tester);
    expect(room.commands, ['pause', 'resume']);
    await room.close(tester);
  });

  testWidgets('a sheet over the room leaves her moving under it', (tester) async {
    final room = _Room(root);
    await room.open(tester);
    room.ready();
    await tester.pump();
    room.page.scripts.clear();
    unawaited(
      showModalBottomSheet<void>(
        context: room.navigator.currentContext!,
        builder: (_) => const SizedBox(height: 200, child: Text('menu')),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('menu'), findsOneWidget);
    expect(room.commands, isEmpty);
    room.navigator.currentState!.pop();
    await tester.pumpAndSettle();
    expect(room.commands, isEmpty);
    await room.close(tester);
  });

  testWidgets('app resume cannot resume a stage whose route is still covered', (tester) async {
    final room = _Room(root);
    await room.open(tester);
    room.ready();
    await tester.pump();
    await room.cover(tester);
    room.page.scripts.clear();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(room.commands.where((type) => type == 'resume'), isEmpty);
    await room.close(tester);
  });

  testWidgets('ready while covered keeps the latest route intent until it is exposed', (tester) async {
    final room = _Room(root);
    await room.open(tester);
    await room.cover(tester);
    room.ready();
    await tester.pump();
    await room.uncover(tester);
    expect(room.commands, ['pause', 'resume']);
    await room.close(tester);
  });

  testWidgets('an inactive room retires ongoing stage interaction until resumed', (tester) async {
    final room = _Room(root);
    await room.open(tester);
    room.ready();
    await tester.pump();
    room.page.scripts.clear();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(room.commands, ['pause', 'resume']);
    await room.close(tester);
  });

  testWidgets('a hide/show before ready keeps the most recent visible intent', (tester) async {
    final room = _Room(root);
    await room.open(tester);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    room.ready();
    await tester.pump();
    expect(room.commands.where((type) => type == 'pause'), isEmpty);
    await room.close(tester);
  });
}
