// The back bridge (assets/web/dsh_web_back.js): what one press of back does
// inside DSH Web, run against a page model under node
// (test/web/support/back_bridge_harness.mjs). Topmost first — a dialog or
// menu, a popover, the sidebar as a drawer (the app's, or DSH Web's own in the
// official layout), the right panel, a level up inside the main area, a full
// page back to its conversation — one step per press, and
// nothing that stays open can hold back forever. Needs `node` on PATH;
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

  Future<Map<String, Object?>> back(Map<String, Object?> scenario) async {
    final result = await Process.run(node!, [
      'test/web/support/back_bridge_harness.mjs',
      'assets/web/dsh_web_back.js',
      jsonEncode(scenario),
    ]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    return jsonDecode(result.stdout as String) as Map<String, Object?>;
  }

  /// A press every 600 ms: each one a press of its own.
  List<int> presses(int n) => [for (var i = 0; i < n; i++) i * 600];

  test('settings over the drawer: Escape closes settings, the next press the drawer, then nothing is left', () async {
    final out = await back({
      'layers': [
        {'role': 'dialog', 'mask': true, 'closes': 'escape'},
      ],
      'drawer': true,
      'presses': presses(3),
    });
    expect(out['steps'], ['layer', 'drawer', 'none']);
    expect(out['open'], isEmpty);
    expect(out['drawer'], false);
    expect(out['idempotent'], true);
  }, skip: skip);

  test("DSH Web's own sidebar drawer: one press folds it with its own toggle", () async {
    final out = await back({
      'officialDrawer': true,
      'noPhoneLayout': true,
      'layout': '',
      'rightFull': true,
      'presses': presses(3),
    });
    // The drawer first, then the panel under it, then the page.
    expect(out['steps'], ['drawer', 'panel', 'none']);
    expect(out['officialDrawer'], false);
    expect(out['rightFull'], false);
    // Folded through the toggle in the sidebar's logo row: what a person taps
    // (the app's marker has stepped aside while the drawer is up).
    expect((out['log'] as List).cast<String>(), contains('click sidebarToggle'));
  }, skip: skip);

  test("with the app's phone layout the frame is a drawer too, but back leaves it to the app's drawer", () async {
    // The official frame at phone widths, its sidebar expanded inside the
    // app's drawer (dsh_web_phone.js): not the sidebar over the page.
    final out = await back({'officialDrawer': true, 'presses': presses(1)});
    expect(out['steps'], ['none']);
    expect((out['log'] as List).cast<String>(), isNot(contains('click sidebarToggle')));
  }, skip: skip);

  test('a menu over a dialog: the menu first, one layer per press', () async {
    final out = await back({
      'layers': [
        {'role': 'dialog', 'closes': 'escape'},
        {'role': 'menu', 'closes': 'escape'},
      ],
      'presses': presses(3),
    });
    expect(out['steps'], ['layer', 'layer', 'none']);
    final log = (out['log'] as List).cast<String>();
    expect(log.where((l) => l.startsWith('keydown Escape')), hasLength(2));
  }, skip: skip);

  test('Escape as a key press: a word being composed is committed first', () async {
    final out = await back({
      'layers': [
        {'role': 'dialog', 'closes': 'escape'},
      ],
      'editing': true,
    });
    expect(out['log'], [
      'press @0',
      'blur editor',
      // A key up first clears what the composition left behind.
      'keyup Escape @body',
      'keydown Escape @body',
      'keyup Escape @body',
    ]);
  }, skip: skip);

  test('a quick second press while the dialog is on its way out is the same press', () async {
    final out = await back({
      'layers': [
        {'role': 'dialog', 'mask': true, 'closes': 'never'},
      ],
      'presses': [0, 120, 300],
    });
    expect(out['steps'], ['layer', 'layer', 'layer']);
    final log = (out['log'] as List).cast<String>();
    expect(log.where((l) => l.startsWith('keydown')), hasLength(1));
    expect(log.where((l) => l.startsWith('click')), isEmpty);
  }, skip: skip);

  test('a dialog Escape doesn\'t close: its backdrop next, then back is the app\'s', () async {
    final out = await back({
      'layers': [
        {'role': 'dialog', 'mask': true, 'close': true, 'closes': 'mask'},
      ],
      'presses': presses(3),
    });
    expect(out['steps'], ['layer', 'layer', 'none']);
    expect(out['log'], contains('click mask0'));
    expect(out['open'], isEmpty);
  }, skip: skip);

  test('no backdrop: its close button', () async {
    final out = await back({
      'layers': [
        {'role': 'dialog', 'close': true, 'closes': 'close'},
      ],
      'presses': presses(3),
    });
    expect(out['steps'], ['layer', 'layer', 'none']);
    expect(out['log'], contains('click close0'));
    expect(out['open'], isEmpty);
  }, skip: skip);

  test('a notice that must be acknowledged holds what is under it, and the app takes back', () async {
    final out = await back({
      'layers': [
        {'role': 'dialog', 'mask': true, 'closes': 'never'},
      ],
      'drawer': true,
      'page': 'page',
      'stored': 's1',
      'rows': [
        {'id': 's1'},
      ],
      'presses': presses(3),
    });
    expect(out['steps'], ['layer', 'layer', 'none']);
    // Nothing under the notice was touched.
    expect(out['drawer'], true);
    expect(out['main'], 'section');
  }, skip: skip);

  test('a menu that ignores Escape gets a touch outside', () async {
    final out = await back({
      'layers': [
        {'role': 'menu', 'closes': 'touch'},
      ],
      'presses': presses(3),
    });
    expect(out['steps'], ['layer', 'layer', 'none']);
    expect(out['log'], contains('pointerdown touch @body'));
    expect(out['open'], isEmpty);
  }, skip: skip);

  test('a popover closes on a touch outside; one that stays is passed over', () async {
    final closes = await back({
      'popups': [
        {'closes': 'touch'},
      ],
      'drawer': true,
      'presses': presses(2),
    });
    expect(closes['steps'], ['popup', 'drawer']);
    expect(closes['log'], containsAll(['pointerdown touch @body', 'pointerup touch @body']));

    final stays = await back({
      'popups': [
        {'closes': 'never'},
      ],
      'drawer': true,
      'presses': presses(3),
    });
    expect(stays['steps'], ['popup', 'drawer', 'none']);
  }, skip: skip);

  test('the drawer is the app\'s only in the drawer layout', () async {
    final desktop = await back({'layout': 'desktop', 'drawer': true});
    expect(desktop['steps'], ['none']);
    expect(desktop['drawer'], true);
    final off = await back({'noPhoneLayout': true});
    expect(off['steps'], ['none']);
  }, skip: skip);

  test('the right panel over the conversation folds away', () async {
    final out = await back({'rightFull': true, 'presses': presses(2)});
    expect(out['steps'], ['panel', 'none']);
    expect(out['log'], contains('click fold'));
    expect(out['rightFull'], false);
  }, skip: skip);

  test('a plugin\'s page goes back to the list, the list to the conversation', () async {
    final out = await back({
      'page': 'page',
      'crumb': true,
      'stored': 's1',
      'rows': [
        {'id': 's0'},
        {'id': 's1'},
      ],
    });
    expect(out['steps'], ['page']);
    expect(out['log'], contains('click crumb'));

    final list = await back({
      'page': 'page',
      'stored': 's1',
      'rows': [
        {'id': 's0'},
        {'id': 's1'},
      ],
      'presses': presses(2),
    });
    expect(list['steps'], ['chat', 'none']);
    expect(list['log'], contains('click row:s1'));
    expect(list['main'], 'conversation');
  }, skip: skip);

  test('a subagent\'s conversation goes back to its parent\'s', () async {
    final out = await back({
      'lineage': ['root', 'parent'],
    });
    expect(out['steps'], ['page']);
    expect(out['log'], contains('click lineage:parent'));
  }, skip: skip);

  test('a full page over a conversation that won\'t open (archived, or none): back is the app\'s', () async {
    final archived = await back({
      'page': 'page',
      'stored': 's1',
      'rows': [
        {'id': 's1', 'archived': true},
      ],
    });
    expect(archived['steps'], ['none']);
    final none = await back({'page': 'page'});
    expect(none['steps'], ['none']);
  }, skip: skip);
}
