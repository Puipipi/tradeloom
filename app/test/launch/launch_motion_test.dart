// 启动画面的时间线：关键帧上的位置和透明度，按 launch_motion.dart 顶部的设计量出来。

import 'package:dsh_app/launch/launch_motion.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // The 390 × 844 phone at 2×: the system centres its 320 px icon at (230, 684) px.
  final cover = const Rect.fromLTWH(115, 342, 160, 160);
  final layout = LaunchLayout(cover: cover);
  LaunchFrame at(int ms) => layout.at(Duration(milliseconds: ms));

  test('starts exactly on the system picture', () {
    final f = at(0);
    expect(f.icon, cover);
    expect(f.wordmarkOpacity, 0);
    expect(f.sweep, isNull);
  });

  test('leaves the still splash from rest: no jump in the first frames', () {
    // One 60 Hz frame in, the icon has moved less than a tenth of a pixel; two frames, under half.
    expect((at(16).icon.center - cover.center).distance, lessThan(0.1));
    expect((at(33).icon.center - cover.center).distance, lessThan(0.5));
    expect(at(16).icon.width, closeTo(160, 0.1));
  });

  test('settles to 0.8 by 640 ms, lockup centred where the icon was', () {
    final settled = at(640).icon;
    expect(settled.width, closeTo(128, 1e-9));
    expect(settled, layout.settled);
    // Icon top to wordmark bottom is centred on the system icon's centre.
    final top = settled.top;
    final bottom = layout.wordmarkTop + layout.wordmarkHeight;
    expect((top + bottom) / 2, closeTo(cover.center.dy, 1e-9));
    expect(settled.center.dx, cover.center.dx);
    expect(layout.wordmarkTop - settled.bottom, LaunchMotion.wordmarkGap);
    // Halfway through, past halfway there (a decelerating curve).
    final half = at(320).icon;
    expect(half.width, lessThan(144));
    expect(half.width, greaterThan(128));
  });

  test('the wordmark comes in between 200 and 640 ms, rising 10 into place', () {
    expect(at(200).wordmarkOpacity, 0);
    expect(at(200).wordmarkRise, LaunchMotion.wordmarkRiseBy);
    expect(at(420).wordmarkOpacity, inExclusiveRange(0.5, 1));
    expect(at(640).wordmarkOpacity, 1);
    expect(at(640).wordmarkRise, 0);
    // Opacity only ever grows.
    var last = 0.0;
    for (var ms = 0; ms <= 700; ms += 10) {
      final o = at(ms).wordmarkOpacity;
      expect(o, greaterThanOrEqualTo(last));
      last = o;
    }
  });

  test('one light crosses the icon between 560 and 1360 ms, left to right', () {
    expect(at(560).sweep, isNull);
    expect(at(1360).sweep, isNull);
    var last = 0.0;
    for (var ms = 570; ms < 1360; ms += 10) {
      final s = at(ms).sweep!;
      expect(s, greaterThan(last));
      last = s;
    }
    expect(at(960).sweep, closeTo(0.5, 0.01));
  });

  test('at rest from 1360 ms on', () {
    for (final ms in [1360, 2000, 10000]) {
      final f = at(ms);
      expect(f.icon, layout.settled);
      expect(f.wordmarkOpacity, 1);
      expect(f.sweep, isNull);
    }
    expect(LaunchMotion.total, const Duration(milliseconds: 1360));
  });

  test('follows a measured splash anywhere on the screen', () {
    // A vendor that draws a smaller icon higher up.
    const vendor = Rect.fromLTWH(131, 300, 128, 128);
    final l = LaunchLayout(cover: vendor);
    expect(l.at(Duration.zero).icon, vendor);
    expect(l.settled.width, closeTo(128 * 0.8, 1e-9));
    expect(l.settled.center.dx, vendor.center.dx);
  });
}
