import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/tavern/deferred_tavern.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/tavern/tavern_tool_turns.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_tool_strip.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _at = '2026-11-13T00:00:00.000Z';

/// The preview with one tool turn on its greeting: two rolls (one adopted,
/// one not settled) and a proposal to remember, as the engine would give them.
class _Tools extends PreviewTavern {
  _Tools() : super(tick: Duration.zero);

  late String chat;
  late String reply;
  String workflow = 'pending_confirmation';
  bool eligible = true;
  bool failStorage = false;
  String outcome = 'accepted';
  String? reason;
  final decisions = <({String decisionId, int version, TavernMemoryDecision decision, Map<String, Object?> anchor})>[];

  Map<String, Object?> get _token => {'nodeId': reply, 'seq': 1, 'sourceEpoch': 0, 'contentVersion': 1};
  Map<String, Object?> get _anchor => {'chatId': chat, 'selectedLeaf': _token, 'treeRevision': 3};

  Map<String, Object?> get _proposal => {
    'proposalId': 'p1',
    'chatId': chat,
    'logicalTurnId': 'lt1',
    'requestId': 'rq1',
    'executionId': 'x3',
    'candidateNodeId': reply,
    'text': '她怕打雷',
    'mode': 'ask',
    'workflow': workflow,
    'sourceValidity': 'bound',
    'candidateSeq': 1,
    'candidateSourceEpoch': 0,
    'version': 2,
    'keywords': ['雷'],
    'memoryId': null,
    'ineligibleReason': eligible ? null : 'not_on_branch',
    'source': _token,
    'lastDecisionRef': null,
    'contextAnchor': _anchor,
    'eligible': eligible,
  };

  @override
  Future<List<TavernToolTurnSummary>> recentToolTurns(String chatId, {int limit = 20}) async => [
    TavernToolTurnSummary(logicalTurnId: 'lt1', replyNodeId: reply),
  ];

  @override
  Future<TavernToolTurnSnapshot?> readToolTurn(String logicalTurnId) async => logicalTurnId != 'lt1'
      ? null
      : TavernToolTurnSnapshot.fromJson({
          'version': 1,
          'logicalTurnId': 'lt1',
          'chatId': chat,
          'generationType': 'normal',
          'status': 'completed',
          'outcome': 'normal_final',
          'capturedPolicy': <String, Object?>{},
          'usageSummary': <String, Object?>{},
          'admissionAnchor': _anchor,
          'currentContextAnchor': _anchor,
          'candidateSource': _token,
          'budgetUsed': 2,
          'budgetMax': 4,
          'requests': <Object?>[],
          'proposals': [_proposal],
          'receiptIds': ['x1', 'x2'],
          'replyCommitAdopted': true,
          'normalFinalAdopted': true,
        });

  @override
  Future<TavernToolReceipt?> readToolReceipt(String executionId) async => switch (executionId) {
    'x1' => TavernToolReceipt.fromJson({
      'version': 1,
      'receiptId': 'x1',
      'executionId': 'x1',
      'chatId': chat,
      'kind': 'roll',
      'origin': 'model',
      'status': 'committed',
      'committed': true,
      'capturedParameters': {'dice': '2d6+1', 'target': 8},
      'result': {
        'dice': '2d6+1',
        'count': 2,
        'sides': 6,
        'modifier': 1,
        'values': [3, 5],
        'total': 9,
        'label': '开锁',
        'target': 8,
        'pass': true,
      },
      'createdAt': _at,
      'updatedAt': _at,
    }),
    'x2' => TavernToolReceipt.fromJson({
      'version': 1,
      'receiptId': 'x2',
      'executionId': 'x2',
      'chatId': chat,
      'kind': 'roll',
      'origin': 'model',
      'status': 'unresolved',
      'committed': null,
      'capturedParameters': {'dice': '1d20'},
      'createdAt': _at,
      'updatedAt': _at,
    }),
    _ => null,
  };

  @override
  Future<TavernMemoryDecisionReceipt> resolveMemoryProposal(
    String proposalId, {
    required String decisionId,
    required int expectedVersion,
    required TavernMemoryDecision decision,
    required TavernToolContextAnchor expectedContextAnchor,
  }) async {
    decisions.add((
      decisionId: decisionId,
      version: expectedVersion,
      decision: decision,
      anchor: expectedContextAnchor.toJson(),
    ));
    if (failStorage) {
      throw TavernToolException(
        code: TavernToolErrorCode.storageFailure,
        operation: 'resolveMemoryProposal',
        message: 'disk',
        committed: null,
        proposalId: proposalId,
      );
    }
    if (outcome == 'accepted') workflow = decision == TavernMemoryDecision.accept ? 'accepted' : 'rejected';
    return TavernMemoryDecisionReceipt.fromJson({
      'version': 1,
      'record': {
        'decisionRef': {'origin': 'user', 'decisionId': decisionId},
        'chatId': chat,
        'proposalId': proposalId,
        'decision': decision.name,
        'outcome': outcome == 'accepted'
            ? (decision == TavernMemoryDecision.accept ? 'accepted' : 'rejected')
            : outcome,
        'reason': reason,
        'expectedVersion': expectedVersion,
        'expectedContextAnchor': expectedContextAnchor.toJson(),
        'parameters': <String, Object?>{},
        'proposalBefore': <String, Object?>{},
        'proposalAfter': <String, Object?>{},
        'createdAt': _at,
      },
      'current': {'proposal': _proposal, 'contextAnchor': _anchor, 'sourceValidity': 'bound', 'eligible': eligible},
      'replayed': false,
    });
  }
}

