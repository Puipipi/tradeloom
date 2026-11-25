import 'package:dsh_app/ui/common/brief_notice.dart';
import 'package:dsh_app/ui/tavern/tavern_toasts.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<ScaffoldMessengerState> _messenger(WidgetTester tester) async {
  await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox.expand())));
  return tester.state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger));
}

final _toast = find.byKey(const ValueKey('tavern-canvas-toast'));

void main() {
  testWidgets("a card's toastr is the app's notice; a second takes the first one's place", (tester) async {
    final messenger = await _messenger(tester);
    final toasts = TavernToasts();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '   '});
    await tester.pump();
    expect(_toast, findsNothing);

    toasts.show(messenger, {'type': 'toast', 'level': 'success', 'title': '存档', 'message': '已保存'});
    await tester.pumpAndSettle();
    expect(_toast, findsOneWidget);
    expect(find.text('存档\n已保存'), findsOneWidget);
    // The title is the heading.
    final words = tester.widget<Text>(find.byKey(const ValueKey('tavern-canvas-toast-text'))).textSpan! as TextSpan;
    expect((words.children!.first as TextSpan).style?.fontWeight, FontWeight.w600);
    expect((words.children!.last as TextSpan).style, isNull);

    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '又一条'});
    await tester.pump();
    expect(_toast, findsOneWidget);
    expect(find.text('又一条'), findsOneWidget);
    expect(find.text('存档\n已保存'), findsNothing);

    // A tap puts it away; the next is a new notice.
    await tester.tap(find.text('又一条'));
    await tester.pumpAndSettle();
    expect(_toast, findsNothing);
    toasts.show(messenger, {'type': 'toast', 'level': 'error', 'title': '出错', 'message': ''});
    await tester.pumpAndSettle();
    expect(find.text('出错'), findsOneWidget);
    // An error stays up four seconds.
    await tester.pump(const Duration(milliseconds: 3500));
    expect(find.text('出错'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(_toast, findsNothing);
    toasts.dispose();
  });

  testWidgets('the card puts its notice away: the call that showed it, or with none named whichever is up', (
    tester,
  ) async {
    final messenger = await _messenger(tester);
    final toasts = TavernToasts();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '加载中', 'id': 1});
    await tester.pumpAndSettle();
    expect(find.text('加载中'), findsOneWidget);
    // Another call's number: not this one.
    toasts.clear({'type': 'toastClear', 'id': 7});
    await tester.pumpAndSettle();
    expect(find.text('加载中'), findsOneWidget);
    toasts.clear({'type': 'toastClear', 'id': 1});
    await tester.pumpAndSettle();
    expect(_toast, findsNothing);

    // Its words replaced by a later call: clearing the first leaves them.
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '第一句', 'id': 2});
    toasts.show(messenger, {'type': 'toast', 'level': 'success', 'title': '', 'message': '第二句', 'id': 3});
    await tester.pumpAndSettle();
    toasts.clear({'type': 'toastClear', 'id': 2});
    await tester.pumpAndSettle();
    expect(find.text('第二句'), findsOneWidget);
    toasts.clear({'type': 'toastClear', 'id': null});
    await tester.pumpAndSettle();
    expect(_toast, findsNothing);

    // Put away, then new words before it went: they stay their time.
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '旧的', 'id': 4});
    await tester.pumpAndSettle();
    toasts.clear({'type': 'toastClear', 'id': 4});
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '新的', 'id': 5});
    await tester.pumpAndSettle();
    expect(find.text('新的'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1500));
    expect(find.text('新的'), findsOneWidget);
    toasts.dispose();
  });

  testWidgets("put away while waiting behind the app's own: it never stays up", (tester) async {
    final messenger = await _messenger(tester);
    final toasts = TavernToasts();
    messenger.showBriefNotice('已复制');
    await tester.pumpAndSettle();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '加载中', 'id': 1});
    toasts.clear({'type': 'toastClear', 'id': null});
    await tester.pump();
    expect(find.text('已复制'), findsOneWidget);

    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('已复制'), findsNothing);
    expect(_toast, findsNothing);
    // And the next is a notice of its own.
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '好了', 'id': 2});
    await tester.pumpAndSettle();
    expect(find.text('好了'), findsOneWidget);
    toasts.dispose();
  });

  testWidgets("the app's own notice is not put away for one: it waits its turn", (tester) async {
    final messenger = await _messenger(tester);
    final toasts = TavernToasts();
    messenger.showBriefNotice('已复制');
    await tester.pumpAndSettle();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '卡说话了'});
    await tester.pump();
    expect(find.text('已复制'), findsOneWidget);
    expect(_toast, findsNothing);

    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('已复制'), findsNothing);
    expect(find.text('卡说话了'), findsOneWidget);
    toasts.dispose();
  });

  testWidgets('done with while one is up: it reads its words until it goes', (tester) async {
    final messenger = await _messenger(tester);
    final toasts = TavernToasts();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '还在'});
    await tester.pumpAndSettle();
    toasts.dispose();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '不再'});
    await tester.pump();
    expect(find.text('还在'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(_toast, findsNothing);
    toasts.dispose();
  });

  testWidgets('new words on a notice about to go: they get their own time to be read', (tester) async {
    final messenger = await _messenger(tester);
    final toasts = TavernToasts();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '好'});
    await tester.pumpAndSettle();
    await tester.pump(const Duration(milliseconds: 1500));
    toasts.show(messenger, {'type': 'toast', 'level': 'warning', 'title': '小心', 'message': '前面有人'});
    await tester.pump();
    // Past the first one's two seconds, the warning is still up.
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('小心\n前面有人'), findsOneWidget);
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    expect(_toast, findsNothing);
    toasts.dispose();
  });

  testWidgets('new words while one is on its way out: a notice of their own, not gone with it', (tester) async {
    final messenger = await _messenger(tester);
    final toasts = TavernToasts();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '走了'});
    await tester.pumpAndSettle();
    await tester.tap(find.text('走了'));
    await tester.pump();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '又来'});
    await tester.pumpAndSettle();
    expect(find.text('又来'), findsOneWidget);
    await tester.pump(const Duration(seconds: 7));
    await tester.pumpAndSettle();
    expect(_toast, findsNothing);
    toasts.dispose();
  });

  testWidgets('new words just as one runs out of time: a notice of their own, up for their own time', (tester) async {
    final messenger = await _messenger(tester);
    final toasts = TavernToasts();
    toasts.show(messenger, {'type': 'toast', 'level': 'info', 'title': '', 'message': '好'});
    await tester.pumpAndSettle();
    // Its two seconds are up: it starts to go.
    await tester.pump(const Duration(milliseconds: 2050));
    await tester.pump(const Duration(milliseconds: 50));
    toasts.show(messenger, {'type': 'toast', 'level': 'warning', 'title': '小心', 'message': '前面有人'});
    await tester.pumpAndSettle();
    expect(find.text('小心\n前面有人'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('小心\n前面有人'), findsOneWidget);
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    expect(_toast, findsNothing);
    toasts.dispose();
  });
}
