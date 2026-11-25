import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

void main() {
  testWidgets('酒馆设置 keeps the model and thinking', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          theme: withTestFonts(buildLightTheme()),
          locale: const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: const TavernSettingsPage(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('未填'), findsOneWidget);
    await tester.tap(find.text('V4 Pro'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-thinking')));
    await tester.pumpAndSettle();

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(TavernSettingsController.modelKey), 'deepseek-v4-pro');
    expect(prefs.getBool(TavernSettingsController.thinkingKey), isTrue);
  });
}
