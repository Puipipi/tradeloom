import 'package:dsh_app/ui/safe_mode/recovery_actions.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Future<void> pump(
    WidgetTester tester, {
    required double width,
    required double scale,
    required List<String> secondary,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = Size(width, 900);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildLightTheme(),
        home: Scaffold(
          body: MediaQuery(
            data: MediaQueryData(textScaler: TextScaler.linear(scale)),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('故障原因', key: ValueKey('body')),
                  RecoveryActions(
                    primaryLabel: '帮我修复',
                    onPrimary: () {},
                    secondary: [for (final label in secondary) (label: label, onPressed: () {})],
                    onLog: () {},
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  /// Every button 50 tall and inside the body's edges, rows 8 apart, side-by-side
  /// buttons equal and 8 apart, a lone button full width, the log centred.
  void expectLayout(WidgetTester tester, {required double width, required List<String> secondary}) {
    final body = tester.getRect(find.byKey(const ValueKey('body')));
    final primary = tester.getRect(find.widgetWithText(FilledButton, '帮我修复'));
    final buttons = [for (final label in secondary) tester.getRect(find.widgetWithText(OutlinedButton, label))];
    final log = tester.getRect(find.widgetWithText(TextButton, '查看日志'));
    for (final rect in [primary, ...buttons, log]) {
      expect(rect.height, 50);
    }
    expect(primary.left, closeTo(body.left, .5));
    expect(primary.right, closeTo(body.right, .5));

    // Group the secondaries into rows by their top edge.
    final rows = <List<Rect>>[];
    for (final rect in buttons) {
      if (rows.isNotEmpty && (rows.last.first.top - rect.top).abs() < .5) {
        rows.last.add(rect);
      } else {
        rows.add([rect]);
      }
    }
    final paired = rows.any((row) => row.length == 2);
    for (final (i, row) in rows.indexed) {
      expect(row.length, lessThanOrEqualTo(2));
      expect(row.first.left, closeTo(body.left, .5));
      expect(row.last.right, closeTo(body.right, .5));
      if (row.length == 2) {
        expect(row[0].width, closeTo(row[1].width, .5));
        expect(row[1].left - row[0].right, closeTo(RecoveryActions.gap, .5));
      }
      // Pairs first; only the last row may hold one button.
      if (paired && i < rows.length - 1) expect(row.length, 2);
    }

    // Even vertical rhythm: primary, each row, the log, all 8 apart.
    final tops = [primary, for (final row in rows) row.first, log];
    for (var i = 1; i < tops.length; i++) {
      expect(tops[i].top - tops[i - 1].bottom, closeTo(RecoveryActions.gap, .5));
    }
    expect(log.center.dx, closeTo(width / 2, .5));
    for (final label in ['帮我修复', ...secondary]) {
      expect(tester.widget<Text>(find.text(label)).maxLines, 1);
    }
    expect(tester.takeException(), isNull);
  }

  for (final (width, scale) in [(390.0, 1.0), (360.0, 1.3), (304.0, 1.0)]) {
    for (final secondary in [
      ['进入安全模式', '重试'],
      ['正常启动', '恢复配置', '移开补丁'],
    ]) {
      testWidgets('recovery actions align at $width / $scale with ${secondary.length}', (tester) async {
        await pump(tester, width: width, scale: scale, secondary: secondary);
        expectLayout(tester, width: width, secondary: secondary);
      });
    }
  }

  testWidgets('three short secondaries: a pair, then one full width', (tester) async {
    const secondary = ['正常启动', '恢复配置', '移开补丁'];
    await pump(tester, width: 390, scale: 1, secondary: secondary);
    final a = tester.getRect(find.widgetWithText(OutlinedButton, '正常启动'));
    final b = tester.getRect(find.widgetWithText(OutlinedButton, '恢复配置'));
    final c = tester.getRect(find.widgetWithText(OutlinedButton, '移开补丁'));
    expect(a.top, closeTo(b.top, .5));
    expect(c.top, greaterThan(a.bottom));
    expect(c.width, closeTo(390 - 32, .5));
  });
}
