import 'dart:async';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/chat/render/markdown_body.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_search_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/haptics.dart';
import '../support/test_fonts.dart';

/// The preview, its selectSibling calls noted.
class _Noting extends PreviewTavern {
  _Noting() : super(tick: Duration.zero);

  final selected = <(String, int)>[];

  @override
  Future<void> selectSibling(String chatId, String nodeId, int index) {
    selected.add((nodeId, index));
    return super.selectSibling(chatId, nodeId, index);
  }
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 30; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pumpAndSettle();
}

void main() {
  for (final (n, paged) in [(3, true), (30, false)]) {
    testWidgets('a search hit is gone to: line $n (${paged ? 'paged back to' : 'already loaded'})', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final tavern = _Noting();
      final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
      // 80 lines of yours: more than the first page of 60 the chat reads.
      await tester.runAsync(() async {
        for (var i = 1; i <= 80; i++) {
          await tavern.sendOnly(chat, '第$i句话，这是一段足够长的话，好让每一行都占些地方。');
        }
      });
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
      final target = find.byWidgetPredicate((w) => w is MarkdownBody && w.text.startsWith('第$n句话'));
      expect(target, findsNothing); // not built: paged back to, or off screen

      unawaited(Navigator.of(tester.element(find.byType(TavernChatPage))).push(TavernSearchPage.route(chat)));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '第$n句话，');
      await tester.pump(const Duration(milliseconds: 300));
      await _settle(tester);
      final hit = find.byWidgetPredicate(
        (w) => w is InkWell && (w.key as ValueKey<String>?)?.value.startsWith('tavern-chat-search-hit-') == true,
      );
      expect(hit, findsOneWidget);
      await tester.tap(hit);
      await tester.pumpAndSettle();
      final felt = recordHaptics(tester);
      await tester.tap(find.byKey(const ValueKey('tavern-chat-search-go')));
      // Less than the mark's moment: loaded, scrolled, still marked.
      for (var i = 0; i < 30; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 2)));
        await tester.pump(const Duration(milliseconds: 16));
      }
      await tester.pump(const Duration(milliseconds: 300)); // the scroll's own animation

      // Back on the chat, its branch selected, the line on screen and marked.
      expect(find.byType(TavernSearchPage), findsNothing);
      expect(tavern.selected, hasLength(1));
      expect(felt, ['HapticFeedbackType.selectionClick']);
      expect(target, findsOneWidget);
      final rect = tester.getRect(target);
      expect(rect.top, greaterThan(0));
      expect(rect.bottom, lessThan(844));
      // Not at the top of what is loaded: brought to about the middle.
      if (!paged) expect(rect.center.dy, inInclusiveRange(250, 600));
      expect(find.byWidgetPredicate((w) => w.runtimeType.toString() == '_JumpMark'), findsOneWidget);

      // The mark goes after a moment.
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(find.byWidgetPredicate((w) => w.runtimeType.toString() == '_JumpMark'), findsNothing);
    });
  }
}
