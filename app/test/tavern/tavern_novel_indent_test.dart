import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/chat/render/markdown_body.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/tavern/tavern_ink.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _in = tavernIndent;

Future<void> _open(WidgetTester tester, Map<String, Object> prefs) async {
  SharedPreferences.setMockInitialValues(prefs);
  final tavern = PreviewTavern(tick: Duration.zero);
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
}

/// The greeting's text as the story draws it.
String _greeting(WidgetTester tester) => tester
    .widgetList<MarkdownBody>(
      find.descendant(of: find.byKey(const ValueKey('tavern-transcript')), matching: find.byType(MarkdownBody)),
    )
    .map((b) => b.text)
    .firstWhere((t) => t.contains('旅店的门被风推开'));

void main() {
  test('prose lines open on two ideographic spaces; structure, code and blank lines stay', () {
    const text =
        '*她抬起头。*\n\n「进来吧。」\n  有点冷。\n\n# 第一章\n> 引用\n- 一项\n1. 一项\n| 表 |\n<div>x</div>\n---\n'
        '```\n代码\n```\n    缩进代码\n　　已经缩进\n';
    expect(
      tavernIndentParagraphs(text),
      '$_in*她抬起头。*\n\n$_in「进来吧。」\n$_in有点冷。\n\n# 第一章\n> 引用\n- 一项\n1. 一项\n| 表 |\n<div>x</div>\n---\n'
      '```\n代码\n```\n    缩进代码\n　　已经缩进\n',
    );
    expect(tavernIndentParagraphs(''), '');
  });

  testWidgets('小说 indents each paragraph', (tester) async {
    await _open(tester, {TavernSettingsController.layoutKey: 'novel'});
    final shown = _greeting(tester);
    expect(shown, startsWith('$_in*旅店的门被风推开'));
    expect(shown, contains('\n\n$_in「这么晚了还在赶路？'));
  });

  testWidgets('switched off, nothing is indented', (tester) async {
    await _open(tester, {TavernSettingsController.layoutKey: 'novel', TavernSettingsController.novelIndentKey: false});
    expect(_greeting(tester), startsWith('*旅店的门被风推开'));
  });

  testWidgets('bubbles are not indented', (tester) async {
    await _open(tester, {TavernSettingsController.layoutKey: 'bubble'});
    expect(_greeting(tester), startsWith('*旅店的门被风推开'));
  });
}
