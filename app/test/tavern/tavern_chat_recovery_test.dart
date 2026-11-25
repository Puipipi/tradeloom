import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/chat/widgets/thinking_pill.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, except the first send fails before anything is stored.
class _FlakyTavern extends PreviewTavern {
  _FlakyTavern([this.kind = TavernFailure.network]) : super(tick: const Duration(milliseconds: 1));

  final TavernFailure kind;

  var failed = false;

  @override
  Stream<TavernEvent> send(String chatId, String text) {
    if (failed) return super.send(chatId, text);
    failed = true;
    return Stream.value(TavernTurnFailed(kind));
  }
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 200; i++) {
    await tester.pump(const Duration(milliseconds: 5));
  }
  await tester.pumpAndSettle();
}

Future<String> _open(WidgetTester tester, PreviewTavern tavern) async {
  final chat = await tavern.createChat('sample-innkeeper');
  await tester.pumpWidget(
    ProviderScope(
      overrides: [tavernProvider.overrideWith((ref) => tavern)],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: TavernChatPage(chatId: chat),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return chat;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('a send that stored nothing puts the line back and offers 重试', (tester) async {
    await _open(tester, _FlakyTavern());

    await tester.enterText(find.byType(TextField), '外面怎么了？');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    await _settle(tester);

    expect(find.text('连不上，检查网络后重试'), findsOneWidget);
    expect(find.widgetWithText(TextField, '外面怎么了？'), findsOneWidget);

    await tester.tap(find.text('重试'));
    await _settle(tester);
    expect(find.byKey(const ValueKey('tavern-error')), findsNothing);
    expect(find.textContaining('地下室'), findsOneWidget);
  });

  testWidgets('no key: the error offers 设置, not a retry that cannot work', (tester) async {
    await _open(tester, _FlakyTavern(TavernFailure.noKey));

    await tester.enterText(find.byType(TextField), '外面怎么了？');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    await _settle(tester);

    expect(find.text('先在设置里填 DeepSeek API Key'), findsOneWidget);
    expect(find.widgetWithText(TextField, '外面怎么了？'), findsOneWidget);
    final banner = find.byKey(const ValueKey('tavern-error'));
    expect(find.descendant(of: banner, matching: find.text('设置')), findsOneWidget);
    expect(find.descendant(of: banner, matching: find.text('重试')), findsNothing);
  });

  testWidgets('switching an earlier message offers to undo', (tester) async {
    await _open(tester, PreviewTavern(tick: const Duration(milliseconds: 1)));
    await tester.enterText(find.byType(TextField), '你好');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    await _settle(tester);

    // The greeting (1/2) is the earlier message: no ‹ › of its own, it swipes.
    // The list is built newest first, so it is the last of the swipes.
    final swipes = find.byWidgetPredicate(
      (w) => w.key is ValueKey<String> && (w.key! as ValueKey<String>).value.startsWith('tavern-swipe-'),
    );
    await tester.drag(swipes.last, const Offset(-200, 0));
    await tester.pumpAndSettle();
    expect(find.text('切到了另一条分支'), findsOneWidget);
    expect(find.text('你好'), findsNothing);

    await tester.tap(find.text('撤销'));
    await tester.pumpAndSettle();
    expect(find.text('你好'), findsOneWidget);
  });

  testWidgets('with 思考 on, the thinking shows above the reply and stays folded after', (tester) async {
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1))
      ..configure(TavernModelConfig(apiKey: () async => 'k', thinking: true));
    await _open(tester, tavern);
    await tester.enterText(find.byType(TextField), '你好');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    await _settle(tester);

    expect(find.byType(ThinkingPill), findsOneWidget);
    expect(find.textContaining('地下室').evaluate().isEmpty, isTrue); // a greeting reply, not the question one
    expect(find.textContaining('炉子'), findsOneWidget);
  });

  testWidgets('视觉小说 pages through paragraphs and follows a new reply', (tester) async {
    SharedPreferences.setMockInitialValues({'tavern.layout': 'visualNovel'});
    await _open(tester, PreviewTavern(tick: const Duration(milliseconds: 1)));

    // The greeting is two paragraphs; the newest one shows.
    expect(find.text('2/2'), findsOneWidget);
    await tester.fling(find.byKey(const ValueKey('tavern-vn-box')), const Offset(300, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text('1/2'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-vn-box')));
    await tester.pumpAndSettle();
    expect(find.text('2/2'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '外面怎么了？');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    await _settle(tester);
    expect(find.textContaining('地下室'), findsOneWidget);
  });

  testWidgets('the title opens the character; 舞台 › 本局 is where this chat picks its own layout', (tester) async {
    final chat = await _open(tester, PreviewTavern(tick: const Duration(milliseconds: 1)));

    await tester.tap(find.byKey(const ValueKey('bot-title')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernCharacterPage), findsOneWidget);
    Navigator.of(tester.element(find.byType(TavernCharacterPage))).pop();
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-stage-session')), findsOneWidget); // 本局 first
    await tester.ensureVisible(find.byKey(const ValueKey('tavern-chat-layout')));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-chat-layout')), matching: find.text('小说')));
    await tester.pumpAndSettle();

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('tavern.layout.$chat'), 'novel');
    expect(find.text('跟随酒馆设置'), findsOneWidget);
  });

  testWidgets('视觉小说 opens the backlog and closes it again', (tester) async {
    SharedPreferences.setMockInitialValues({'tavern.layout': 'visualNovel'});
    await _open(tester, PreviewTavern(tick: const Duration(milliseconds: 1)));

    await tester.tap(find.byKey(const ValueKey('tavern-vn-log')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-vn-backlog')), findsOneWidget);
    expect(find.textContaining('旅店的门被风推开'), findsWidgets);

    await tester.tap(find.byIcon(AppIcons.close));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-vn-backlog')), findsNothing);
  });

  testWidgets('a message hidden from the model stays visible, faded and marked', (tester) async {
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await _open(tester, tavern);
    final greeting = (await tavern.path(chat)).last;

    await tester.longPress(find.textContaining('炉子还热着'));
    await tester.pumpAndSettle();
    expect(find.text('对模型隐藏'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('tavern-menu-hide')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-menu-hide')));
    await tester.pumpAndSettle();

    expect((await tavern.path(chat)).last.hidden, isTrue);
    expect(find.byKey(ValueKey('tavern-hidden-${greeting.nodeId}')), findsOneWidget);
    expect(find.textContaining('炉子还热着'), findsOneWidget);

    await tester.longPress(find.textContaining('炉子还热着'));
    await tester.pumpAndSettle();
    expect(find.text('让模型看到'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('tavern-menu-hide')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-menu-hide')));
    await tester.pumpAndSettle();
    expect((await tavern.path(chat)).last.hidden, isFalse);
    expect(find.byKey(ValueKey('tavern-hidden-${greeting.nodeId}')), findsNothing);
  });

  testWidgets('scrolling back through a long chat loads older messages a page at a time', (tester) async {
    final tavern = _Long();
    await _open(tester, tavern);

    // The latest 60 first, with a marker that more is above.
    expect(tavern.limits.last, 60);
    expect(find.text('第 149 句'), findsOneWidget);
    for (var i = 0; i < 12 && tavern.limits.last < 180; i++) {
      await tester.drag(find.byKey(const ValueKey('tavern-transcript')), const Offset(0, 2400));
      await tester.pumpAndSettle();
    }
    expect(tavern.limits, containsAllInOrder([60, 120, 180]));
    // 180 asked, 150 there: the start of the chat, no more marker.
    await tester.drag(find.byKey(const ValueKey('tavern-transcript')), const Offset(0, 20000));
    await tester.pumpAndSettle();
    expect(find.text('第 0 句'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-older')), findsNothing);
  });

  testWidgets('editing a message opens a whole page and saves only a change', (tester) async {
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await _open(tester, tavern);

    await tester.longPress(find.textContaining('炉子还热着'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const ValueKey('tavern-menu-edit')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-menu-edit')));
    await tester.pumpAndSettle();
    expect(find.text('编辑消息'), findsWidgets);
    expect(find.text('林晚'), findsWidgets); // who said it

    await tester.enterText(find.byKey(const ValueKey('tavern-message-field')), '「进来吧。」');
    await tester.tap(find.byKey(const ValueKey('tavern-message-save')));
    await tester.pumpAndSettle();

    expect((await tavern.path(chat)).last.text, '「进来吧。」');
    expect(find.text('「进来吧。」'), findsOneWidget);
  });

  testWidgets('接着写 beside the box carries the newest reply on', (tester) async {
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await _open(tester, tavern);
    final before = await tavern.path(chat);
    expect(before.last.role, TavernRole.character); // the greeting

    await tester.tap(find.byKey(const ValueKey('tavern-continue')));
    await _settle(tester);

    final after = await tavern.path(chat);
    expect(after.length, before.length); // no new message: the same one, longer
    expect(after.last.text, startsWith(before.last.text));
    expect(after.last.text, contains('还有一件事'));
    expect(find.textContaining('还有一件事'), findsOneWidget);

    // With something in the box the key steps aside, and comes back when it is empty.
    await tester.enterText(find.byType(TextField), '你好');
    await tester.pump();
    expect(find.byKey(const ValueKey('tavern-continue')), findsNothing);
    await tester.enterText(find.byType(TextField), '');
    await tester.pump();
    expect(find.byKey(const ValueKey('tavern-continue')), findsOneWidget);
  });

  testWidgets('帮我写 drafts the next line into the box without sending it', (tester) async {
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await _open(tester, tavern);
    final before = await tavern.path(chat);

    expect(find.byKey(const ValueKey('tavern-write-for-me')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-write-for-me')));
    await _settle(tester);

    expect(find.widgetWithText(TextField, '我推开门，四下看了看。'), findsOneWidget);
    expect((await tavern.path(chat)).length, before.length);
    // With something in the box the key steps aside.
    expect(find.byKey(const ValueKey('tavern-write-for-me')), findsNothing);
  });

  testWidgets('帮我写 without a key offers 设置', (tester) async {
    await _open(tester, _NoKeyDraft());
    await tester.tap(find.byKey(const ValueKey('tavern-write-for-me')));
    await _settle(tester);

    expect(find.text('先在设置里填 DeepSeek API Key'), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('tavern-error')), matching: find.text('设置')), findsOneWidget);
  });
}

/// The preview, except drafting a line finds no key.
class _NoKeyDraft extends PreviewTavern {
  _NoKeyDraft() : super(tick: const Duration(milliseconds: 1));

  @override
  Stream<TavernEvent> impersonate(String chatId) => Stream.value(TavernTurnFailed(TavernFailure.noKey));
}

/// The preview with a long chat: 150 messages on its path.
class _Long extends PreviewTavern {
  _Long() : super(tick: const Duration(milliseconds: 1));

  final limits = <int>[];

  @override
  Future<List<TavernMessage>> path(String chatId, {int limit = 60, String? beforeNodeId}) async {
    limits.add(limit);
    final all = [
      for (var i = 0; i < 150; i++)
        TavernMessage(
          nodeId: 'n$i',
          role: i.isEven ? TavernRole.character : TavernRole.user,
          speaker: i.isEven ? '林晚' : 'User',
          text: '第 $i 句',
          at: DateTime(2026, 11, 10),
        ),
    ];
    return all.sublist((all.length - limit).clamp(0, all.length));
  }
}
