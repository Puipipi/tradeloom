// The activity pill above the composer (light + dark): every state it can be
// in, the four whale-tail speed levels, and its behaviour (long-press stats,
// copy rotation, level changes waiting for the loop, reduced motion, the
// compaction state coming from the run pulse).
// Regenerate with
// `flutter test --update-goldens test/chat/activity_strip_golden_test.dart`.

import 'package:dsh_app/state/run_pulse.dart';
import 'package:dsh_app/ui/chat/activity_copy.dart';
import 'package:dsh_app/ui/chat/run_info.dart';
import 'package:dsh_app/ui/chat/widgets/activity_strip.dart';
import 'package:dsh_app/ui/chat/widgets/live_clock.dart';
import 'package:dsh_app/ui/chat/widgets/whale_tail.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';
import 'support/run_info_fixture.dart';

/// Tue 2026-10-20 15:00: no holiday, not a weekend, not night.
final now = DateTime(2026, 10, 20, 15);

/// A turn started 47 s ago whose seed does not draw the rare egg.
final turnStart = () {
  var t = now.subtract(const Duration(seconds: 47));
  while (rareTurn(t)) {
    t = t.add(const Duration(milliseconds: 1));
  }
  return t;
}();

RunActivity act(
  ActivityKind kind,
  String title, {
  String detail = '',
  bool code = false,
  Duration ago = const Duration(seconds: 9),
  String? narration,
  AfterTool? after,
  int todoDone = 0,
  int todoTotal = 0,
  bool rateLimited = false,
}) => RunActivity(
  kind: kind,
  title: title,
  detail: detail,
  detailIsCode: code,
  since: now.subtract(ago),
  turnStart: turnStart,
  narration: narration,
  after: after,
  todoDone: todoDone,
  todoTotal: todoTotal,
  rateLimited: rateLimited,
);

final states = <(RunActivity, int)>[
  (act(ActivityKind.waiting, '思考中', ago: const Duration(seconds: 1)), 1),
  (act(ActivityKind.thinking, '思考中'), 2),
  (
    act(
      ActivityKind.thinking,
      '思考中',
      ago: const Duration(seconds: 1),
      after: (name: 'bash', command: 'flutter test test/auth', failed: true),
    ),
    3,
  ),
  (act(ActivityKind.writing, '写回复中', narration: '修复登录按钮的重复提交'), 4),
  (act(ActivityKind.tool, '跑', detail: 'flutter test test/auth', code: true, todoDone: 3, todoTotal: 5), 1),
  (act(ActivityKind.tool, '改', detail: 'lib/auth/login_controller.dart', code: true), 3),
  (act(ActivityKind.approval, '等你确认', detail: '跑 flutter test test/auth'), 1),
  (act(ActivityKind.question, '等你回答', detail: '数据库用哪一个?'), 1),
  (act(ActivityKind.retry, '重试中', detail: '第 2 次', rateLimited: true), 1),
  (act(ActivityKind.compaction, '压缩上下文'), 1),
];

Widget sheet(List<Widget> children) => Builder(
  builder: (context) => AppBackdrop(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(12, 24, 12, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [for (final child in children) Padding(padding: const EdgeInsets.only(bottom: 10), child: child)],
      ),
    ),
  ),
);

Future<void> pumpSheet(
  WidgetTester tester,
  List<Widget> children, {
  Brightness brightness = Brightness.light,
  double height = 700,
}) async {
  tester.view.devicePixelRatio = 2;
  tester.view.physicalSize = Size(780, height * 2);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(testApp(Scaffold(body: sheet(children)), brightness: brightness));
  await pumpFrames(tester, 4);
}

