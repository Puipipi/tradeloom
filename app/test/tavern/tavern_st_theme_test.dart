import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_file_kind.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/tavern/tavern_st_theme.dart';
import 'package:dsh_app/ui/chat/dsh_ui/dsh_ui_model.dart' show dshUiContrast;
import 'package:dsh_app/ui/tavern/tavern_chat_files.dart';
import 'package:dsh_app/ui/tavern/tavern_ink.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// A theme as SillyTavern exports one (Settings › Theme › Export), its
/// colours as ST's picker writes them.
const _dark = <String, Object?>{
  'name': 'Dark V 1.0',
  'blur_strength': 10,
  'main_text_color': 'rgba(220, 220, 210, 1)',
  'italics_text_color': 'rgba(145, 145, 145, 1)',
  'underline_text_color': 'rgba(188, 231, 207, 1)',
  'quote_text_color': 'rgba(225, 138, 36, 1)',
  'blur_tint_color': 'rgba(23, 23, 23, 1)',
  'chat_tint_color': 'rgba(23, 23, 23, 1)',
  'shadow_color': 'rgba(0, 0, 0, 1)',
  'shadow_width': 2,
  'font_scale': 1,
  'chat_width': 50,
  'custom_css': '',
};

Uint8List _bytes(Object json) => Uint8List.fromList(utf8.encode(jsonEncode(json)));

Future<void> _settings(WidgetTester tester, List<TavernChatFile> picked) async {
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => PreviewTavern(tick: Duration.zero)),
        tavernChatPickerProvider.overrideWithValue(() async => picked),
      ],
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

