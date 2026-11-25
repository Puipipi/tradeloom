import 'dart:async';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_inspector_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, with a recorded turn for one reply.
class _Recorded extends PreviewTavern {
  _Recorded({this.usage = const TavernUsage(promptTokens: 131, cacheHitTokens: 96, completionTokens: 54), this.at})
    : super(tick: const Duration(milliseconds: 1));

  final TavernUsage usage;

  /// When the turn was asked, if not now.
  final DateTime? at;

  final asked = <String?>[];

  @override
  Future<TavernTurnInspection?> inspectTurn(String chatId, {String? nodeId}) async {
    asked.add(nodeId);
    if (nodeId == 'none') return null;
    return TavernTurnInspection(
      chatId: chatId,
      nodeId: nodeId,
      generationType: 'normal',
      startedAt: at ?? DateTime.now(),
      finishedAt: at ?? DateTime.now(),
      status: TavernInspectionStatus.completed,
      prompt: const PromptAssembly(
        body: {'model': 'deepseek-flash'},
        beforePostProcessing: [],
        afterPostProcessing: [
          PromptSegment(
            id: 'main',
            message: {'role': 'system', 'content': '你是林晚，雨夜小镇旅店的老板娘。只说一半。'},
            sources: [PromptSource('preset', 'main', label: 'Main Prompt')],
            tokens: 120,
          ),
          PromptSegment(
            id: 'h1',
            message: {'role': 'user', 'content': '外面怎么了？'},
            sources: [PromptSource('history', 'n1', label: '阿遥')],
            tokens: 8,
          ),
        ],
        excluded: [
          PromptExclusion('nsfw', 'disabled', [PromptSource('preset', 'nsfw', label: 'NSFW Prompt')]),
        ],
        budget: 8000,
        remainingBudget: 7872,
        counterName: 'estimate',
        exactTokenCounts: false,
      ),
      worldInfo: const {
        'activated': [
          {'bookId': 'town', 'uid': 3, 'primaryKey': '雨', 'reason': 'primary', 'content': '镇上的雨已经下了三天。'},
        ],
      },
      reportedUsage: usage,
    );
  }
}

