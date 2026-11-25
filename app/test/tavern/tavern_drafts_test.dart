import 'dart:async';

import 'package:dsh_app/l10n/gen/app_localizations_zh.dart';
import 'package:dsh_app/tavern/tavern_authoring.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_draft_page.dart';
import 'package:dsh_app/ui/tavern/tavern_draft_trial_page.dart';
import 'package:dsh_app/ui/tavern/tavern_drafts_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _card = TavernAuthoringTarget(kind: TavernAuthoringTargetKind.character, id: 'lin');
const _authority = TavernAuthorityRevision(domainId: 'd1', revision: 3);

TavernAuthoringChange _set(String id, String path, Object? value, {List<String> dependsOn = const []}) =>
    TavernAuthoringChange(
      id: id,
      physicalResourceId: _card.physicalResourceId,
      path: path,
      operation: TavernAuthoringChangeKind.set,
      value: value,
      dependsOn: dependsOn,
    );

/// One card's draft with three changes: a greeting, and a lorebook entry
/// whose keys depend on its content.
class _Drafts extends PreviewTavern {
  _Drafts() : super(tick: Duration.zero);

  var revision = 4;
  var changes = [
    _set('c1', '/data/first_mes', '你又来了。'),
    _set('c2', '/data/character_book/entries/0/content', '旧城的钟每晚响一次'),
    _set('c3', '/data/character_book/entries/0/keys', ['钟'], dependsOn: ['c2']),
  ];

  /// What apply and rebase were called with.
  final applied = <({List<String> ids, TavernAuthorityRevision expected, String operation})>[];
  final rebased = <List<String>>[];
  TavernAuthoringException? applyError;

  TavernAuthoringRunRequest? asked;

  TavernAuthoringSimulationRequest? tried;
  final trial = _Trial();

  @override
  TavernAuthoringSimulationTask simulateAuthoringDraft(TavernAuthoringSimulationRequest request) {
    tried = request;
    return trial;
  }

  final run = _Run();

  TavernAuthoringDraft get _draft => TavernAuthoringDraft(
    id: 'draft1',
    draftRevision: revision,
    sources: [
      TavernAuthoringSource(
        target: _card,
        sourceFormat: 'chara_card_v3',
        base: const {
          'spec': 'chara_card_v3',
          'data': {'name': '林晚', 'first_mes': '欢迎。'},
        },
        authorityRevision: _authority,
        applySupported: true,
      ),
    ],
    changes: changes,
    createdAt: DateTime.utc(2026, 11, 14),
    updatedAt: DateTime.utc(2026, 11, 14),
  );

  @override
  Future<TavernAuthoringDraft?> readAuthoringDraft(String draftId) async => _draft;

  /// No drafts until one is created.
  List<TavernAuthoringTarget>? created;

  @override
  Future<List<TavernAuthoringDraftSummary>> listAuthoringDrafts() async => [
    if (created case final targets?)
      TavernAuthoringDraftSummary(
        id: 'draft1',
        draftRevision: revision,
        targets: targets,
        updatedAt: DateTime.utc(2026),
      ),
  ];

  @override
  Future<TavernAuthoringDraft> createAuthoringDraft(List<TavernAuthoringTarget> targets) async {
    created = targets;
    return _draft;
  }

  @override
  Future<List<TavernAuthoringRunSummary>> listAuthoringRuns({
    String? draftId,
    int limit = 30,
    String? beforeRunId,
  }) async => const [];

  @override
  Future<TavernAuthoringPreview> previewAuthoringDraft(
    String draftId, {
    required int draftRevision,
    required List<String> changeIds,
  }) async => TavernAuthoringPreview(
    draftId: draftId,
    draftRevision: draftRevision,
    changeIds: changeIds,
    candidates: const {},
    diffs: const [],
    reports: const {},
    issues: const {},
  );

  @override
  Future<TavernAuthoringReceipt> applyAuthoringChanges(
    String draftId, {
    required int draftRevision,
    required String physicalResourceId,
    required List<String> changeIds,
    required TavernAuthorityRevision expectedAuthorityRevision,
    required String operationId,
  }) async {
    applied.add((ids: changeIds, expected: expectedAuthorityRevision, operation: operationId));
    if (applyError case final error?) throw error;
    return TavernAuthoringReceipt(
      domainId: 'd1',
      operationId: operationId,
      physicalResourceId: physicalResourceId,
      state: TavernAuthoringOperationState.adopted,
      adoptedRevision: 4,
      historyPending: false,
    );
  }

  @override
  Future<TavernAuthoringDraft> rebaseAuthoringDraft(
    String draftId, {
    required int draftRevision,
    required List<TavernAuthoringChange> changes,
  }) async {
    rebased.add([for (final c in changes) c.id]);
    this.changes = changes;
    revision++;
    return _draft;
  }

  @override
  TavernAuthoringRun startAuthoringRun(
    TavernAuthoringRunRequest request, {
    TavernAuthoringPromptHost? promptHost,
    TavernAuthoringPreviewHost? renderHost,
  }) {
    asked = request;
    return run;
  }
}

