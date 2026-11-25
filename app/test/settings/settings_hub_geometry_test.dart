// The regrouped hub, measured: every card 16 from both screen edges, every
// group's icon discs in one column 16 inside the cards, titles in one column,
// group headings on the 24 line, rows 52 tall, the search capsule over the
// overview card on the same edges; a group's discs share its hue.

import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/common/search_capsule.dart';
import 'package:dsh_app/ui/settings/settings_screen.dart';
import 'package:dsh_app/ui/settings/settings_widgets.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../phone/support.dart' show FixedActiveHost, FixedHosts;
import '../shell/golden_harness.dart';

const _tol = 0.6;
const _width = 390.0;

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('six groups on one grid', (tester) async {
    tester.view.devicePixelRatio = 2;
    tester.view.physicalSize = const Size(_width * 2, 2600 * 2);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      goldenApp(
        home: const SettingsScreen(),
        brightness: Brightness.light,
        overrides: [
          activeHostProvider.overrideWith(() => FixedActiveHost(HostRef.local)),
          hostsProvider.overrideWith(FixedHosts.new),
          localRuntimeProvider.overrideWith(
            () => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus)),
          ),
          settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
        ],
      ),
    );
    await tester.pumpAndSettle();

    final sections = tester.widgetList<SettingsSection>(find.byType(SettingsSection)).toList();
    expect([for (final s in sections) s.title], ['AI', '能力', '外观', '通用', '主机', '帮助与关于']);

    final capsule = tester.getRect(find.byType(SearchCapsuleButton));
    for (final section in find.byType(SettingsSection).evaluate()) {
      final card = tester.getRect(
        find.descendant(of: find.byWidget(section.widget), matching: find.byType(GlassSurface)).first,
      );
      expect(card.left, moreOrLessEquals(16, epsilon: _tol));
      expect(_width - card.right, moreOrLessEquals(16, epsilon: _tol));
      expect(card.left, moreOrLessEquals(capsule.left, epsilon: _tol));
      expect(card.right, moreOrLessEquals(capsule.right, epsilon: _tol));
      final heading = (section.widget as SettingsSection).title!;
      expect(tester.getRect(find.text(heading)).left, moreOrLessEquals(24, epsilon: _tol), reason: heading);

      // One hue per group.
      final discs = tester.widgetList<SettingsIcon>(
        find.descendant(of: find.byWidget(section.widget), matching: find.byType(SettingsIcon)),
      );
      expect({for (final d in discs) d.tint}.length, 1, reason: heading);
    }

    // Every disc in one column, 16 in; every title in one column.
    for (final disc in find.byType(SettingsIcon).evaluate()) {
      expect(tester.getRect(find.byWidget(disc.widget)).left, moreOrLessEquals(32, epsilon: _tol));
    }
    for (final tile in tester.widgetList<SettingsTile>(find.byType(SettingsTile))) {
      final title = tile.title ?? tile.spot!.title(appL10n);
      final row = find.ancestor(of: find.text(title), matching: find.byType(ConstrainedBox)).first;
      expect(tester.getSize(row).height, SettingsMetrics.rowHeight, reason: title);
      expect(
        tester.getRect(find.text(title)).left,
        moreOrLessEquals(16 + SettingsMetrics.textStart, epsilon: _tol),
        reason: title,
      );
    }
  });
}
