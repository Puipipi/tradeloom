// Pumps a phone-control page with the fake native side, a recording runtime
// and a fixed active host.

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/ui/common/list_page_row.dart';
import 'package:dsh_app/ui/common/row_marks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../shell/golden_harness.dart';
import 'support.dart';

class PhoneHarness {
  PhoneHarness(this.native, this.runtime);

  final FakePhoneNative? native;
  final PhoneTestRuntime runtime;
}

List<Override> phoneOverrides(PhoneTestRuntime runtime, {HostRef host = HostRef.local}) => [
  localRuntimeProvider.overrideWith(() => runtime),
  activeHostProvider.overrideWith(() => FixedActiveHost(host)),
  hostsProvider.overrideWith(FixedHosts.new),
];

/// Tall surface by default so every section is on screen without scrolling.
Future<PhoneHarness> pumpPhone(
  WidgetTester tester,
  Widget home, {
  FakePhoneNative? native,
  bool missingNative = false,
  RuntimeStatus engine = runningRuntime,
  HostRef host = HostRef.local,
  Size size = const Size(390, 2400),
  Brightness brightness = Brightness.light,
}) async {
  tester.view.devicePixelRatio = 2;
  tester.view.physicalSize = size * 2;
  tester.view.padding = const FakeViewPadding(top: 32 * 2, bottom: 24 * 2);
  tester.view.viewPadding = const FakeViewPadding(top: 32 * 2, bottom: 24 * 2);
  addTearDown(tester.view.reset);
  final fake = missingNative ? null : (native ?? FakePhoneNative());
  if (fake == null) {
    removePhoneNative();
  } else {
    fake.install();
  }
  final runtime = PhoneTestRuntime(LocalRuntimeState(loaded: true, status: engine));
  await tester.pumpWidget(
    goldenApp(
      home: home,
      brightness: brightness,
      overrides: phoneOverrides(runtime, host: host),
    ),
  );
  await settlePhone(tester);
  return PhoneHarness(fake, runtime);
}

/// Lets channel replies land (they are real async messages) and frames build.
Future<void> settlePhone(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// Leaves the app and comes back (AppLifecycleListener.onResume fires).
Future<void> leaveAndResume(WidgetTester tester) async {
  for (final s in const [
    AppLifecycleState.inactive,
    AppLifecycleState.hidden,
    AppLifecycleState.paused,
    AppLifecycleState.hidden,
    AppLifecycleState.inactive,
    AppLifecycleState.resumed,
  ]) {
    tester.binding.handleAppLifecycleStateChanged(s);
  }
  await settlePhone(tester);
}

Future<void> openPhoneFold(WidgetTester tester, String key) async {
  final fold = find.byKey(ValueKey(key));
  await tester.scrollUntilVisible(fold, 200, scrollable: find.byType(Scrollable).first);
  final arrow = find.descendant(of: fold, matching: find.byType(RowExpandArrow)).first;
  if (tester.widget<RowExpandArrow>(arrow).open) return;
  final header = find.descendant(of: fold, matching: find.byType(ListPageRow)).first;
  await Scrollable.ensureVisible(tester.element(header), alignment: 0.5);
  await tester.pumpAndSettle();
  expect(header.hitTestable(), findsOneWidget);
  await tester.tap(header);
  await tester.pumpAndSettle();
}

Future<void> openPhoneChannel(WidgetTester tester, String title) async {
  if (find.text(title).evaluate().isEmpty && find.byKey(const ValueKey('phone-dnd-channels')).evaluate().isNotEmpty) {
    await openPhoneFold(tester, 'phone-dnd-channels');
  }
  if (find.text(title).evaluate().isEmpty && (title == 'Root' || title == 'Sui')) {
    await openPhoneFold(tester, 'phone-dnd-more-channels');
  }
  await tester.ensureVisible(find.text(title));
  await tester.tap(find.text(title));
  await tester.pumpAndSettle();
}

ProviderContainer containerOf(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));

PhoneState phoneOf(WidgetTester tester) => containerOf(tester).read(phoneProvider);
