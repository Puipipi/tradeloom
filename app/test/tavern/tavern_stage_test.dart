import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/tavern/tavern_character_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_inspector_page.dart';
import 'package:dsh_app/ui/tavern/tavern_stage_panel.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, with a record for its turns.
class _Recorded extends PreviewTavern {
  _Recorded({this.empty = false}) : super(tick: Duration.zero);

  final bool empty;
  int reads = 0;

  @override
  Future<TavernTurnInspection?> inspectTurn(String chatId, {String? nodeId}) async {
    reads++;
    if (empty) return null;
    return TavernTurnInspection(
      chatId: chatId,
      nodeId: nodeId,
      generationType: 'normal',
      startedAt: DateTime.now(),
      finishedAt: DateTime.now(),
      status: TavernInspectionStatus.completed,
      worldInfo: const {
        'activated': [
          {'bookId': 'town', 'uid': 3, 'primaryKey': '雨', 'reason': 'primary', 'content': '镇上的雨已经下了三天。'},
        ],
      },
      reportedUsage: const TavernUsage(promptTokens: 200, cacheHitTokens: 150, completionTokens: 54),
    );
  }
}

Future<String> _open(WidgetTester tester, PreviewTavern tavern, {Size size = const Size(390, 844)}) async {
  SharedPreferences.setMockInitialValues({});
  final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
  tester.view.physicalSize = size * 2;
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
        home: TavernChatPage(chatId: chat),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return chat;
}

void main() {
  testWidgets('on a phone 舞台 slides in from the header; 本回合 has this turn\'s figures', (tester) async {
    await _open(tester, _Recorded());
    expect(find.byType(TavernStagePanel), findsNothing);

    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernStagePanel), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-stage-session')), findsOneWidget); // 本局 first
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-stage-tabs')), matching: find.text('本回合')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-stage-usage')), findsOneWidget);
    expect(find.text('200'), findsOneWidget); // the prompt
    expect(find.text('75%'), findsOneWidget); // 150 of 200 from the cache
    expect(find.text('54'), findsOneWidget); // the reply
    expect(find.byType(TavernWorldHitTile), findsOneWidget);
    expect(find.textContaining('镇上的雨'), findsOneWidget);

    // The whole record is a tap away.
    await tester.tap(find.byKey(const ValueKey('tavern-stage-inspect')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernInspectorPage), findsOneWidget);
  });

  testWidgets('状态 and 导演 say what they will hold', (tester) async {
    await _open(tester, _Recorded());
    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();

    await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-stage-tabs')), matching: find.text('状态')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-stage-state')), findsOneWidget);
    expect(find.text('这张卡还没有状态'), findsOneWidget);

    await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-stage-tabs')), matching: find.text('导演')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-stage-director')), findsOneWidget);
  });

  testWidgets('本局: the model and look of this chat, and the way to its character', (tester) async {
    await _open(tester, _Recorded());
    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();
    for (final key in [
      'tavern-session-model',
      'tavern-session-thinking',
      'tavern-chat-persona',
      'tavern-chat-layout',
    ]) {
      expect(find.byKey(ValueKey(key)), findsOneWidget, reason: key);
    }

    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-session-model')), matching: find.text('V4 Pro')),
    );
    await tester.pumpAndSettle();
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(TavernSettingsController.modelKey), tavernModels[1]);

    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('tavern-character-details')),
      200,
      scrollable: find.descendant(of: find.byKey(const ValueKey('tavern-stage')), matching: find.byType(Scrollable)),
    );
    // The drag's fling can carry it past the edge again.
    await tester.ensureVisible(find.byKey(const ValueKey('tavern-character-details')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-character-details')));
    await tester.pumpAndSettle();
    expect(find.byType(TavernCharacterPage), findsOneWidget);
    Navigator.of(tester.element(find.byType(TavernCharacterPage))).pop();
    await tester.pumpAndSettle();
    expect(find.byType(TavernStagePanel), findsNothing); // the drawer closed on the way
  });

  testWidgets('本局 gives this chat a preset of its own, or the default again', (tester) async {
    final tavern = _Recorded();
    final imported = (await tester.runAsync(() => tavern.importPreset('{"temperature": 1}', fileName: '长篇小说.json')))!;
    final id = imported.preset.id;
    final chat = await _open(tester, tavern);
    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();
    final tile = find.byKey(const ValueKey('tavern-chat-preset'));
    expect(find.descendant(of: tile, matching: find.text('跟随默认')), findsOneWidget);

    await tester.tap(tile);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey('tavern-chat-preset-$id')));
    await tester.pumpAndSettle();
    expect((await tavern.presetSelection(chatId: chat)).boundPresetId, id);
    expect((await tavern.presetSelection()).defaultPresetId, isNull); // only this chat
    expect(find.descendant(of: tile, matching: find.text('长篇小说')), findsOneWidget);

    await tester.tap(tile);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-chat-preset-follow')));
    await tester.pumpAndSettle();
    expect((await tavern.presetSelection(chatId: chat)).boundPresetId, isNull);
  });

  testWidgets('with no turn on record, 本回合 says so', (tester) async {
    await _open(tester, _Recorded(empty: true));
    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-stage-tabs')), matching: find.text('本回合')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-stage-turn-none')), findsOneWidget);
  });

  testWidgets('wide, 舞台 stands beside the story; 本回合 is read when shown, and again each new turn', (tester) async {
    final tavern = _Recorded();
    final chat = await _open(tester, tavern, size: const Size(1100, 800));
    expect(find.byType(TavernStagePanel), findsOneWidget);
    expect(find.byKey(const ValueKey('bot-action')), findsNothing); // no key needed
    expect(find.byKey(const ValueKey('bot-details')), findsOneWidget);
    // 本局 first: a whole turn's prompt is not read for it.
    expect(tavern.reads, 0);

    await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-stage-tabs')), matching: find.text('本回合')));
    await tester.pumpAndSettle();
    final before = tavern.reads;
    expect(before, greaterThan(0));

    await tester.runAsync(() => tavern.send(chat, '外面怎么了？').drain<void>());
    await tester.pumpAndSettle();
    expect(tavern.reads, greaterThan(before));
  });
}
