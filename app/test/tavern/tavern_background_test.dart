import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/tavern/tavern_backgrounds.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_app/ui/wallpaper/wallpaper_backdrop.dart';
import 'package:dsh_app/wallpaper/custom_wallpaper.dart';
import 'package:dsh_app/wallpaper/wallpaper_import.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The system picker, answering from a list.
class _FakeImport extends WallpaperImport {
  _FakeImport(this.answers) : super(directory: () async => Directory.systemTemp);

  final List<(CustomWallpaper?, LaunchImportProblem?)> answers;
  final previous = <CustomWallpaper?>[];

  @override
  Future<(CustomWallpaper?, LaunchImportProblem?)> pick({CustomWallpaper? previous}) async {
    this.previous.add(previous);
    return answers.removeAt(0);
  }
}

const _first = CustomWallpaper(path: '/nowhere/custom-1.jpg', width: 1200, height: 1800);
const _second = CustomWallpaper(path: '/nowhere/custom-2.jpg', width: 1200, height: 1800);

Future<String> _open(WidgetTester tester, {_FakeImport? import, String? chatId, PreviewTavern? tavern}) async {
  final t = tavern ?? PreviewTavern(tick: const Duration(milliseconds: 1));
  final chat = chatId ?? await t.createChat('sample-innkeeper');
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => t),
        if (import != null) tavernBackgroundImportProvider.overrideWithValue(import),
      ],
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
  return chat;
}

/// 舞台 › 本局, where the chat's background is picked.
Future<void> _quickLook(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('bot-action')));
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.byKey(const ValueKey('tavern-chat-background')));
  await tester.pumpAndSettle();
}

CustomWallpaper? _shown(WidgetTester tester) =>
    tester.widget<WallpaperBackdrop>(find.byType(WallpaperBackdrop)).picture;

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('a picture is chosen for the chat, changed, and taken away again', (tester) async {
    final import = _FakeImport([(_first, null), (_second, null)]);
    final chat = await _open(tester, import: import);
    expect(_shown(tester), isNull);

    await _quickLook(tester);
    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-chat-background')), matching: find.text('无')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('tavern-chat-background')));
    await tester.pumpAndSettle();
    expect(_shown(tester)?.path, _first.path);
    final prefs = await SharedPreferences.getInstance();
    expect(jsonDecode(prefs.getString('tavern.background.$chat')!)['path'], _first.path);

    // A second pick replaces the first (whose file the import lets go).
    await tester.tap(find.text('换一张'));
    await tester.pumpAndSettle();
    expect(import.previous, [null, _first]);
    expect(_shown(tester)?.path, _second.path);

    await tester.ensureVisible(find.byKey(const ValueKey('tavern-chat-background-remove')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-chat-background-remove')));
    await tester.pumpAndSettle();
    expect(_shown(tester), isNull);
    expect(prefs.getString('tavern.background.$chat'), isNull);
    expect(find.byKey(const ValueKey('tavern-chat-background-remove')), findsNothing);
  });

  testWidgets('backing out changes nothing; a picture that can not be used says why', (tester) async {
    final import = _FakeImport([(null, LaunchImportProblem.cancelled), (null, LaunchImportProblem.unsupported)]);
    await _open(tester, import: import);
    await _quickLook(tester);

    await tester.tap(find.byKey(const ValueKey('tavern-chat-background')));
    await tester.pumpAndSettle();
    expect(_shown(tester), isNull);
    expect(find.text('支持 PNG、JPEG 和 WebP'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('tavern-chat-background')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('支持 PNG、JPEG 和 WebP'), findsOneWidget);
    expect(_shown(tester), isNull);
    await tester.pumpAndSettle(const Duration(seconds: 5));
  });

  testWidgets('a kept picture is back when the chat opens again, unless its file is gone', (tester) async {
    final folder = Directory.systemTemp.createTempSync('tavern-bg');
    addTearDown(() => folder.deleteSync(recursive: true));
    final file = File('${folder.path}/custom-1.jpg')..writeAsBytesSync([0xff, 0xd8, 0xff]);
    final kept = CustomWallpaper(path: file.path, width: 1200, height: 1800);
    final tavern = PreviewTavern(tick: const Duration(milliseconds: 1));
    final chat = await tavern.createChat('sample-innkeeper');
    final gone = await tavern.createChat('sample-innkeeper');
    SharedPreferences.setMockInitialValues({
      'tavern.background.$chat': jsonEncode(kept.toJson()),
      'tavern.background.$gone': jsonEncode(_first.toJson()),
    });

    await _open(tester, tavern: tavern, chatId: chat);
    expect(_shown(tester)?.path, file.path);

    await tester.pumpWidget(const SizedBox());
    await _open(tester, tavern: tavern, chatId: gone);
    expect(_shown(tester), isNull);
  });

  test('a deleted chat lets its picture go', () async {
    final folder = Directory.systemTemp.createTempSync('tavern-bg');
    addTearDown(() => folder.deleteSync(recursive: true));
    final file = File('${folder.path}/custom-1.jpg')..writeAsBytesSync([0xff, 0xd8, 0xff]);
    SharedPreferences.setMockInitialValues({
      'tavern.background.c1': jsonEncode(CustomWallpaper(path: file.path, width: 10, height: 10).toJson()),
      'tavern.background.c2': jsonEncode(_first.toJson()),
    });

    await forgetTavernBackground('c1');

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('tavern.background.c1'), isNull);
    expect(file.existsSync(), isFalse);
    expect(prefs.getString('tavern.background.c2'), isNotNull); // others stay
  });
}
