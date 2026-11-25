import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/chat/render/markdown_body.dart';
import 'package:dsh_app/ui/common/streaming_cursor.dart';
import 'package:dsh_app/ui/tavern/tavern_ink.dart';
import 'package:dsh_app/ui/tavern/tavern_reading.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

Future<void> _pump(WidgetTester tester, Widget home) async {
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: Scaffold(body: home),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// Every piece of text drawn, with the colour it is drawn in.
Map<String, Color?> _drawn(WidgetTester tester) {
  final out = <String, Color?>{};
  for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
    rich.text.visitChildren((span) {
      if (span is TextSpan && (span.text?.trim().isNotEmpty ?? false)) out[span.text!.trim()] = span.style?.color;
      return true;
    });
  }
  return out;
}

const _line = '*她笑了笑* 「进来吧。」雨还在下。';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('each set has its own colours, light and dark; 素 has none', () {
    expect(TavernInk.of(TavernPalette.plain, Brightness.light).plain, isTrue);
    final light = TavernInk.of(TavernPalette.ember, Brightness.light);
    final dark = TavernInk.of(TavernPalette.ember, Brightness.dark);
    expect(light.dialogue, isNot(dark.dialogue));
    expect(light.dialogue, isNot(light.action));
    expect(TavernInk.of(TavernPalette.rose, Brightness.light).dialogue, isNot(light.dialogue));
  });

  testWidgets('what is said and what is done get their colours; the narration keeps the page\'s', (tester) async {
    await _pump(tester, const TavernReading(child: MarkdownBody(text: _line, selectable: false)));
    final ink = TavernInk.of(TavernPalette.ember, Brightness.light);
    final drawn = _drawn(tester);
    expect(drawn['「进来吧。」'], ink.dialogue);
    expect(drawn['她笑了笑'], ink.action);
    expect(drawn['雨还在下。'], isNot(ink.dialogue));
    expect(drawn['雨还在下。'], isNot(ink.action));
    // No asterisks left: it reads as italics.
    expect(drawn.keys.any((t) => t.contains('*')), isFalse);
  });

  testWidgets('素 draws the text as the app does', (tester) async {
    SharedPreferences.setMockInitialValues({TavernSettingsController.paletteKey: 'plain'});
    await _pump(tester, const TavernReading(child: MarkdownBody(text: _line, selectable: false)));
    final ink = TavernInk.of(TavernPalette.ember, Brightness.light);
    final drawn = _drawn(tester);
    expect(drawn['「进来吧。」'], isNot(ink.dialogue));
  });

  testWidgets('quotes in an HTML attribute are left alone', (tester) async {
    await _pump(tester, const TavernReading(child: MarkdownBody(text: '她说"好"。', selectable: false)));
    expect(_drawn(tester)['"好"'], TavernInk.of(TavernPalette.ember, Brightness.light).dialogue);
    expect(tavernInkPattern.pattern.allMatches('<span class="hp">').map((m) => m[0]), isNot(contains('"hp"')));
  });

  testWidgets('a reply being written keeps its cursor', (tester) async {
    // The cursor breathes for as long as the reply is written: one frame, not settling.
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          theme: withTestFonts(buildLightTheme()),
          home: const Scaffold(
            body: TavernReading(child: MarkdownBody(text: '「进来吧」她说', streaming: true, selectable: false)),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(StreamingCursor), findsOneWidget);
    expect(_drawn(tester)['「进来吧」'], TavernInk.of(TavernPalette.ember, Brightness.light).dialogue);
  });

  testWidgets('a quote still open at the end is said already, and the cursor stays after it', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          theme: withTestFonts(buildLightTheme()),
          home: const Scaffold(
            body: TavernReading(child: MarkdownBody(text: '她说：「进来', streaming: true, selectable: false)),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(StreamingCursor), findsOneWidget);
    final drawn = _drawn(tester);
    expect(drawn['「进来'], TavernInk.of(TavernPalette.ember, Brightness.light).dialogue);
    expect(drawn.keys.any((t) => t.contains('')), isFalse); // no cursor drawn as a character
    // Only at the very end: a quote left open on a line before is not.
    expect(tavernInkPattern.pattern.allMatches('「没关上\n下一行').map((m) => m[0]), isEmpty);
  });

  testWidgets('the chat’s own character is named in the accent; anyone else in a colour of their own', (tester) async {
    late BuildContext context;
    await _pump(
      tester,
      Builder(
        builder: (c) {
          context = c;
          return const SizedBox();
        },
      ),
    );
    final accent = Theme.of(context).colorScheme.primary;
    expect(tavernNameColor(context, '林晚', lead: '林晚'), accent);
    expect(tavernNameColor(context, '', lead: '林晚'), accent);
    final guest = tavernNameColor(context, '老周', lead: '林晚');
    expect(guest, isNot(accent));
    expect(tavernNameColor(context, '老周', lead: '林晚'), guest); // the same every time
    final others = {
      for (final n in ['老周', '阿青', '小满', '掌柜', '船夫', '陌生人']) tavernNameColor(context, n, lead: '林晚'),
    };
    expect(others.length, greaterThan(2)); // not all one colour
  });

  testWidgets('酒馆设置 picks the colours, kept', (tester) async {
    await _pump(tester, const TavernSettingsPage());
    // Further down the (lazy) list than it is built at first.
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('tavern-palette')),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.ensureVisible(find.byKey(const ValueKey('tavern-palette')));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-palette')), matching: find.text('冷')));
    await tester.pumpAndSettle();
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(TavernSettingsController.paletteKey), 'ocean');
  });
}
