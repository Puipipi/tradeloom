import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_app/tavern/deferred_tavern.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_files.dart';
import 'package:dsh_app/ui/tavern/tavern_regex_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// Two ST rules; the first carries a field of its own the page does not show.
final _scripts = jsonEncode([
  {
    'scriptName': '去掉思考',
    'findRegex': '/<think>[\\s\\S]*?<\\/think>/g',
    'replaceString': '',
    'placement': [2],
    'markdownOnly': false,
    'promptOnly': false,
    'disabled': false,
    'x-card': {'keep': true},
  },
  {'scriptName': '状态栏', 'findRegex': '/<status>(.*?)<\\/status>/s', 'replaceString': '', 'disabled': false},
]);

/// The preview, counting edits, or answering them with [answer].
class _Edits extends PreviewTavern {
  _Edits() : super(tick: Duration.zero);

  final patches = <Map<String, Object?>>[];
  Future<TavernRegexScript> Function(String id, Map<String, Object?> patch)? answer;

  @override
  Future<TavernRegexScript> updateRegexScript(String regexId, Map<String, Object?> patch) {
    patches.add(patch);
    return answer?.call(regexId, patch) ?? super.updateRegexScript(regexId, patch);
  }
}

Future<void> _open(WidgetTester tester, PreviewTavern tavern) async {
  SharedPreferences.setMockInitialValues({});
  // Tall enough that the whole form is built.
  tester.view.physicalSize = const Size(390, 2200) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  final file = TavernChatFile(fileName: 'regex.json', bytes: Uint8List.fromList(utf8.encode(_scripts)));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => tavern),
        tavernChatPickerProvider.overrideWithValue(() async => [file]),
      ],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: const TavernRegexPage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('tavern-regex-import')));
  await tester.pumpAndSettle();
}

/// Opens 编辑规则 for the first rule; returns its id.
Future<String> _edit(WidgetTester tester, PreviewTavern tavern) async {
  final id = (await tavern.listRegexScripts()).first.id;
  await tester.tap(find.byKey(ValueKey('tavern-regex-$id')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('编辑规则'));
  await tester.pumpAndSettle();
  return id;
}

Future<void> _show(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(ValueKey(key)));
  await tester.pumpAndSettle();
}

