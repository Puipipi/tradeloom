import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('sidebar bridge follows late mounts, replacements and layout changes', () async {
    final result = await Process.run('node', ['--test', 'test/web/support/sidebar_bridge_test.mjs']);
    expect(result.exitCode, 0, reason: '${result.stdout}\n${result.stderr}');
  });
}
