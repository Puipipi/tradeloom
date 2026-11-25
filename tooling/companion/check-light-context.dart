// Run with App package configuration, or a Dart-only package config containing
// http ^1.6.0. Imports the actual light history/SSE implementation, no Flutter.
import 'dart:convert';
import 'dart:io';

import 'package:http/testing.dart';
import 'package:http/http.dart' as http;

import '../../app/lib/companion/companion_context.dart';
import '../../app/lib/companion/companion_light.dart';

void check(bool value, String message) {
  if (!value) throw StateError(message);
}

void equal(Object? actual, Object? expected) =>
    check(jsonEncode(actual) == jsonEncode(expected), '$actual != $expected');

Future<void> main() async {
  final root = await Directory.systemTemp.createTemp('companion-context-check-');
  final file = File('${root.path}/light-chat.json');
  try {
    const raw = '你好，  这是用户的原话。';
    const legacy = '〔11月8日 周日 13:20，摸了摸你的头〕\n$raw';
    await file.writeAsString(
      jsonEncode({
        'v': 1,
        'lines': [
          {'role': 'user', 'text': legacy},
          {'role': 'assistant', 'text': '你好呀'},
          {'role': 'user', 'text': '〔用户自己输入的旁白〕\n保留'},
        ],
      }),
    );
    final history = CompanionLightHistory(file);
    await history.load();
    equal(history.lines.first.text, raw);
    equal(history.lines.first.legacyText, legacy);
    equal(history.lines.last.text, '〔用户自己输入的旁白〕\n保留');
    await history.save();
    final saved = jsonDecode(await file.readAsString()) as Map;
    equal(saved['v'], 2);
    equal((saved['lines'] as List).first['legacyText'], legacy);
    final reread = CompanionLightHistory(file);
    await reread.load();
    equal(reread.lines.map((e) => e.toJson()).toList(), history.lines.map((e) => e.toJson()).toList());
    print('PASS v1 migration persists a lossless backup and v2 round-trips verbatim');

    final now = DateTime.utc(2026, 11, 8, 5, 20);
    final context = companionTurnContext(
      now: now,
      utcOffsetMinutes: 480,
      events: [CompanionContextEvent(id: 'e1', kind: 'pet', at: now, detail: '摸头')],
    );
    Map<String, Object?>? sent;
    final client = MockClient.streaming((request, body) async {
      sent = jsonDecode(await body.bytesToString()) as Map<String, Object?>;
      return http.StreamedResponse(
        Stream.value(
          utf8.encode(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"收到"}}\n\n'
            'data: {"type":"message_stop"}\n\n',
          ),
        ),
        200,
      );
    });
    try {
      final before = await file.readAsString();
      final words = await streamCompanionReply(
        client: client,
        apiKey: 'synthetic-not-a-key',
        system: '固定系统',
        lines: reread.context(),
        context: context,
      ).toList();
      equal(words, ['收到']);
      equal(await file.readAsString(), before);
      final messages = sent!['messages'] as List;
      equal(sent!['system'], '固定系统');
      check(messages.every((m) => m['role'] == 'user' || m['role'] == 'assistant'), 'messages-level system');
      final content = messages.last['content'] as List;
      equal(content.first['text'], '〔用户自己输入的旁白〕\n保留');
      check((content[1]['text'] as String).contains('摸头'), 'request event missing');
      check(!before.contains('<companion_context>'), 'event persisted as human text');
      check(!jsonEncode(sent).contains('legacyText'), 'migration backup was sent to model');
      print('PASS actual SSE request has top-level system and transient event block; disk stays unchanged');
    } finally {
      client.close();
    }

    await reread.clear();
    const literal = '〔11月8日 周日 13:20〕\n用户刻意输入这个日期';
    reread.add(const CompanionLine.user(literal));
    await reread.save();
    final finalRead = CompanionLightHistory(file);
    await finalRead.load();
    equal(finalRead.lines.single.text, literal);
    equal(finalRead.lines.single.legacyText, null);
    print('PASS v2 user-written date-shaped text is never stripped');
    final window = CompanionLightHistory(File('${root.path}/window.json'));
    var oldMetadataUnits = 0;
    final totals = <String, int>{};
    for (var turn = 1; turn <= 100; turn++) {
      window.add(CompanionLine.user('原话$turn'));
      final humans = window.context().where((e) => !e.fromHer).length;
      equal(humans, turn < 12 ? turn : 12);
      oldMetadataUnits += humans;
      if ([10, 50, 100].contains(turn)) totals['$turn'] = oldMetadataUnits * 60;
      window.add(CompanionLine.her('回答$turn'));
    }
    equal(totals, {'10': 3300, '50': 32040, '100': 68040});
    print('PASS actual 24-line window verifies metadata estimate at 10/50/100 turns: $totals');
    print(jsonEncode({'passed': 4, 'failed': 0, 'scope': 'actual Dart files and mocked HTTP; no real API or Flutter'}));
  } finally {
    await root.delete(recursive: true);
  }
}
