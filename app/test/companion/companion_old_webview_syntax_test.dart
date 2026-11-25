import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The room's scripts load unbundled into the system WebView. Android 10 phones
/// can still ship WebView 83, which rejects logical assignment (`??=`, `||=`,
/// `&&=`, Chrome 85) at parse time and the whole script never runs (#1165).
void main() {
  test('companion scripts avoid syntax newer than WebView 83', () {
    final files = Directory('assets/companion')
        .listSync()
        .whereType<File>()
        .where((f) => f.path.endsWith('.js') || f.path.endsWith('.html'));
    final logicalAssign = RegExp(r'(\?\?|\|\||&&)=');
    for (final file in files) {
      final lines = file.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        expect(logicalAssign.hasMatch(lines[i]), isFalse, reason: '${file.path}:${i + 1}: ${lines[i].trim()}');
      }
    }
  });
}
