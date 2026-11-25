import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_usage_summary.dart';
import 'package:dsh_app/ui/tavern/tavern_inspector_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// One field across the requests, as the engine sums it.
Map<String, Object?> _field(
  String known, {
  bool complete = false,
  bool overflow = false,
  List<int> missing = const [],
  List<int> invalid = const [],
  List<int> unknown = const [],
}) => {
  'knownSubtotal': overflow ? null : int.parse(known),
  'exactKnownSubtotal': known,
  'overflow': overflow,
  'missingRequestIndexes': missing,
  'invalidRequestIndexes': invalid,
  'unknownRequestIndexes': unknown,
  'complete': complete,
  'total': complete ? int.parse(known) : null,
};

Map<String, Object?> _summary(
  int requests, {
  required Map<String, Object?> prompt,
  required Map<String, Object?> cache,
  required Map<String, Object?> completion,
}) => {
  'version': 1,
  'summaryScope': 'selected_reported_values',
  'requestCount': requests,
  'fields': {'prompt_tokens': prompt, 'completion_tokens': completion, 'cache_hit_tokens': cache},
};

/// The preview with one recorded turn that the engine ran as a tool turn
/// ('lt1'), its requests' usage summed as [summary] says.
class _ToolTurn extends PreviewTavern {
  _ToolTurn(this.summary, {this.usage}) : super(tick: Duration.zero);

  final Map<String, Object?> summary;

  /// The old single figure: only there when every request reported all.
  final TavernUsage? usage;

  @override
  Future<TavernTurnInspection?> inspectTurn(String chatId, {String? nodeId}) async => TavernTurnInspection(
    chatId: chatId,
    nodeId: nodeId,
    generationType: 'normal',
    startedAt: DateTime.utc(2026, 11, 13, 14),
    finishedAt: DateTime.utc(2026, 11, 13, 14),
    status: TavernInspectionStatus.completed,
    reportedUsage: usage,
    logicalTurnId: 'lt1',
  );

  @override
  Future<TavernToolTurnSnapshot?> readToolTurn(String logicalTurnId) async {
    const token = {'nodeId': 'r1', 'seq': 1, 'sourceEpoch': 0, 'contentVersion': 1};
    const anchor = {'chatId': 'c', 'selectedLeaf': token, 'treeRevision': 3};
    return TavernToolTurnSnapshot.fromJson({
      'version': 1,
      'logicalTurnId': logicalTurnId,
      'chatId': 'c',
      'generationType': 'normal',
      'status': 'completed',
      'outcome': 'normal_final',
      'capturedPolicy': <String, Object?>{},
      'usageSummary': summary,
      'admissionAnchor': anchor,
      'currentContextAnchor': anchor,
      'candidateSource': token,
      'budgetUsed': 2,
      'budgetMax': 4,
      'requests': <Object?>[],
      'proposals': <Object?>[],
      'receiptIds': <Object?>[],
      'replyCommitAdopted': true,
      'normalFinalAdopted': true,
    });
  }
}

Future<void> _open(WidgetTester tester, PreviewTavern tavern) async {
  SharedPreferences.setMockInitialValues({});
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
        home: const TavernInspectorPage(chatId: 'c', nodeId: 'r1'),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Finder _inUsage(String text) =>
    find.descendant(of: find.byKey(const ValueKey('tavern-inspect-usage')), matching: find.text(text));

void main() {
  testWidgets('a request not known: what is known, never as a total', (tester) async {
    await _open(
      tester,
      _ToolTurn(
        _summary(
          2,
          prompt: _field('100', unknown: [2]),
          cache: _field('60', unknown: [2]),
          completion: _field('20', unknown: [2]),
        ),
      ),
    );
    expect(_inUsage('2 次请求'), findsOneWidget);
    expect(_inUsage('输入：已明确 100，1 个请求未知\n缓存：已明确 60，1 个请求未知\n输出：已明确 20，1 个请求未知'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-inspect-cost')), findsNothing);
  });

  testWidgets('each field says what it is short of: not reported, reported wrongly', (tester) async {
    await _open(
      tester,
      _ToolTurn(
        _summary(
          3,
          prompt: _field('100', complete: false, missing: [2], invalid: [3]),
          cache: _field('0', missing: [1, 2, 3]),
          completion: _field('75', complete: true),
        ),
      ),
    );
    expect(_inUsage('3 次请求'), findsOneWidget);
    expect(_inUsage('输入：已明确 100，1 个请求没报告，1 个请求报告的数不对\n缓存：3 个请求没报告\n输出：75'), findsOneWidget);
  });

  testWidgets('every request reported all: the turn total, as before', (tester) async {
    await _open(
      tester,
      _ToolTurn(
        _summary(
          2,
          prompt: _field('300', complete: true),
          cache: _field('200', complete: true),
          completion: _field('50', complete: true),
        ),
        usage: const TavernUsage(promptTokens: 300, cacheHitTokens: 200, completionTokens: 50),
      ),
    );
    expect(_inUsage('2 次请求'), findsOneWidget);
    expect(_inUsage('输入 300（缓存 200）· 输出 50'), findsOneWidget);
  });

  testWidgets('a sum past 64 bits stays exact and is not called a total', (tester) async {
    const huge = '18446744073709551616';
    await _open(
      tester,
      _ToolTurn(
        _summary(
          2,
          prompt: _field(huge, overflow: true),
          cache: _field('0', complete: true),
          completion: _field('9', complete: true),
        ),
      ),
    );
    expect(_inUsage('输入：已明确 $huge\n缓存：0\n输出：9'), findsOneWidget);
  });

  testWidgets('one request: no count beside it', (tester) async {
    await _open(
      tester,
      _ToolTurn(
        _summary(
          1,
          prompt: _field('131', complete: true),
          cache: _field('96', complete: true),
          completion: _field('54', complete: true),
        ),
        usage: const TavernUsage(promptTokens: 131, cacheHitTokens: 96, completionTokens: 54),
      ),
    );
    expect(_inUsage('1 次请求'), findsNothing);
    expect(_inUsage('输入 131（缓存 96）· 输出 54'), findsOneWidget);
  });

  test('a summary of a shape not known here, or of no request, is not read', () {
    expect(TavernUsageSummary.fromJson({'version': 2, 'requestCount': 1, 'fields': <String, Object?>{}}), isNull);
    expect(
      TavernUsageSummary.fromJson(_summary(0, prompt: _field('0'), cache: _field('0'), completion: _field('0'))),
      isNull,
    );
    expect(
      TavernUsageSummary.fromJson(_summary(1, prompt: _field('12'), cache: _field('-1'), completion: _field('0'))),
      isNull,
    );
  });
}
