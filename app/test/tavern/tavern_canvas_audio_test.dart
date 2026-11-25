import 'package:dsh_app/tavern/tavern_canvas_audio.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test("a chat's players are kept as their lists and right settings, nothing else", () {
    expect(
      tavernAudioState({
        'bgm': {
          'list': [
            {'title': '雨夜', 'url': 'https://example.com/rain.mp3'},
            {'url': 'https://example.com/inn.ogg'},
            {'title': 'no url'},
            {'url': ''},
            'not a track',
          ],
          'settings': {'enabled': false, 'mode': 'shuffle', 'muted': true, 'volume': 140, 'extra': 1},
        },
        'ambient': {
          'list': 'not a list',
          'settings': {'mode': 'loud', 'volume': double.nan, 'enabled': 'yes'},
        },
        'voice': {'list': <Object?>[]},
      }),
      {
        'bgm': {
          'list': [
            {'title': '雨夜', 'url': 'https://example.com/rain.mp3'},
            {'title': '', 'url': 'https://example.com/inn.ogg'},
          ],
          'settings': {'enabled': false, 'mode': 'shuffle', 'muted': true, 'volume': 100},
        },
        'ambient': {'list': <Object?>[], 'settings': <String, Object?>{}},
      },
    );
    expect(tavernAudioState(null), isEmpty);
    expect(tavernAudioState({'bgm': 'x'}), isEmpty);
  });

  test('kept per chat on this phone; a chat never set has nothing', () async {
    SharedPreferences.setMockInitialValues({});
    expect(await tavernLoadAudio('c1'), isEmpty);
    await tavernSaveAudio('c1', {
      'bgm': {
        'list': [
          {'title': 'a', 'url': 'u1'},
        ],
        'settings': {'volume': 40},
      },
    });
    expect(await tavernLoadAudio('c1'), {
      'bgm': {
        'list': [
          {'title': 'a', 'url': 'u1'},
        ],
        'settings': {'volume': 40},
      },
    });
    expect(await tavernLoadAudio('c2'), isEmpty);

    SharedPreferences.setMockInitialValues({'tavern.audio.c3': '{not json'});
    expect(await tavernLoadAudio('c3'), isEmpty);
  });

  testWidgets('the app out of sight: the players are told to wait, and to go on when it is back', (tester) async {
    final told = <bool>[];
    final lifecycle = TavernCanvasAudioLifecycle(told.add);
    final binding = tester.binding;

    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    expect(told, isEmpty, reason: 'a dialog over the app is not leaving it');
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(told, [true]);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    expect(told, [true, false]);

    // Gone with its page: told nothing more.
    lifecycle.dispose();
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    expect(told, [true, false]);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  });
}
