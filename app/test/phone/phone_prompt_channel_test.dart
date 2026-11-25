import 'dart:async';

import 'package:dsh_app/phone/phone_channel.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a silent native prompt is cancelled at the Dart deadline', (tester) async {
    final pending = Completer<Object?>();
    final calls = <MethodCall>[];
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(phoneMethods, (call) {
      calls.add(call);
      return call.method == 'presentPrompt' ? pending.future : Future<Object?>.value(null);
    });
    addTearDown(() => messenger.setMockMethodCallHandler(phoneMethods, null));
    final result = PhoneChannel().presentPrompt(
      requestId: 'opaque-id',
      sessionId: 's1',
      host: 'local:local',
      text: 'one action',
      canApprove: true,
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 35));
    expect((await result).decision, PhonePromptDecision.timeout);
    expect(calls.map((c) => c.method), ['presentPrompt', 'cancelPrompt']);
    expect(calls.last.arguments, {'requestId': 'opaque-id'});
    pending.complete({'decision': 'allowed-once', 'presented': 'overlay'});
    await tester.pump();
  });

  test('oversize native text fails closed before calling the platform', () async {
    final native = FakePhoneNative()..install();
    final result = await PhoneChannel().presentPrompt(
      requestId: 'opaque-id',
      sessionId: 's1',
      host: 'local:local',
      text: 'x' * 4097,
      canApprove: true,
    );
    expect(result.decision, PhonePromptDecision.unavailable);
    expect(native.callsOf('presentPrompt'), isEmpty);
  });

  test('engine prompt decoder never inherits native visual permission', () {
    expect(PhoneDecision.parse('confirmed-visual'), PhoneDecision.allowed);
    for (final decision in ['allowed-visual', 'allowed-app', 'allowed-task']) {
      final result = PhonePromptResult.fromMap({'decision': decision, 'presented': 'app'});
      expect(result.decision, PhonePromptDecision.unavailable);
    }
  });

}
