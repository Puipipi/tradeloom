// Goldens of 搜索设置: before typing (common words, recent searches), with
// results (a synonym hit names its synonym), and with nothing found (问 AI),
// light and dark; results again at 320 dp and at 2× text.
//
//   flutter test --update-goldens test/settings/search/settings_search_golden_test.dart

import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/settings/search/settings_search_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../phone/support.dart' show FixedActiveHost, FixedHosts;
import '../../shell/golden_harness.dart';

List<Override> _overrides() => [
  activeHostProvider.overrideWith(() => FixedActiveHost(HostRef.local)),
  hostsProvider.overrideWith(FixedHosts.new),
  localRuntimeProvider.overrideWith(() => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus))),
  settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
];

/// Types [query], then puts the keyboard away as the search key would.
Future<void> Function(WidgetTester) _search(String query) => (tester) async {
  await tester.enterText(find.byType(TextField), query);
  await tester.pump();
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pump(const Duration(milliseconds: 300));
};

Future<void> _idle(WidgetTester tester) async {
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  setUp(
    () => SharedPreferences.setMockInitialValues({
      RecentSearches.key: ['保活', 'api key'],
    }),
  );

  goldenBoth('settings_search_idle', () => const SettingsSearchPage(), overrides: _overrides, before: _idle);
  goldenBoth(
    'settings_search_results',
    () => const SettingsSearchPage(),
    overrides: _overrides,
    before: _search('别问我'),
  );
  goldenBoth(
    'settings_search_empty',
    () => const SettingsSearchPage(),
    overrides: _overrides,
    before: _search('怎么把对话导出成 PDF'),
  );

  for (final (name, width, scale) in [('narrow', 320.0, 1.0), ('large_text', 390.0, 2.0)]) {
    testWidgets('settings_search_results_$name (light)', (tester) async {
      await tester.runAsync(loadGoldenFonts);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = Size(width * 2, 844 * 2);
      tester.view.padding = const FakeViewPadding(top: 32 * 2, bottom: 24 * 2);
      tester.view.viewPadding = const FakeViewPadding(top: 32 * 2, bottom: 24 * 2);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        goldenApp(
          home: MediaQuery.withClampedTextScaling(
            minScaleFactor: scale,
            maxScaleFactor: scale,
            child: const SettingsSearchPage(),
          ),
          brightness: Brightness.light,
          overrides: _overrides(),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      await _search('别问我')(tester);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/settings_search_results_${name}_light.png'),
      );
    });
  }
}
