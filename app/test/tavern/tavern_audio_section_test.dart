import 'package:dsh_app/tavern/tavern_canvas_audio.dart';
import 'package:dsh_app/ui/settings/settings_widgets.dart';
import 'package:dsh_app/ui/tavern/tavern_audio_section.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/test_fonts.dart';

Map<String, Object?> _channel(String title, {bool playing = true, int tracks = 2, Map<String, Object?>? settings}) => {
  'title': title,
  'playing': playing,
  'tracks': tracks,
  'settings': settings ?? {'enabled': true, 'mode': 'repeat_all', 'muted': false, 'volume': 80},
};

void main() {
  setUpAll(loadTestFonts);

  test('the page says what its players do; the app tells the page that is up', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final audio = container.read(tavernCanvasAudioProvider('c1').notifier);
    final sent = <Map<String, Object?>>[];
    Future<void> send(Map<String, Object?> command) async => sent.add(command);

    audio.report({
      'bgm': _channel('雨夜', settings: {'enabled': false, 'mode': 'shuffle', 'volume': 300}),
      'ambient': 'not a player',
      'voice': _channel('x'),
    });
    final now = container.read(tavernCanvasAudioProvider('c1'));
    expect(now.keys, ['bgm']);
    expect(now['bgm'], const TavernAudioNow(title: '雨夜', playing: true, tracks: 2, enabled: false, mode: 'shuffle'));
    expect(container.read(tavernCanvasAudioProvider('c2')), isEmpty);

    // Nothing up to tell yet.
    await audio.toggle('bgm');
    expect(sent, isEmpty);
    audio.attach(send);
    await audio.toggle('bgm');
    await audio.settle('ambient', {'volume': 40});
    expect(sent, [
      {'type': 'bgm', 'action': 'toggle'},
      {
        'type': 'ambient',
        'settings': {'volume': 40},
      },
    ]);

    // Another page's going does not clear this one's; this one's does.
    Future<void> other(Map<String, Object?> command) async {}
    audio.detach(other);
    expect(container.read(tavernCanvasAudioProvider('c1')), isNotEmpty);
    audio.detach(send);
    expect(container.read(tavernCanvasAudioProvider('c1')), isEmpty);
    await audio.toggle('bgm');
    expect(sent, hasLength(2));
  });

  group('舞台 › 会话 › 音乐和音效', () {
    late ProviderContainer container;
    late List<Map<String, Object?>> sent;

    Future<void> pump(WidgetTester tester, Object? now) async {
      tester.view.physicalSize = const Size(390, 1600) * 2;
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      container = ProviderContainer();
      addTearDown(container.dispose);
      sent = [];
      container.read(tavernCanvasAudioProvider('c1').notifier)
        ..attach((command) async => sent.add(command))
        ..report(now);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: withTestFonts(buildLightTheme()),
            locale: const Locale('zh', 'CN'),
            supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
            localizationsDelegates: GlobalMaterialLocalizations.delegates,
            home: const Scaffold(
              body: SingleChildScrollView(child: TavernAudioSection(chatId: 'c1')),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('no canvas page up: no section', (tester) async {
      await pump(tester, null);
      expect(find.byType(SettingsSection), findsNothing);
      expect(find.text('音乐和音效'), findsNothing);
    });

    testWidgets('a page with nothing to play: only a way to add music of your own', (tester) async {
      await pump(tester, {
        'bgm': _channel('', playing: false, tracks: 0),
        'ambient': _channel('', playing: false, tracks: 0),
      });
      expect(find.text('音乐和音效'), findsOneWidget);
      expect(find.text('背景音乐'), findsNothing);
      expect(find.byKey(const ValueKey('tavern-audio-add')), findsOneWidget);
    });

    testWidgets('your own track, by its link: a web address only, added to the music list', (tester) async {
      await pump(tester, {'bgm': _channel('', playing: false, tracks: 0)});
      await tester.tap(find.byKey(const ValueKey('tavern-audio-add')));
      await tester.pumpAndSettle();
      expect(find.text('背景音乐的链接'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'file:///sdcard/a.mp3');
      await tester.tap(find.text('加入'));
      await tester.pumpAndSettle();
      expect(find.text('要以 http:// 或 https:// 开头'), findsOneWidget);
      expect(sent, isEmpty);

      await tester.enterText(find.byType(TextField), ' https://example.com/rain.mp3 ');
      await tester.tap(find.text('加入'));
      await tester.pumpAndSettle();
      expect(sent, [
        {
          'type': 'bgm',
          'append': [
            {'url': 'https://example.com/rain.mp3'},
          ],
        },
      ]);
    });

    testWidgets("each player with something on: what it is on, and the person's controls", (tester) async {
      await pump(tester, {'bgm': _channel('雨夜'), 'ambient': _channel('', playing: false, tracks: 1)});
      expect(find.text('音乐和音效'), findsOneWidget);
      expect(find.text('背景音乐'), findsOneWidget);
      expect(find.text('雨夜'), findsOneWidget);
      expect(find.text('音效'), findsOneWidget);
      expect(find.text('没在放'), findsOneWidget);
      expect(find.byTooltip('暂停'), findsOneWidget);
      expect(find.byTooltip('播放'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('tavern-audio-bgm-toggle')));
      await tester.tap(
        find.descendant(of: find.byKey(const ValueKey('tavern-audio-ambient-mode')), matching: find.text('随机')),
      );
      await tester.tap(
        find.descendant(of: find.byKey(const ValueKey('tavern-audio-bgm-allow')), matching: find.byType(Switch)),
      );
      await tester.pumpAndSettle();
      expect(sent, [
        {'type': 'bgm', 'action': 'toggle'},
        {
          'type': 'ambient',
          'settings': {'mode': 'shuffle'},
        },
        {
          'type': 'bgm',
          'settings': {'enabled': false},
        },
      ]);

      // The volume goes to the page once the finger lets go.
      sent.clear();
      final slider = find.descendant(
        of: find.byKey(const ValueKey('tavern-audio-bgm-volume')),
        matching: find.byType(Slider),
      );
      await tester.drag(slider, const Offset(-400, 0));
      await tester.pumpAndSettle();
      expect(sent, [
        {
          'type': 'bgm',
          'settings': {'volume': 0},
        },
      ]);
    });

    testWidgets('a player the card may not use cannot be started from here', (tester) async {
      await pump(tester, {
        'bgm': _channel('雨夜', playing: false, settings: {'enabled': false}),
      });
      final toggle = tester.widget<IconButton>(find.byKey(const ValueKey('tavern-audio-bgm-toggle')));
      expect(toggle.onPressed, isNull);
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    });
  });
}
