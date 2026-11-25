import 'dart:async';

import 'package:dsh_app/tavern/tavern_generation.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

Future<void> _openSettings(WidgetTester tester, PreviewTavern tavern) async {
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
        home: const TavernSettingsPage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _pick(WidgetTester tester, String tile, String label) async {
  final row = find.byKey(ValueKey(tile));
  // To the middle: at the top it would sit under the glass header.
  unawaited(Scrollable.ensureVisible(tester.element(row), alignment: 0.5));
  await tester.pumpAndSettle();
  await tester.tap(find.descendant(of: row, matching: find.text(label)));
  await tester.pumpAndSettle();
}

Map<String, Object?> _preset(Map<String, Object?> settings) => settings['preset']! as Map<String, Object?>;

void main() {
  testWidgets('生成 writes the whole default preset with the one value changed', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await _openSettings(tester, tavern);

    await _pick(tester, 'tavern-max-context', '32K');
    var preset = _preset(await tavern.readSettings());
    expect(preset['openai_max_context'], 32768);
    // Not the one field alone: the prompts and their order are still there.
    expect(preset['prompts'], isA<List<Object?>>().having((p) => p.length, 'length', greaterThan(5)));
    expect(preset['prompt_order'], isNotNull);

    await _pick(tester, 'tavern-max-reply', '2000');
    await _pick(tester, 'tavern-temperature', '1.5');
    preset = _preset(await tavern.readSettings());
    expect(preset['openai_max_context'], 32768); // the first change kept
    expect(preset['openai_max_tokens'], 2000);
    expect(preset['temperature'], 1.5);
  });

  testWidgets('a preset already set is the one changed, and read back', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    await tavern.setSettings({
      'preset': {'openai_max_context': 65536, 'openai_max_tokens': 1000, 'temperature': 1.3, 'mine': true},
    });
    await _openSettings(tester, tavern);
    final container = ProviderScope.containerOf(tester.element(find.byType(TavernSettingsPage)));
    final read = container.read(tavernGenerationProvider).value!;
    expect((read.maxContext, read.maxReply, read.temperature), (65536, 1000, 1.3));

    await _pick(tester, 'tavern-temperature', '0.7');
    final preset = _preset(await tavern.readSettings());
    expect(preset['temperature'], 0.7);
    expect(preset['mine'], isTrue); // its own fields stay
    expect(preset['openai_max_context'], 65536);
  });
}
