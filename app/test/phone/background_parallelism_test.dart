import 'dart:async';

import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/ui/common/list_page_row.dart';
import 'package:dsh_app/ui/phone/dnd_mode_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'support.dart';

Map<String, Object?> parallelStatus({int configured = 1, int effective = 1, int held = 0, String? reason}) {
  final base = phoneStatus(a11y: true);
  return {
    ...base,
    'parallelLimit': 1,
    'taskProtocol': 1,
    'tasks': [
      {'id': 8, 'active': true, 'backgroundSlot': true},
    ],
    'background': {
      ...(base['background'] as Map),
      'androidOk': true,
      'parallelism': {
        'v': 1,
        'configuredLimit': configured,
        'effectiveLimit': effective,
        'heldSlots': held,
        'reason': reason,
      },
    },
  };
}

void main() {
  testWidgets('modern read failure preserves trusted task facts but hides capacity writes', (tester) async {
    final native = FakePhoneNative(status: {...parallelStatus(), 'statusRevision': 1});
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    await openPhoneFold(tester, 'phone-dnd-options');
    final selector = find.byKey(const ValueKey('phone-background-limit-2'));
    await tester.scrollUntilVisible(selector, 200, scrollable: find.byType(Scrollable).first);
    final oldTap = tester.widget<ListPageRow>(selector).onTap!;
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    native.calls.clear();
    native.onStatus = () async => throw PlatformException(code: 'offline');
    final reply = await containerOf(tester).read(phoneProvider.notifier).setBackgroundParallelLimit(2);
    await settlePhone(tester);
    expect(reply.ok, isTrue);
    expect(phoneOf(tester).status.ready, isFalse);
    expect(phoneOf(tester).status.statusRevision, 1);
    expect(phoneOf(tester).status.tasks.single.id, 8);
    expect(phoneOf(tester).status.tasks.single.backgroundSlot, isTrue);
    expect(
      phoneOf(tester).status.background.parallelism!.configuredLimit,
      1,
      reason: 'This is retained last-known data, not a successful fresh read.',
    );
    expect(selector, findsNothing);
    oldTap();
    await settlePhone(tester);
    expect(native.methods, ['setBackgroundParallelLimit', 'status']);
    native.push({...parallelStatus(configured: 2), 'statusRevision': 2});
    await settlePhone(tester);
    await openPhoneFold(tester, 'phone-dnd-options');
    await tester.scrollUntilVisible(selector, 200, scrollable: find.byType(Scrollable).first);
    expect(phoneOf(tester).status.ready, isTrue);
    expect(tester.widget<ListPageRow>(selector).onTap, isNull);
    expect(native.methods, ['setBackgroundParallelLimit', 'status']);
  });

  testWidgets('a newer push wins over the setters older read without changing its receipt', (tester) async {
    final native = FakePhoneNative(status: {...parallelStatus(), 'statusRevision': 1});
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    await openPhoneFold(tester, 'phone-dnd-options');
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    native.calls.clear();
    final read = Completer<Map<String, Object?>>();
    native.onStatus = () => read.future;
    final pending = containerOf(tester).read(phoneProvider.notifier).setBackgroundParallelLimit(2);
    try {
      await tester.pump();
      expect(native.methods, ['setBackgroundParallelLimit', 'status']);
      native.push({...parallelStatus(configured: 3), 'statusRevision': 3});
      await settlePhone(tester);
      read.complete({...parallelStatus(configured: 2), 'statusRevision': 2});
      final reply = await pending;
      expect(reply.ok, isTrue);
      expect(phoneOf(tester).status.statusRevision, 3);
      expect(phoneOf(tester).status.background.parallelism!.configuredLimit, 3);
      expect(native.methods, ['setBackgroundParallelLimit', 'status']);
    } finally {
      if (!read.isCompleted) read.complete({...parallelStatus(), 'statusRevision': 1});
      await pending;
    }
  });

  test('strict native capacity parsing preserves held slots above the soft limit', () {
    final status = PhoneStatus.fromMap(parallelStatus(configured: 1, effective: 1, held: 3));
    expect(status.background.parallelism!.heldSlots, 3);
    expect(status.background.parallelism!.configuredLimit, 1);
    expect(status.parallelLimit, 1);
    expect(status.tasks.single.backgroundSlot, isTrue);
    final unavailable = PhoneStatus.fromMap(
      parallelStatus(configured: 3, effective: 0, held: 3, reason: 'connectionRequired'),
    );
    expect(unavailable.background.parallelism!.effectiveLimit, 0);
    expect(PhoneTaskStatus.fromMap({}).backgroundSlot, isNull);
    expect(PhoneTaskStatus.fromMap({'backgroundSlot': 1}).backgroundSlot, isFalse);
    expect(PhoneTaskStatus.fromMap({'backgroundSlot': 'true'}).backgroundSlot, isFalse);
  });

  test('unknown or contradictory native capacity never fabricates available slots', () {
    final valid = <String, Object?>{'v': 1, 'configuredLimit': 3, 'effectiveLimit': 2, 'heldSlots': 1, 'reason': null};
    for (final bad in <Object?>[
      null,
      false,
      '1',
      {},
      {...valid, 'v': 1.0},
      {...valid, 'v': 2},
      {...valid, 'configuredLimit': '3'},
      {...valid, 'configuredLimit': 2.0},
      {...valid, 'configuredLimit': 0},
      {...valid, 'configuredLimit': 4},
      {...valid, 'configuredLimit': 1},
      {...valid, 'effectiveLimit': 1.0},
      {...valid, 'effectiveLimit': -1},
      {...valid, 'effectiveLimit': 4},
      {...valid, 'effectiveLimit': 0},
      {...valid, 'reason': 'invented'},
      {...valid, 'reason': true},
      {...valid, 'heldSlots': 0.0},
      {...valid, 'heldSlots': -1},
      {...valid, 'heldSlots': 4},
    ]) {
      expect(BackgroundParallelism.parse(bad), isNull, reason: '$bad');
    }
    for (final reason in [
      'off',
      'unsupported',
      'connectionRequired',
      'busy',
      'transportSerial',
    ]) {
      expect(BackgroundParallelism.parse({...valid, 'effectiveLimit': 0, 'reason': reason}), isNotNull);
    }
    // Removed admission gates: a self-check or an old resource record never zeroes capacity.
    for (final reason in ['resourceRecovery', 'peerUnsupported']) {
      expect(BackgroundParallelism.parse({...valid, 'effectiveLimit': 0, 'reason': reason}), isNull);
    }
  });

  testWidgets('explicit capacity selection saves and refreshes without connecting or operating a task', (tester) async {
    final h = await pumpPhone(
      tester,
      const PhoneDndPage(),
      native: FakePhoneNative(status: parallelStatus(effective: 0, reason: 'off')),
    );
    await openPhoneFold(tester, 'phone-dnd-options');
    expect(h.native!.methods, ['status', 'getPolicies', 'actionLog']);
    h.native!.calls.clear();
    expect(h.native!.callsOf('setBackgroundParallelLimit'), isEmpty);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('phone-background-limit-3')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.byKey(const ValueKey('phone-background-limit-3')));
    await settlePhone(tester);
    expect(h.native!.callsOf('setBackgroundParallelLimit').single.arguments, {'limit': 3});
    final capacity = phoneOf(tester).status.background.parallelism!;
    expect(capacity.configuredLimit, 3);
    expect(capacity.effectiveLimit, 0); // Saving does not create a channel.
    expect(phoneOf(tester).status.tasks.single.backgroundSlot, isTrue);
    expect(h.native!.methods, ['setBackgroundParallelLimit', 'status']);
  });

  testWidgets('failed preference commit keeps the previous capacity selected and displays failure', (tester) async {
    final native = FakePhoneNative(status: parallelStatus())
      ..results['setBackgroundParallelLimit'] = {'ok': false, 'reason': 'Capacity save refused'};
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    await openPhoneFold(tester, 'phone-dnd-options');
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    native.calls.clear();
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('phone-background-limit-2')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.byKey(const ValueKey('phone-background-limit-2')));
    await settlePhone(tester);
    expect(native.callsOf('setBackgroundParallelLimit'), hasLength(1));
    expect(phoneOf(tester).status.background.parallelism!.configuredLimit, 1);
    expect(find.text('Capacity save refused'), findsOneWidget);
    expect(native.methods, ['setBackgroundParallelLimit', 'status']);
  });

  testWidgets('old native or invalid capacity hides selectors and sends no setter', (tester) async {
    final native = FakePhoneNative(status: phoneStatus(a11y: true));
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    await openPhoneFold(tester, 'phone-dnd-options');
    for (final limit in [1, 2, 3]) {
      expect(find.byKey(ValueKey('phone-background-limit-$limit')), findsNothing);
    }
    final next = parallelStatus();
    (next['background'] as Map)['parallelism'] = {'v': 2};
    native.push(next);
    await settlePhone(tester);
    expect(find.byKey(const ValueKey('phone-background-limit-1')), findsNothing);
    expect(native.callsOf('setBackgroundParallelLimit'), isEmpty);
  });

  testWidgets('lower configured limit keeps native occupied count and task slot visible', (tester) async {
    final h = await pumpPhone(
      tester,
      const PhoneDndPage(),
      native: FakePhoneNative(status: parallelStatus(configured: 3, effective: 3, held: 3)),
    );
    await openPhoneFold(tester, 'phone-dnd-options');
    expect(h.native!.methods, ['status', 'getPolicies', 'actionLog']);
    h.native!.calls.clear();
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('phone-background-limit-1')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.byKey(const ValueKey('phone-background-limit-1')));
    await settlePhone(tester);
    final capacity = phoneOf(tester).status.background.parallelism!;
    expect(capacity.configuredLimit, 1);
    expect(capacity.effectiveLimit, 1);
    expect(capacity.heldSlots, 3);
    expect(phoneOf(tester).status.tasks.single.backgroundSlot, isTrue);
    expect(h.native!.methods, ['setBackgroundParallelLimit', 'status']);
  });
  testWidgets('capacity stays busy through the write ACK and its fresh status read', (tester) async {
    final native = FakePhoneNative(status: parallelStatus());
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    await openPhoneFold(tester, 'phone-dnd-options');
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    native.calls.clear();
    final written = Completer<Map<String, Object?>>();
    final read = Completer<Map<String, Object?>?>();
    native.onSetBackgroundParallelLimit = (_) => written.future;
    native.onStatus = () => read.future;
    try {
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('phone-background-limit-3')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const ValueKey('phone-background-limit-3')));
      await tester.pump();
      expect(native.methods, ['setBackgroundParallelLimit']);
      expect(phoneOf(tester).status.background.parallelism!.configuredLimit, 1);
      for (final limit in [1, 2, 3]) {
        expect(tester.widget<ListPageRow>(find.byKey(ValueKey('phone-background-limit-$limit'))).onTap, isNull);
      }
      written.complete({'ok': true});
      await tester.pump();
      expect(native.methods, ['setBackgroundParallelLimit', 'status']);
      expect(phoneOf(tester).status.background.parallelism!.configuredLimit, 1);
      expect(tester.widget<ListPageRow>(find.byKey(const ValueKey('phone-background-limit-2'))).onTap, isNull);
      read.complete(parallelStatus(configured: 3, effective: 3));
      await settlePhone(tester);
      expect(phoneOf(tester).status.background.parallelism!.configuredLimit, 3);
      expect(tester.widget<ListPageRow>(find.byKey(const ValueKey('phone-background-limit-2'))).onTap, isNotNull);
      expect(native.methods, ['setBackgroundParallelLimit', 'status']);
    } finally {
      if (!written.isCompleted) written.complete({'ok': false});
      if (!read.isCompleted) read.complete(null);
      await settlePhone(tester);
    }
  });

  testWidgets('a current limit is not written again', (tester) async {
    final native = FakePhoneNative(status: parallelStatus());
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    await openPhoneFold(tester, 'phone-dnd-options');
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    native.calls.clear();
    expect(tester.widget<ListPageRow>(find.byKey(const ValueKey('phone-background-limit-1'))).onTap, isNull);
    expect(native.methods, isEmpty);
  });

  for (final failure in ['null', 'missingPlugin', 'platform', 'invalidCapacity']) {
    testWidgets('failed save and $failure readback leave capacity unknown', (tester) async {
      final native = FakePhoneNative(status: parallelStatus())
        ..results['setBackgroundParallelLimit'] = {'ok': false, 'reason': 'Capacity save refused'};
      await pumpPhone(tester, const PhoneDndPage(), native: native);
      await openPhoneFold(tester, 'phone-dnd-options');
      expect(native.methods, ['status', 'getPolicies', 'actionLog']);
      native.calls.clear();
      native.onStatus = () async {
        if (failure == 'missingPlugin') throw MissingPluginException();
        if (failure == 'platform') throw PlatformException(code: 'read_failed');
        if (failure == 'invalidCapacity') {
          final invalid = parallelStatus();
          (invalid['background'] as Map)['parallelism'] = {'v': 2};
          return invalid;
        }
        return null;
      };
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('phone-background-limit-2')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const ValueKey('phone-background-limit-2')));
      await settlePhone(tester);
      expect(phoneOf(tester).status.background.parallelism, isNull);
      for (final limit in [1, 2, 3]) {
        expect(find.byKey(ValueKey('phone-background-limit-$limit')), findsNothing);
      }
      expect(find.text('Capacity save refused'), findsOneWidget);
      expect(native.methods, ['setBackgroundParallelLimit', 'status']);
      native.onStatus = null;
      await containerOf(tester).read(phoneProvider.notifier).refreshStatus();
      await tester.pump();
      expect(phoneOf(tester).status.background.parallelism!.configuredLimit, 1);
      expect(native.methods, ['setBackgroundParallelLimit', 'status', 'status']);
    });
  }

  testWidgets('successful write keeps its result when the fresh read is unavailable', (tester) async {
    final native = FakePhoneNative(status: parallelStatus());
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    await openPhoneFold(tester, 'phone-dnd-options');
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    native.calls.clear();
    native.onStatus = () async => null;
    final result = await containerOf(tester).read(phoneProvider.notifier).setBackgroundParallelLimit(3);
    await tester.pump();
    expect(result.ok, isTrue);
    expect(result.reason, isNull);
    expect(phoneOf(tester).status.background.parallelism, isNull);
    expect(find.byKey(const ValueKey('phone-background-limit-3')), findsNothing);
    expect(native.methods, ['setBackgroundParallelLimit', 'status']);
  });
  testWidgets('a disposed provider does not start a readback after the write reply', (tester) async {
    final native = FakePhoneNative(status: parallelStatus());
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    await openPhoneFold(tester, 'phone-dnd-options');
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    native.calls.clear();
    final write = Completer<Map<String, Object?>>();
    native.onSetBackgroundParallelLimit = (_) => write.future;
    final result = containerOf(tester).read(phoneProvider.notifier).setBackgroundParallelLimit(2);
    await tester.pump();
    expect(native.methods, ['setBackgroundParallelLimit']);
    await tester.pumpWidget(const SizedBox.shrink());
    write.complete({'ok': false, 'reason': 'Capacity save refused'});
    final reply = await result;
    expect(reply.ok, isFalse);
    expect(reply.reason, 'Capacity save refused');
    expect(native.methods, ['setBackgroundParallelLimit']);
  });
}