TavernAuthoringSimulationResult _trialResult(
  TavernAuthoringSimulationStatus status, {
  List<TavernAuthoringSimulationTurn> turns = const [],
  Map<String, Object?> usage = const {},
}) => TavernAuthoringSimulationResult(
  requestId: 'trial1',
  captureId: 'c',
  draftId: 'draft1',
  draftRevision: 4,
  changeIds: const ['c1'],
  status: status,
  origin: const {},
  turns: turns,
  requests: const [],
  usage: usage,
  cleanup: const {},
  issues: const [],
);

class _Trial implements TavernAuthoringSimulationTask {
  final done = Completer<TavernAuthoringSimulationResult>();
  var cancelled = false;

  @override
  String get requestId => 'trial1';

  @override
  TavernAuthoringSimulationResult get view => _trialResult(TavernAuthoringSimulationStatus.running);

  @override
  Future<TavernAuthoringSimulationResult> get result => done.future;

  @override
  Future<void> cancel() async => cancelled = true;
}

class _Run implements TavernAuthoringRun {
  final controller = StreamController<TavernAuthoringRunEvent>.broadcast();
  final done = Completer<TavernAuthoringRunSnapshot>();

  @override
  String get runId => 'run1';

  @override
  Stream<TavernAuthoringRunEvent> get events => controller.stream;

  @override
  Future<TavernAuthoringRunSnapshot> get result => done.future;

  @override
  Future<void> cancel() async {}

  void say(String text) => controller.add(
    TavernAuthoringRunEvent(
      runId: runId,
      seq: 1,
      kind: TavernAuthoringRunEventKind.text,
      status: TavernAuthoringRunStatus.running,
      draftRevision: 4,
      delta: text,
    ),
  );
}

Future<void> _open(
  WidgetTester tester,
  _Drafts tavern, {
  Widget home = const TavernDraftPage(draftId: 'draft1'),
}) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = const Size(390, 844) * 2;
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

Finder _change(String id) => find.byKey(ValueKey('tavern-draft-change-$id'));
Checkbox _box(WidgetTester tester, String id) =>
    tester.widget<Checkbox>(find.descendant(of: _change(id), matching: find.byType(Checkbox)));

