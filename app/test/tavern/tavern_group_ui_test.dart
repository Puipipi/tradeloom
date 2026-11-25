import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_group_page.dart';
import 'package:dsh_app/ui/tavern/tavern_home_page.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _lin = 'sample-innkeeper';
const _star = 'sample-navigator';

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 200; i++) {
    await tester.pump(const Duration(milliseconds: 5));
  }
  await tester.pumpAndSettle();
}

Future<void> _pump(WidgetTester tester, PreviewTavern tavern, Widget home) async {
  tester.view.physicalSize = const Size(390, 1100) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [tavernProvider.overrideWith((ref) => tavern)],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: home,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<String> _group(
  WidgetTester tester,
  PreviewTavern tavern, {
  TavernGroupActivation activation = TavernGroupActivation.listOrder,
}) async =>
    (await tester.runAsync(() => tavern.createGroupChat([_lin, _star], activation: activation, addGreetings: false)))!;

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('a line in a group: each member answers in turn, under their own name', (tester) async {
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await _group(tester, tavern);
    await _pump(tester, tavern, TavernChatPage(chatId: chat));
    // The group's own title over the story; its members to name, over the box.
    expect(find.text('林晚、星图'), findsWidgets);
    expect(find.byKey(const ValueKey('tavern-speak-$_lin')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-speak-$_star')), findsOneWidget);

    await tester.enterText(find.byType(TextField), '大家好');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    await _settle(tester);

    final path = (await tester.runAsync(() => tavern.path(chat)))!;
    expect(path.map((m) => m.speakerCharacterId), [null, _lin, _star]);
    expect(find.byKey(ValueKey('tavern-speaker-${path[1].nodeId}')), findsOneWidget);
    expect(find.byKey(ValueKey('tavern-speaker-${path[2].nodeId}')), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(ValueKey('tavern-speaker-${path[2].nodeId}')), matching: find.text('星图')),
      findsNothing,
    ); // the key is on the name's own Text
    expect(tester.widget<Text>(find.byKey(ValueKey('tavern-speaker-${path[2].nodeId}'))).data, '星图');
  });

  testWidgets('naming a member has that one speak, muted or not; 手动 alone says no one spoke', (tester) async {
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await _group(tester, tavern, activation: TavernGroupActivation.manual);
    await tester.runAsync(() => tavern.updateGroupMember(chat, _star, muted: true));
    await _pump(tester, tavern, TavernChatPage(chatId: chat));

    await tester.enterText(find.byType(TextField), '有人吗');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    await _settle(tester);
    expect(find.textContaining('这一轮没人接话'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-speak-$_star')));
    await _settle(tester);
    final path = (await tester.runAsync(() => tavern.path(chat)))!;
    expect(path.map((m) => (m.role, m.speakerCharacterId)), [(TavernRole.user, null), (TavernRole.character, _star)]);
  });

  testWidgets('新建群聊 from 对话: pick two, name it or not, and its chat opens', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _pump(tester, tavern, const TavernHomePage());
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-sections')), matching: find.text('对话')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-group-new')));
    await tester.pumpAndSettle();

    // Not yet: one is not a group.
    await tester.tap(find.byKey(const ValueKey('tavern-group-pick-$_star')));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('tavern-group-create'))).onPressed, isNull);
    await tester.tap(find.byKey(const ValueKey('tavern-group-pick-$_lin')));
    await tester.pumpAndSettle();
    expect(find.text('建群（2 人）'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('tavern-group-title')), '夜航');
    await tester.tap(find.byKey(const ValueKey('tavern-group-create')));
    await tester.pumpAndSettle();

    expect(find.byType(TavernChatPage), findsOneWidget);
    final chats = (await tester.runAsync(() => tavern.watchChats().first))!;
    final made = chats.singleWhere((c) => c.kind == TavernChatKind.group);
    expect(made.title, '夜航');
    // Picked first, the host; and first to speak.
    expect(made.characterId, _star);
    expect(made.memberCharacterIds, [_star, _lin]);
  });

  testWidgets('群聊设置: how it takes turns, how many, and each member', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final chat = await _group(tester, tavern);
    await _pump(tester, tavern, TavernGroupPage(chatId: chat));

    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-group-activation')), matching: find.text('随机')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-group-max-down')));
    await tester.pumpAndSettle();
    var group = (await tester.runAsync<TavernGroupChat?>(() => tavern.groupChat(chat)))!;
    expect(group.activation, TavernGroupActivation.randomPool);
    expect(group.maxSpeakersPerTurn, 2);

    await tester.tap(find.byKey(const ValueKey('tavern-group-member-$_star')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-group-member-muted')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-group-member-up')));
    await tester.pumpAndSettle();
    group = (await tester.runAsync<TavernGroupChat?>(() => tavern.groupChat(chat)))!;
    expect(group.members.map((m) => m.characterId), [_star, _lin]);
    expect(group.members.first.muted, isTrue);
    await tester.tap(find.byKey(const ValueKey('tavern-group-member-remove')));
    await tester.pumpAndSettle();
    group = (await tester.runAsync<TavernGroupChat?>(() => tavern.groupChat(chat)))!;
    expect(group.members.map((m) => m.characterId), [_lin]);
    expect(find.text('静音'), findsNothing);

    // One more, from the shelf.
    await tester.tap(find.byKey(const ValueKey('tavern-group-add')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-group-add-$_star')));
    await tester.pumpAndSettle();
    group = (await tester.runAsync<TavernGroupChat?>(() => tavern.groupChat(chat)))!;
    expect(group.members.map((m) => m.characterId), [_lin, _star]);
  });
}
