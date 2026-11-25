// The chat page on 本机 when it won't come up by itself: no runtime (install)
// or stopped with 打开 App 时自动启动 off (start).
//
//   flutter test --update-goldens test/onboarding/local_chat_golden_test.dart

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/ui/chat/chat_screen.dart';
import 'package:dsh_app/ui/chat/empty_state.dart';
import 'package:dsh_app/ui/chat/widgets/whale_tail.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../chat/support/harness.dart';
import '../chat/support/sample_chat.dart';
import '../support/english_preview.dart';
import 'local_optional_support.dart';

ChatHarness _harness(RuntimeStatus status) => ChatHarness(
  connected: false,
  runtime: () => RecordingLocalRuntime(LocalRuntimeState(loaded: true, status: status)),
);

void main() {
  setUpAll(() async {
    await loadTestFonts();
    await WhaleSprites.load();
    chatClock = () => DateTime(2026, 10, 23, 15, 20);
  });

  testWidgets('no runtime on this phone (en)', (tester) async {
    useEnglish();
    usePhoneView(tester);
    await tester.pumpWidget(testApp(inEnglish(const ChatScreen()), overrides: _harness(missingStatus).overrides));
    await pumpFrames(tester);
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/en_chat_missing_light.png'));
  });

  for (final brightness in Brightness.values) {
    final suffix = brightness == Brightness.dark ? 'dark' : 'light';
    testWidgets('no runtime on this phone ($suffix)', (tester) async {
      usePhoneView(tester);
      await tester.pumpWidget(
        testApp(const ChatScreen(), brightness: brightness, overrides: _harness(missingStatus).overrides),
      );
      await pumpFrames(tester);
      await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/chat_missing_$suffix.png'));
    });
  }

  testWidgets('a cold start back into the last conversation still offers the start', (tester) async {
    usePhoneView(tester);
    final harness = ChatHarness(
      session: 's1',
      connected: false,
      runtime: () => RecordingLocalRuntime(const LocalRuntimeState(loaded: true, status: stoppedStatus)),
    );
    await tester.pumpWidget(testApp(const ChatScreen(), overrides: harness.overrides));
    await pumpFrames(tester);
    expect(find.text('引擎未运行'), findsOneWidget);
    await tester.tap(find.text('启动引擎'));
    await tester.pump();
    final runtime = ProviderScope.containerOf(tester.element(find.byType(ChatScreen)))
        .read(localRuntimeProvider.notifier);
    expect((runtime as RecordingLocalRuntime).calls, ['start']);
  });

  testWidgets('a loaded conversation stays on screen while stopped', (tester) async {
    usePhoneView(tester);
    final harness = ChatHarness(
      session: 's1',
      states: {'s1': conversationState()},
      connected: false,
      runtime: () => RecordingLocalRuntime(const LocalRuntimeState(loaded: true, status: stoppedStatus)),
    );
    await tester.pumpWidget(testApp(const ChatScreen(), overrides: harness.overrides));
    await pumpFrames(tester);
    expect(find.text('启动引擎'), findsNothing);
  });

  testWidgets('stopped, auto start off (light)', (tester) async {
    usePhoneView(tester);
    await tester.pumpWidget(testApp(const ChatScreen(), overrides: _harness(stoppedStatus).overrides));
    await pumpFrames(tester);
    expect(find.text('启动引擎'), findsOneWidget);
    await expectLater(find.byType(ChatScreen), matchesGoldenFile('goldens/chat_stopped_light.png'));
  });
}
