import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/tavern/deferred_tavern.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
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

const _lin = 'sample-innkeeper';
const _star = 'sample-navigator';
const _at = '2026-11-13T00:00:00.000Z';

/// A group chat whose members each had a turn of their own (STAGE1-APP-
/// INTEGRATION §1, §3.2): one logical turn per actor, in one round, each
/// with its own roll, on its own reply.
class _GroupTools extends PreviewTavern {
  _GroupTools() : super(tick: Duration.zero);

  late String chat;

  /// Logical turn → the member's reply it is on.
  final replies = <String, String>{};

  /// The turns the engine knows of so far.
  final known = <String>{};

  /// Taken in the next round: the turn that comes with it.
  String? next;

  static const _rolls = {
    'lt-a': (label: '潜行', dice: '1d6', values: [4], total: 4, actor: _lin),
    'lt-b': (label: '说服', dice: '1d20', values: [17], total: 17, actor: _star),
  };

  Map<String, Object?> _token(String node) => {'nodeId': node, 'seq': 1, 'sourceEpoch': 0, 'contentVersion': 1};
  Map<String, Object?> _anchor(String node) => {'chatId': chat, 'selectedLeaf': _token(node), 'treeRevision': 1};

  @override
  Future<List<TavernToolTurnSummary>> recentToolTurns(String chatId, {int limit = 20}) async => [
    for (final id in known) TavernToolTurnSummary(logicalTurnId: id, replyNodeId: replies[id]),
  ];

  @override
  Future<TavernToolTurnSnapshot?> readToolTurn(String logicalTurnId) async {
    final node = replies[logicalTurnId];
    final roll = _rolls[logicalTurnId];
    if (node == null || roll == null || !known.contains(logicalTurnId)) return null;
    return TavernToolTurnSnapshot.fromJson({
      'version': 1,
      'logicalTurnId': logicalTurnId,
      'chatId': chat,
      'generationType': 'normal',
      'status': 'completed',
      'outcome': 'normal_final',
      'actorId': roll.actor,
      'groupRoundId': 'round-1',
      'capturedPolicy': <String, Object?>{},
      'usageSummary': <String, Object?>{},
      'admissionAnchor': _anchor(node),
      'currentContextAnchor': _anchor(node),
      'candidateSource': _token(node),
      'budgetUsed': 2,
      'budgetMax': 4,
      'requests': <Object?>[],
      'proposals': <Object?>[],
      'receiptIds': ['x-$logicalTurnId'],
      'replyCommitAdopted': true,
      'normalFinalAdopted': true,
    });
  }

  @override
  Future<TavernToolReceipt?> readToolReceipt(String executionId) async {
    final id = executionId.replaceFirst('x-', '');
    final roll = _rolls[id];
    if (roll == null) return null;
    return TavernToolReceipt.fromJson({
      'version': 1,
      'receiptId': executionId,
      'executionId': executionId,
      'chatId': chat,
      'kind': 'roll',
      'origin': 'model',
      'status': 'committed',
      'committed': true,
      'capturedParameters': {'dice': roll.dice},
      'result': {'dice': roll.dice, 'values': roll.values, 'total': roll.total, 'label': roll.label},
      'createdAt': _at,
      'updatedAt': _at,
    });
  }

  @override
  Stream<TavernGroupEvent> sendGroup(String chatId, String text, {String? speakerCharacterId}) {
    if (next case final id?) known.add(id);
    return super.sendGroup(chatId, text, speakerCharacterId: speakerCharacterId);
  }
}

/// A key in, so the round really goes to the engine (here, the preview).
class _Settings extends SettingsController {
  @override
  AppSettings build() => const AppSettings(loaded: true, apiKey: 'sk-test');
}

Widget _page(_GroupTools tavern) => ProviderScope(
  overrides: [
    tavernProvider.overrideWith((ref) => DeferredTavern(Future.value(tavern))),
    settingsProvider.overrideWith(_Settings.new),
  ],
  child: MaterialApp(
    theme: withTestFonts(buildLightTheme()),
    locale: const Locale('zh', 'CN'),
    supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: TavernChatPage(chatId: tavern.chat),
  ),
);

Future<_GroupTools> _open(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final tavern = _GroupTools();
  tavern.chat = (await tester.runAsync(
    () => tavern.createGroupChat([_lin, _star], activation: TavernGroupActivation.listOrder),
  ))!;
  final greetings = [
    for (final m in (await tester.runAsync(() => tavern.path(tavern.chat)))!)
      if (m.role == TavernRole.character) m.nodeId,
  ];
  tavern.replies['lt-a'] = greetings[0];
  tavern.replies['lt-b'] = greetings[1];
  tavern.known.add('lt-a');
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_page(tavern));
  await tester.pumpAndSettle();
  return tavern;
}

Finder _in(String key, Finder finder) => find.descendant(of: find.byKey(ValueKey(key)), matching: finder);

void main() {
  testWidgets("in a group each member's reply shows the dice of its own turn", (tester) async {
    final tavern = await _open(tester);
    tavern.known.add('lt-b');
    // Rejoining the chat reads them again.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(_page(tavern));
    await tester.pumpAndSettle();
    final a = 'tavern-tools-${tavern.replies['lt-a']}';
    final b = 'tavern-tools-${tavern.replies['lt-b']}';
    expect(_in(a, find.text('潜行：🎲 1d6 掷出 4')), findsOneWidget);
    expect(_in(a, find.textContaining('说服')), findsNothing);
    expect(_in(b, find.text('说服：🎲 1d20 掷出 17')), findsOneWidget);
    expect(_in(b, find.textContaining('潜行')), findsNothing);
  });

  testWidgets('a member that rolls in the round shows it once the round is over', (tester) async {
    final tavern = await _open(tester);
    final b = 'tavern-tools-${tavern.replies['lt-b']}';
    expect(find.byKey(ValueKey(b)), findsNothing);
    tavern.next = 'lt-b';
    await tester.enterText(find.byType(TextField), '大家好');
    await tester.pump();
    await tester.tap(find.byIcon(AppIcons.send));
    for (var i = 0; i < 200; i++) {
      await tester.pump(const Duration(milliseconds: 5));
    }
    await tester.pumpAndSettle();
    expect(tavern.known, contains('lt-b'));
    await tester.ensureVisible(find.byKey(ValueKey(b)));
    expect(_in(b, find.text('说服：🎲 1d20 掷出 17')), findsOneWidget);
  });
}
