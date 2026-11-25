// The chat screen takes a word handed over by another page (技能 ›
// 「在对话里用」 / 「新对话里用」): into the right composer, at the caret,
// focused, with a short confirmation that stays clear of the composer. A
// picked skill always goes out as a message, never as a look-alike command.

import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/chat_state.dart';
import 'package:dsh_app/state/composer_insert.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/draft_store.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/ui/chat/chat_screen.dart';
import 'package:dsh_app/ui/chat/composer.dart';
import 'package:dsh_app/ui/chat/composer_toast.dart';
import 'package:dsh_app/ui/chat/empty_actions.dart';
import 'package:dsh_app/ui/chat/empty_state.dart';
import 'package:dsh_app/ui/safe_mode/engine_failure_card.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../safe_mode/support.dart';
import 'support/harness.dart';

Future<ProviderContainer> _pump(WidgetTester tester, ChatHarness harness) async {
  usePhoneView(tester);
  mockClipboard(tester);
  await tester.pumpWidget(testApp(const ChatScreen(), overrides: harness.overrides));
  await pumpFrames(tester);
  return ProviderScope.containerOf(tester.element(find.byType(ChatScreen)));
}

TextEditingController _field(WidgetTester tester) => tester.widget<TextField>(find.byType(TextField)).controller!;

bool _focused(WidgetTester tester) => tester.widget<TextField>(find.byType(TextField)).focusNode!.hasFocus;

