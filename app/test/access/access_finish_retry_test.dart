// 继续 on the first-run summary: when finishing fails (the readings could not
// be taken), the step says so with 重试, and 继续 works again instead of
// staying pressed for good.

import 'package:dsh_app/state/access_state.dart';
import 'package:dsh_app/ui/onboarding/access_step.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';
import '../support/english_preview.dart';
import 'support.dart';

Future<void> _frames(WidgetTester tester, [int n = 8]) async {
  for (var i = 0; i < n; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

const _done = ValueKey('access-summary-done');

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('a failed 继续 can be pressed again, and says so', (tester) async {
    final driver = FlakyAccessDriver(offPhone, answer: (item, r) => item == AccessItem.mic ? readingsWith(r, mic: true) : r);
    var done = 0;
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(
        home: AccessStepPage(onDone: () => done++),
        brightness: Brightness.light,
        overrides: accessOverrides(driver),
      ),
    );
    await _frames(tester);
    final c = ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.voice});
    await _frames(tester);
    await tester.tap(find.byKey(const ValueKey('access-primary')));
    await _frames(tester, 20);
    expect(find.byKey(_done), findsOneWidget, reason: 'the walk is over: the summary');

    driver.failures = 1;
    await tester.ensureVisible(find.byKey(_done));
    await tester.tap(find.byKey(_done));
    await _frames(tester);
    expect(done, 0);
    expect(find.text('没能完成设置'), findsOneWidget);
    expect(c.read(accessSetupProvider).features, {AccessFeature.voice}, reason: 'the step is not over');
    expect(tester.takeException(), isNull);

    await tester.tap(find.widgetWithText(SnackBarAction, '重试'));
    await _frames(tester);
    expect(done, 1, reason: '重试 goes on');
    expect(c.read(accessSetupProvider).features, isNull);
  });

  testWidgets('…in English too', (tester) async {
    useEnglish();
    final driver = FlakyAccessDriver(readingsWith(offPhone, mic: true));
    var done = 0;
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(
        home: inEnglish(AccessStepPage(onDone: () => done++)),
        brightness: Brightness.light,
        overrides: accessOverrides(driver),
      ),
    );
    await _frames(tester);
    final c = ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.voice});
    await _frames(tester, 20);
    if (find.byKey(_done).evaluate().isEmpty) {
      await tester.tap(find.byKey(const ValueKey('access-primary')));
      await _frames(tester, 20);
    }
    driver.failures = 1;
    await tester.ensureVisible(find.byKey(_done));
    await tester.tap(find.byKey(_done));
    await _frames(tester);
    expect(find.text('Couldn’t finish setup'), findsOneWidget);
    expect(find.widgetWithText(SnackBarAction, 'Retry'), findsOneWidget);
    expect(done, 0);
    // The notice goes by itself; 继续 works again.
    await _frames(tester, 80);
    expect(find.text('Couldn’t finish setup'), findsNothing);
    await tester.tap(find.byKey(_done));
    await _frames(tester);
    expect(done, 1);
  });
}
