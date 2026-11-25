import 'package:dsh_app/tavern/tavern_agent_runs.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

TavernAgentRun _run(String id, String kind, Map<String, Object?> result, {String? nodeId = 'n1'}) =>
    TavernAgentRun(id: id, chatId: 'c', nodeId: nodeId, kind: kind, at: DateTime.now(), result: result);

/// A card's own state with one value, and [runs] as its audit.
class _Logged extends PreviewTavern {
  _Logged(this.runs) : super(tick: Duration.zero);

  final List<TavernAgentRun> runs;
  final limits = <int>[];

  @override
  Future<TavernStateSnapshot> readState(String chatId) async => TavernStateSnapshot(
    chatId: chatId,
    nodeId: (await path(chatId)).last.nodeId,
    legacy: false,
    initialized: true,
    valueExists: true,
    automaticEnabled: true,
    values: const {'好感': 55},
  );

  @override
  Future<List<TavernAgentRun>> readAgentRuns(String chatId, {String? nodeId, int limit = 50}) async {
    limits.add(limit);
    return runs;
  }
}

Future<void> _openRuns(WidgetTester tester, PreviewTavern tavern) async {
  SharedPreferences.setMockInitialValues({});
  final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
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
        home: TavernChatPage(chatId: chat),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('bot-action')));
  await tester.pumpAndSettle();
  await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-stage-tabs')), matching: find.text('状态')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('tavern-state-runs')));
  await tester.pumpAndSettle();
}

Finder _row(String id) => find.byKey(ValueKey('tavern-run-$id'));

void main() {
  group('reading a run', () {
    test('kinds fall into families; one we do not know keeps its name', () {
      expect(tavernRunFamily('state.user'), TavernRunFamily.user);
      expect(tavernRunFamily('state.tool_batch'), TavernRunFamily.model);
      expect(tavernRunFamily('director.tick'), TavernRunFamily.director);
      expect(tavernRunFamily('director.secret_failure'), TavernRunFamily.directorFailed);
      expect(tavernRunFamily('director.event_apply'), TavernRunFamily.event);
      expect(tavernRunFamily('story.rules'), TavernRunFamily.story);
      expect(tavernRunFamily('something.new'), TavernRunFamily.other);
    });

    test('what a run changed, and what went wrong', () {
      expect(tavernRunChanges(_run('a', 'state.user', {'path': '/stat_data/体力', 'value': 9})), ['stat_data › 体力 → 9']);
      expect(
        tavernRunChanges(
          _run('b', 'state.rules', {
            'changes': [
              {'path': '/mood', 'oldExists': true, 'newExists': true, 'old': '平静', 'new': '亲近'},
              {'path': '/a~1b', 'oldExists': true, 'newExists': false, 'old': 1},
            ],
          }),
        ),
        ['mood → 亲近', 'a/b → —'],
      );
      final refused = _run('c', 'state.user', {
        'path': '/好感',
        'value': 500,
        'committed': false,
        'issues': [
          {'code': 'range', 'message': '超出 0–100'},
        ],
      });
      expect(tavernRunKept(refused), isFalse);
      expect(tavernRunIssue(refused), '超出 0–100');
      expect(tavernRunKept(_run('d', 'director.success', const {})), isTrue);
      expect(
        tavernRunIssue(
          _run('e', 'director.failure', {
            'issues': [
              {'code': 'timeout'},
            ],
          }),
        ),
        'timeout',
      );
    });
  });

  testWidgets('后台记录 lists who changed what, newest first; one opens whole', (tester) async {
    final tavern = _Logged([
      _run('u1', 'state.user', {'path': '/好感', 'value': 55, 'committed': true}),
      _run('u0', 'state.user', {
        'path': '/好感',
        'value': 500,
        'committed': false,
        'issues': [
          {'message': '超出 0–100'},
        ],
      }),
      _run('m1', 'state.rules', {
        'committed': true,
        'changes': [
          for (final key in ['a', 'b', 'c', 'd', 'e']) {'path': '/$key', 'newExists': true, 'new': 1},
        ],
      }),
      _run('d1', 'director.success', const {'version': 1}, nodeId: null),
      _run('x1', 'future.kind', const {'note': 'kept as is'}),
    ]);
    await _openRuns(tester, tavern);

    expect(tavern.limits, [100]);
    expect(find.byKey(const ValueKey('tavern-runs')), findsOneWidget);
    expect(find.descendant(of: _row('u1'), matching: find.text('你改的')), findsOneWidget);
    expect(find.descendant(of: _row('u1'), matching: find.textContaining('好感 → 55')), findsOneWidget);
    // Refused: why, and that it was not kept.
    expect(find.descendant(of: _row('u0'), matching: find.textContaining('好感 → 500 · 没收下：超出 0–100')), findsOneWidget);
    // Three changes shown, the rest counted.
    expect(find.descendant(of: _row('m1'), matching: find.text('卡的规则')), findsOneWidget);
    expect(find.descendant(of: _row('m1'), matching: find.textContaining('a → 1；b → 1；c → 1；等 2 处')), findsOneWidget);
    // A run whose message was deleted says so; a kind we do not know keeps its name.
    expect(find.descendant(of: _row('d1'), matching: find.textContaining('那条消息已删')), findsOneWidget);
    expect(find.descendant(of: _row('x1'), matching: find.text('future.kind')), findsOneWidget);
    expect(tester.getTopLeft(_row('u1')).dy, lessThan(tester.getTopLeft(_row('x1')).dy));

    await tester.tap(_row('x1'));
    await tester.pumpAndSettle();
    final whole = tester.widget<SelectableText>(find.byKey(const ValueKey('tavern-run-whole'))).data!;
    expect(whole, contains('"kind": "future.kind"'));
    expect(whole, contains('"note": "kept as is"'));
  });

  testWidgets('后台记录 with nothing yet says so', (tester) async {
    await _openRuns(tester, _Logged(const []));
    expect(find.byKey(const ValueKey('tavern-runs-empty')), findsOneWidget);
    expect(find.text('还没有记录'), findsOneWidget);
  });
}
