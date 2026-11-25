import 'dart:async';

import 'package:dsh_app/phone/phone_channel.dart';
import 'package:dsh_app/ui/phone/phone_control_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'harness.dart';
import 'support.dart';

const batch = '00000000-0000-4000-8000-000000000001';
Map<String, Object?> interruption({String state = 'ready', int count = 1}) => {
  'version': 1, 'state': state, 'count': count,
  'batchToken': state == 'ready' && count > 0 ? batch : null,
  'error': state == 'error' ? 'writeFailed' : null,
};

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('old native and malformed summaries never invent an acknowledgement token or task', () {
    expect(PhoneStatus.fromMap({}).taskInterruption.visible, isFalse);
    for (final value in [
      {'version': 2},
      {...interruption(), 'count': 1.0},
      {...interruption(), 'batchToken': 'wrong'},
      {...interruption(), 'error': 'loadFailed'},
      {...interruption(state: 'error'), 'batchToken': batch},
    ]) {
      final status = PhoneStatus.fromMap({'taskInterruption': value});
      expect(status.taskInterruption.canAcknowledge, isFalse);
      expect(status.tasks, isEmpty); expect(status.task.active, isFalse);
    }
    final status = PhoneStatus.fromMap({'taskInterruption': interruption()});
    expect(status.taskInterruption.canAcknowledge, isTrue);
    expect(status.copyWith(enabled: true).taskInterruption.batchToken, batch);
    expect(status.tasks, isEmpty);
  });

  testWidgets('notice acknowledges only the captured batch and never resumes or replays work', (tester) async {
    final native = FakePhoneNative(status: {...phoneStatus(), 'taskInterruption': interruption()});
    native.onAcknowledgeInterruption = (token) async {
      expect(token, batch);
      native.status = {...native.status, 'taskInterruption': interruption(count: 0)};
      return true;
    };
    await pumpPhone(tester, const PhoneControlScreen(), native: native);
    expect(find.byKey(const ValueKey('phone-task-interruption')), findsOneWidget);
    await tester.tap(find.text('已核对中断提示')); await settlePhone(tester);
    expect(native.callsOf('acknowledgeTaskInterruption').single.arguments, {'batchToken': batch});
    expect(find.byKey(const ValueKey('phone-task-interruption')), findsNothing);
    for (final forbidden in ['resumeTask', 'stopTask', 'testScreen', 'setBackgroundMode']) {
      expect(native.callsOf(forbidden), isEmpty);
    }
  });

  testWidgets('pending or failed acknowledgement keeps the notice and prevents duplicate sends', (tester) async {
    final reply = Completer<bool>();
    final native = FakePhoneNative(status: {...phoneStatus(), 'taskInterruption': interruption()});
    native.onAcknowledgeInterruption = (_) => reply.future;
    await pumpPhone(tester, const PhoneControlScreen(), native: native);
    await tester.tap(find.text('已核对中断提示')); await tester.pump();
    await tester.tap(find.text('已核对中断提示')); await tester.pump();
    expect(native.callsOf('acknowledgeTaskInterruption').length, 1);
    expect(find.byKey(const ValueKey('phone-task-interruption')), findsOneWidget);
    reply.complete(false); await settlePhone(tester);
    expect(find.byKey(const ValueKey('phone-task-interruption')), findsOneWidget);
    expect(find.text('任务记录尚未确认，请重试'), findsOneWidget);
  });

  testWidgets('storage error invokes a real retry and loading cannot acknowledge', (tester) async {
    final native = FakePhoneNative(status: {...phoneStatus(), 'taskInterruption': interruption(state: 'loading', count: 0)});
    native.onRetryInterruption = () async {
      native.status = {...native.status, 'taskInterruption': interruption()};
      return true;
    };
    await pumpPhone(tester, const PhoneControlScreen(), native: native);
    expect(find.byKey(const ValueKey('phone-task-interruption-action')), findsNothing);
    native.push({...native.status, 'taskInterruption': interruption(state: 'error')});
    await settlePhone(tester);
    await tester.tap(find.text('重试保存或读取')); await settlePhone(tester);
    expect(native.callsOf('retryTaskInterruptionStorage').length, 1);
    expect(native.callsOf('acknowledgeTaskInterruption'), isEmpty);
    expect(find.text('已核对中断提示'), findsOneWidget);
  });
}
