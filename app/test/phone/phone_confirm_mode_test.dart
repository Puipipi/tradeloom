import 'package:dsh_app/phone/phone_channel.dart';
import 'package:dsh_app/ui/common/app_sheet.dart';
import 'package:dsh_app/ui/common/risk_notice.dart';
import 'package:dsh_app/ui/phone/phone_control_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';
import 'support.dart';

Future<void> openPicker(WidgetTester tester) async {
  await tester.ensureVisible(find.text('确认方式'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('确认方式'));
  await tester.pumpAndSettle();
}

Object? sentMode(FakePhoneNative native) => (native.callsOf('setPolicies').single.arguments as Map)['confirmMode'];

void main() {
  testWidgets('three modes; 始终免确认 warns first and 取消 changes nothing', (tester) async {
    final h = await pumpPhone(tester, const PhoneControlScreen());
    expect(find.text('每次都询问'), findsOneWidget);

    await openPicker(tester);
    for (final label in ['每次都询问', '本任务免确认', '始终免确认']) {
      expect(find.descendant(of: find.byType(BottomSheet), matching: find.text(label)), findsOneWidget);
    }
    // Under the three: what stays with you whichever is picked (test/phone/phone_unlock_test.dart).
    final yours = find.descendant(of: find.byType(BottomSheet), matching: find.text('这些由你来操作'));
    expect(yours, findsOneWidget);
    // Its group title sits on the column of the sheet's group titles.
    final title = find.descendant(of: find.byType(BottomSheet), matching: find.text('确认方式'));
    expect(tester.getTopLeft(yours).dx, greaterThan(tester.getTopLeft(title).dx));
    await tester.tap(find.text('始终免确认'));
    await tester.pumpAndSettle();
    // The every-time risk notice: no 「不再提示」, the action named on its key.
    expect(find.byType(RiskNoticeSheet), findsOneWidget);
    expect(find.text('始终免确认？'), findsOneWidget);
    expect(find.text('打开 App、点按、发送、删除都直接做，不再问你。'), findsOneWidget);
    expect(find.byType(Checkbox), findsNothing);
    expect(find.text('不确定？问 AI'), findsOneWidget);
    await tester.tap(find.descendant(of: find.byType(SheetHeader), matching: find.byType(SheetIconButton)));
    await tester.pumpAndSettle();
    expect(h.native!.callsOf('setPolicies'), isEmpty);

    await openPicker(tester);
    await tester.tap(find.text('始终免确认'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('risk-confirm')));
    await tester.pumpAndSettle();
    expect(sentMode(h.native!), 'always');
    // The lists go along unchanged.
    expect((h.native!.callsOf('setPolicies').single.arguments as Map)['denyPackages'], isNotEmpty);
    expect(find.text('始终免确认'), findsOneWidget);
    expect(find.text('从不询问，直接操作'), findsNothing);
  });

  testWidgets('本任务免确认 needs no warning (each task still asks once)', (tester) async {
    final h = await pumpPhone(tester, const PhoneControlScreen());
    await openPicker(tester);
    await tester.tap(find.text('本任务免确认'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byType(RiskNoticeSheet), findsNothing);
    expect(sentMode(h.native!), 'task');
    expect(find.text('本任务免确认'), findsOneWidget);
  });

  testWidgets('going stricter needs no warning', (tester) async {
    final native = FakePhoneNative(policies: {...defaultPolicies(), 'confirmMode': 'always'});
    await pumpPhone(tester, const PhoneControlScreen(), native: native);
    await openPicker(tester);
    await tester.tap(find.text('每次都询问'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byType(RiskNoticeSheet), findsNothing);
    expect(sentMode(native), 'ask');
  });

  testWidgets('a waived task says so on its card', (tester) async {
    await pumpPhone(
      tester,
      const PhoneControlScreen(),
      native: FakePhoneNative(status: phoneStatus(a11y: true, taskActive: true, taskApp: '高德地图', taskWaived: true)),
    );
    expect(find.text('正在操作「高德地图」'), findsOneWidget);
    expect(find.text('本任务免确认 · 悬浮条上也能暂停或停止'), findsOneWidget);
  });

  test('wire: unknown or missing modes read as 每次都询问', () {
    expect(PhonePolicies.fromMap({}).confirmMode, PhoneConfirmMode.ask);
    expect(PhonePolicies.fromMap({'confirmMode': 'yolo'}).confirmMode, PhoneConfirmMode.ask);
    expect(PhonePolicies.fromMap({'confirmMode': 'task'}).confirmMode, PhoneConfirmMode.task);
    final p = PhonePolicies.fromMap({
      'denyPackages': ['a.b'],
      'confirmMode': 'always',
    });
    expect(p.withRule('c.d', AppRule.deny).confirmMode, PhoneConfirmMode.always);
    expect(p.toWire()['confirmMode'], 'always');
    expect(PhoneDecision.parse('confirmed-task'), PhoneDecision.allowed);
  });
}