Future<void> _show(WidgetTester tester, String key) async {
  await tester.scrollUntilVisible(find.byKey(ValueKey(key)), 300, scrollable: find.byType(Scrollable).first);
  // In the middle: at the top it would sit under the page's bar.
  await Scrollable.ensureVisible(tester.element(find.byKey(ValueKey(key))), alignment: 0.5);
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('reading a theme', () {
    test('CSS colours as ST writes them', () {
      expect(tavernCssColor('rgba(225, 138, 36, 1)'), 0xE18A24);
      expect(tavernCssColor('rgb(10 20 30)'), 0x0A141E);
      expect(tavernCssColor('rgba(100%, 0%, 50%, 0.5)'), 0xFF0080);
      expect(tavernCssColor('#abc'), 0xAABBCC);
      expect(tavernCssColor('#E18A24FF'), 0xE18A24);
      expect(tavernCssColor('rgba(1, 2, 3, 0)'), isNull); // transparent: none
      expect(tavernCssColor('#00000000'), isNull);
      expect(tavernCssColor('orange'), isNull);
      expect(tavernCssColor(42), isNull);
    });

    test('a theme file is known by its keys and gives its two colours', () {
      expect(tavernFileKindOf('Dark V 1.0.json', _bytes(_dark)), TavernFileKind.stTheme);
      expect(tavernFileKindOf('p.json', _bytes({'prompts': [], 'main_text_color': 'x'})), TavernFileKind.preset);
      final theme = tavernStThemeOf(_dark, fileName: 'x.json')!;
      expect((theme.name, theme.quote, theme.italics), ('Dark V 1.0', 0xE18A24, 0x919191));
      // Named by its file when it names nothing; none without a colour to use.
      final unnamed = Map.of(_dark)..remove('name');
      expect(tavernStThemeOf(unnamed, fileName: 'Mine.JSON')!.name, 'Mine');
      expect(tavernStThemeOf({'main_text_color': 'rgba(1,1,1,1)', 'quote_text_color': 'none'}, fileName: 'x'), isNull);
      expect(TavernStTheme.fromJson(jsonDecode(jsonEncode(theme.toJson()))), theme);
    });

    test('its custom CSS is kept as written, for the canvas, and can be let go', () {
      const css = '#chat .mes { border-left: 3px solid gold; }\n.mes_text q { color: tomato; }';
      final theme = tavernStThemeOf({..._dark, 'custom_css': css}, fileName: 'x')!;
      expect((theme.customCss, theme.useCss, theme.canvasCss), (css, true, css));
      expect(tavernStThemeOf(_dark, fileName: 'x')!.customCss, isNull); // '' is none
      expect(tavernStThemeOf({..._dark, 'custom_css': '  \n'}, fileName: 'x')!.customCss, isNull);
      // CSS alone is a theme too.
      final cssOnly = tavernStThemeOf({
        'main_text_color': 'rgba(1,1,1,1)',
        'quote_text_color': 'none',
        'custom_css': css,
      }, fileName: 'x')!;
      expect((cssOnly.quote, cssOnly.italics, cssOnly.customCss), (null, null, css));
      // Let go: the colours stay, the canvas gets none; kept across a restart.
      final off = theme.withUseCss(false);
      expect((off.quote, off.customCss, off.canvasCss), (theme.quote, css, ''));
      expect(TavernStTheme.fromJson(jsonDecode(jsonEncode(off.toJson()))), off);
      expect(TavernStTheme.fromJson(jsonDecode(jsonEncode(theme.toJson()))), theme);
      // One kept before there was CSS reads as it was.
      expect(
        TavernStTheme.fromJson({'name': 'Old', 'quote': 0xE18A24, 'italics': null}),
        const TavernStTheme(name: 'Old', quote: 0xE18A24),
      );
      expect(TavernStTheme.fromJson({'name': 'Empty', 'quote': null, 'italics': null}), isNull);
    });

    test('its colours are made readable on the page, hue kept', () {
      final theme = tavernStThemeOf(_dark, fileName: 'x')!;
      const white = Color(0xFFFFFFFF);
      final light = TavernInk.st(theme, white);
      for (final color in [light.dialogue!, light.action!]) {
        expect(dshUiContrast(color.toARGB32() & 0xFFFFFF, 0xFFFFFF), greaterThanOrEqualTo(4.5));
      }
      expect(HSVColor.fromColor(light.dialogue!).hue, closeTo(HSVColor.fromColor(const Color(0xFFE18A24)).hue, 3));
      // On a dark page it reads as it is.
      final dark = TavernInk.st(theme, const Color(0xFF17171A));
      expect(dark.dialogue, const Color(0xFFE18A24));
    });
  });

  testWidgets('导入 an ST theme: 配色 becomes ST, shown here, and goes again', (tester) async {
    await _settings(tester, [TavernChatFile(fileName: 'Dark V 1.0.json', bytes: _bytes(_dark))]);
    await _show(tester, 'tavern-st-theme-import');
    expect(find.descendant(of: find.byKey(const ValueKey('tavern-palette')), matching: find.text('ST')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('tavern-st-theme-import')));
    for (var i = 0; i < 10; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
    expect(find.text('换成了 ST 主题「Dark V 1.0」的配色'), findsOneWidget);
    expect(find.text('ST 主题：Dark V 1.0'), findsOneWidget);
    // No custom CSS in this one: nothing to switch.
    expect(find.byKey(const ValueKey('tavern-st-theme-css')), findsNothing);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(TavernSettingsController.paletteKey), 'st');
    expect(prefs.getString(TavernStThemeController.key), contains('Dark V 1.0'));

    // The sample under 配色 wears it, readable on this page.
    final scope = tester.widget<TavernInkScope>(
      find.descendant(of: find.byKey(const ValueKey('tavern-reading-preview')), matching: find.byType(TavernInkScope)),
    );
    final page = Theme.of(tester.element(find.byKey(const ValueKey('tavern-palette')))).colorScheme.surface;
    expect(scope.ink.dialogue, TavernInk.st(tavernStThemeOf(_dark, fileName: '')!, page).dialogue);

    await tester.tap(find.byKey(const ValueKey('tavern-st-theme-remove')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-st-theme')), findsNothing);
    expect(find.byKey(const ValueKey('tavern-st-theme-import')), findsOneWidget);
    expect(prefs.getString(TavernSettingsController.paletteKey), 'ember');
    expect(prefs.getString(TavernStThemeController.key), isNull);
  });

  testWidgets('a theme with custom CSS: on for the canvas, and can be turned off, colours kept', (tester) async {
    const css = '#chat .mes { border-left: 3px solid gold; }';
    await _settings(tester, [
      TavernChatFile(fileName: 'Gold.json', bytes: _bytes({..._dark, 'name': 'Gold', 'custom_css': css})),
    ]);
    await _show(tester, 'tavern-st-theme-import');
    await tester.tap(find.byKey(const ValueKey('tavern-st-theme-import')));
    for (var i = 0; i < 10; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
    final container = ProviderScope.containerOf(tester.element(find.byType(TavernSettingsPage)));
    expect(container.read(tavernStThemeProvider)!.canvasCss, css);

    await _show(tester, 'tavern-st-theme-css');
    expect(find.text('用它的自定义 CSS'), findsOneWidget);
    expect(
      tester
          .widget<Switch>(
            find.descendant(of: find.byKey(const ValueKey('tavern-st-theme-css')), matching: find.byType(Switch)),
          )
          .value,
      isTrue,
    );
    await tester.tap(find.byKey(const ValueKey('tavern-st-theme-css')));
    await tester.pumpAndSettle();
    final off = container.read(tavernStThemeProvider)!;
    expect((off.useCss, off.canvasCss, off.quote), (false, '', 0xE18A24));
    final prefs = await SharedPreferences.getInstance();
    expect(jsonDecode(prefs.getString(TavernStThemeController.key)!), containsPair('useCss', false));
    expect(prefs.getString(TavernSettingsController.paletteKey), 'st');
  });
}