Future<void> _save(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('tavern-regex-edit-save')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a rule is edited in place: only what changed is written, the rest kept', (tester) async {
    final tavern = _Edits();
    await _open(tester, tavern);
    final id = await _edit(tester, tavern);
    expect(find.widgetWithText(TextField, '去掉思考'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('tavern-regex-edit-name')), '藏起思考');
    await _show(tester, 'tavern-regex-place-1');
    await tester.tap(find.byKey(const ValueKey('tavern-regex-place-1')));
    await tester.pumpAndSettle();
    await _show(tester, 'tavern-regex-edit-phase');
    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-regex-edit-phase')), matching: find.text('只改显示')),
    );
    await tester.pumpAndSettle();
    await _show(tester, 'tavern-regex-edit-min');
    await tester.enterText(find.byKey(const ValueKey('tavern-regex-edit-min')), '2');
    await _save(tester);

    expect(tavern.patches.single, {
      'scriptName': '藏起思考',
      'placement': [1, 2],
      'markdownOnly': true,
      'minDepth': 2,
    });
    final rules = await tavern.listRegexScripts();
    expect(rules.map((r) => r.id).first, id); // same rule, same place
    expect(rules.map((r) => r.name), ['藏起思考', '状态栏']);
    expect(rules.first.raw['x-card'], {'keep': true});
    expect(rules.first.raw['findRegex'], '/<think>[\\s\\S]*?<\\/think>/g');
    // Back on the list, the new name.
    expect(find.text('藏起思考'), findsOneWidget);
  });

  testWidgets('nothing changed: 保存 just goes back', (tester) async {
    final tavern = _Edits();
    await _open(tester, tavern);
    await _edit(tester, tavern);
    await _save(tester);
    expect(tavern.patches, isEmpty);
    expect(find.byKey(const ValueKey('tavern-regex-edit-save')), findsNothing);
  });

  testWidgets('a depth emptied means any depth again: written as null, not left out', (tester) async {
    final tavern = _Edits();
    await _open(tester, tavern);
    await _edit(tester, tavern);
    await _show(tester, 'tavern-regex-edit-max');
    await tester.enterText(find.byKey(const ValueKey('tavern-regex-edit-max')), '3');
    await _save(tester);
    expect(tavern.patches.single, {'maxDepth': 3});
    tavern.patches.clear();
    await _edit(tester, tavern);
    await _show(tester, 'tavern-regex-edit-max');
    expect(tester.widget<TextField>(find.byKey(const ValueKey('tavern-regex-edit-max'))).controller!.text, '3');
    await tester.enterText(find.byKey(const ValueKey('tavern-regex-edit-max')), '');
    await _save(tester);
    expect(tavern.patches.single, {'maxDepth': null});
    final raw = (await tavern.listRegexScripts()).first.raw;
    expect(raw.containsKey('maxDepth'), isTrue);
    expect(raw['maxDepth'], isNull);
  });

  testWidgets('saved but not runnable here says so; a rule gone says that, and the page stays', (tester) async {
    final tavern = _Edits();
    await _open(tester, tavern);
    final rule = (await tavern.listRegexScripts()).first;
    tavern.answer = (id, patch) async => TavernRegexScript(
      id: rule.id,
      sourceText: rule.sourceText,
      raw: {...rule.raw, ...patch},
      importedAt: rule.importedAt,
      diagnostics: const [
        TavernRegexDiagnostic(
          path: r'$.findRegex',
          status: TavernRegexCompatibility.incompatible,
          code: 'invalid-script',
          message: 'bad',
        ),
      ],
    );
    await _edit(tester, tavern);
    await tester.enterText(find.byKey(const ValueKey('tavern-regex-edit-find')), '/[/');
    await _save(tester);
    expect(find.text('已保存。这条规则在这里跑不了，用的时候会跳过'), findsOneWidget);

    tavern.answer = (id, patch) async => throw const TavernImportError('missing');
    await _edit(tester, tavern);
    await tester.enterText(find.byKey(const ValueKey('tavern-regex-edit-name')), '新名字');
    await _save(tester);
    expect(find.text('这条规则已经不在了，回列表刷新一下'), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-regex-edit-save')), findsOneWidget);
  });

  testWidgets('试一下 from the page uses the rule as filled in', (tester) async {
    final tavern = _Edits();
    await _open(tester, tavern);
    await _edit(tester, tavern);
    await tester.enterText(find.byKey(const ValueKey('tavern-regex-edit-find')), '/早安/g');
    await _show(tester, 'tavern-regex-edit-try');
    await tester.tap(find.byKey(const ValueKey('tavern-regex-edit-try')));
    await tester.pumpAndSettle();
    expect(find.text('/早安/g'), findsOneWidget);
    expect(tavern.patches, isEmpty);
  });

  test('the preview edits as the engine does: maps merge, the rest replaced, null kept', () async {
    final tavern = PreviewTavern(tick: Duration.zero);
    final rule = (await tavern.importRegexScripts(_scripts)).scripts.first;
    final patch = <String, Object?>{
      'x-card': {'more': 1},
      'placement': [1],
      'minDepth': null,
    };
    final edited = tavern.updateRegexScript(rule.id, patch);
    patch['placement'] = [9]; // after the call: not part of the edit
    final raw = (await edited).raw;
    expect(raw['x-card'], {'keep': true, 'more': 1});
    expect(raw['placement'], [1]);
    expect(raw.containsKey('minDepth'), isTrue);
    expect((await edited).id, rule.id);
    expect((await tavern.listRegexScripts()).first.id, rule.id);
    await expectLater(tavern.updateRegexScript('nope', const {}), throwsA(isA<TavernImportError>()));
  });

  test('DeferredTavern takes the edit as it is when called, before the engine opens', () async {
    final opening = Completer<Tavern>();
    final deferred = DeferredTavern(opening.future);
    final preview = PreviewTavern(tick: Duration.zero);
    final rule = (await preview.importRegexScripts(_scripts)).scripts.first;
    final patch = <String, Object?>{
      'scriptName': '先',
      'x-card': <String, Object?>{'keep': false},
    };
    final edited = deferred.updateRegexScript(rule.id, patch);
    patch['scriptName'] = '后';
    (patch['x-card']! as Map<String, Object?>)['keep'] = 'changed';
    opening.complete(preview);
    final raw = (await edited).raw;
    expect(raw['scriptName'], '先');
    expect(raw['x-card'], {'keep': false});
  });
}
