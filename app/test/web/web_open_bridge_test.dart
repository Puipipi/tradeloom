// The open bridge's conversation hop (assets/web/dsh_web_open.js), run in a
// minimal page under node (test/web/support/open_bridge_harness.mjs).
// location.reload() with a fragment in the URL is a same-document jump in
// the WebView: nothing loads, and a fresh profile hung on its first 「打开
// 对话」. The hop loads the page again with a one-off query instead, at most
// once, and takes the query back out of the address. Needs `node` on PATH;
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

  Future<Map<String, Object?>> page(Map<String, Object?> scenario) async {
    final result = await Process.run(node!, [
      'test/web/support/open_bridge_harness.mjs',
      'assets/web/dsh_web_open.js',
      jsonEncode(scenario),
    ]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    return jsonDecode(result.stdout as String) as Map<String, Object?>;
  }

  const withFragment = 'http://127.0.0.1:3080/?token=t#/chat';

  test('opening another conversation loads the page again, fragment or not', () async {
    final out = await page({
      'href': withFragment,
      'stored': 's1',
      'open': {'session': 's2'},
    });
    expect(out['reloaded'], 0);
    final replaced = out['replaced'] as List;
    expect(replaced, hasLength(1));
    final url = Uri.parse(replaced.single as String);
    expect(url.queryParameters['token'], 't');
    expect(url.queryParameters['dsh-go-hop'], isNotNull);
    expect(url.fragment, '/chat');
    // The selection the client restores at boot, and the rest for the next load.
    expect(jsonDecode(out['stored'] as String), {'sessionId': 's2'});
    expect(jsonDecode(out['pending'] as String), {'session': 's2', 'hopped': true});
  }, skip: skip);

  test('back from the hop: the query leaves the address and the conversation is reported', () async {
    final out = await page({
      'href': 'http://127.0.0.1:3080/?token=t&dsh-go-hop=123#/chat',
      'stored': 's2',
      'pending': {'session': 's2', 'hopped': true},
      'shown': true,
    });
    expect(out['historyReplaced'], [withFragment]);
    expect(out['replaced'], isEmpty);
    expect(out['pending'], isNull);
    expect(out['reports'], [
      {'ok': true, 'step': null},
    ]);
  }, skip: skip);

  test('at most one hop: still not on screen after it, it says so and stays', () async {
    final out = await page({
      'href': 'http://127.0.0.1:3080/?token=t&dsh-go-hop=123#/chat',
      'stored': 's2',
      'pending': {'session': 's2', 'hopped': true},
      'shown': false,
    });
    expect(out['replaced'], isEmpty);
    expect(out['reloaded'], 0);
    expect(out['reports'], [
      {'ok': false, 'step': 'session'},
    ]);
  }, skip: skip);

  test('the conversation already selected: no hop at all', () async {
    final out = await page({
      'href': withFragment,
      'stored': 's2',
      'open': {'session': 's2'},
      'shown': true,
    });
    expect(out['replaced'], isEmpty);
    expect(out['historyReplaced'], isEmpty);
    expect(out['reports'], [
      {'ok': true, 'step': null},
    ]);
  }, skip: skip);
}
