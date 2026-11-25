import 'dart:async';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The sample chat after one exchange: the greeting, your line, her reply.
Future<void> _openAfterOneExchange(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
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
  await _send(tester, '外面怎么了？');
  expect(find.textContaining('地下室', findRichText: true), findsWidgets);
}

/// Sends [line] and lets the whole reply in.
Future<void> _send(WidgetTester tester, String line) async {
  await tester.enterText(find.byType(TextField), line);
  await tester.pump();
  await tester.tap(find.byIcon(AppIcons.send));
  for (var i = 0; i < 200; i++) {
    await tester.pump(const Duration(milliseconds: 5));
  }
  await tester.pumpAndSettle();
}

/// Scrolls the transcript back to [text] and brings it to the middle, clear
/// of the glass header.
Future<void> _bringBack(WidgetTester tester, String text) async {
  final target = find.textContaining(text, findRichText: true);
  await tester.scrollUntilVisible(
    target,
    300,
    scrollable: find.descendant(of: find.byKey(const ValueKey('tavern-transcript')), matching: find.byType(Scrollable)),
  );
  unawaited(Scrollable.ensureVisible(tester.element(target.last), alignment: 0.5));
  await tester.pumpAndSettle();
}

/// Long-presses [text] and picks 删除这条及以后.
Future<void> _deleteFrom(WidgetTester tester, String text) async {
  await tester.longPress(find.textContaining(text, findRichText: true).last);
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('tavern-menu-delete')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a few messages go at once, and 撤销 brings them back', (tester) async {
    await _openAfterOneExchange(tester);

    // Your line and her reply: two, gone without asking.
    await _deleteFrom(tester, '外面怎么了');
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.textContaining('外面怎么了', findRichText: true), findsNothing);
    expect(find.textContaining('地下室', findRichText: true), findsNothing);
    expect(find.text('删掉了 2 条'), findsOneWidget);

    await tester.tap(find.text('撤销'));
    await tester.pumpAndSettle();
    expect(find.textContaining('外面怎么了', findRichText: true), findsWidgets);
    expect(find.textContaining('地下室', findRichText: true), findsWidgets);
  });

  testWidgets('the last message alone is one; once 撤销 has gone, so has it', (tester) async {
    await _openAfterOneExchange(tester);
    await _deleteFrom(tester, '地下室');
    expect(find.text('删掉了 1 条'), findsOneWidget);
    await tester.pump(tavernUndoWindow + const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.text('撤销'), findsNothing);
    expect(find.textContaining('地下室', findRichText: true), findsNothing);
    expect(find.textContaining('外面怎么了', findRichText: true), findsWidgets);
  });

  testWidgets('just this one asks first, and keeps what came after it', (tester) async {
    await _openAfterOneExchange(tester);
    await tester.longPress(find.textContaining('外面怎么了', findRichText: true).last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-menu-deleteOne')));
    await tester.pumpAndSettle();
    expect(find.text('只删除这一条消息？'), findsOneWidget);
    expect(find.textContaining('不能撤销'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '取消'));
    await tester.pumpAndSettle();
    expect(find.textContaining('外面怎么了', findRichText: true), findsWidgets); // kept

    await tester.longPress(find.textContaining('外面怎么了', findRichText: true).last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-menu-deleteOne')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '删除'));
    await tester.pumpAndSettle();
    expect(find.textContaining('外面怎么了', findRichText: true), findsNothing);
    // Her reply stays, now after the greeting; no undo for this one.
    expect(find.textContaining('地下室', findRichText: true), findsWidgets);
    expect(find.text('撤销'), findsNothing);
  });

  testWidgets('ten or more ask first, saying they can still be undone', (tester) async {
    await _openAfterOneExchange(tester);
    for (final line in ['你是谁？', '这里是哪？', '有吃的吗？', '我能住一晚吗？']) {
      await _send(tester, line);
    }
    // From your first line: five exchanges, ten messages.
    await _bringBack(tester, '外面怎么了');
    await _deleteFrom(tester, '外面怎么了');
    expect(find.text('删除这 10 条消息？'), findsOneWidget);
    expect(find.textContaining('几秒内可以撤销'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '取消'));
    await tester.pumpAndSettle();
    expect(find.textContaining('外面怎么了', findRichText: true), findsWidgets); // kept

    await _bringBack(tester, '外面怎么了');
    await _deleteFrom(tester, '外面怎么了');
    await tester.tap(find.widgetWithText(TextButton, '删除'));
    await tester.pumpAndSettle();
    expect(find.textContaining('外面怎么了', findRichText: true), findsNothing);
    expect(find.text('删掉了 10 条'), findsOneWidget);
  });
}
