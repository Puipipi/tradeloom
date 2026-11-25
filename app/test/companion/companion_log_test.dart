import 'package:dsh_app/companion/companion_light.dart';
import 'package:dsh_app/companion/companion_reply.dart';
import 'package:dsh_app/l10n/gen/app_localizations.dart';
import 'package:dsh_app/state/app_notes.dart';
import 'package:dsh_app/ui/companion/companion_chrome.dart';
import 'package:dsh_app/ui/companion/companion_log.dart';
import 'package:dsh_app/ui/theme/app_theme.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final aside = companionAside(now: DateTime(2026, 11, 8, 13, 20), notes: const ['对方刚才摸了摸你的头'])!;

  test('a light conversation: her words without marks, theirs without the aside', () {
    final log = companionLogFromLight([
      CompanionLine.user('$aside\n摸摸'),
      const CompanionLine.her('[表情:害羞][动作:低头]别、别摸啦……'),
      const CompanionLine.her('[表情:开心]'),
      CompanionLine.user(aside),
    ]);
    expect(log, const [CompanionLogEntry.you('摸摸'), CompanionLogEntry.her('别、别摸啦……')]);
  });

  test('a full-mode session: what she did on the host sits between the lines', () {
    final log = companionLogFromChat([
      UserChatItem(seq: 1, time: DateTime(2026, 11, 8), text: '$aside\n看看今天的日程', images: const [], files: const []),
      const AssistantChatItem(id: 'a1', text: '[动作:点头]我看一下。', reasoning: ''),
      const ToolChatItem(
        callId: 'c1',
        name: 'bash',
        arguments: '{"command":"cat today.md"}',
        status: ToolStatus.succeeded,
      ),
      const AssistantChatItem(id: 'a2', text: '下午三点有个会。', reasoning: ''),
    ]);
    expect(log.map((e) => e.speaker), [
      CompanionLogSpeaker.you,
      CompanionLogSpeaker.her,
      CompanionLogSpeaker.narration,
      CompanionLogSpeaker.her,
    ]);
    expect(log[0].text, '看看今天的日程');
    expect(log[1].text, '我看一下。');
    expect(log[2].text, contains('cat today.md'));
    expect(log[2].code, isTrue);
  });

  test('her persona, sent inline to a host without her preset, is not a line of theirs', () {
    final log = companionLogFromChat([
      UserChatItem(
        seq: 1,
        time: DateTime(2026, 11, 14),
        text: '${appNote('（从现在起请扮演下面的角色，直接开始，不要复述这段设定。）\n你是小鲸。')}\n你好呀',
        images: const [],
        files: const [],
      ),
    ]);
    expect(log, const [CompanionLogEntry.you('你好呀')]);
  });

  testWidgets('the log: names where the speaker changes, closed by its button', (tester) async {
    var closed = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildDarkTheme(),
        localizationsDelegates: L10n.localizationsDelegates,
        supportedLocales: L10n.supportedLocales,
        locale: const Locale('zh'),
        home: Scaffold(
          body: CompanionLog(
            entries: const [CompanionLogEntry.you('在吗'), CompanionLogEntry.her('在呀。'), CompanionLogEntry.her('怎么啦？')],
            name: '小鲸',
            onClose: () => closed++,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('聊天记录'), findsOneWidget);
    expect(find.text('你'), findsOneWidget);
    expect(find.text('小鲸'), findsOneWidget);
    expect(find.text('在呀。'), findsOneWidget);
    expect(find.text('怎么啦？'), findsOneWidget);
    await tester.tap(
      find.bySemanticsLabel(MaterialLocalizations.of(tester.element(find.byType(CompanionLog))).closeButtonTooltip),
    );
    expect(closed, 1);
  });

  testWidgets('pulling down past the top of her line asks for the log; pushing up does not', (tester) async {
    var pulled = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildDarkTheme(),
        localizationsDelegates: L10n.localizationsDelegates,
        supportedLocales: L10n.supportedLocales,
        locale: const Locale('zh'),
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: CompanionSpeech(text: '今天也辛苦啦。', onPullBack: () => pulled++),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.drag(find.text('今天也辛苦啦。'), const Offset(0, -160));
    await tester.pumpAndSettle();
    expect(pulled, 0);
    await tester.drag(find.text('今天也辛苦啦。'), const Offset(0, 160));
    await tester.pumpAndSettle();
    expect(pulled, 1);
  });

  testWidgets('a pull that went back in does not count', (tester) async {
    var pulled = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildDarkTheme(),
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: CompanionSpeech(text: '嗯。', onPullBack: () => pulled++),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final gesture = await tester.startGesture(tester.getCenter(find.text('嗯。')));
    for (final dy in [10.0, 10.0, 10.0, -10.0, -10.0, -10.0, 10.0, 10.0]) {
      await gesture.moveBy(Offset(0, dy));
      await tester.pump();
    }
    await gesture.up();
    await tester.pumpAndSettle();
    expect(pulled, 0);
  });

  testWidgets('a fetch of earlier history that brings nothing stops; a tap tries again', (tester) async {
    var loads = 0;
    var history = 1;
    late StateSetter rebuild;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildDarkTheme(),
        localizationsDelegates: L10n.localizationsDelegates,
        supportedLocales: L10n.supportedLocales,
        locale: const Locale('zh'),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              return CompanionLog(
                entries: const [CompanionLogEntry.you('在吗')],
                name: '小鲸',
                onClose: () {},
                history: history,
                onLoadOlder: () async => loads++,
              );
            },
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    // Brought nothing: no second try on its own.
    expect(loads, 1);
    await tester.pump();
    expect(loads, 1);
    expect(find.text('加载更早的记录'), findsOneWidget);
    // A page with nothing the log shows still counts as progress.
    await tester.tap(find.text('加载更早的记录'));
    rebuild(() => history = 5);
    await tester.pump();
    await tester.pump();
    expect(loads, greaterThanOrEqualTo(2));
  });

  testWidgets('a fetch whose items land with the next build still counts as progress', (tester) async {
    var loads = 0;
    var history = 1;
    late StateSetter rebuild;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildDarkTheme(),
        localizationsDelegates: L10n.localizationsDelegates,
        supportedLocales: L10n.supportedLocales,
        locale: const Locale('zh'),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              return CompanionLog(
                entries: const [CompanionLogEntry.you('在吗')],
                name: '小鲸',
                onClose: () {},
                history: history,
                // Three pages, each landing a build after the fetch is over.
                onLoadOlder: loads < 3
                    ? () async {
                        loads++;
                        rebuild(() => history += 2);
                      }
                    : null,
              );
            },
          ),
        ),
      ),
    );
    for (var i = 0; i < 12; i++) {
      await tester.pump();
    }
    expect(loads, 3);
    expect(find.text('加载更早的记录'), findsNothing);
  });
}
