// Dev-fixture smoke test. This proves Dart/controller/HTTP wiring only;
// app/tool/pet_actions_probe.py separately requires actual Android overlay UI.
import 'dart:io';

import 'package:dsh_app/dev/pet_actions_probe_main.dart';
import 'package:dsh_app/pets/pet_overlay_actions.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../test/chat/support/composer_fakes.dart' show silentWav;

class _LoopbackHttp extends HttpOverrides {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('dev fixture sends real HTTP prompts, approvals, questions and local speech', () async {
    final previous = HttpOverrides.current;
    HttpOverrides.global = _LoopbackHttp();
    final p = await PetActionsProbe.start();
    try {
      final actions = p.container.read(petOverlayActionsProvider);
      Future<Map> call(String method, [Map? args]) async => (await actions.handle(MethodCall(method, args)))! as Map;
      Future<void> until(bool Function() ready) async {
        final end = DateTime.now().add(const Duration(seconds: 4));
        while (!ready()) {
          if (DateTime.now().isAfter(end)) fail('Timed out: ${p.snapshot}');
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
      }

      final offer = await call('askTarget');
      expect(offer['voice'], 'ready');
      expect(
        await call('ask', {
          'offer': offer['offer'],
          'host': probeHost.encode(),
          'sessionId': probeSession,
          'text': 'hello from fixture',
        }),
        containsPair('sent', true),
      );
      final fresh = await call('askTarget');
      expect(
        await call('ask', {
          'offer': fresh['offer'],
          'host': probeHost.encode(),
          'fresh': true,
          'text': 'new fixture session',
        }),
        containsPair('sessionId', 'probe-new-1'),
      );

      for (final decision in ['allow', 'reject', 'Blue']) {
        final kind = decision == 'Blue' ? 'question' : 'approval';
        final id = p.seed(kind);
        await until(() => p.lastRequest?['eventId'] == id);
        final request = p.lastRequest!;
        expect(request['token'], isNonNegative);
        if (kind == 'approval') expect(request['approvable'], isTrue);
        expect(
          await call('answer', {...request, if (kind == 'approval') 'decision': decision else 'choice': decision}),
          {'result': 'handled'},
        );
      }
      expect(p.snapshot['answerCount'], 3);
      final before = p.snapshot['promptCount'];
      expect(await call('transcribe', {'wav': silentWav(1)}), {'text': probeTranscript});
      expect(p.snapshot['speechCount'], 1);
      expect(p.snapshot['promptCount'], before, reason: 'Transcription must not submit a prompt');
      final outcomes = p.lines.value
          .where((e) => e['endpoint'] == r'$events/result')
          .map((e) => (e['args'] as Map)['outcome'])
          .toList();
      expect(outcomes, [
        {'kind': 'result', 'value': 'allowed-once'},
        {'kind': 'result', 'value': 'rejected'},
        {
          'kind': 'result',
          'value': {
            'answers': [
              {
                'id': 'color',
                'selected': ['Blue'],
              },
            ],
          },
        },
      ]);
      expect(
        p.lines.value.any((e) => e['kind'] == 'native-action'),
        isFalse,
        reason: 'Headless smoke must never be presented as Android channel evidence',
      );
    } finally {
      await p.close();
      HttpOverrides.global = previous;
    }
  });
}
