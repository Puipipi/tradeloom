import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/tavern/tavern_bookmarks.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/chat/render/markdown_body.dart';
import 'package:dsh_app/ui/tavern/tavern_bookmarks_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/haptics.dart';
import '../support/test_fonts.dart';

Finder _line(int n) => find.byWidgetPredicate((w) => w is MarkdownBody && w.text.startsWith('第$n句话'));

/// A chat of 80 lines of yours (more than the first page of 60), its page
/// open; [marks] already kept for it.
Future<(PreviewTavern, String)> _open(
  WidgetTester tester, {
  List<Object?> Function(Map<int, String> ids)? marks,
}) async {
  final tavern = PreviewTavern(tick: Duration.zero);
  final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
  final ids = <int, String>{};
  await tester.runAsync(() async {
    for (var i = 1; i <= 80; i++) {
      ids[i] = (await tavern.sendOnly(chat, '第$i句话，这是一段足够长的话，好让每一行都占些地方。')).nodeId;
    }
  });
  SharedPreferences.setMockInitialValues({if (marks != null) 'tavern.bookmarks.$chat': jsonEncode(marks(ids))});
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
  return (tavern, chat);
}

Future<void> _frames(WidgetTester tester, [int n = 30]) async {
  for (var i = 0; i < n; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 2)));
    await tester.pump(const Duration(milliseconds: 16));
  }
}

Map<String, Object?> _mark(String nodeId, String preview) => {
  'nodeId': nodeId,
  'siblingIndex': 0,
  'speaker': 'You',
  'preview': preview,
  'at': '2026-11-11T08:00:00.000',
};

void main() {
  test('a bookmark keeps what it needs to be found again; junk is no bookmark', () {
    final mark = TavernBookmark.fromJson(_mark('n1', '她推开门。'))!;
    expect(TavernBookmark.fromJson(mark.toJson())!.toJson(), mark.toJson());
    expect(TavernBookmark.fromJson({'preview': 'x'}), isNull);
    expect(TavernBookmark.fromJson('n1'), isNull);
  });

  testWidgets("a message's menu marks it, kept for this chat; again takes the mark off", (tester) async {
    final (_, chat) = await _open(tester);
    Future<void> menu() async {
      await tester.longPress(_line(80));
      await tester.pumpAndSettle();
    }

    await menu();
    expect(find.text('加书签'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-menu-bookmark')));
    await tester.pumpAndSettle();
    final prefs = await SharedPreferences.getInstance();
    final kept = jsonDecode(prefs.getString('tavern.bookmarks.$chat')!) as List;
    expect((kept.single as Map)['preview'], startsWith('第80句话'));
    // Marked in the story too, under the line.
    final tag = find.byKey(ValueKey('tavern-bookmarked-${(kept.single as Map)['nodeId']}'));
    expect(tag, findsOneWidget);

    await menu();
    expect(find.text('去掉书签'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-menu-bookmark')));
    await tester.pumpAndSettle();
    expect(prefs.getString('tavern.bookmarks.$chat'), isNull);
    expect(tag, findsNothing);
  });

  testWidgets('a bookmark far back goes there: its line loaded, on screen, marked', (tester) async {
    final (_, chat) = await _open(tester, marks: (ids) => [_mark(ids[3]!, '第3句话')]);
    expect(_line(3), findsNothing);
    unawaited(Navigator.of(tester.element(find.byType(TavernChatPage))).push(TavernBookmarksPage.route(chat)));
    await tester.pumpAndSettle();
    expect(find.text('第3句话'), findsOneWidget);
    final felt = recordHaptics(tester);
    await tester.tap(find.text('第3句话'));
    await _frames(tester);
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(TavernBookmarksPage), findsNothing);
    expect(felt, ['HapticFeedbackType.selectionClick']);
    expect(_line(3), findsOneWidget);
    final rect = tester.getRect(_line(3));
    expect(rect.top, greaterThan(0));
    expect(rect.bottom, lessThan(844));
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
  });

  testWidgets('a bookmark whose line is gone says so and goes', (tester) async {
    final (_, chat) = await _open(tester, marks: (_) => [_mark('no-such-node', '不在了的那句')]);
    unawaited(Navigator.of(tester.element(find.byType(TavernChatPage))).push(TavernBookmarksPage.route(chat)));
    await tester.pumpAndSettle();
    final felt = recordHaptics(tester);
    await tester.tap(find.text('不在了的那句'));
    await _frames(tester, 10);
    await tester.pumpAndSettle();
    expect(find.byType(TavernBookmarksPage), findsOneWidget);
    expect(felt, isEmpty); // went nowhere: nothing felt
    expect(find.textContaining('已经不在了'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-bookmarks-empty')), findsOneWidget);
  });
}
