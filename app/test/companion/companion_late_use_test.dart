import 'package:dsh_app/companion/companion_late_use.dart';
import 'package:flutter_test/flutter_test.dart';

final start = DateTime.utc(2026, 11, 5, 23).millisecondsSinceEpoch;
Map<String, Object?>? observe(
  CompanionLateUseTracker t,
  int ms, {
  bool touch = false,
  bool resumed = true,
  int offset = 0,
  int? wall,
}) => t.observe(wallMs: wall ?? start + ms, monoMs: ms, offsetMinutes: offset, resumed: resumed, interaction: touch);

void main() {
  test('15 minutes counts only resumed intervals covered by recent actual input', () {
    final t = CompanionLateUseTracker();
    expect(observe(t, 0, touch: true), isNull);
    for (var minute = 1; minute < 15; minute++) {
      expect(observe(t, minute * 60000, touch: true), isNull);
    }
    final result = observe(t, 15 * 60000, touch: true)!;
    expect(result, {
      'nightKey': '2026-11-05',
      'utcOffsetMinutes': 0,
      'recentInteraction': true,
      'activeMinutesBucket': '15plus',
    });
    expect(t.activeMs, 15 * 60000);
    expect(() => result['body'] = 'never', throwsUnsupportedError);
  });

  test('a new touch cannot backfill hours of idle time', () {
    final t = CompanionLateUseTracker();
    observe(t, 0, touch: true);
    expect(observe(t, 2 * 60 * 60000, touch: true), isNull);
    expect(t.activeMs, 120000);
    expect(observe(t, 2 * 60 * 60000 + 1, touch: true), isNull);
    expect(t.activeMs, 120001);
  });

  test('background time is excluded and resume alone does not refresh input', () {
    final t = CompanionLateUseTracker();
    observe(t, 0, touch: true);
    observe(t, 60000, resumed: false);
    observe(t, 30 * 60000, resumed: false);
    expect(observe(t, 31 * 60000), isNull);
    observe(t, 32 * 60000, touch: true);
    expect(t.activeMs, 60000);
    observe(t, 33 * 60000, touch: true);
    expect(t.activeMs, 120000);
  });

  test('no input, or only a foreground clock, never reaches threshold', () {
    final t = CompanionLateUseTracker();
    for (var minute = 0; minute <= 60; minute++) {
      expect(observe(t, minute * 60000), isNull);
    }
    expect(t.activeMs, 0);
  });

  test('23:00 boundary clips preceding activity to the night interval', () {
    final t = CompanionLateUseTracker();
    observe(t, 0, wall: start - 60000, touch: true);
    observe(t, 120000, wall: start + 60000, touch: true);
    expect(t.activeMs, 60000);
  });

  test('07:00 ends the night and clears threshold state', () {
    final t = CompanionLateUseTracker();
    final morning = start + 8 * 60 * 60000;
    for (var minute = 0; minute < 15; minute++) {
      observe(t, minute * 60000, wall: morning - 15 * 60000 + minute * 60000, touch: true);
    }
    expect(observe(t, 15 * 60000, wall: morning, touch: true), isNull);
    expect(t.activeMs, 0);
  });

  test('offset changes and forward clock jumps discard accumulated activity', () {
    for (final jump in [false, true]) {
      final t = CompanionLateUseTracker();
      observe(t, 0, touch: true);
      observe(t, 60000, touch: true);
      expect(t.activeMs, 60000);
      expect(observe(t, 120000, touch: true, offset: jump ? 0 : 60, wall: jump ? start + 3600000 : null), isNull);
      expect(t.activeMs, 0);
      expect(t.faulted, isFalse);
    }
  });

  test('rollback or unsafe offset permanently closes this tracker', () {
    for (final badOffset in [false, true]) {
      final t = CompanionLateUseTracker();
      observe(t, 60000, touch: true);
      observe(t, badOffset ? 120000 : 0, offset: badOffset ? 841 : 0, touch: true);
      expect(t.faulted, isTrue);
      expect(observe(t, 180000, touch: true), isNull);
      expect(t.activeMs, 0);
    }
  });
}
