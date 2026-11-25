import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_vn_view.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, its display pass rewriting two phrases as a display regex
/// would (one in the greeting, one in the reply); or failing, when [broken].
/// A reply comes a piece every [tick].
class _Displayed extends PreviewTavern {
  _Displayed({this.broken = false, super.tick = Duration.zero});

  final bool broken;

  /// The nodes the pass ran for while the reply was being written.
  final passes = <String?>[];

  /// The reply's pieces so far, and whether it is still coming.
  int pieces = 0;
  bool writing = false;

  @override
  Stream<TavernEvent> send(String chatId, String text) => super.send(chatId, text).map((event) {
    if (event is TavernTextDelta) {
      pieces++;
      writing = true;
    }
    if (event is TavernTurnDone) writing = false;
    return event;
  });

  @override
  Future<TavernDisplayResult> displayText(
    String chatId, {
    String? nodeId,
    String? text,
    TavernRole? role,
    String? speaker,
    num? depth,
    bool reasoning = false,
  }) async {
    if (writing) passes.add(nodeId);
    if (broken) throw StateError('worker gone');
    final stored = await super.displayText(chatId, nodeId: nodeId, text: text);
    final shown = stored.text.replaceAll('冷雨', '冷雨【显示正则】').replaceAll('地下室', '地下室【显示正则】');
    return TavernDisplayResult(text: shown, replacements: 1);
  }
}

Future<(PreviewTavern, String)> _open(WidgetTester tester, PreviewTavern tavern, String layout) async {
  SharedPreferences.setMockInitialValues({'tavern.layout': layout});
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
  return (tavern, chat);
}

void main() {
  for (final layout in ['bubble', 'novel']) {
    testWidgets('$layout: a message shows through the display regex; what is stored does not change', (tester) async {
      final (tavern, chat) = await _open(tester, _Displayed(), layout);
      expect(find.textContaining('冷雨【显示正则】', findRichText: true), findsOneWidget);
      final stored = await tester.runAsync(() => tavern.path(chat));
      expect(stored!.first.text, contains('冷雨'));
      expect(stored.first.text, isNot(contains('显示正则')));
    });
  }

  testWidgets('视觉小说: the pages read each message through the display regex', (tester) async {
    await _open(tester, _Displayed(), 'visualNovel');
    final pages = tester.widget<TavernVisualNovelView>(find.byType(TavernVisualNovelView)).pages;
    expect(pages.map((p) => p.text).join(), contains('冷雨【显示正则】'));
  });

  for (final layout in ['bubble', 'visualNovel']) {
    testWidgets('$layout: the reply being written shows through the display regex, a pass a beat', (tester) async {
      final tavern = _Displayed(tick: const Duration(milliseconds: 20));
      await _open(tester, tavern, layout);
      await tester.enterText(find.byType(TextField), '外面怎么了？');
      await tester.pump();
      await tester.tap(find.byIcon(AppIcons.send));

      var seenWhileWriting = false;
      for (var i = 0; i < 200; i++) {
        await tester.pump(const Duration(milliseconds: 10));
        if (tavern.writing && _showsRewritten(tester, layout)) seenWhileWriting = true;
      }
      await tester.pumpAndSettle();
      expect(tavern.writing, isFalse);
      expect(seenWhileWriting, isTrue);
      // A pass every 120 ms or so, not one a piece (20 ms apart).
      expect(tavern.pieces, greaterThan(10));
      expect(tavern.passes.length, lessThan(tavern.pieces / 2), reason: '${tavern.passes}');
    });
  }

  testWidgets('when the display pass fails, the text shows as written', (tester) async {
    await _open(tester, _Displayed(broken: true), 'bubble');
    expect(find.textContaining('带进一阵冷雨', findRichText: true), findsOneWidget);
    expect(find.textContaining('显示正则', findRichText: true), findsNothing);
  });
}

/// Whether the reply's rewritten phrase is on screen.
bool _showsRewritten(WidgetTester tester, String layout) => layout == 'visualNovel'
    ? tester
          .widget<TavernVisualNovelView>(find.byType(TavernVisualNovelView))
          .pages
          .any((p) => p.streaming && p.text.contains('地下室【显示正则】'))
    : find.textContaining('地下室【显示正则】', findRichText: true).evaluate().isNotEmpty;
