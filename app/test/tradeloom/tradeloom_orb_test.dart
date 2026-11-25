import 'package:dsh_app/ui/tradeloom/tradeloom_orb.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('orb is a labeled touch target and opens its supplied route', (tester) async {
    var opened = false;
    var remoteOpened = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TradeLoomOrb(
            label: '织贸工作台',
            hint: '跨设备',
            onTap: () => opened = true,
            onLongPress: () => remoteOpened = true,
          ),
        ),
      ),
    );

    expect(find.bySemanticsLabel('织贸工作台'), findsOneWidget);
    expect(tester.getSize(find.byType(TradeLoomOrb)), const Size(56, 56));
    await tester.tap(find.byType(TradeLoomOrb));
    expect(opened, isTrue);
    await tester.longPress(find.byType(TradeLoomOrb));
    expect(remoteOpened, isTrue);
  });
}