void main() {
  setUpAll(loadTestFonts);

  testWidgets('this conversation: at the caret, focused, confirmed', (tester) async {
    final container = await _pump(tester, ChatHarness(session: 's1', states: {'s1': const ChatState(loading: false)}));
    await tester.enterText(find.byType(TextField), '总结这个文件');
    _field(tester).selection = const TextSelection.collapsed(offset: 2);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();

    container.read(composerInsertProvider.notifier).request(ComposerInsert.skill('pdf', sessionId: 's1'));
    await pumpFrames(tester, 14);

    expect(_field(tester).text, '总结 /pdf 这个文件');
    expect(_field(tester).selection, const TextSelection.collapsed(offset: 8));
    expect(_focused(tester), isTrue);
    expect(container.read(composerInsertProvider), isNull, reason: 'taken once');
    expect(container.read(currentSessionProvider), 's1');

    // The confirmation floats above the composer, not over it: measured for
    // the keyboard that the focus brings up, a little higher until then.
    expect(find.text(composerInsertedText), findsOneWidget);
    double gap() =>
        tester.getRect(find.byType(Composer)).top -
        tester.getRect(find.descendant(of: find.byType(SnackBar), matching: find.byType(Material)).first).bottom;
    expect(gap(), moreOrLessEquals(composerToastGap + 8, epsilon: 1));

    tester.view.padding = const FakeViewPadding(top: 48);
    tester.view.viewInsets = const FakeViewPadding(bottom: 600);
    addTearDown(tester.view.resetViewInsets);
    await pumpFrames(tester, 3);
    expect(gap(), moreOrLessEquals(composerToastGap, epsilon: 1));
  });

  testWidgets('a skill that adds lines: the confirmation clears the grown composer', (tester) async {
    final container = await _pump(tester, ChatHarness(session: 's1', states: {'s1': const ChatState(loading: false)}));
    await tester.enterText(find.byType(TextField), '一段很长的话' * 12);
    await tester.pump();
    await pumpFrames(tester, 14);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();
    final before = tester.getRect(find.byType(Composer)).height;

    container
        .read(composerInsertProvider.notifier)
        .request(ComposerInsert.skill('一个名字很长很长很长很长的技能' * 4, sessionId: 's1'));
    // Measure after the composer settles, before the brief confirmation expires.
    await pumpFrames(tester, 10);

    expect(tester.getRect(find.byType(Composer)).height, greaterThan(before), reason: 'the insert did add a line');
    final toast = tester.getRect(find.descendant(of: find.byType(SnackBar), matching: find.byType(Material)).first);
    expect(tester.getRect(find.byType(Composer)).top - toast.bottom, greaterThanOrEqualTo(composerToastGap - 1));
  });

  testWidgets('a new conversation: the open one keeps its draft', (tester) async {
    final container = await _pump(tester, ChatHarness(session: 's1', states: {'s1': const ChatState(loading: false)}));
    await tester.enterText(find.byType(TextField), '还没发的话');
    await tester.pump();

    container.read(composerInsertProvider.notifier).request(ComposerInsert.skill('pdf', sessionId: null));
    await pumpFrames(tester, 6);

    expect(container.read(currentSessionProvider), isNull);
    expect(find.byType(ChatEmptyState), findsOneWidget);
    expect(_field(tester).text, '/pdf ');
    expect(_focused(tester), isTrue);
    expect(container.read(draftStoreProvider).drafts['s1']?.text, '还没发的话');
  });

  testWidgets('asked before the chat was built', (tester) async {
    usePhoneView(tester);
    final harness = ChatHarness(session: 's1', states: {'s1': const ChatState(loading: false)});
    final show = ValueNotifier(false);
    addTearDown(show.dispose);
    await tester.pumpWidget(
      testApp(
        ValueListenableBuilder<bool>(
          valueListenable: show,
          builder: (_, on, _) => on ? const ChatScreen() : const SizedBox(),
        ),
        overrides: harness.overrides,
      ),
    );
    final container = ProviderScope.containerOf(tester.element(find.byType(SizedBox).first));
    container.read(composerInsertProvider.notifier).request(ComposerInsert.skill('pdf', sessionId: 's1'));
    show.value = true;
    await pumpFrames(tester, 6);
    expect(_field(tester).text, '/pdf ');
    expect(container.read(composerInsertProvider), isNull);
  });

  testWidgets('a picked skill goes out as a message in a new chat', (tester) async {
    // `go` is the start of the host command `goal`: typed by hand, a bare
    // `/go` would pick that command; picked from 技能 it is the skill.
    final harness = ChatHarness(created: 'fresh');
    final container = await _pump(tester, harness);
    container.read(composerInsertProvider.notifier).request(ComposerInsert.skill('go', sessionId: null));
    await pumpFrames(tester, 4);
    expect(_field(tester).text, '/go ');

    await tester.tap(find.byIcon(AppIcons.send));
    await pumpFrames(tester, 4);
    expect(harness.sessions.creates, 1);
    expect(harness.controllers['fresh']!.sent, ['/go']);
    expect(harness.controllers['fresh']!.commandLines, isEmpty);
  });

  testWidgets('the engine failure card keeps the only primary action', (tester) async {
    usePhoneView(tester);
    final harness = ChatHarness(
      connected: false,
      runtime: () => RecordingRuntime(LocalRuntimeState(loaded: true, status: failedStatus())),
    );
    await tester.pumpWidget(
      testApp(
        const ChatScreen(),
        overrides: [
          activeConnectionProvider.overrideWithValue(AsyncError<HostConnection?>(StateError('raw'), StackTrace.empty)),
          ...harness.overrides.skip(1),
          runtimeBridgeProvider.overrideWithValue(FakeBridge()),
        ],
      ),
    );
    await pumpFrames(tester, 8);
    expect(find.byType(EngineFailureCard), findsOneWidget);
    expect(find.byType(EmptyPrimaryPill), findsNothing);
    expect(find.text('重新连接'), findsNothing);
  });

  testWidgets('a remote host never shows the local engine failure card', (tester) async {
    usePhoneView(tester);
    final harness = ChatHarness(
      runtime: () => RecordingRuntime(LocalRuntimeState(loaded: true, status: failedStatus())),
    );
    await tester.pumpWidget(
      testApp(
        const ChatScreen(),
        overrides: [
          ...harness.overrides,
          activeHostProvider.overrideWith(() => _FixedHost(const HostRef.ssh('box'))),
          runtimeBridgeProvider.overrideWithValue(FakeBridge()),
        ],
      ),
    );
    await pumpFrames(tester, 8);
    expect(find.byType(EngineFailureCard), findsNothing);
    expect(find.byType(ChatEmptyState), findsOneWidget);
  });
}

class _FixedHost extends ActiveHostController {
  _FixedHost(this.host);
  final HostRef host;
  @override
  HostRef build() => host;
}
