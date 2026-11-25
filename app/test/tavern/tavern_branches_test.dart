import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_branches_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/haptics.dart';
import '../support/test_fonts.dart';

/// A tree node: [id] under [parent], the [index]th of its siblings.
TavernTreeNode _node(String id, String? parent, {int index = 0, bool current = false}) => TavernTreeNode(
  nodeId: id,
  parentId: parent,
  role: TavernRole.user,
  speaker: 'You',
  preview: id,
  at: DateTime(2026, 11, 11),
  isCurrentPath: current,
  siblingIndex: index,
);

/// Rows as "first..last@level".
List<String> _rows(List<TavernTreeNode> tree) => [
  for (final b in tavernBranches(tree)) '${b.first.nodeId}..${b.last.nodeId}@${b.level}',
];

/// A chat with a reply regenerated once: two openings, your line, two
/// replies (the new one current).
Future<(PreviewTavern, String, List<TavernTreeNode>)> _forked(WidgetTester tester) async {
  final tavern = PreviewTavern(tick: Duration.zero);
  final (chat, tree) = (await tester.runAsync(() async {
    final chat = await tavern.createChat('sample-innkeeper');
    await tavern.send(chat, '外面怎么了？').drain<void>();
    final reply = (await tavern.path(chat)).last;
    await tavern.regenerate(chat, reply.nodeId).drain<void>();
    return (chat, await tavern.tree(chat));
  }))!;
  return (tavern, chat, tree);
}

Future<void> _pump(WidgetTester tester, PreviewTavern tavern, Widget home) async {
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

/// 舞台 › 本局 › 分支, from the story.
Future<void> _openFromStory(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('bot-action')));
  await tester.pumpAndSettle();
  final row = find.byKey(const ValueKey('tavern-chat-branches'));
  await tester.scrollUntilVisible(row, 120, scrollable: find.byType(Scrollable).last);
  await tester.pumpAndSettle();
  await tester.tap(row);
  await tester.pumpAndSettle();
  expect(find.byType(TavernBranchesPage), findsOneWidget);
}

Finder _row(String firstId) => find.byKey(ValueKey('tavern-branch-$firstId'));