Future<_Tools> _open(WidgetTester tester, [void Function(_Tools)? setUp, Map<String, Object> prefs = const {}]) async {
  SharedPreferences.setMockInitialValues(prefs);
  final tavern = _Tools();
  tavern.chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
  final path = (await tester.runAsync(() => tavern.path(tavern.chat)))!;
  tavern.reply = path.firstWhere((m) => m.role == TavernRole.character).nodeId;
  setUp?.call(tavern);
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      // Behind the deferred wrapper, as the app holds a real tavern: the
      // preview itself keeps no tool turns and is not asked.
      overrides: [tavernProvider.overrideWith((ref) => DeferredTavern(Future.value(tavern)))],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: TavernChatPage(chatId: tavern.chat),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return tavern;
}

Finder _in(String key, Finder finder) => find.descendant(of: find.byKey(ValueKey(key)), matching: finder);

void main() {
  testWidgets("a reply shows the dice its turn rolled and what it would remember", (tester) async {
    final tavern = await _open(tester);
    final tools = 'tavern-tools-${tavern.reply}';
    expect(_in(tools, find.text('开锁：🎲 2d6+1 掷出 9（3 + 5 + 1） · 目标 8，成功')), findsOneWidget);
    // Not settled: said so, no number made up.
    expect(_in(tools, find.text('🎲 1d20：结果还没确认')), findsOneWidget);
    expect(_in(tools, find.text('想记住：「她怕打雷」')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-tool-memory-accept-p1')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-tool-memory-reject-p1')), findsOneWidget);
  });

  testWidgets("视觉小说 draws no message rows: the newest reply's dice and memory sit over the composer", (tester) async {
    final tavern = await _open(tester, null, {TavernSettingsController.layoutKey: TavernLayout.visualNovel.name});
    final tools = 'tavern-tools-${tavern.reply}';
    expect(_in(tools, find.text('想记住：「她怕打雷」')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-tool-memory-accept-p1')), findsOneWidget);
  });

  testWidgets('记住 sends the proposal as it is, under a new id, kept until it goes through', (tester) async {
    final tavern = await _open(tester);
    await tester.tap(find.byKey(const ValueKey('tavern-tool-memory-accept-p1')));
    await tester.pumpAndSettle();
    final sent = tavern.decisions.single;
    expect(sent.decision, TavernMemoryDecision.accept);
    expect(sent.version, 2);
    expect(sent.anchor['treeRevision'], 3);
    expect((sent.anchor['selectedLeaf']! as Map)['nodeId'], tavern.reply);
    expect(sent.decisionId, startsWith('dshgo-'));
    expect((await SharedPreferences.getInstance()).getString('${tavernMemoryIntentKey}p1'), isNull);
    // Read again: what the engine now says.
    expect(find.text('已记住'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-tool-memory-accept-p1')), findsNothing);
  });

  testWidgets('one that could not be saved stays, and 重试 sends the very same one', (tester) async {
    final tavern = await _open(tester, (t) => t.failStorage = true);
    await tester.tap(find.byKey(const ValueKey('tavern-tool-memory-reject-p1')));
    await tester.pumpAndSettle();
    expect(find.text('没确认上：disk'), findsOneWidget);
    final kept = jsonDecode((await SharedPreferences.getInstance()).getString('${tavernMemoryIntentKey}p1')!) as Map;
    expect(kept['decision'], 'reject');
    expect(find.text('上次的决定还没确认上'), findsOneWidget);

    tavern.failStorage = false;
    await tester.tap(find.byKey(const ValueKey('tavern-tool-memory-retry-p1')));
    await tester.pumpAndSettle();
    expect(tavern.decisions, hasLength(2));
    expect(tavern.decisions.last.decisionId, tavern.decisions.first.decisionId);
    expect(tavern.decisions.last.decision, TavernMemoryDecision.reject);
    expect((await SharedPreferences.getInstance()).getString('${tavernMemoryIntentKey}p1'), isNull);
    expect(find.text('没有记'), findsOneWidget);
  });

  testWidgets('not applied says why', (tester) async {
    await _open(tester, (t) {
      t.outcome = 'not_applied';
      t.reason = 'context_changed';
    });
    await tester.tap(find.byKey(const ValueKey('tavern-tool-memory-accept-p1')));
    await tester.pumpAndSettle();
    expect(find.text('没记上：对话已经变了'), findsOneWidget);
  });

  testWidgets('one that cannot be decided now offers no buttons and says why', (tester) async {
    await _open(tester, (t) => t.eligible = false);
    expect(find.text('现在不能确认：不在现在这条线上'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-tool-memory-accept-p1')), findsNothing);
  });

  testWidgets('remembered by the automatic setting, and a turn that did not end normally, say so', (tester) async {
    Map<String, Object?> proposal(String workflow, {Map<String, Object?>? ref}) => {
      'proposalId': 'p',
      'chatId': 'c',
      'logicalTurnId': 't',
      'requestId': 'r',
      'executionId': 'x',
      'candidateNodeId': 'n',
      'text': '雨夜',
      'mode': 'auto',
      'workflow': workflow,
      'sourceValidity': 'bound',
      'candidateSeq': 1,
      'candidateSourceEpoch': 0,
      'version': 1,
      'keywords': <Object?>[],
      'lastDecisionRef': ref,
      'contextAnchor': {'chatId': 'c', 'selectedLeaf': null, 'treeRevision': 0},
      'eligible': false,
    };
    TavernToolTurnView view(Map<String, Object?> p) => TavernToolTurnView(
      TavernToolTurnSnapshot.fromJson({
        'version': 1,
        'logicalTurnId': 't',
        'chatId': 'c',
        'generationType': 'normal',
        'status': 'completed',
        'capturedPolicy': <String, Object?>{},
        'usageSummary': <String, Object?>{},
        'admissionAnchor': {'chatId': 'c', 'selectedLeaf': null, 'treeRevision': 0},
        'currentContextAnchor': {'chatId': 'c', 'selectedLeaf': null, 'treeRevision': 0},
        'budgetUsed': 1,
        'budgetMax': 4,
        'requests': <Object?>[],
        'proposals': [p],
        'receiptIds': <Object?>[],
        'replyCommitAdopted': true,
        'normalFinalAdopted': true,
      }),
      const {},
    );
    for (final (p, text) in [
      (proposal('accepted', ref: {'origin': 'policy_auto', 'decisionId': 'a'}), '已按自动设置记住'),
      (proposal('inactive_terminal'), '这一回合没有正常写完，没有记'),
    ]) {
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            theme: withTestFonts(buildLightTheme()),
            locale: const Locale('zh', 'CN'),
            supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
            localizationsDelegates: GlobalMaterialLocalizations.delegates,
            home: Scaffold(
              body: TavernToolStrip(view: view(p), onDecide: (_, _) {}, onRetry: (_) {}),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(text), findsOneWidget);
    }
  });

  test('the preview keeps no tool executions: every one of the six says so', () async {
    final preview = PreviewTavern(tick: Duration.zero);
    final anchor = TavernToolContextAnchor(chatId: 'c', selectedLeaf: null, treeRevision: 0);
    for (final (name, call) in <(String, Future<Object?> Function())>[
      ('readToolTurn', () => preview.readToolTurn('t')),
      ('readToolReceipt', () => preview.readToolReceipt('x')),
      ('rollDice', () => preview.rollDice('c', actionId: 'a', dice: 'd6')),
      (
        'resolveMemoryProposal',
        () => preview.resolveMemoryProposal(
          'p',
          decisionId: 'd',
          expectedVersion: 1,
          decision: TavernMemoryDecision.accept,
          expectedContextAnchor: anchor,
        ),
      ),
      ('readToolPolicy', () => preview.readToolPolicy()),
      ('setToolPolicy', () => preview.setToolPolicy({})),
    ]) {
      await expectLater(
        call(),
        throwsA(
          isA<TavernToolException>()
              .having((e) => e.code, 'code', TavernToolErrorCode.unsupportedCapability)
              .having((e) => e.operation, 'operation', name)
              .having((e) => e.committed, 'committed', false),
        ),
      );
    }
  });

  test('before it opens, a policy patch is taken as it was at the call; a cycle is refused', () async {
    final opening = Completer<Tavern>();
    final deferred = DeferredTavern(opening.future);
    final patch = <String, Object?>{
      'roll': {'allow': false},
    };
    final result = deferred.setToolPolicy(patch, chatId: 'c');
    (patch['roll']! as Map)['allow'] = true;
    final seen = <Map<String, Object?>>[];
    opening.complete(_Recording(seen));
    await expectLater(result, throwsA(isA<TavernToolException>()));
    expect(seen.single, {
      'roll': {'allow': false},
    });

    final cyclic = <String, Object?>{};
    cyclic['self'] = cyclic;
    await expectLater(
      deferred.setToolPolicy(cyclic),
      throwsA(isA<TavernToolException>().having((e) => e.code, 'code', TavernToolErrorCode.invalidArgument)),
    );
  });
}

/// Records the policy patch it is handed, then refuses as the preview does.
class _Recording extends PreviewTavern {
  _Recording(this.seen) : super(tick: Duration.zero);

  final List<Map<String, Object?>> seen;

  @override
  Future<TavernToolPolicyWriteResult> setToolPolicy(Map<String, Object?> patch, {String? chatId}) {
    seen.add(patch);
    return super.setToolPolicy(patch, chatId: chatId);
  }
}
