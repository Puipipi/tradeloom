import 'package:dsh_app/ui/phone/background_preview.dart';
import 'package:dsh_app/ui/common/list_page_row.dart';
import 'package:dsh_app/ui/phone/dnd_mode_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'support.dart';

Map<String, Object?> _status({bool modern = true}) {
  final base = phoneStatus(mode: 'adb', backgroundReady: true, taskActive: true, taskId: 7);
  return {
    ...base,
    'taskProtocol': 1,
    'selectedTaskId': 9,
    'tasks': [
      {'id': 7, 'active': true, if (modern) 'backgroundSlot': true, 'app': 'First'},
      {'id': 8, 'active': true, if (modern) 'backgroundSlot': true, 'app': 'Second'},
      {'id': 9, 'active': true, if (modern) 'backgroundSlot': false, 'app': 'Main'},
      {'id': 10, 'active': false, if (modern) 'backgroundSlot': true, 'cleanupFailed': true},
    ],
    'background': {
      ...(base['background'] as Map),
      'preview': {'v': 1, 'enabled': true},
      if (modern) 'parallelism': {
        'v': 1, 'configuredLimit': 3, 'effectiveLimit': 3, 'heldSlots': 3, 'reason': null,
      },
    },
  };
}

void main() {
  testWidgets('a stale holder callback cannot open a retired preview', (tester) async {
    final native = FakePhoneNative(status: _status());
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    final holder = find.byKey(const ValueKey('phone-preview-task-8'));
    await tester.scrollUntilVisible(holder, 200, scrollable: find.byType(Scrollable).first);
    final open = tester.widget<ListPageRow>(holder).onTap!;
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    native.calls.clear();
    final retired = _status();
    retired['tasks'] = [
      {'id': 7, 'active': true, 'backgroundSlot': true},
      {'id': 8, 'active': false, 'backgroundSlot': true},
      {'id': 9, 'active': true, 'backgroundSlot': false},
    ];
    native.push(retired);
    await settlePhone(tester);
    open();
    await settlePhone(tester);
    expect(find.byType(PhoneBackgroundPreviewDialog), findsNothing);
    expect(native.methods, isEmpty);
  });

  testWidgets('preview selection follows actual active BG holders, not the latest executing task', (tester) async {
    final h = await pumpPhone(tester, const PhoneDndPage(), native: FakePhoneNative(status: _status()));
    expect(h.native!.methods, ['status', 'getPolicies', 'actionLog']);
    h.native!.calls.clear();
    expect(find.byKey(const ValueKey('phone-preview-task-7')), findsOneWidget);
    expect(find.byKey(const ValueKey('phone-preview-task-8')), findsOneWidget);
    expect(find.byKey(const ValueKey('phone-preview-task-9')), findsNothing);
    expect(find.byKey(const ValueKey('phone-preview-task-10')), findsNothing);
    await tester.scrollUntilVisible(find.byKey(const ValueKey('phone-preview-task-8')), 200,
        scrollable: find.byType(Scrollable).first);
    await tester.tap(find.byKey(const ValueKey('phone-preview-task-8')));
    await settlePhone(tester);
    expect(tester.widget<PhoneBackgroundPreviewDialog>(find.byType(PhoneBackgroundPreviewDialog)).taskId, 8);
    expect(h.native!.methods, isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    await settlePhone(tester);
  });

  testWidgets('an old native module keeps the original single selected task entry', (tester) async {
    await pumpPhone(tester, const PhoneDndPage(), native: FakePhoneNative(status: _status(modern: false)));
    expect(find.byKey(const ValueKey('phone-preview-task-9')), findsOneWidget);
    expect(find.byKey(const ValueKey('phone-preview-task-7')), findsNothing);
    expect(find.byKey(const ValueKey('phone-preview-task-8')), findsNothing);
  });
  testWidgets('temporarily missing capacity never selects a MAIN task for preview', (tester) async {
    final native = FakePhoneNative(status: _status());
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    native.calls.clear();
    final stale = _status();
    (stale['background'] as Map).remove('parallelism');
    native.push(stale);
    await settlePhone(tester);
    expect(find.byKey(const ValueKey('phone-background-limit-1')), findsNothing);
    expect(find.byKey(const ValueKey('phone-preview-task-7')), findsOneWidget);
    expect(find.byKey(const ValueKey('phone-preview-task-8')), findsOneWidget);
    expect(find.byKey(const ValueKey('phone-preview-task-9')), findsNothing);
    await tester.scrollUntilVisible(find.byKey(const ValueKey('phone-preview-task-8')), 200,
        scrollable: find.byType(Scrollable).first);
    await tester.tap(find.byKey(const ValueKey('phone-preview-task-8')));
    await settlePhone(tester);
    expect(tester.widget<PhoneBackgroundPreviewDialog>(find.byType(PhoneBackgroundPreviewDialog)).taskId, 8);
    expect(native.methods, isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    await settlePhone(tester);
  });

  testWidgets('mixed missing and malformed slot metadata grants only explicit true', (tester) async {
    final status = _status();
    (status['background'] as Map).remove('parallelism');
    status['tasks'] = [
      {'id': 7, 'active': true, 'backgroundSlot': 'true'},
      {'id': 8, 'active': true, 'backgroundSlot': true},
      {'id': 9, 'active': true},
      {'id': 10, 'active': false, 'backgroundSlot': true},
    ];
    final native = FakePhoneNative(status: status);
    await pumpPhone(tester, const PhoneDndPage(), native: native);
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
    expect(find.byKey(const ValueKey('phone-preview-task-8')), findsOneWidget);
    for (final id in [7, 9, 10]) {
      expect(find.byKey(ValueKey('phone-preview-task-$id')), findsNothing);
    }
    status['tasks'] = [
      {'id': 7, 'active': true, 'backgroundSlot': null},
      {'id': 9, 'active': true, 'backgroundSlot': 1},
    ];
    native.push(status);
    await settlePhone(tester);
    for (final id in [7, 8, 9, 10]) {
      expect(find.byKey(ValueKey('phone-preview-task-$id')), findsNothing);
    }
    expect(native.methods, ['status', 'getPolicies', 'actionLog']);
  });
}
