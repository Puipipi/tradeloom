import 'dart:async';

import 'package:dsh_app/notify/notify_channel.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../notify/support.dart' show settle;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const methods = MethodChannel('dsh/notify');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const post = NotifyPost(
    group: 'local|s1',
    key: 'phone-1',
    attention: true,
    title: 'DSH Go',
    text: 'Task complete',
    publicText: 'Task ended',
    sessionId: 's1',
    host: HostRef.local,
    kind: 'phone-result',
  );
  final calls = <MethodCall>[];
  late Future<Object?> Function(MethodCall) reply;

  setUp(() {
    calls.clear();
    reply = (call) async => call.method == 'status' ? {'enabled': true, 'done': true, 'attention': true} : null;
    messenger.setMockMethodCallHandler(methods, (call) {
      calls.add(call);
      return reply(call);
    });
  });
  tearDown(() => messenger.setMockMethodCallHandler(methods, null));

  test('an accepted operational notice preserves its exact task route', () async {
    expect(await NotifyChannel().tryShow(post), isTrue);
    expect(calls.map((c) => c.method), ['status', 'show']);
    expect(calls.last.arguments, post.toMap());
  });

  for (final blocked in ['enabled', 'attention']) {
    test('a blocked $blocked gate refuses the result notice', () async {
      reply = (call) async => {'enabled': true, 'attention': true, blocked: false};
      expect(await NotifyChannel().tryShow(post), isFalse);
      expect(calls.map((c) => c.method), ['status']);
    });
  }

  test('a channel exception is not reported as an accepted notice', () async {
    reply = (call) async {
      if (call.method == 'status') return {'enabled': true, 'attention': true};
      throw PlatformException(code: 'notifications-unavailable');
    };
    expect(await NotifyChannel().tryShow(post), isFalse);
    expect(calls.map((c) => c.method), ['status', 'show']);
  });

  test('an absent native plugin does not claim that the notice was delivered', () async {
    reply = (call) async => throw MissingPluginException();
    expect(await NotifyChannel().tryShow(post), isFalse);
    expect(calls.map((c) => c.method), ['status']);
  });

  test('a late status answer cannot post for an expired task scope', () async {
    final status = Completer<Object?>();
    reply = (call) => status.future;
    var current = true;
    final result = NotifyChannel().tryShow(post, stillCurrent: () => current);
    await settle();
    expect(calls.map((c) => c.method), ['status']);
    current = false;
    status.complete({'enabled': true, 'attention': true});
    expect(await result, isFalse);
    expect(calls.map((c) => c.method), ['status']);
  });
}
