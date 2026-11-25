import 'package:dsh_app/state/voice_state.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/chat/voice/voice_bridge.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../chat/support/composer_fakes.dart';
import '../support/test_fonts.dart';

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('the box takes dictation, and what is heard is sent as a line', (tester) async {
    final bridge = FakeVoiceBridge();
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await tavern.createChat('sample-innkeeper');
    final container = ProviderContainer(
      overrides: [tavernProvider.overrideWith((ref) => tavern), voiceBridgeProvider.overrideWithValue(bridge)],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
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

    // An empty box offers the mic in place of send.
    expect(find.byIcon(AppIcons.voice), findsOneWidget);
    await tester.tap(find.byIcon(AppIcons.voice));
    await _settle(tester);
    expect(bridge.calls, ['permission', 'recognizer']);
    expect(container.read(voiceInputActiveProvider), isTrue);

    bridge.emit(const VoicePartial('外面'));
    await tester.pump();
    expect(find.widgetWithText(TextField, '外面'), findsOneWidget);
    bridge.emit(const VoiceFinal('外面怎么了？'));
    await _settle(tester);
    expect(container.read(voiceInputActiveProvider), isFalse);
    expect(find.widgetWithText(TextField, '外面怎么了？'), findsOneWidget);

    await tester.tap(find.byIcon(AppIcons.send));
    for (var i = 0; i < 200; i++) {
      await tester.pump(const Duration(milliseconds: 5));
    }
    await tester.pumpAndSettle();
    expect((await tavern.path(chat)).map((m) => m.text), contains('外面怎么了？'));
  });

  testWidgets('leaving while dictating stops it', (tester) async {
    final bridge = FakeVoiceBridge();
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await tavern.createChat('sample-innkeeper');
    final container = ProviderContainer(
      overrides: [tavernProvider.overrideWith((ref) => tavern), voiceBridgeProvider.overrideWithValue(bridge)],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
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
    await tester.tap(find.byIcon(AppIcons.voice));
    await _settle(tester);
    expect(container.read(voiceInputActiveProvider), isTrue);

    await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const SizedBox()));
    await _settle(tester);
    expect(bridge.calls.last, 'cancel');
    expect(container.read(voiceInputActiveProvider), isFalse);
  });
}
