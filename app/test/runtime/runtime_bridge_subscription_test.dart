// Proposed owner-side regression for 5310; not in the production patch.
// Destination: app/test/runtime/runtime_bridge_subscription_test.dart.
// Compilation, formatting and execution have not been performed here.
import 'dart:async';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('runtime events deactivate at the last listener and can activate again', () async {
    const name = 'test/5310/runtime-events';
    const eventMethods = MethodChannel(name);
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final calls = <String>[];
    final listens = [Completer<void>(), Completer<void>()];
    final cancels = [Completer<void>(), Completer<void>()];
    var listenCount = 0;
    var cancelCount = 0;
    final subscriptions = <StreamSubscription<RuntimeEvent>>[];
    messenger.setMockMethodCallHandler(eventMethods, (call) async {
      calls.add(call.method);
      expect(call.arguments, isNull);
      if (call.method == 'listen') {
        expect(listenCount, lessThan(listens.length));
        listens[listenCount++].complete();
      } else if (call.method == 'cancel') {
        expect(cancelCount, lessThan(cancels.length));
        cancels[cancelCount++].complete();
      } else {
        fail('unexpected platform method: ${call.method}');
      }
      return null;
    });
    addTearDown(() async {
      for (final subscription in subscriptions) {
        await subscription.cancel();
      }
      // EOF is independent cleanup after assertions, including a failed baseline.
      // Its cancel must not count as correct last-listener cancellation.
      final ended = Completer<void>();
      await messenger.handlePlatformMessage(name, null, (_) => ended.complete());
      await ended.future.timeout(const Duration(seconds: 2));
      messenger.setMessageHandler(name, null);
      messenger.setMockMethodCallHandler(eventMethods, null);
    });

    Future<void> observed(Future<void> event) => event.timeout(const Duration(seconds: 2));
    Future<void> send(Map<String, Object?> event) async {
      final delivered = Completer<void>();
      await messenger.handlePlatformMessage(
        name,
        const StandardMethodCodec().encodeSuccessEnvelope(event),
        (ByteData? _) => delivered.complete(),
      );
      await observed(delivered.future);
    }

    final bridge = RuntimeBridge(events: const EventChannel(name));
    final events = bridge.events;
    expect(events.isBroadcast, isTrue);
    expect(identical(events, bridge.events), isTrue);
    final left = <String>[];
    final right = <String>[];
    final leftFirst = Completer<void>();
    final rightFirst = Completer<void>();
    final rightSecond = Completer<void>();
    final first = events.listen((event) {
      if (event is RuntimeNoticeEvent) {
        left.add(event.text);
        if (event.text == 'first') leftFirst.complete();
      }
    });
    subscriptions.add(first);
    final second = events.listen((event) {
      if (event is RuntimeNoticeEvent) {
        right.add(event.text);
        if (event.text == 'first') rightFirst.complete();
        if (event.text == 'second') rightSecond.complete();
      }
    });
    subscriptions.add(second);
    await observed(listens[0].future);
    await send({'type': 'unknown-fixture-event'});
    await send({'type': 'notice', 'text': 'first'});
    await observed(Future.wait([leftFirst.future, rightFirst.future]).then((_) {}));
    expect(calls, ['listen']);
    expect(left, ['first']);
    expect(right, ['first']);

    await first.cancel();
    await send({'type': 'notice', 'text': 'second'});
    await observed(rightSecond.future);
    expect(left, ['first']);
    expect(right, ['first', 'second']);
    expect(calls, ['listen'], reason: 'one listener still owns the channel');

    await second.cancel();
    // Wait for the actual mock channel request, not only cancel()'s Future.
    await observed(cancels[0].future);
    await Future<void>.delayed(Duration.zero);
    expect(calls, ['listen', 'cancel']);

    final resumed = Completer<void>();
    final resumedValues = <String>[];
    final third = events.listen((event) {
      if (event is RuntimeNoticeEvent) {
        resumedValues.add(event.text);
        if (event.text == 'after-relisten') resumed.complete();
      }
    });
    subscriptions.add(third);
    await observed(listens[1].future);
    await send({'type': 'notice', 'text': 'after-relisten'});
    await observed(resumed.future);
    expect(resumedValues, ['after-relisten']);
    expect(left, ['first']);
    expect(right, ['first', 'second']);
    await third.cancel();
    await observed(cancels[1].future);
    expect(calls, ['listen', 'cancel', 'listen', 'cancel']);
  }, timeout: const Timeout(Duration(seconds: 15)));
}
