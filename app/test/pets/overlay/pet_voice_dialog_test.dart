import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/pets/pet_voice_dialog.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/voice_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../chat/support/composer_fakes.dart';

class _Local extends LocalConnectionController {
  _Local(this.client);
  final DshClient client;
  @override
  Future<HostConnection?> build() async => HostConnection(client: client, isLocal: true);
}

void main() {
  testWidgets('foreground voice returns recognized text with the original overlay draft', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    final carrier = FakeRpcCarrier({
      'speech/catalog': (_) => readySpeechCatalog(),
      'speech/transcribe': (_) => {'text': 'offline words', 'audioSeconds': 1},
    });
    final client = DshClient.withCarrier(carrier);
    final bridge = FakeVoiceBridge()..recording = silentWav(1);
    final container = ProviderContainer(
      overrides: [
        localConnectionProvider.overrideWith(() => _Local(client)),
        voiceBridgeProvider.overrideWithValue(bridge),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(client.close);
    await container.read(localConnectionProvider.future);
    String? returned;
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  returned = await showDialog<String>(
                    context: context,
                    builder: (_) => const PetVoiceDialog(text: 'typed draft '),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(bridge.calls.any((c) => c.startsWith('recorder:')), true);
    expect(bridge.calls, isNot(contains('recognizer')));
    await tester.tap(find.text(appL10n.petActionVoiceStop));
    await tester.pumpAndSettle();
    expect(returned, contains('typed draft'));
    expect(returned, contains('offline words'));
    expect(find.byType(PetVoiceDialog), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
