import 'dart:async';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

TavernDirectorRun _run(String id, {bool success = true, String beat = '', String? failure}) => TavernDirectorRun(
  id: id,
  chatId: 'c',
  sourceKind: 'node',
  sourceFingerprint: 'f',
  startedAt: DateTime(2026),
  finishedAt: DateTime(2026),
  success: success,
  automatic: false,
  failure: failure,
  output: success
      ? {
          'notes': '她其实认得你，只是不说。',
          'beat': beat,
          'prefetch': <Object?>[],
          'suggestions': [
            {'text': '问她楼上那间房', 'risk': '她会起疑'},
            {'text': '把湿外套挂到炉边', 'risk': ''},
            {'text': '提起那封信', 'risk': '可能太早'},
          ],
          'events': <Object?>[],
        }
      : null,
);

/// The preview with a director whose views the test sends; a run sends a
/// new one when it ends.
class _Directed extends PreviewTavern {
  _Directed(this.first) : super(tick: Duration.zero);

  final TavernDirectorSnapshot Function(String chatId) first;
  final views = StreamController<TavernDirectorSnapshot>.broadcast();
  final settings = <(Map<String, Object?>, String?)>[];
  Completer<void>? holding;
  int runs = 0;

  @override
  Stream<TavernDirectorSnapshot> watchDirector(String chatId) async* {
    yield first(chatId);
    yield* views.stream;
  }

  @override
  Future<void> setSettings(Map<String, Object?> patch, {String? chatId}) async {
    settings.add((patch, chatId));
    await super.setSettings(patch, chatId: chatId);
  }

  @override
  Future<TavernDirectorRun> runDirector(String chatId) async {
    runs++;
    await holding?.future;
    final run = _run('r$runs', beat: '第 $runs 次：雨更大了');
    views.add(
      TavernDirectorSnapshot(
        chatId: chatId,
        automaticEnabled: false,
        pendingJobs: 0,
        running: false,
        latestSuccess: run,
        latestAttempt: run,
        stale: false,
      ),
    );
    return run;
  }
}

TavernDirectorSnapshot _view(
  String chatId, {
  TavernDirectorRun? success,
  TavernDirectorRun? attempt,
  bool stale = false,
  bool auto = false,
}) => TavernDirectorSnapshot(
  chatId: chatId,
  automaticEnabled: auto,
  pendingJobs: 0,
  running: false,
  latestSuccess: success,
  latestAttempt: attempt ?? success,
  stale: stale,
);

/// The chat open, the stage not.
Future<String> _openChat(WidgetTester tester, PreviewTavern tavern) async {
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
  return chat;
}

Future<String> _openDirector(WidgetTester tester, PreviewTavern tavern) async {
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
  await tester.tap(find.byKey(const ValueKey('bot-action')));
  await tester.pumpAndSettle();
  await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-stage-tabs')), matching: find.text('导演')));
  await tester.pumpAndSettle();
  return chat;
}

