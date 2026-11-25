import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// A chat opened at 09:00, a line at [later] after it, then one more a
/// minute on; laid out as [layout].
Future<List<String>> _open(WidgetTester tester, Duration later, TavernLayout layout) async {
  var now = DateTime(2026, 11, 11, 9);
  final tavern = PreviewTavern(tick: Duration.zero, clock: () => now);
  final ids = (await tester.runAsync(() async {
    final chat = await tavern.createChat('sample-innkeeper');
    now = now.add(later);
    final first = await tavern.sendOnly(chat, '第二天一早，我下楼。');
    now = now.add(const Duration(minutes: 1));
    final second = await tavern.sendOnly(chat, '炉子还热着吗？');
    return [chat, first.nodeId, second.nodeId];
  }))!;
  SharedPreferences.setMockInitialValues({TavernSettingsController.layoutKey: layout.name});
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
        home: TavernChatPage(chatId: ids.first),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return ids;
}

void main() {
  testWidgets('小说: a long pause starts a chapter, marked with when the story picks up', (tester) async {
    final [_, first, second] = await _open(tester, const Duration(hours: 7), TavernLayout.novel);
    // The list wraps each row in a Padding with the row's own key: .first.
    final chapter = find.byKey(ValueKey('tavern-chapter-$first')).first;
    expect(find.byKey(ValueKey('tavern-chapter-$first')), findsWidgets);
    expect(find.byType(TavernChapterBreak), findsOneWidget); // not before the next line, a minute on
    expect(find.descendant(of: chapter, matching: find.textContaining('16:00')), findsOneWidget);
    // Between the greeting and the line after the pause.
    expect(tester.getTopLeft(chapter).dy, lessThan(tester.getTopLeft(find.byKey(ValueKey(first)).first).dy));
    expect(find.byKey(ValueKey('tavern-chapter-$second')), findsNothing);
  });

  testWidgets('a short pause is no chapter', (tester) async {
    await _open(tester, const Duration(hours: 2), TavernLayout.novel);
    expect(find.byType(TavernChapterBreak), findsNothing);
  });

  testWidgets('bubbles have no chapters', (tester) async {
    await _open(tester, const Duration(hours: 7), TavernLayout.bubble);
    expect(find.byType(TavernChapterBreak), findsNothing);
  });
}
