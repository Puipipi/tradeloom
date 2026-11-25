// The open bridge on DSH Web's Plugins page (assets/web/dsh_web_open.js),
// run under node against a model of DSH 0.2.1-rc.4's page
// (test/web/support/plugins_page_harness.mjs): how it finds a plugin's
// card, and that an open never outstays its welcome — bounded in time, only
// the latest one acting, stopping once the person uses the page, never
// pressing anything but the way to the card (a card's enable switch least of
// all). Needs `node` on PATH; skipped without it.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String? _node() {
  for (final dir in (Platform.environment['PATH'] ?? '').split(':')) {
    if (dir.isNotEmpty && File('$dir/node').existsSync()) return '$dir/node';
  }
  return null;
}

const _weather = {'name': '@acme/dsh-weather', 'title': '天气'};
const _clock = {'name': '@acme/dsh-clock', 'title': '时钟'};
const _extra = {'name': '@acme/dsh-extra', 'title': '额外', 'more': true};

/// What the bridge did on the model page.
typedef _Run = ({
  List<({int at, String name})> presses,
  List<Map<String, Object?>> reports,
  String view,
  List<Object?> switched,
  int? doneAt,
  int pendingTimers,
});

void main() {
  final node = _node();
  final skip = node == null ? 'node is not installed' : null;

  Future<_Run> page(Map<String, Object?> scenario) async {
    final result = await Process.run(node!, [
      'test/web/support/plugins_page_harness.mjs',
      'assets/web/dsh_web_open.js',
      jsonEncode(scenario),
    ]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    final out = jsonDecode(result.stdout as String) as Map<String, Object?>;
    return (
      presses: [
        for (final p in (out['presses'] as List).cast<Map<String, Object?>>())
          (at: p['at'] as int, name: p['name'] as String),
      ],
      reports: (out['reports'] as List).cast<Map<String, Object?>>(),
      view: out['view'] as String,
      switched: out['switched'] as List,
      doneAt: out['doneAt'] as int?,
      pendingTimers: out['pendingTimers'] as int,
    );
  }

  List<String> pressed(_Run run) => [for (final p in run.presses) p.name];

  bool landed(_Run run) =>
      run.reports.length == 1 && run.reports.single['ok'] == true;

  bool missed(_Run run, String step) =>
      run.reports.length == 1 && run.reports.single['ok'] == false && run.reports.single['step'] == step;

  group('finding the card', () {
    test('by the package name the page marks it with, whatever language the page is in', () async {
      final run = await page({
        'open': {
          'pluginItem': ['@acme/dsh-weather'],
        },
        'bundles': [_clock, _weather],
      });
      expect(pressed(run), ['插件', '查看 天气']);
      expect(run.view, 'package:@acme/dsh-weather');
      expect(landed(run), isTrue);
    }, skip: skip);

    test('by a title, stray spaces and all', () async {
      final run = await page({
        'open': {
          'pluginItem': [' 天气  '],
        },
        'bundles': [_clock, _weather],
      });
      expect(pressed(run), ['插件', '查看 天气']);
      expect(landed(run), isTrue);
    }, skip: skip);

    test('an empty name presses nothing: it would match any icon, a card\'s enable switch first', () async {
      final run = await page({
        'open': {
          'pluginItem': ['', ' '],
        },
        'bundles': [_weather],
      });
      expect(run.presses, isEmpty);
      expect(run.switched, isEmpty);
      expect(missed(run, 'pluginItem'), isTrue);
    }, skip: skip);

    test('behind 「更多」', () async {
      final run = await page({
        'open': {
          'pluginItem': ['额外'],
        },
        'bundles': [_weather, _extra],
      });
      expect(pressed(run), ['插件', '更多', '查看 额外']);
      expect(landed(run), isTrue);
    }, skip: skip);

    test('a page the panel remembers: back to the list by its crumbs, a press at a time', () async {
      final run = await page({
        'open': {
          'pluginItem': ['天气'],
        },
        'bundles': [_weather, _clock],
        'view': {'row': '@acme/dsh-clock'},
      });
      expect(pressed(run), ['插件', '返回 时钟', '返回插件', '查看 天气']);
      final backs = run.presses.where((p) => p.name.startsWith('返回')).toList();
      expect(backs[1].at - backs[0].at, greaterThanOrEqualTo(600), reason: 'each crumb gets its page drawn first');
      expect(landed(run), isTrue);
    }, skip: skip);
  });

  group('never outstays its welcome', () {
    test('a card that isn\'t there: gives up, stays on the Plugins page, touches no switch', () async {
      final run = await page({
        'open': {
          'pluginItem': ['weather'],
        },
        'bundles': [_weather, _clock, _extra],
      });
      expect(pressed(run), ['插件', '更多']);
      expect(run.view, 'more', reason: 'still the Plugins page');
      expect(run.switched, isEmpty);
      expect(missed(run, 'pluginItem'), isTrue);
      expect(run.doneAt, lessThan(3000));
      expect(run.pendingTimers, 0, reason: 'nothing keeps polling');
    }, skip: skip);

    test('a list that never loads: gives up in bounded time, presses nothing more', () async {
      final run = await page({
        'open': {
          'pluginItem': ['天气'],
        },
        'bundles': [_weather],
        'loadMs': null,
      });
      expect(pressed(run), ['插件']);
      expect(missed(run, 'pluginItem'), isTrue);
      expect(run.doneAt, lessThan(7000));
      expect(run.pendingTimers, 0);
    }, skip: skip);

    test('a page that never boots: says so after its wait, then nothing runs', () async {
      final run = await page({
        'open': {
          'pluginItem': ['天气'],
        },
        'bundles': [_weather],
        'bootMs': 1000000,
      });
      expect(run.presses, isEmpty);
      expect(missed(run, 'boot'), isTrue);
      expect(run.doneAt, lessThan(16000));
      expect(run.pendingTimers, 0);
    }, skip: skip);

    test('the person touching the page stops it there: nothing pressed after, nothing said', () async {
      final run = await page({
        'open': {
          'pluginItem': ['天气'],
        },
        'bundles': [_weather],
        'loadMs': 4000,
        'touchAt': 1000,
      });
      expect(pressed(run), ['插件']);
      expect(run.presses.every((p) => p.at <= 1000), isTrue);
      expect(run.reports, isEmpty);
      expect(run.pendingTimers, 0);
    }, skip: skip);

    test('a touch while the page is still loading changes nothing yet', () async {
      final run = await page({
        'open': {
          'pluginItem': ['天气'],
        },
        'bundles': [_weather],
        'bootMs': 2000,
        'touchAt': 500,
      });
      expect(pressed(run), ['插件', '查看 天气']);
      expect(landed(run), isTrue);
    }, skip: skip);

    test('a newer open stops the one on its way: one landing, one report', () async {
      final run = await page({
        'open': {
          'pluginItem': ['天气'],
        },
        'bundles': [_weather, _clock],
        'loadMs': 3000,
        'reopenAt': 1000,
        'reopen': {
          'pluginItem': ['时钟'],
        },
      });
      // The first never opens its card, and never presses its way back out
      // of the second's.
      expect(pressed(run), ['插件', '插件', '查看 时钟']);
      expect(run.view, 'package:@acme/dsh-clock');
      expect(landed(run), isTrue);
    }, skip: skip);
  });
}
