// The phone layout on the official frame (assets/web/dsh_web_phone.js and .css),
// run against a model under node (test/web/support/phone_layout_harness.mjs).
// From DSH 0.2.2 on the official layout has a drawer of its own below 768px and
// makes the page inert while its sidebar is expanded, so keeping that sidebar
// expanded under the app's drawer leaves a page that takes no touch at all.
// Needs `node` on PATH; skipped without it.

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

  Future<Map<String, Object?>> run(Map<String, Object?> scenario) async {
    final result = await Process.run(node!, [
      'test/web/support/phone_layout_harness.mjs',
      'assets/web/dsh_web_phone.js',
      jsonEncode(scenario),
    ]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    return jsonDecode(result.stdout as String) as Map<String, Object?>;
  }

  test('the official drawer is left closed on load and the menu button drives it', () async {
    final out = await run({
      'officialDrawer': true,
      'steps': ['toggle', 'close'],
    });
    final loaded = out['afterLoad']! as Map<String, Object?>;
    expect(loaded['clicks'], 0, reason: 'expanding it on load makes the whole page inert');
    expect(loaded['attrs'], contains('data-sidebar-collapsed'));
    expect(out['sheets'], [startsWith('@layer dsh-app-touch-defaults {')], reason: 'repeated injection is idempotent');

    final steps = (out['steps']! as List).cast<Map<String, Object?>>();
    expect(steps[0]['open'], true);
    expect(steps[0]['attrs'], isNot(contains('data-sidebar-collapsed')));
    expect(steps[0]['attrs'], isNot(contains('data-dsh-app-drawer')));
    expect(steps[1]['open'], false);
    expect(steps[1]['attrs'], contains('data-sidebar-collapsed'));
  }, skip: skip);

  test('without one the sidebar stays expanded under the app\'s own drawer', () async {
    final out = await run({
      'officialDrawer': false,
      'steps': ['toggle', 'close'],
    });
    final loaded = out['afterLoad']! as Map<String, Object?>;
    expect(loaded['attrs'], isNot(contains('data-sidebar-collapsed')));

    final steps = (out['steps']! as List).cast<Map<String, Object?>>();
    expect(steps[0]['open'], true);
    expect(steps[0]['attrs'], contains('data-dsh-app-drawer'));
    expect(steps[1]['open'], false);
    expect(steps[1]['attrs'], isNot(contains('data-dsh-app-drawer')));
  }, skip: skip);

  test('the app\'s drawer and settings rules stand down for the official drawer', () {
    final css = File('assets/web/dsh_web_phone.css').readAsStringSync();
    expect(
      css,
      isNot(contains(':root[data-dsh-app-layout="drawer"] [data-slot="root"] > [class*="_frame"] > [class*="_sidebarCol"]')),
      reason: 'sliding the column fights the official transform',
    );
    final settings = css.substring(css.indexOf('settings as a full-screen sheet'), css.indexOf('Desktop layout:'));
    expect(RegExp(r':root\[data-dsh-app-layout="drawer"\](?!:not\(:has\(\[data-sidebar-drawer\]\)\))').hasMatch(settings), false);
  });
}
