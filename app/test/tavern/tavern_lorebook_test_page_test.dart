import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_lorebook_page.dart';
import 'package:dsh_app/ui/tavern/tavern_lorebook_test_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, answering 测一下 with [answer] when given, or failing.
class _Traced extends PreviewTavern {
  _Traced({this.answer, this.fail = false}) : super(tick: Duration.zero);

  final Map<String, Object?>? answer;
  final bool fail;
  final lines = <String>[];

  @override
  Future<Map<String, Object?>> previewCharacterBook(
    String characterId,
    String text, {
    String? chatId,
    int seed = 0,
  }) async {
    lines.add(text);
    if (fail) throw StateError('engine closed');
    return answer ?? super.previewCharacterBook(characterId, text, chatId: chatId, seed: seed);
  }
}

/// 世界书 of the sample innkeeper, then 测一下.
Future<void> _open(WidgetTester tester, PreviewTavern tavern) async {
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
        home: const TavernLorebookPage(characterId: 'sample-innkeeper'),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('tavern-lore-test')));
  await tester.pumpAndSettle();
  expect(find.byType(TavernLorebookTestPage), findsOneWidget);
}

Future<void> _try(WidgetTester tester, String line) async {
  await tester.enterText(find.byKey(const ValueKey('tavern-lore-test-input')), line);
  await tester.tap(find.byKey(const ValueKey('tavern-lore-test-run')));
  await tester.pumpAndSettle();
}

Finder _hit(String uid) => find.byKey(ValueKey('tavern-lore-hit-$uid'));

void main() {
  testWidgets('a line brings in its keyed entry, the always-on one too, highest order first', (tester) async {
    await _open(tester, _Traced());
    await _try(tester, '我想去地下室看看');

    expect(find.text('会带进提示词的（2）'), findsOneWidget);
    expect(find.descendant(of: _hit('0'), matching: find.text('地下室')), findsOneWidget);
    expect(find.descendant(of: _hit('0'), matching: find.text('关键词「地下室」 · 角色设定前 · 顺序 100')), findsOneWidget);
    expect(find.descendant(of: _hit('0'), matching: find.text('旅店地下室名义上是酒窖，钥匙只有林晚有。')), findsOneWidget);
    expect(find.descendant(of: _hit('1'), matching: find.text('常驻 · 角色设定前 · 顺序 90')), findsOneWidget);
    expect(tester.getTopLeft(_hit('0')).dy, lessThan(tester.getTopLeft(_hit('1')).dy));
  });

  testWidgets('a line with no key brings in only what is always on; an off entry never', (tester) async {
    final tavern = _Traced();
    await tavern.updateCharacterBookEntry('sample-innkeeper', 1, {'enabled': false});
    await _open(tester, tavern);
    await _try(tester, '今天天气不错');
    expect(find.byKey(const ValueKey('tavern-lore-test-none')), findsOneWidget);
    expect(find.text('这句话不会带出任何条目。'), findsOneWidget);
  });

  testWidgets('the engine’s reasons and positions read in words; over budget says so', (tester) async {
    await _open(
      tester,
      _Traced(
        answer: {
          'overflowed': true,
          'activated': [
            {
              'uid': '0',
              'reason': 'keywords',
              'primaryKey': '酒窖',
              'secondaryMatches': ['钥匙'],
              'position': 4,
              'depth': 2,
              'order': 100,
              'content': '展开后的内容',
            },
            {'uid': '9', 'reason': 'sticky', 'position': 2, 'order': 5, 'content': '别的书来的\n第二行'},
            {'uid': '1', 'reason': 'decorator-activate', 'position': 7, 'order': 90, 'content': ''},
          ],
        },
      ),
    );
    await _try(tester, '酒窖的钥匙');

    expect(find.text('关键词「酒窖」 + 「钥匙」 · 倒数第 2 条消息处 · 顺序 100'), findsOneWidget);
    expect(find.text('展开后的内容'), findsOneWidget); // what goes in, after macros
    // No entry of this book has uid 9: its first line names it.
    expect(find.descendant(of: _hit('9'), matching: find.text('别的书来的')), findsOneWidget);
    expect(find.text('粘性，还在生效 · 作者注释旁 · 顺序 5'), findsOneWidget);
    expect(find.text('装饰器 · 出口 · 顺序 90'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-lore-test-overflow')), findsOneWidget);
  });

  testWidgets('a hit opens its entry; coming back tries the same line again', (tester) async {
    final tavern = _Traced();
    await _open(tester, tavern);
    await _try(tester, '酒窖');
    expect(tavern.lines, ['酒窖']);

    await tester.tap(_hit('0'));
    await tester.pumpAndSettle();
    expect(find.byType(TavernLorebookEntryPage), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-lore-constant')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-lore-save')));
    await tester.pumpAndSettle();

    expect(find.byType(TavernLorebookTestPage), findsOneWidget);
    expect(tavern.lines, ['酒窖', '酒窖']);
    expect(find.descendant(of: _hit('0'), matching: find.textContaining('常驻')), findsOneWidget);
  });

  testWidgets('a try that fails says why and shows nothing old', (tester) async {
    await _open(tester, _Traced(fail: true));
    await _try(tester, '地下室');
    expect(find.textContaining('没能测：'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-lore-test-hits')), findsNothing);
  });

  testWidgets('a book without entries offers nothing to try', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    for (var i = 0; i < 2; i++) {
      await tavern.deleteCharacterBookEntry('sample-innkeeper', 0);
    }
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(
      ProviderScope(
        overrides: [tavernProvider.overrideWith((ref) => tavern)],
        child: MaterialApp(
          theme: withTestFonts(buildLightTheme()),
          locale: const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: const TavernLorebookPage(characterId: 'sample-innkeeper'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-lore-test')), findsNothing);
  });
}
