import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, its replies ending for [finishReason], or failing as [failure].
class _Ending extends PreviewTavern {
  _Ending({this.finishReason, this.failure, this.detail, this.toolCode}) : super(tick: Duration.zero);

  final String? finishReason;
  final TavernFailure? failure;
  final String? detail;
  final String? toolCode;
  final continued = <String>[];
  final regenerated = <String>[];

  @override
  Stream<TavernEvent> send(String chatId, String text) {
    if (failure case final kind?) {
      return Stream.value(TavernTurnFailed(kind, detail: detail, toolFailureCode: toolCode));
    }
    return super
        .send(chatId, text)
        .map((e) => e is TavernTurnDone ? TavernTurnDone(e.message, finishReason: finishReason) : e);
  }

  @override
  Stream<TavernEvent> continueReply(String chatId, String nodeId) {
    continued.add(nodeId);
    return super.continueReply(chatId, nodeId);
  }

  @override
  Stream<TavernEvent> regenerate(String chatId, String nodeId) {
    regenerated.add(nodeId);
    return super.regenerate(chatId, nodeId);
  }
}

Future<void> _sendOneLine(WidgetTester tester, PreviewTavern tavern) async {
  SharedPreferences.setMockInitialValues({});
  final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
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
  await tester.enterText(find.byType(TextField), '外面怎么了？');
  await tester.pump();
  await tester.tap(find.byIcon(AppIcons.send));
  for (var i = 0; i < 100; i++) {
    await tester.pump(const Duration(milliseconds: 5));
  }
  await tester.pumpAndSettle();
}

Finder _inBanner(String text) =>
    find.descendant(of: find.byKey(const ValueKey('tavern-error')), matching: find.textContaining(text));

/// How a reply ended, said without alarm.
Finder _inNotice(String text) =>
    find.descendant(of: find.byKey(const ValueKey('tavern-notice')), matching: find.textContaining(text));

/// The notice's button, by its exact label (the message may say the same words).
Finder _button(String label) =>
    find.descendant(of: find.byKey(const ValueKey('tavern-notice')), matching: find.text(label));

void main() {
  testWidgets('a reply cut off at the reply limit says so, and 接着写 carries it on', (tester) async {
    final tavern = _Ending(finishReason: 'length');
    await _sendOneLine(tester, tavern);
    expect(_inNotice('回复上限'), findsOneWidget);
    // Not an error: no red banner.
    expect(find.byKey(const ValueKey('tavern-error')), findsNothing);
    await tester.tap(_button('接着写'));
    await tester.pump();
    expect(tavern.continued, hasLength(1));
    await tester.pumpAndSettle();
  });

  testWidgets('a reply the filter stopped says so, and 重新生成 tries again', (tester) async {
    final tavern = _Ending(finishReason: 'content_filter');
    await _sendOneLine(tester, tavern);
    expect(_inNotice('内容过滤'), findsOneWidget);
    await tester.tap(_button('重新生成'));
    await tester.pump();
    expect(tavern.regenerated, hasLength(1));
    await tester.pumpAndSettle();
  });

  testWidgets('a reply that ended as usual says nothing', (tester) async {
    await _sendOneLine(tester, _Ending(finishReason: 'stop'));
    expect(find.byKey(const ValueKey('tavern-error')), findsNothing);
    expect(find.byKey(const ValueKey('tavern-notice')), findsNothing);
  });

  testWidgets('the notice can be put away', (tester) async {
    await _sendOneLine(tester, _Ending(finishReason: 'length'));
    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('tavern-notice')), matching: find.byIcon(AppIcons.close)),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-notice')), findsNothing);
  });

  testWidgets('too little balance says so', (tester) async {
    await _sendOneLine(tester, _Ending(failure: TavernFailure.insufficientBalance));
    expect(_inBanner('余额不足'), findsOneWidget);
  });

  testWidgets('parameters the model refused say which', (tester) async {
    await _sendOneLine(tester, _Ending(failure: TavernFailure.invalidParameters, detail: 'max_tokens too large'));
    expect(_inBanner('参数'), findsOneWidget);
    expect(_inBanner('max_tokens too large'), findsOneWidget);
  });

  testWidgets("a tool's failure says which", (tester) async {
    await _sendOneLine(tester, _Ending(failure: TavernFailure.toolFailure, toolCode: 'budget_exhausted'));
    expect(_inBanner('这一回合用工具的次数用完了'), findsOneWidget);
  });

  testWidgets("a tool's failure not known here gives its detail", (tester) async {
    await _sendOneLine(
      tester,
      _Ending(failure: TavernFailure.toolFailure, toolCode: 'something_new', detail: 'tool exploded'),
    );
    expect(_inBanner('用工具时出错了：tool exploded'), findsOneWidget);
  });
}
