// Search, measured: the hub's capsule and the search page's field are the
// same capsule (height, glass, where the hint starts), each 16 from the
// screen on both sides like the cards under it.

import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/common/list_page_row.dart';
import 'package:dsh_app/ui/common/overview_card.dart';
import 'package:dsh_app/ui/common/search_capsule.dart';
import 'package:dsh_app/ui/settings/search/settings_search_page.dart';
import 'package:dsh_app/ui/settings/settings_screen.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../phone/support.dart' show FixedActiveHost, FixedHosts;
import '../../shell/golden_harness.dart';

const _tol = 0.6;
const _width = 390.0;

List<Override> _overrides() => [
  activeHostProvider.overrideWith(() => FixedActiveHost(HostRef.local)),
  hostsProvider.overrideWith(FixedHosts.new),
  localRuntimeProvider.overrideWith(() => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus))),
  settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
];

Future<void> _pump(WidgetTester tester, Widget home, {double scale = 1}) async {
  usePhoneSurface(tester);
  await tester.pumpWidget(
    goldenApp(
      home: MediaQuery.withClampedTextScaling(minScaleFactor: scale, maxScaleFactor: scale, child: home),
      brightness: Brightness.light,
      overrides: _overrides(),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final scale in [1.0, 2.0]) {
    testWidgets('the hub\'s capsule: 16 from both sides, over the overview card, at $scale× text', (tester) async {
      await _pump(tester, const SettingsScreen(), scale: scale);
      final capsule = tester.getRect(find.byType(SearchCapsuleButton));
      expect(capsule.left, moreOrLessEquals(16, epsilon: _tol));
      expect(_width - capsule.right, moreOrLessEquals(16, epsilon: _tol));
      final card = tester.getRect(
        find.descendant(of: find.byType(OverviewCard), matching: find.byType(GlassSurface)).first,
      );
      expect(capsule.left, moreOrLessEquals(card.left, epsilon: _tol));
      expect(capsule.right, moreOrLessEquals(card.right, epsilon: _tol));
      expect(card.top - capsule.bottom, moreOrLessEquals(16, epsilon: _tol));
      // The glass sits in a square slot as tall as the capsule: equal room
      // above and below, and as much on its left.
      final glass = tester.getRect(
        find.descendant(of: find.byType(SearchCapsuleButton), matching: find.byIcon(AppIcons.search)),
      );
      expect(glass.center.dy, moreOrLessEquals(capsule.center.dy, epsilon: _tol));
      expect(glass.center.dx - capsule.left, moreOrLessEquals(SearchCapsule.slot / 2, epsilon: _tol));
    });

    testWidgets('the page\'s field matches the hub\'s capsule at $scale× text', (tester) async {
      await _pump(tester, const SettingsScreen(), scale: scale);
      final hub = tester.getRect(find.byType(SearchCapsuleButton));
      Rect hint(Finder capsule) => tester.getRect(find.descendant(of: capsule, matching: find.text('搜索设置')).last);
      Rect glass(Finder capsule) =>
          tester.getRect(find.descendant(of: capsule, matching: find.byIcon(AppIcons.search)));
      final hubHint = hint(find.byType(SearchCapsuleButton));
      final hubGlass = glass(find.byType(SearchCapsuleButton));
      await tester.tap(find.byType(SearchCapsuleButton));
      await tester.pumpAndSettle();
      expect(find.byType(SettingsSearchPage), findsOneWidget);
      // The page itself, at the same text size (a fresh app: a pushed route
      // would sit outside the text-size override).
      await tester.pumpWidget(const SizedBox());
      await _pump(tester, const SettingsSearchPage(), scale: scale);
      final field = tester.getRect(find.byType(SearchCapsule));
      expect(field.height, moreOrLessEquals(hub.height, epsilon: _tol));
      expect(field.left, moreOrLessEquals(hub.left, epsilon: _tol));
      expect(field.right, moreOrLessEquals(hub.right, epsilon: _tol));
      final fieldHint = hint(find.byType(SearchCapsule));
      expect(fieldHint.left - field.left, moreOrLessEquals(hubHint.left - hub.left, epsilon: _tol));
      expect(fieldHint.center.dy - field.top, moreOrLessEquals(hubHint.center.dy - hub.top, epsilon: 1));
      final fieldGlass = glass(find.byType(SearchCapsule));
      expect(fieldGlass.left - field.left, moreOrLessEquals(hubGlass.left - hub.left, epsilon: _tol));
      expect(fieldGlass.center.dy - field.top, moreOrLessEquals(hubGlass.center.dy - hub.top, epsilon: _tol));
    });
  }

  testWidgets('results line up with the field: same 16 on both sides', (tester) async {
    await _pump(tester, const SettingsSearchPage());
    await tester.enterText(find.byType(TextField), '通知');
    await tester.pumpAndSettle();
    final field = tester.getRect(find.byType(SearchCapsule));
    final card = tester.getRect(
      find.descendant(of: find.byType(ListPageCard), matching: find.byType(GlassSurface)).first,
    );
    expect(field.left, moreOrLessEquals(16, epsilon: _tol));
    expect(_width - field.right, moreOrLessEquals(16, epsilon: _tol));
    expect(card.left, moreOrLessEquals(field.left, epsilon: _tol));
    expect(card.right, moreOrLessEquals(field.right, epsilon: _tol));
  });
}
