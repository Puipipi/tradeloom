import 'package:dsh_app/tavern/deferred_tavern.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview with the engine's global tool scope kept in memory, as
/// readToolPolicy and setToolPolicy would give and take it.
class _Policy extends PreviewTavern {
  _Policy() : super(tick: Duration.zero);

  Map<String, Object?> raw = {};
  List<Map<String, Object?>> diagnostics = [];
  TavernToolException? refuse;
  final patches = <Map<String, Object?>>[];

  TavernToolPolicySnapshot get _snapshot {
    final roll = raw['roll'] as Map? ?? const {};
    final remember = raw['remember'] as Map? ?? const {};
    return TavernToolPolicySnapshot.fromJson({
      'configuredGlobal': {'present': raw.isNotEmpty, 'raw': raw.isEmpty ? null : raw},
      'configuredChat': null,
      'effectiveScope': {
        'rollAllow': roll['allow'] as bool? ?? true,
        'rememberAllow': remember['allow'] as bool? ?? false,
        'rememberMode': remember['mode'] as String? ?? 'ask',
      },
      'diagnostics': diagnostics,
    });
  }

  @override
  Future<TavernToolPolicySnapshot> readToolPolicy({String? chatId}) async => _snapshot;

  @override
  Future<TavernToolPolicyWriteResult> setToolPolicy(Map<String, Object?> patch, {String? chatId}) async {
    patches.add(patch);
    if (refuse case final e?) throw e;
    for (final MapEntry(:key, :value) in patch.entries) {
      raw[key] = {...(raw[key] as Map<String, Object?>? ?? const {}), ...value! as Map<String, Object?>};
    }
    return TavernToolPolicyWriteResult.fromJson({
      'snapshot': _snapshot.toJson(),
      'committed': true,
      'diagnostics': <Object?>[],
    });
  }
}

Future<void> _settings(WidgetTester tester, Tavern tavern) async {
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

Future<void> _show(WidgetTester tester, String key) async {
  await tester.scrollUntilVisible(find.byKey(ValueKey(key)), 200, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
}

bool _on(WidgetTester tester, String key) =>
    tester.widget<Switch>(find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(Switch))).value;

Future<void> _flip(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(ValueKey(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(Switch)));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets("工具 shows the engine's scope; turning dice off sends that and reads back", (tester) async {
    final engine = _Policy();
    await _settings(tester, DeferredTavern(Future.value(engine)));
    await _show(tester, 'tavern-tool-remember');
    expect(_on(tester, 'tavern-tool-roll'), isTrue);
    expect(_on(tester, 'tavern-tool-remember'), isFalse);
    expect(find.byKey(const ValueKey('tavern-tool-remember-mode')), findsNothing);

    await _flip(tester, 'tavern-tool-roll');
    expect(engine.patches.single, {
      'roll': {'allow': false},
    });
    expect(_on(tester, 'tavern-tool-roll'), isFalse);
  });

  testWidgets('memories on for the first time ask first; a mode once chosen is kept', (tester) async {
    final engine = _Policy();
    await _settings(tester, DeferredTavern(Future.value(engine)));
    await _show(tester, 'tavern-tool-remember');
    await _flip(tester, 'tavern-tool-remember');
    expect(engine.patches.last, {
      'remember': {'allow': true, 'mode': 'ask'},
    });
    await _show(tester, 'tavern-tool-remember-mode');
    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-tool-remember-mode')), matching: find.text('自动')),
    );
    await tester.pumpAndSettle();
    expect(engine.patches.last, {
      'remember': {'mode': 'auto'},
    });

    // Off and on again: the chosen 自动 stays.
    await _show(tester, 'tavern-tool-remember');
    await _flip(tester, 'tavern-tool-remember');
    await _flip(tester, 'tavern-tool-remember');
    expect(engine.patches.last, {
      'remember': {'allow': true},
    });
    expect((engine.raw['remember']! as Map)['mode'], 'auto');
  });

  testWidgets('a refused change says why and shows what the engine has', (tester) async {
    final engine = _Policy()
      ..refuse = const TavernToolException(
        code: TavernToolErrorCode.invalidArgument,
        operation: 'setToolPolicy',
        message: 'invalid_stored_policy',
        committed: false,
        fieldPath: 'toolPolicy.roll',
      );
    await _settings(tester, DeferredTavern(Future.value(engine)));
    await _show(tester, 'tavern-tool-roll');
    await _flip(tester, 'tavern-tool-roll');
    expect(find.text('没改成：invalid_stored_policy'), findsOneWidget);
    expect(_on(tester, 'tavern-tool-roll'), isTrue);
  });

  testWidgets('a setting it could not read in part says so', (tester) async {
    final engine = _Policy()
      ..diagnostics = [
        {'code': 'invalid_stored_policy', 'fieldPath': 'toolPolicy.remember'},
      ];
    await _settings(tester, DeferredTavern(Future.value(engine)));
    await _show(tester, 'tavern-tool-remember');
    expect(find.text('设置里有一部分读不懂，对应的工具先关着'), findsOneWidget);
  });

  testWidgets('the preview keeps no tools, so there is no 工具', (tester) async {
    await _settings(tester, PreviewTavern(tick: Duration.zero));
    expect(find.byKey(const ValueKey('tavern-tool-policy')), findsNothing);
  });
}