void main() {
  final l10n = L10nZh();

  test('a change is placed in the words the card pages use; elsewhere it stays a pointer', () {
    expect(tavernDraftPlace(l10n, '/data/first_mes'), '开场白');
    expect(tavernDraftPlace(l10n, '/data/alternate_greetings/0'), '开场白 2');
    expect(tavernDraftPlace(l10n, '/data/character_book/entries/2/content'), '世界书 › 第 3 条 › 内容');
    expect(tavernDraftPlace(l10n, '/entries/0/keys'), '第 1 条 › 关键词');
    expect(tavernDraftPlace(l10n, '/data/extensions/x~1y'), '/data/extensions/x~1y');
  });

  test('what a place held: an array slot, a missing key', () {
    const base = <String, Object?>{
      'data': {
        'tags': ['a', 'b'],
        'a/b': 1,
      },
    };
    expect(tavernDraftValueAt(base, '/data/tags/1'), (true, 'b'));
    expect(tavernDraftValueAt(base, '/data/a~1b'), (true, 1));
    expect(tavernDraftValueAt(base, '/data/tags/2'), (false, null));
    expect(tavernDraftValueAt(base, '/data/name'), (false, null));
  });

  test('ticking takes what a change depends on; unticking takes what depends on it', () {
    final changes = _Drafts().changes;
    expect(tavernDraftWithDependencies(['c3'], changes), {'c3', 'c2'});
    expect(tavernDraftWithDependents(['c2'], changes), {'c2', 'c3'});
    expect(tavernDraftWithDependents(['c1'], changes), {'c1'});
  });

  testWidgets('apply sends the ticked changes with the saved authority; after it, 按现在的版本继续 keeps the rest', (
    tester,
  ) async {
    final tavern = _Drafts();
    await _open(tester, tavern);
    expect(find.descendant(of: _change('c1'), matching: find.text('开场白')), findsOneWidget);
    expect(find.descendant(of: _change('c1'), matching: find.text('你又来了。')), findsOneWidget);

    // c3's keys go with c2's content: unticking c2 unticks c3 too.
    await tester.tap(find.descendant(of: _change('c2'), matching: find.byType(Checkbox)));
    await tester.pumpAndSettle();
    expect(_box(tester, 'c2').value, isFalse);
    expect(_box(tester, 'c3').value, isFalse);
    expect(find.text('应用 1 处'), findsOneWidget);

    await tester.tap(find.byKey(ValueKey('tavern-draft-apply-${_card.physicalResourceId}')));
    await tester.pumpAndSettle();
    expect(tavern.applied.single.ids, ['c1']);
    expect(tavern.applied.single.expected, _authority);
    expect(find.text('已应用到「林晚」'), findsOneWidget);
    expect(find.descendant(of: _change('c1'), matching: find.text('已应用')), findsOneWidget);

    await tester.tap(find.byKey(ValueKey('tavern-draft-catch-up-${_card.physicalResourceId}')));
    await tester.pumpAndSettle();
    expect(tavern.rebased.single, ['c2', 'c3']);
    expect(_change('c1'), findsNothing);
  });

  testWidgets('a card changed since the draft began: it says so, and 按现在的版本继续 keeps every change', (tester) async {
    final tavern = _Drafts()..applyError = const TavernAuthoringException('authority_conflict', 'moved');
    await _open(tester, tavern);
    await tester.tap(find.byKey(ValueKey('tavern-draft-apply-${_card.physicalResourceId}')));
    await tester.pumpAndSettle();
    expect(tavern.applied.single.ids, ['c1', 'c2', 'c3']);
    expect(find.textContaining('在起草之后改过了'), findsOneWidget);

    await tester.tap(find.byKey(ValueKey('tavern-draft-catch-up-${_card.physicalResourceId}')));
    await tester.pumpAndSettle();
    expect(tavern.rebased.single, ['c1', 'c2', 'c3']);
  });

  testWidgets('asking the AI starts a run on the draft as it is, shows what it says, then how it ended', (
    tester,
  ) async {
    final tavern = _Drafts();
    await _open(tester, tavern);
    await tester.enterText(find.byKey(const ValueKey('tavern-draft-ask')), '开场白冷淡一点');
    await tester.tap(find.byKey(const ValueKey('tavern-draft-send')));
    await tester.pump();
    expect(tavern.asked!.instruction, '开场白冷淡一点');
    expect(tavern.asked!.draftId, 'draft1');
    expect(tavern.asked!.draftRevision, 4);

    tavern.run.say('改好了开场白。');
    await tester.pump();
    expect(find.text('改好了开场白。'), findsOneWidget);

    tavern.run.done.complete(
      TavernAuthoringRunSnapshot(
        runId: 'run1',
        draftId: 'draft1',
        startRevision: 4,
        currentRevision: 5,
        status: TavernAuthoringRunStatus.completed,
        answer: '改好了开场白。',
        request: tavern.asked!.toJson(),
        model: const {},
        requests: const [],
        receipts: const [],
        usage: const {},
        issues: const [],
        createdAt: DateTime.utc(2026, 11, 14),
        updatedAt: DateTime.utc(2026, 11, 14),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text(l10n.tavernDraftAiDone), findsOneWidget);
  });

  testWidgets('a card with no drafts: 新草稿 starts one on it and opens it', (tester) async {
    final tavern = _Drafts();
    await _open(tester, tavern, home: const TavernDraftsPage(characterId: 'lin'));
    expect(find.byKey(const ValueKey('tavern-drafts-empty')), findsOneWidget);
    await tester.tap(find.text('新草稿').last);
    await tester.pumpAndSettle();
    expect(tavern.created!.single.physicalResourceId, _card.physicalResourceId);
    expect(find.byType(TavernDraftPage), findsOneWidget);
    expect(_change('c1'), findsOneWidget);
  });

  testWidgets('试玩 plays the ticked changes for the lines typed, then shows the reply and what it used', (tester) async {
    final tavern = _Drafts();
    await _open(
      tester,
      tavern,
      home: TavernDraftTrialPage(draft: tavern._draft, changeIds: const ['c1']),
    );
    await tester.enterText(find.byKey(const ValueKey('tavern-draft-trial-line-0')), '你好');
    await tester.tap(find.byKey(const ValueKey('tavern-draft-trial-play')));
    await tester.pump();
    final asked = tavern.tried!;
    expect(asked.userInputs, ['你好']);
    expect(asked.changeIds, ['c1']);
    expect(asked.draftRevision, 4);
    expect(asked.context.characterResourceId, _card.physicalResourceId);
    expect(find.byKey(const ValueKey('tavern-draft-trial-stop')), findsOneWidget);

    tavern.trial.done.complete(
      _trialResult(
        TavernAuthoringSimulationStatus.completed,
        turns: [
          TavernAuthoringSimulationTurn(
            index: 1,
            input: '你好',
            status: TavernAuthoringSimulationStatus.completed,
            helpers: const [],
            hookIssues: const [],
            message: TavernMessage(
              nodeId: 'n2',
              role: TavernRole.character,
              speaker: '林晚',
              text: '你又来了。',
              at: DateTime.utc(2026, 11, 14),
            ),
          ),
        ],
        usage: {
          'version': 1,
          'requestCount': 1,
          'fields': {
            'prompt_tokens': {'exactKnownSubtotal': '120', 'complete': true},
            'completion_tokens': {'exactKnownSubtotal': '8', 'complete': true},
            'cache_hit_tokens': {'exactKnownSubtotal': '0', 'complete': true},
          },
        },
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('你又来了。'), findsOneWidget);
    expect(find.textContaining('输入 120（缓存 0）· 输出 8'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-draft-trial-play')), findsOneWidget);
  });
}
