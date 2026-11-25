// A conversation view's island (island.js `then.view`, CR-7881a22), run
// against a model of DSH Web's conversation page under node
// (test/plugins/islands/support/island_page_harness.mjs). View tabs carry
// no ids, so a name only picks the control to press; the view counts as
// open when the client's own record of the conversation's view
// (`dsh.conversation.<id>` `view`) is the cell asked for and the slot draws
// it. A longer name that starts with this one is not this one; two views
// under one name, another view by this name already on screen, or a pick
// the client never recorded: the island says `empty` and the app falls back
// to 在网页版打开, never `ready` over another view. Needs `node` on PATH;
// skipped without it.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String? _node() {
  for (final dir in (Platform.environment['PATH'] ?? '').split(':')) {
    if (dir.isNotEmpty && File('$dir/node').existsSync()) return '$dir/node';
  }
  return null;
}

void main() {
  final node = _node();
  final skip = node == null ? 'node is not installed' : null;

  Future<Map<String, Object?>> open(Map<String, Object?> scenario) async {
    final result = await Process.run(node!, [
      'test/plugins/islands/support/island_page_harness.mjs',
      'assets/islands/island.js',
      jsonEncode({
        'cell': 'gallery-target',
        'names': ['Gallery'],
        'stored': 'original-choice',
        ...scenario,
      }),
    ]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    final out = jsonDecode(result.stdout as String) as Map<String, Object?>;
    expect(out['thrown'], isNull, reason: '${out['thrown']}');
    return out;
  }

  const chat = {'id': 'chat', 'label': 'Chat'};
  const target = {'id': 'gallery-target', 'label': 'Gallery'};

  List<Object?> messages(Map<String, Object?> out) => out['messages']! as List<Object?>;
  Map<String, Object?> stored(Map<String, Object?> out) => out['stored']! as Map<String, Object?>;

  /// `ready` for the cell asked for, with the slot drawing it.
  void opened(Map<String, Object?> out) {
    expect(messages(out), [
      {'t': 'ready', 'slot': 'conversation.view', 'cell': 'gallery-target', 'release': null, 'found': 1, 'load': 1},
    ], reason: '${out['trace']}');
    expect(out['shown'], 'gallery-target');
  }

  /// No `ready`: one `empty` (the slot is there, the view isn't), which
  /// falls back to DSH Web.
  void fellBack(Map<String, Object?> out) {
    expect(messages(out), [
      {'t': 'empty', 'slot': 'conversation.view', 'code': 'empty', 'detail': 'navigation', 'load': 1},
    ], reason: '${out['trace']}');
  }

  group('found by its tab', () {
    test('control: the one tab under its name opens it; the person\'s own choice goes back', () async {
      final out = await open({
        'views': [chat, target],
      });
      opened(out);
      expect(out['clicks'], ['tab:gallery-target']);
      expect(stored(out)['view'], 'original-choice');
    }, skip: skip);

    test('a longer name before it that starts with its name is another view: never pressed', () async {
      final out = await open({
        'views': [
          chat,
          {'id': 'gallery-extra', 'label': 'Gallery Extra'},
          target,
        ],
      });
      opened(out);
      expect(out['clicks'], ['tab:gallery-target']);
    }, skip: skip);

    test('another view by the same name already on screen is not this one: no click, no ready', () async {
      final out = await open({
        'views': [
          {'id': 'gallery-other', 'label': 'Gallery'},
          target,
        ],
        'stored': 'gallery-other',
      });
      fellBack(out);
      expect(out['clicks'], isEmpty);
      expect(out['shown'], 'gallery-other');
      expect(stored(out)['view'], 'gallery-other');
    }, skip: skip);

    test('two views under one name, neither on screen: which is which can\'t be told, nothing is pressed', () async {
      final out = await open({
        'views': [
          chat,
          {'id': 'gallery-other', 'label': 'Gallery'},
          target,
        ],
      });
      fellBack(out);
      expect(out['clicks'], isEmpty);
      expect(out['shown'], 'chat');
    }, skip: skip);

    test('control: no view by that name: nothing is pressed', () async {
      final out = await open({
        'views': [
          chat,
          {'id': 'gallery-other', 'label': 'Different'},
        ],
      });
      fellBack(out);
      expect(out['clicks'], isEmpty);
    }, skip: skip);

    test('already on screen under its id (the person left it there): open without a click', () async {
      final out = await open({
        'views': [chat, target],
        'stored': 'gallery-target',
      });
      opened(out);
      expect(out['clicks'], isEmpty);
      expect(stored(out)['view'], 'gallery-target');
    }, skip: skip);

    test('a pick the client never records can\'t be confirmed: no ready', () async {
      final out = await open({
        'views': [chat, target],
        'persist': false,
      });
      fellBack(out);
      expect(out['clicks'], contains('tab:gallery-target'));
    }, skip: skip);
  });

  group('found under 更多会话视图', () {
    test('control: the one row under its name opens it', () async {
      final out = await open({
        'views': [
          chat,
          {...target, 'menu': true},
        ],
      });
      opened(out);
      expect(out['clicks'], ['more', 'row:gallery-target']);
      expect(stored(out)['view'], 'original-choice');
    }, skip: skip);

    test('two rows under one name: nothing is picked', () async {
      final out = await open({
        'views': [
          chat,
          {'id': 'gallery-other', 'label': 'Gallery', 'menu': true},
          {...target, 'menu': true},
        ],
      });
      fellBack(out);
      expect(out['clicks'], everyElement('more'));
      expect(out['shown'], 'chat');
    }, skip: skip);

    test('a tab by its name that turns out to be another view: no ready, and the person\'s choice goes back', () async {
      final out = await open({
        'views': [
          chat,
          {'id': 'gallery-other', 'label': 'Gallery'},
          {...target, 'menu': true},
        ],
      });
      fellBack(out);
      expect(out['clicks'], ['tab:gallery-other']);
      expect(stored(out)['view'], 'original-choice');
    }, skip: skip);
  });

  group('the person\'s own choice', () {
    test('control: the client writing its state again later still gets the person\'s choice back', () async {
      final out = await open({
        'views': [chat, target],
        'rewrites': [800, 3000],
        'pagehide': true,
      });
      opened(out);
      expect(stored(out)['view'], 'original-choice');
    }, skip: skip);

    test(
      'a different choice stored later (another DSH Web on the same storage) is not overwritten on the way out',
      () async {
        final out = await open({
          'views': [chat, target],
          'later': {'at': 4000, 'view': 'later-user-choice'},
          'pagehide': true,
        });
        opened(out);
        expect(stored(out)['view'], 'later-user-choice');
      },
      skip: skip,
    );
  });
}
