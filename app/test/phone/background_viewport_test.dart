import 'package:dsh_app/phone/phone_channel.dart';
import 'package:dsh_app/ui/phone/dnd_mode_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'support.dart';

Map<String, Object?> viewportStatus({Object? version = 1, Object? preset = 'portrait'}) {
  final base = phoneStatus(a11y: true);
  return {
    ...base,
    'task': {'id': 8, 'active': true, 'app': 'Example'},
    'background': {
      ...(base['background'] as Map),
      'androidOk': true,
      'viewport': {'v': version, 'preset': preset},
    },
  };
}

void main() {
  test('only exact versioned native preset metadata enables the setting', () {
    expect(PhoneBackgroundViewport.fromMap({'v': 1, 'preset': 'landscape'}), PhoneBackgroundViewport.landscape);
    for (final input in <Map<Object?, Object?>>[
      {},
      {'v': 1.0, 'preset': 'landscape'},
      {'v': 2, 'preset': 'portrait'},
      {'v': 1, 'preset': 'square'},
      {'v': '1', 'preset': 'portrait'},
    ]) {
      expect(PhoneBackgroundViewport.fromMap(input), isNull);
    }
  });

  testWidgets('only explicit selection saves and does not operate the running background task', (tester) async {
    final h = await pumpPhone(tester, const PhoneDndPage(), native: FakePhoneNative(status: viewportStatus()));
    expect(h.native!.methods, ['status', 'getPolicies', 'actionLog']);
    h.native!.calls.clear();
    expect(h.native!.callsOf('setBackgroundViewport'), isEmpty);
    await openPhoneFold(tester, 'phone-dnd-options');
    await tester.tap(find.byKey(const ValueKey('phone-viewport-landscape')));
    await settlePhone(tester);
    expect(h.native!.callsOf('setBackgroundViewport').single.arguments, {'preset': 'landscape'});
    expect(phoneOf(tester).status.background.viewport, PhoneBackgroundViewport.landscape);
    expect(h.native!.methods, ['setBackgroundViewport', 'status']);
    await tester.pump();
    expect(h.native!.callsOf('setBackgroundViewport'), hasLength(1));
    expect(phoneOf(tester).status.task.active, isTrue);
  });

  testWidgets('failed persistence leaves the old preset selected', (tester) async {
    final native = FakePhoneNative(status: viewportStatus())
      ..results['setBackgroundViewport'] = {'ok': false, 'reason': 'Viewport save refused'};
    final h = await pumpPhone(tester, const PhoneDndPage(), native: native);
    await openPhoneFold(tester, 'phone-dnd-options');
    await tester.tap(find.byKey(const ValueKey('phone-viewport-landscape')));
    await settlePhone(tester);
    expect(h.native!.callsOf('setBackgroundViewport'), hasLength(1));
    expect(phoneOf(tester).status.background.viewport, PhoneBackgroundViewport.portrait);
    expect(find.text('Viewport save refused'), findsOneWidget);
  });

  testWidgets('old native modules have no preset controls and receive no setter calls', (tester) async {
    final h = await pumpPhone(tester, const PhoneDndPage(), native: FakePhoneNative(status: phoneStatus(a11y: true)));
    await openPhoneFold(tester, 'phone-dnd-options');
    expect(find.byKey(const ValueKey('phone-viewport-portrait')), findsNothing);
    expect(find.byKey(const ValueKey('phone-viewport-landscape')), findsNothing);
    expect(h.native!.callsOf('setBackgroundViewport'), isEmpty);
  });
}
