import 'package:dsh_app/tavern/tavern_cache_break.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_inspector_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/test_fonts.dart';

PromptSegment _part(String id, String role, String content, int tokens) =>
    PromptSegment(id: id, message: {'role': role, 'content': content}, sources: const [], tokens: tokens);

TavernTurnInspection _turn(String nodeId, String context, List<PromptSegment> parts) => TavernTurnInspection(
  chatId: 'c',
  nodeId: nodeId,
  contextNodeId: context,
  generationType: 'normal',
  startedAt: DateTime.utc(2026, 11, 12),
  status: TavernInspectionStatus.completed,
  prompt: PromptAssembly(
    body: const {},
    beforePostProcessing: parts,
    afterPostProcessing: parts,
    excluded: const [],
    budget: 8000,
    remainingBudget: 7000,
    counterName: 'test',
    exactTokenCounts: true,
  ),
);

TavernMessage _message(String id, TavernRole role) =>
    TavernMessage(nodeId: id, role: role, speaker: role.name, text: id, at: DateTime.utc(2026, 11, 12));

/// A chat G · H1 · R1 · H2 · R2 whose replies have [records] (by node).
class _Recorded extends PreviewTavern {
  _Recorded(this.records) : super(tick: Duration.zero);

  final Map<String, TavernTurnInspection> records;
  final asked = <String?>[];

  static final _path = [
    _message('g', TavernRole.character),
    _message('h1', TavernRole.user),
    _message('r1', TavernRole.character),
    _message('h2', TavernRole.user),
    _message('r2', TavernRole.character),
  ];

  @override
  Future<TavernTurnInspection?> inspectTurn(String chatId, {String? nodeId}) async {
    asked.add(nodeId);
    return records[nodeId];
  }

  @override
  Future<List<TavernMessage>> path(String chatId, {int limit = 60, String? beforeNodeId}) async {
    final end = beforeNodeId == null ? _path.length : _path.indexWhere((m) => m.nodeId == beforeNodeId);
    return _path.sublist((end - limit).clamp(0, end), end);
  }
}

final _main = _part('main', 'system', 'You are C.', 100);
final _card = _part('card', 'system', 'C is a keeper.', 300);

Future<void> _open(WidgetTester tester, PreviewTavern tavern, String nodeId) async {
  tester.view.physicalSize = const Size(390, 1400) * 2;
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
        home: TavernInspectorPage(chatId: 'c', nodeId: nodeId),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('where the cache breaks', () {
    test('the first part that differs; adding at the end breaks nothing', () {
      final before = [_main, _part('wi', 'system', 'Lore A', 50), _card, _part('h1', 'user', 'H1', 10)];
      final grown = [...before, _part('r1', 'assistant', 'R1', 40), _part('h2', 'user', 'H2', 10)];
      expect(tavernCacheBreak(before, grown), isNull);
      expect(tavernCacheBreak(grown, before), isNull); // a front of the turn before
      final swapped = [_main, _part('wi', 'system', 'Lore B', 60), _card, _part('h1', 'user', 'H1', 10)];
      expect(tavernCacheBreak(before, swapped), 1);
      expect(tavernTokensFrom(swapped, 1), 370);
      // A part's name or role counts too, not just its words.
      expect(tavernCacheBreak([_main], [_part('main', 'user', 'You are C.', 100)]), 0);
    });

    test('the turn before is the latest earlier reply with a record', () async {
      final r1 = _turn('r1', 'h1', [_main]);
      final tavern = _Recorded({'r1': r1});
      expect(await tavernPreviousTurn(tavern, _turn('r2', 'h2', [_main])), same(r1));
      expect(tavern.asked, ['r1']); // users skipped; the greeting never reached
      // No earlier reply with a record: nothing to compare.
      expect(await tavernPreviousTurn(_Recorded({}), _turn('r2', 'h2', [_main])), isNull);
      expect(await tavernPreviousTurn(_Recorded({}), _turn('r1', 'h1', [_main])), isNull);
    });
  });

  testWidgets('检视 marks the part where the cache broke', (tester) async {
    final tavern = _Recorded({
      'r1': _turn('r1', 'h1', [_main, _part('wi', 'system', 'Lore A', 50), _card, _part('h1', 'user', 'H1', 10)]),
      'r2': _turn('r2', 'h2', [
        _main,
        _part('wi', 'system', 'Lore B', 60),
        _card,
        _part('h1', 'user', 'H1', 10),
        _part('r1', 'assistant', 'R1', 40),
        _part('h2', 'user', 'H2', 10),
      ]),
    });
    await _open(tester, tavern, 'r2');

    final cache = find.byKey(const ValueKey('tavern-inspect-cache'));
    expect(find.descendant(of: cache, matching: find.text('从第 2 段起变了')), findsOneWidget);
    expect(find.descendant(of: cache, matching: find.textContaining('约 420 tokens 不会命中缓存')), findsOneWidget);
    final mark = find.byKey(const ValueKey('tavern-inspect-cache-break'));
    expect(mark, findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-inspect-segment-wi')), matching: mark),
      findsOneWidget,
    );
  });

  testWidgets('检视 says so when the turn only added to the last one', (tester) async {
    final before = [_main, _card, _part('h1', 'user', 'H1', 10)];
    final tavern = _Recorded({
      'r1': _turn('r1', 'h1', before),
      'r2': _turn('r2', 'h2', [...before, _part('r1', 'assistant', 'R1', 40), _part('h2', 'user', 'H2', 10)]),
    });
    await _open(tester, tavern, 'r2');
    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-inspect-cache')), matching: find.text('和上一回合同前缀')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('tavern-inspect-cache-break')), findsNothing);
  });

  testWidgets('检视 of a first turn has nothing to compare', (tester) async {
    await _open(
      tester,
      _Recorded({
        'r1': _turn('r1', 'h1', [_main, _card]),
      }),
      'r1',
    );
    expect(find.byKey(const ValueKey('tavern-inspect-tokens')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-inspect-cache')), findsNothing);
  });
}