void main() {
  test('a stretch with no fork is one row; at a fork the other ways hang under it and the current one carries on', () {
    // a-b-c, then c forks: d (current, then f) or e (then g, which forks: h or i).
    final tree = [
      _node('a', null, current: true),
      _node('b', 'a', current: true),
      _node('c', 'b', current: true),
      _node('e', 'c'),
      _node('d', 'c', index: 1, current: true),
      _node('f', 'd', current: true),
      _node('g', 'e'),
      _node('h', 'g'),
      _node('i', 'g', index: 1),
    ];
    expect(_rows(tree), ['a..c@0', 'e..g@1', 'i..i@2', 'h..h@1', 'd..f@0']);
  });

  test('other openings come after the story; a missing parent makes a root', () {
    final tree = [
      _node('g2', null, index: 1),
      _node('g1', null, current: true),
      _node('x', 'g1', current: true),
      _node('orphan', 'deleted'),
    ];
    expect(_rows(tree), ['g1..x@0', 'orphan..orphan@0', 'g2..g2@0']); // the rest in sibling order
    expect(tavernBranches(const []), isEmpty);
  });

  test('thousands of forks down one line are no trouble', () {
    final tree = <TavernTreeNode>[_node('0', null, current: true)];
    for (var i = 1; i <= 3000; i++) {
      tree
        ..add(_node('alt$i', '${i - 1}'))
        ..add(_node('$i', '${i - 1}', index: 1, current: true));
    }
    final rows = tavernBranches(tree);
    expect(rows, hasLength(6001));
    expect(rows.first.nodes.single.nodeId, '0');
    expect(rows.map((r) => r.level).toSet(), {0, 1});
  });

  testWidgets('分支 lists the chat as rows, the current path marked, the other reply indented', (tester) async {
    final (tavern, chat, tree) = await _forked(tester);
    final path = tree.where((n) => n.isCurrentPath).toList();
    final [opening, yours, reply] = path;
    final old = tree.firstWhere((n) => n.parentId == yours.nodeId && !n.isCurrentPath);
    final other = tree.firstWhere((n) => n.parentId == null && !n.isCurrentPath);
    await _pump(tester, tavern, TavernChatPage(chatId: chat));
    await _openFromStory(tester);

    final order = [opening, old, reply, other].map((n) => tester.getTopLeft(_row(n.nodeId)).dy).toList();
    expect(order, orderedEquals([...order]..sort()));
    expect(find.descendant(of: _row(opening.nodeId), matching: find.text('2 条 · 到「外面怎么了？」')), findsOneWidget);
    expect(find.text('正在看'), findsNWidgets(2));
    expect(tester.getTopLeft(_row(old.nodeId)).dx, tester.getTopLeft(_row(reply.nodeId)).dx);
    // Indented: its dot sits further right than the current reply's.
    double dot(TavernTreeNode n) =>
        tester.getTopLeft(find.descendant(of: _row(n.nodeId), matching: find.byType(Container)).first).dx;
    expect(dot(old), greaterThan(dot(reply)));
  });

  testWidgets('a row switches the story to it, and the story shows it', (tester) async {
    final (tavern, chat, tree) = await _forked(tester);
    final yours = tree.firstWhere((n) => n.role == TavernRole.user);
    final old = tree.firstWhere((n) => n.parentId == yours.nodeId && !n.isCurrentPath);
    await _pump(tester, tavern, TavernChatPage(chatId: chat));
    await _openFromStory(tester);

    await tester.tap(_row(old.nodeId));
    await tester.pumpAndSettle();
    final felt = recordHaptics(tester);
    await tester.tap(find.byKey(const ValueKey('tavern-branch-switch')));
    await tester.pumpAndSettle();

    expect(find.byType(TavernBranchesPage), findsNothing);
    expect(find.text('切到了这条分支'), findsOneWidget);
    // Felt as a swipe to another reply is: one light tick.
    expect(felt, ['HapticFeedbackType.selectionClick']);
    final now = (await tester.runAsync(() => tavern.path(chat)))!;
    expect(now.last.nodeId, old.nodeId);
  });

  testWidgets('a branch the story is not on can go, asked first, and come back with 撤销', (tester) async {
    final (tavern, chat, tree) = await _forked(tester);
    final yours = tree.firstWhere((n) => n.role == TavernRole.user);
    final old = tree.firstWhere((n) => n.parentId == yours.nodeId && !n.isCurrentPath);
    final reply = tree.firstWhere((n) => n.parentId == yours.nodeId && n.isCurrentPath);
    await _pump(tester, tavern, TavernBranchesPage(chatId: chat));

    // The current way offers no delete.
    await tester.tap(_row(reply.nodeId));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-branch-delete')), findsNothing);
    await tester.tapAt(const Offset(195, 60));
    await tester.pumpAndSettle();

    await tester.tap(_row(old.nodeId));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-branch-delete')));
    await tester.pumpAndSettle();
    expect(find.text('删掉这条分支？'), findsOneWidget);
    expect(find.textContaining('这条分支上的 1 条消息'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '删除'));
    await tester.pumpAndSettle();
    expect(_row(old.nodeId), findsNothing);
    expect((await tester.runAsync(() => tavern.tree(chat)))!.any((n) => n.nodeId == old.nodeId), isFalse);
    expect((await tester.runAsync(() => tavern.path(chat)))!.last.nodeId, reply.nodeId); // the story untouched

    await tester.tap(find.text('撤销'));
    for (var i = 0; i < 10; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
    expect(_row(old.nodeId), findsOneWidget);
  });

  testWidgets('the current row only takes a name; a name shows, and an empty one clears it', (tester) async {
    final (tavern, chat, tree) = await _forked(tester);
    final yours = tree.firstWhere((n) => n.role == TavernRole.user);
    final reply = tree.firstWhere((n) => n.parentId == yours.nodeId && n.isCurrentPath);
    await _pump(tester, tavern, TavernBranchesPage(chatId: chat));

    Future<void> name(String text) async {
      await tester.tap(_row(reply.nodeId));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('tavern-branch-switch')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('tavern-branch-name')));
      await tester.pumpAndSettle();
      await tester.enterText(find.descendant(of: find.byType(Dialog), matching: find.byType(TextField)), text);
      await tester.tap(find.descendant(of: find.byType(Dialog), matching: find.text('保存')));
      await tester.pumpAndSettle();
    }

    await name('她先说了地下室');
    expect(find.descendant(of: _row(reply.nodeId), matching: find.text('她先说了地下室')), findsOneWidget);
    expect(
      (await tester.runAsync(() => tavern.tree(chat)))!.firstWhere((n) => n.nodeId == reply.nodeId).branchName,
      '她先说了地下室',
    );

    await name('');
    expect(find.text('她先说了地下室'), findsNothing);
  });
}