void main() {
  setUpAll(() async {
    await loadTestFonts();
    await WhaleSprites.load();
  });

  setUp(() => runClock = () => now);
  tearDown(() => runClock = DateTime.now);

  group('behaviour', () {
    testWidgets('one line: title, copy, turn clock, todo progress', (tester) async {
      await pumpSheet(tester, [
        ActivityStrip(activity: states[4].$1, speedLevel: 1),
        ActivityStrip(activity: states[3].$1, speedLevel: 4),
      ]);
      expect(find.text('跑'), findsOneWidget);
      expect(find.text('flutter test test/auth'), findsOneWidget);
      expect(find.text('进度 3/5'), findsOneWidget);
      // The clock is the turn's, not the step's.
      expect(find.text('0:47'), findsNWidgets(2));
      expect(find.text('修复登录按钮的重复提交'), findsOneWidget);
      for (final strip in tester.widgetList<ActivityStrip>(find.byType(ActivityStrip))) {
        expect(tester.getSize(find.byWidget(strip)).height, 36);
      }
    });

    testWidgets('the tail paints in its own layer inside the glass', (tester) async {
      final a = act(ActivityKind.thinking, '思考中', ago: Duration.zero);
      await pumpSheet(tester, [ActivityStrip(activity: a, speedLevel: 2)]);
      final boundary = find.ancestor(of: find.byType(WhaleTail), matching: find.byType(RepaintBoundary)).first;
      expect(tester.widget<RepaintBoundary>(boundary).child, isA<WhaleTail>());
    });

    testWidgets('the copy holds for its window, then moves on', (tester) async {
      final a = act(ActivityKind.thinking, '思考中', ago: Duration.zero);
      await pumpSheet(tester, [ActivityStrip(activity: a, speedLevel: 2)]);
      String shown() => activityFlavor(a, runClock())!.text;
      final first = shown();
      expect(find.text(first), findsOneWidget);
      for (var s = 1; s <= 3; s++) {
        runClock = () => now.add(Duration(seconds: s));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text(first), findsOneWidget);
      }
      runClock = () => now.add(const Duration(seconds: 4, milliseconds: 100));
      await tester.pump(const Duration(seconds: 1));
      await pumpFrames(tester, 3);
      expect(find.text(first), findsNothing);
      expect(find.text(shown()), findsOneWidget);
    });

    testWidgets('on screen, the next window never repeats the line before (ADJ-COPY)', (tester) async {
      // A retry that starts with its turn (seed 0) used to show the same line
      // at 16 s and 20 s.
      final a = RunActivity(kind: ActivityKind.retry, title: '重试中', since: now, turnStart: now);
      runClock = () => now.add(const Duration(seconds: 12));
      await pumpSheet(tester, [ActivityStrip(activity: a, speedLevel: 2)]);
      String onScreen() {
        final texts = [
          for (final line in retryPhrases)
            if (find.text(line).evaluate().isNotEmpty) line,
        ];
        expect(texts, hasLength(1));
        return texts.single;
      }

      var before = onScreen();
      for (var s = 13; s <= 40; s++) {
        runClock = () => now.add(Duration(seconds: s, milliseconds: 100));
        await tester.pump(const Duration(seconds: 1));
        await pumpFrames(tester, 3);
        final here = onScreen();
        if (s % 4 == 0) {
          expect(here, isNot(before), reason: 'window starting at $s s');
        } else {
          expect(here, before, reason: 'inside the window, at $s s');
        }
        before = here;
      }
    });

    testWidgets('long-press: this step and the speed, for a few seconds', (tester) async {
      var taps = 0;
      await pumpSheet(tester, [
        ActivityStrip(activity: states[3].$1, speedLevel: 4, tokensPerSecond: () => 86.4, onTap: () => taps++),
      ]);
      await tester.longPress(find.byType(ActivityStrip));
      await pumpFrames(tester, 3);
      expect(find.text('这一步 0:09 · 约 86 tokens/秒'), findsOneWidget);
      await tester.pump(ActivityStrip.statsFor);
      await pumpFrames(tester, 3);
      expect(find.textContaining('tokens/秒'), findsNothing);
      expect(find.text('修复登录按钮的重复提交'), findsOneWidget);
      await tester.tap(find.byType(ActivityStrip));
      expect(taps, 1);
    });

    testWidgets('it never stops while running: speed eases, forms blend', (tester) async {
      var level = 1;
      late StateSetter set;
      await pumpSheet(tester, [
        StatefulBuilder(
          builder: (context, setState) {
            set = setState;
            return WhaleTail(level: level, color: deepSeekBlue);
          },
        ),
      ]);
      WhaleTailState whale() => tester.state(find.byType(WhaleTail));

      // No tokens (a long tool call): a slow swim, not a still frame.
      final start = whale().frame;
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(whale().shownForm, 2);
      expect(whale().frame, isNot(start), reason: 'still swimming');
      expect(whale().rate, moreOrLessEquals(0.5, epsilon: 0.01));

      // Faster: the speed eases up instead of jumping.
      set(() => level = 2);
      await tester.pump(const Duration(milliseconds: 16));
      await tester.pump(const Duration(milliseconds: 16));
      expect(whale().rate, inExclusiveRange(0.5, 0.6));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(whale().rate, moreOrLessEquals(1, epsilon: 0.01));

      // Another form at once, cross-faded with the old one.
      set(() => level = 4);
      await tester.pump(const Duration(milliseconds: 16));
      expect(whale().shownForm, 4);

      // Waiting for the person: the slowest swim, still moving.
      set(() => level = 0);
      for (var i = 0; i < 30; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(whale().shownForm, 2);
      expect(whale().rate, moreOrLessEquals(0.3, epsilon: 0.01));
      expect(tester.binding.hasScheduledFrame, isTrue, reason: 'ticking');
    });

    testWidgets('still: the still frame, no ticker', (tester) async {
      await pumpSheet(tester, [const WhaleTail(still: true, color: deepSeekBlue)]);
      await tester.pump(const Duration(milliseconds: 100));
      final whale = tester.state<WhaleTailState>(find.byType(WhaleTail));
      expect(whale.shownForm, 1);
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets('reduced motion: the still frame, no ticker', (tester) async {
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(780, 400);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MediaQuery(
          data: const MediaQueryData(disableAnimations: true),
          child: Center(child: WhaleTail(level: 4, color: deepSeekBlue)),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      final whale = tester.state<WhaleTailState>(find.byType(WhaleTail));
      expect(whale.shownForm, 1);
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets('the slot: speed level and compaction from the pulse', (tester) async {
      final pulse = RunPulse();
      addTearDown(pulse.dispose);
      final harness = ChatHarness(session: 's1', states: {'s1': runInfoState()});
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(780, 400);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        testApp(
          const Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: ActivityStripSlot(sessionId: 's1'),
            ),
          ),
          overrides: [...harness.overrides, runPulseProvider('s1').overrideWithValue(pulse)],
        ),
      );
      await pumpFrames(tester, 3);
      expect(find.text('跑'), findsOneWidget);
      expect(tester.widget<WhaleTail>(find.byType(WhaleTail)).level, 1);

      pulse.observe(UnknownEvent(70, runInfoTestDispatched, 'compaction/start', const {}));
      await pumpFrames(tester, 3);
      expect(find.text('压缩上下文'), findsOneWidget);
      pulse.observe(UnknownEvent(71, runInfoTestDispatched, 'compaction/end', const {}));
      await pumpFrames(tester, 3);
      expect(find.text('跑'), findsOneWidget);
    });
  });

  for (final brightness in Brightness.values) {
    final suffix = brightness == Brightness.dark ? 'dark' : 'light';

    group('goldens ($suffix)', () {
      testWidgets('states', (tester) async {
        await pumpSheet(tester, [
          for (final (activity, level) in states) ActivityStrip(activity: activity, speedLevel: level),
        ], brightness: brightness);
        await expectLater(find.byType(Scaffold), matchesGoldenFile('goldens/activity_strip_states_$suffix.png'));
      });

      testWidgets('speed levels', (tester) async {
        final thinking = act(ActivityKind.thinking, '思考中');
        await pumpSheet(
          tester,
          [
            for (var level = 1; level <= 4; level++) ActivityStrip(activity: thinking, speedLevel: level),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                WhaleTail(still: true, color: whaleColorFor(brightness), height: 56),
                for (var level = 2; level <= 4; level++)
                  WhaleTail(level: level, color: whaleColorFor(brightness), height: 56),
              ],
            ),
          ],
          brightness: brightness,
          height: 400,
        );
        await expectLater(find.byType(Scaffold), matchesGoldenFile('goldens/activity_strip_levels_$suffix.png'));
      });
    });
  }
}