void main() {
  testWidgets('the beat, three suggestions and the folded notes; a suggestion only fills the box', (tester) async {
    final tavern = _Directed((chat) => _view(chat, success: _run('r0', beat: '让她提起楼上的客人')));
    final chat = await _openDirector(tester, tavern);
    expect(tester.widget<Text>(find.byKey(const ValueKey('tavern-director-beat'))).data, '让她提起楼上的客人');
    final stage = find.byKey(const ValueKey('tavern-stage'));
    expect(find.descendant(of: stage, matching: find.text('问她楼上那间房')), findsOneWidget);
    expect(find.descendant(of: stage, matching: find.text('她会起疑')), findsOneWidget);
    expect(find.descendant(of: stage, matching: find.text('提起那封信')), findsOneWidget);

    // The notes are a spoiler until asked for.
    expect(find.text('她其实认得你，只是不说。'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('tavern-director-notes')));
    await tester.pumpAndSettle();
    expect(find.text('她其实认得你，只是不说。'), findsOneWidget);

    final before = (await tester.runAsync(() => tavern.path(chat)))!.length;
    await tester.tap(find.byKey(const ValueKey('tavern-director-suggestion-0')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-stage-drawer')), findsNothing);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, '问她楼上那间房');
    expect((await tester.runAsync(() => tavern.path(chat)))!.length, before);
  });

  testWidgets("the director's suggestions lead the row over the box; a tap only fills it", (tester) async {
    final tavern = _Directed((chat) => _view(chat, success: _run('r0', beat: '让她提起楼上的客人')));
    final chat = await _openChat(tester, tavern);
    double x(String key) => tester.getTopLeft(find.byKey(ValueKey(key))).dx;
    // First in the row, in the director's order, before the dice and quick replies.
    expect(x('tavern-directed-0'), lessThan(x('tavern-directed-1')));
    expect(x('tavern-directed-1'), lessThan(x('tavern-directed-2')));
    if (find.byKey(const ValueKey('tavern-dice')).evaluate().isNotEmpty) {
      expect(x('tavern-directed-2'), lessThan(x('tavern-dice')));
    }

    final before = (await tester.runAsync(() => tavern.path(chat)))!.length;
    await tester.tap(find.byKey(const ValueKey('tavern-directed-0')));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, '问她楼上那间房');
    expect((await tester.runAsync(() => tavern.path(chat)))!.length, before);

    // Thought for an earlier moment: gone from the row.
    tavern.views.add(_view(chat, success: _run('r0', beat: '让她提起楼上的客人'), stale: true));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-directed-0')), findsNothing);
  });

  testWidgets("a long press on the director's suggestion sends it as it is", (tester) async {
    final tavern = _Directed((chat) => _view(chat, success: _run('r0', beat: '让她提起楼上的客人')));
    final chat = await _openChat(tester, tavern);
    final before = (await tester.runAsync(() => tavern.path(chat)))!.length;
    await tester.longPress(find.byKey(const ValueKey('tavern-directed-0')));
    for (var i = 0; i < 20; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
    final path = (await tester.runAsync(() => tavern.path(chat)))!;
    expect(path.length, greaterThan(before));
    expect(path.firstWhere((m) => m.role == TavernRole.user).text, '问她楼上那间房');
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty); // not left in the box
  });

  testWidgets('the switch turns the director on for this chat only', (tester) async {
    final tavern = _Directed((chat) => _view(chat));
    final chat = await _openDirector(tester, tavern);
    expect(find.byKey(const ValueKey('tavern-stage-director')), findsOneWidget); // nothing yet
    await tester.tap(find.byKey(const ValueKey('tavern-director-auto')));
    await tester.pumpAndSettle();
    expect(tavern.settings.single.$1, {
      'director': {'enabled': true},
    });
    expect(tavern.settings.single.$2, chat);
    expect(
      tester
          .widget<Switch>(
            find.descendant(of: find.byKey(const ValueKey('tavern-director-auto')), matching: find.byType(Switch)),
          )
          .value,
      isTrue,
    );
  });

  testWidgets('asking now waits for the director, then shows what it thought', (tester) async {
    final tavern = _Directed((chat) => _view(chat))..holding = Completer();
    await _openDirector(tester, tavern);
    await tester.tap(find.byKey(const ValueKey('tavern-director-run')));
    await tester.pump();
    expect(find.text('导演在想…'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('tavern-director-run'))).onPressed, isNull);

    tavern.holding!.complete();
    await tester.pumpAndSettle();
    expect(tavern.runs, 1);
    expect(tester.widget<Text>(find.byKey(const ValueKey('tavern-director-beat'))).data, '第 1 次：雨更大了');
    expect(find.text('让导演想一想'), findsOneWidget);
  });

  testWidgets('an old result is kept to read, not offered; a failed try says so', (tester) async {
    final tavern = _Directed(
      (chat) => _view(
        chat,
        success: _run('r0', beat: '让她提起楼上的客人'),
        attempt: _run('r1', success: false, failure: 'director_queue_full'),
        stale: true,
      ),
    );
    await _openDirector(tester, tavern);
    expect(find.byKey(const ValueKey('tavern-director-stale')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-director-beat')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-director-suggestion-0')), findsNothing);
    expect(find.text('上次没想成：director_queue_full'), findsOneWidget);
  });
}
