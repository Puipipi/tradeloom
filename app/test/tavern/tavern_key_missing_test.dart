import 'package:dsh_app/tavern/deferred_tavern.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/onboarding/api_key_page.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The chat on a real (deferred) engine, not the preview, with or without a
/// DeepSeek key stored.
Future<void> _open(WidgetTester tester, {required bool key, bool preview = false}) async {
  SharedPreferences.setMockInitialValues({});
  FlutterSecureStorage.setMockInitialValues(key ? {'deepseek_api_key': 'sk-test'} : {});
  final inner = PreviewTavern(tick: Duration.zero);
  final chat = (await tester.runAsync(() => inner.createChat('sample-innkeeper')))!;
  final Tavern tavern = preview ? inner : DeferredTavern(Future.value(inner));
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [tavernProvider.overrideWith((ref) => tavern)],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: TavernChatPage(chatId: chat),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('without a key, the chat says so before the first line, and where it goes', (tester) async {
    await _open(tester, key: false);
    expect(find.byKey(const ValueKey('tavern-key-missing')), findsOneWidget);
    await tester.tap(find.text('去填写'));
    await tester.pumpAndSettle();
    expect(find.byType(ApiKeyPage), findsOneWidget);
  });

  testWidgets('with a key there is nothing to say', (tester) async {
    await _open(tester, key: true);
    expect(find.byKey(const ValueKey('tavern-key-missing')), findsNothing);
  });

  testWidgets('the preview needs no key', (tester) async {
    await _open(tester, key: false, preview: true);
    expect(find.byKey(const ValueKey('tavern-key-missing')), findsNothing);
    expect(find.text('填好 Key 就能开始'), findsNothing);
  });

  testWidgets('without a key the box says to add one, and sending goes there, the line kept', (tester) async {
    await _open(tester, key: false);
    expect(find.text('填好 Key 就能开始'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '你好');
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('发送'));
    await tester.pumpAndSettle();
    expect(find.byType(ApiKeyPage), findsOneWidget);
    Navigator.of(tester.element(find.byType(ApiKeyPage))).pop();
    await tester.pumpAndSettle();
    expect(find.text('你好'), findsOneWidget);
  });

  testWidgets('with a key the box invites a line as before', (tester) async {
    await _open(tester, key: true);
    expect(find.text('填好 Key 就能开始'), findsNothing);
    expect(find.text('对林晚说…'), findsOneWidget);
  });
}
