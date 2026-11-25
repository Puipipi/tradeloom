// The launch screen's fixed colours are the Android launch window's (res/values{,-night}/colors.xml):
// a drift would show as a colour step at the hand-over.

import 'dart:io';
import 'dart:ui';

import 'package:dsh_app/launch/custom_launch.dart';
import 'package:dsh_app/ui/theme/palette.dart';
import 'package:flutter_test/flutter_test.dart';

Color _color(String dir, String name) {
  final xml = File('android/app/src/main/res/$dir/colors.xml').readAsStringSync();
  final m = RegExp('<color name="$name">#([0-9A-Fa-f]{8})</color>').firstMatch(xml)!;
  return Color(int.parse(m.group(1)!, radix: 16));
}

void main() {
  test('light launch colours match colors.xml', () {
    expect(LaunchColors.mistTop, _color('values', 'launch_background_top'));
    expect(LaunchColors.mistBottom, _color('values', 'launch_background_bottom'));
  });

  test('dark launch colours match values-night/colors.xml', () {
    expect(LaunchColors.nightTop, _color('values-night', 'launch_background_top'));
    expect(LaunchColors.nightBottom, _color('values-night', 'launch_background_bottom'));
  });

  test('the wordmark ink is the default palette text, and the page is the default backdrop', () {
    expect(LaunchColors.ink, DshPalette.ink);
    expect(LaunchColors.paper, DshPalette.paper);
    expect(LaunchColors.mistTop, DshPalette.mistTop);
    expect(LaunchColors.nightTop, DshPalette.nightTop);
  });
}