Future<void> _open(WidgetTester tester, PreviewTavern tavern, Widget home) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
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

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('a recorded turn shows its parts, sources, lorebook hits and what was left out', (tester) async {
    await _open(tester, _Recorded(), const TavernInspectorPage(chatId: 'c', nodeId: 'r1'));

    expect(find.text('约 128 tokens'), findsOneWidget);
    expect(find.text('输入 131（缓存 96）· 输出 54'), findsOneWidget);
    expect(find.text('发出去的 2 段'), findsOneWidget);
    expect(find.text('预设 · Main Prompt'), findsOneWidget);
    expect(find.text('对话 · 阿遥'), findsOneWidget);
    expect(find.text('世界书命中 1 条'), findsOneWidget);
    expect(find.textContaining('关键词「雨」'), findsOneWidget);
    expect(find.text('没发出去的 1 段'), findsOneWidget);
    expect(find.text('关着'), findsOneWidget);

    // Folded, a part shows one line; a tap opens the whole text.
    expect(find.byType(SelectableText), findsNothing);
    await tester.tap(find.byKey(const ValueKey('tavern-inspect-segment-main')));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(SelectableText, '你是林晚，雨夜小镇旅店的老板娘。只说一半。'), findsOneWidget);
  });

  testWidgets('a DeepSeek turn shows what it cost, at the hour it was asked', (tester) async {
    // 9000 × 0.044 + 3000 × 1.32 + 540 × 3.96 = 6494.4 per million at peak, on a Wednesday.
    const pro = TavernUsage(promptTokens: 12000, cacheHitTokens: 9000, completionTokens: 540, model: 'deepseek-v4-pro');
    await _open(
      tester,
      _Recorded(usage: pro, at: DateTime.utc(2026, 11, 11, 2)),
      const TavernInspectorPage(chatId: 'c', nodeId: 'r1'),
    );
    final cost = find.byKey(const ValueKey('tavern-inspect-cost'));
    expect(find.descendant(of: cost, matching: find.text('约\u00a0US\$0.0065')), findsOneWidget);
    expect(find.descendant(of: cost, matching: find.text('按 DeepSeek 官方价，高峰时段')), findsOneWidget);
  });

  testWidgets('off peak it is half', (tester) async {
    const pro = TavernUsage(promptTokens: 12000, cacheHitTokens: 9000, completionTokens: 540, model: 'deepseek-v4-pro');
    final cost = find.byKey(const ValueKey('tavern-inspect-cost'));
    await _open(
      tester,
      _Recorded(usage: pro, at: DateTime.utc(2026, 11, 11, 12)),
      const TavernInspectorPage(chatId: 'c', nodeId: 'r1'),
    );
    expect(find.descendant(of: cost, matching: find.text('约\u00a0US\$0.0032')), findsOneWidget);
    expect(find.descendant(of: cost, matching: find.text('按 DeepSeek 官方价，低谷时段（半价）')), findsOneWidget);
  });

  testWidgets('long usage numbers sit under the title, which stays on one line', (tester) async {
    const big = TavernUsage(promptTokens: 1234567, cacheHitTokens: 987654, completionTokens: 12345);
    await _open(tester, _Recorded(usage: big), const TavernInspectorPage(chatId: 'c', nodeId: 'r1'));
    final row = find.byKey(const ValueKey('tavern-inspect-usage'));
    expect(find.descendant(of: row, matching: find.text('输入 1234567（缓存 987654）· 输出 12345')), findsOneWidget);
    final title = tester.getSize(find.descendant(of: row, matching: find.text('模型报告的用量'))).height;
    expect(title, tester.getSize(find.text('类型')).height);
  });

  testWidgets('usage with no model named: no cost row', (tester) async {
    await _open(tester, _Recorded(), const TavernInspectorPage(chatId: 'c', nodeId: 'r1'));
    expect(find.byKey(const ValueKey('tavern-inspect-cost')), findsNothing);
  });

  testWidgets('a reply without a record says so', (tester) async {
    await _open(tester, _Recorded(), const TavernInspectorPage(chatId: 'c', nodeId: 'none'));
    expect(find.byKey(const ValueKey('tavern-inspect-none')), findsOneWidget);
  });

  testWidgets('the title sheet opens the latest turn', (tester) async {
    final tavern = _Recorded();
    final chat = await tavern.createChat('sample-innkeeper');
    await _open(tester, tavern, TavernChatPage(chatId: chat));

    await tester.tap(find.byKey(const ValueKey('bot-action')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('tavern-chat-inspect')),
      200,
      scrollable: find.descendant(of: find.byKey(const ValueKey('tavern-stage')), matching: find.byType(Scrollable)),
    );
    // Clear of the sheet's bottom edge.
    unawaited(
      Scrollable.ensureVisible(tester.element(find.byKey(const ValueKey('tavern-chat-inspect'))), alignment: 0.5),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-chat-inspect')));
    await tester.pumpAndSettle();

    expect(find.byType(TavernInspectorPage), findsOneWidget);
    expect(tavern.asked, [null]);
  });

  testWidgets('a character message menu opens that reply', (tester) async {
    final tavern = _Recorded();
    final chat = await tavern.createChat('sample-innkeeper');
    await _open(tester, tavern, TavernChatPage(chatId: chat));

    final greeting = (await tavern.path(chat)).last;
    await tester.longPress(find.textContaining('炉子还热着'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const ValueKey('tavern-menu-inspect')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-menu-inspect')));
    await tester.pumpAndSettle();

    expect(find.byType(TavernInspectorPage), findsOneWidget);
    expect(tavern.asked, [greeting.nodeId]);
  });
}
