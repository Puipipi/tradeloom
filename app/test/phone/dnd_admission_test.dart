import 'package:dsh_app/ui/phone/dnd_mode_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'support.dart';

/// A connected, authorized Shizuku channel; [extra] adds raw native `background` fields.
Map<String, Object?> connectedStatus([Map<String, Object?> extra = const {}]) {
  final base = privilegedStatus(
    mode: 'shizuku',
    ready: true,
    provider: 'shizuku',
    shizukuApp: true,
    running: true,
    granted: true,
  );
  return {
    ...base,
    'background': {...(base['background'] as Map).cast<String, Object?>(), ...extra},
  };
}

void main() {
  testWidgets('fields of the removed self-check, cleanup and recovery gates show nothing and block nothing', (tester) async {
    final native = FakePhoneNative(
      status: connectedStatus({
        'gateCleanup': {'v': 1, 'state': 'unknown', 'canRetry': true, 'handle': 'old'},
        'resourceRecovery': {'v': 1, 'state': 'pending', 'count': 2, 'canRetry': true},
        // An older native build's self-check note: choosing a channel no longer runs that probe.
        'selfCheckWarning': 'Self-check did not pass',
        'trustedDisplay': false,
        'inject': false,
      }),
    );
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    expect(find.text('Self-check did not pass'), findsNothing);
    expect(find.byKey(const ValueKey('phone-gate-cleanup')), findsNothing);
    expect(find.byKey(const ValueKey('phone-resource-recovery')), findsNothing);
    expect(find.byKey(const ValueKey('phone-dnd-self-check-warning')), findsNothing);
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
  });
}
