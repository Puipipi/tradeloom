import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/ui/safe_mode/recovery_actions.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/test_fonts.dart';

void main() {
  setUp(() => AppLocale.use(AppLocale.en));
  tearDown(() => AppLocale.use(AppLocale.zhCN));

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.3, 2.0]) {
      testWidgets('recovery labels remain complete at 320dp / $brightness / $scale', (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(320, 960);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            theme: withTestFonts(brightness == Brightness.dark ? buildDarkTheme() : buildLightTheme()),
            home: Scaffold(
              body: MediaQuery(
                data: MediaQueryData(textScaler: TextScaler.linear(scale)),
                child: SingleChildScrollView(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: RecoveryActions(
                      primaryLabel: appL10n.phoneFailureRestore,
                      onPrimary: () {},
                      secondary: [
                        (label: appL10n.phoneFailureEnterSafe, onPressed: () {}),
                        (label: appL10n.phoneFailureStartNormal, onPressed: () {}),
                      ],
                      onLog: () {},
                      onExport: () {},
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        for (final element in tester.elementList(find.byType(RichText))) {
          final paragraph = element.renderObject;
          if (paragraph is RenderParagraph) {
            expect(paragraph.didExceedMaxLines, isFalse, reason: paragraph.text.toPlainText());
          }
        }
        for (final type in [FilledButton, OutlinedButton, TextButton]) {
          for (final element in tester.elementList(find.byType(type))) {
            final rect = tester.getRect(find.byElementPredicate((e) => identical(e, element)));
            expect(rect.height, greaterThanOrEqualTo(48));
            expect(rect.left, closeTo(320 - rect.right, .5));
          }
        }
        expect(tester.takeException(), isNull);
      });
    }
  }
}
