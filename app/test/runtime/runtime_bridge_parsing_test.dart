// Owner-side 5310 control; outside the production patch. Not compiled or run.
// Destination: app/test/runtime/runtime_bridge_parsing_test.dart.
import 'dart:async';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('runtime parsing and errors keep each listener order across pause', () async {
    const name = 'test/5310/runtime-data';
    const methods = MethodChannel(name);
    const codec = StandardMethodCodec();
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final calls = <String>[];
    final activated = Completer<void>();
    messenger.setMockMethodCallHandler(methods, (call) async {
      calls.add(call.method);
      if (call.method == 'listen') activated.complete();
      return null;
    });
    final subscriptions = <StreamSubscription<RuntimeEvent>>[];
    addTearDown(() async {
      for (final subscription in subscriptions) {
        await subscription.cancel();
      }
      // Separate EOF cleanup for the baseline's retained source, after assertions.
      final ended = Completer<void>();
      await messenger.handlePlatformMessage(name, null, (_) => ended.complete());
      await ended.future.timeout(const Duration(seconds: 2));
      messenger.setMessageHandler(name, null);
      messenger.setMockMethodCallHandler(methods, null);
    });
    Future<void> send(ByteData bytes) async {
      final delivered = Completer<void>();
      await messenger.handlePlatformMessage(name, bytes, (_) => delivered.complete());
      await delivered.future.timeout(const Duration(seconds: 2));
    }

    final left = <RuntimeEvent>[], right = <RuntimeEvent>[];
    final leftErrors = <Object>[], rightErrors = <Object>[];
    final leftDone = Completer<void>(), rightDone = Completer<void>();
    final events = RuntimeBridge(events: const EventChannel(name)).events;
    final first = events.listen((event) {
      left.add(event);
      if (event is RuntimeNoticeEvent && event.text == 'after-error') leftDone.complete();
    }, onError: (Object error) => leftErrors.add(error));
    subscriptions.add(first);
    final second = events.listen((event) {
      right.add(event);
      if (event is RuntimeNoticeEvent && event.text == 'after-error') rightDone.complete();
    }, onError: (Object error) => rightErrors.add(error));
    subscriptions.add(second);
    await activated.future.timeout(const Duration(seconds: 2));
    second.pause();
    await send(
      codec.encodeSuccessEnvelope({
        'type': 'status',
        'status': {'phase': 'running'},
      }),
    );
    await send(codec.encodeSuccessEnvelope({'type': 'progress', 'step': 'extract', 'done': 1, 'total': 2}));
    await send(
      codec.encodeSuccessEnvelope({
        'type': 'logs',
        'entries': [
          {'seq': 7, 'line': 'fixture line', 'stream': 'stdout'},
        ],
      }),
    );
    await send(codec.encodeSuccessEnvelope({'type': 'unknown-fixture-event'}));
    await send(codec.encodeSuccessEnvelope({'type': 'notice', 'text': ''}));
    await send(codec.encodeErrorEnvelope(code: 'fixture_error', message: 'fixture error'));
    await send(codec.encodeSuccessEnvelope({'type': 'notice', 'text': 'after-error'}));
    await leftDone.future.timeout(const Duration(seconds: 2));
    expect(right, isEmpty);
    expect(rightErrors, isEmpty);
    expect(calls, ['listen'], reason: 'pause does not deactivate the channel');
    second.resume();
    await rightDone.future.timeout(const Duration(seconds: 2));
    for (final values in [left, right]) {
      expect(values, hasLength(4));
      expect((values[0] as RuntimeStatusEvent).status.phase, RuntimePhase.running);
      final progress = values[1] as RuntimeProgressEvent;
      expect(progress.step, 'extract');
      expect(progress.fraction, 0.5);
      final line = (values[2] as RuntimeLogsEvent).entries.single;
      expect([line.seq, line.line, line.stream], [7, 'fixture line', 'stdout']);
      expect((values[3] as RuntimeNoticeEvent).text, 'after-error');
    }
    for (final errors in [leftErrors, rightErrors]) {
      expect(errors, hasLength(1));
      expect((errors.single as PlatformException).code, 'fixture_error');
    }
  }, timeout: const Timeout(Duration(seconds: 15)));
}
