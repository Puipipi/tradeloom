import 'dart:async';
import 'dart:convert';
import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';
import 'support/rpc_encoding_host.dart';

class _ManualTimer implements Timer {
  _ManualTimer(this.callback);
  final void Function() callback;
  bool active = true;
  int ticks = 0;
  @override
  void cancel() {
    active = false;
  }

  @override
  bool get isActive => active;
  @override
  int get tick => ticks;
  void fire() {
    if (!active) return;
    active = false;
    ticks++;
    callback();
  }
}

class _Clock {
  final timers = <_ManualTimer>[];
  final durations = <Duration>[];
  ZoneSpecification get specification => ZoneSpecification(
    createTimer: (self, parent, zone, duration, callback) {
      final timer = _ManualTimer(callback);
      timers.add(timer);
      durations.add(duration);
      return timer;
    },
  );
}

class _ThrowingJson {
  _ThrowingJson(this.failure);
  final Object failure;
  Object toJson() => throw failure;
}

void main() {
  late EncodingHost f;
  setUp(() async {
    f = EncodingHost();
    await f.start();
  });
  tearDown(() async => f.close());

  ({Object? error, List<Object> orphanErrors, _Clock clock}) failedCall(Object? params) {
    Object? error;
    final orphanErrors = <Object>[];
    final clock = _Clock();
    runZonedGuarded(
      () {
        try {
          f.rpc.call('encode-failure', params);
        } catch (e) {
          error = e;
        }
      },
      (e, s) => orphanErrors.add(e),
      zoneSpecification: clock.specification,
    );
    return (error: error, orphanErrors: orphanErrors, clock: clock);
  }

  test('unsupported JSON revokes only its timer and does not emit an orphan close error', () async {
    final attempt = failedCall(Object());
    expect(attempt.error, isA<JsonUnsupportedObjectError>());
    expect(attempt.clock.timers, hasLength(1));
    expect(attempt.clock.durations, [f.rpc.defaultTimeout]);
    final activeBeforeClose = attempt.clock.timers.single.isActive;
    await f.rpc.close();
    await f.streamDone.future;
    await Future<void>.microtask(() {});
    print({'timerActiveAfterEncodingFailure': activeBeforeClose, 'orphanErrorsOnClose': attempt.orphanErrors.length});
    expect(activeBeforeClose, isFalse);
    expect(attempt.orphanErrors, isEmpty);
  });
  test('nonfinite numbers and cycles retain synchronous JSON exceptions without active timers', () async {
    final cycle = <Object?>[];
    cycle.add(cycle);
    for (final params in [double.nan, cycle]) {
      final attempt = failedCall(params);
      expect(attempt.error, isA<JsonUnsupportedObjectError>());
      expect(attempt.clock.timers.single.isActive, isFalse);
      expect(attempt.orphanErrors, isEmpty);
    }
  });
  test('toJson failure retains its original cause and records timer before encoding', () async {
    final cause = StateError('serializer failed');
    final clock = _Clock();
    final orphanErrors = <Object>[];
    Object? error;
    final payload = _TimingJson(cause, () => expect(clock.timers.single.isActive, isTrue));
    runZonedGuarded(
      () {
        try {
          f.rpc.call('encode-failure', payload);
        } catch (e) {
          error = e;
        }
      },
      (e, s) => orphanErrors.add(e),
      zoneSpecification: clock.specification,
    );
    expect(error, isA<JsonUnsupportedObjectError>().having((e) => e.cause, 'cause', same(cause)));
    expect(clock.timers.single.isActive, isFalse);
    expect(orphanErrors, isEmpty);
  });
  test('128 rejected encodings do not consume capacity for a subsequent valid RPC', () async {
    final attempts = [for (var i = 0; i < maxPendingRpc; i++) failedCall(Object())];
    expect(attempts.every((a) => a.error is JsonUnsupportedObjectError), isTrue);
    final pending = f.rpc.call('valid', {'ok': true}).then<Object?>((v) => v, onError: (Object e) => e);
    final entered = await Future.any<Object?>([f.request.future, pending]);
    expect(entered, isA<RemoteMessage>());
    final request = entered! as RemoteMessage;
    expect((request.payload! as Map)['method'], 'valid');
    f.sendBytes(RemoteMessage('rpc.response', {'requestId': request.id, 'result': 'ok'}).encode());
    expect(await pending, 'ok');
    expect(attempts.every((a) => !a.clock.timers.single.isActive), isTrue);
    await f.rpc.close();
    await f.streamDone.future;
    await Future<void>.microtask(() {});
    expect(attempts.expand((a) => a.orphanErrors), isEmpty);
  });
  test('encoding rejection does not cancel another live RPC', () async {
    final clock = _Clock();
    final pending = runZoned(() => f.rpc.call('existing', {}), zoneSpecification: clock.specification);
    final request = await f.request.future;
    final rejected = failedCall(Object());
    expect(rejected.error, isA<JsonUnsupportedObjectError>());
    expect(clock.timers.single.isActive, isTrue);
    f.sendBytes(RemoteMessage('rpc.response', {'requestId': request.id, 'result': 17}).encode());
    expect(await pending, 17);
    expect(clock.timers.single.isActive, isFalse);
    expect(rejected.clock.timers.single.isActive, isFalse);
  });
  test('valid RPC deadline still starts before send and expires with original class', () async {
    final clock = _Clock();
    final pending = runZoned(
      () => f.rpc.call('deadline', {}, timeout: const Duration(seconds: 7)),
      zoneSpecification: clock.specification,
    );
    final checked = expectLater(
      pending,
      throwsA(
        isA<RemoteRpcException>().having((e) => e.code, 'code', 'RPC_TIMEOUT').having((e) => e.isLocal, 'local', true),
      ),
    );
    await f.request.future;
    expect(clock.durations, [const Duration(seconds: 7)]);
    expect(clock.timers.single.isActive, isTrue);
    clock.timers.single.fire();
    await checked;
    expect(f.rpc.isClosed, isFalse);
  });
}

class _TimingJson extends _ThrowingJson {
  _TimingJson(super.failure, this.entered);
  final void Function() entered;
  @override
  Object toJson() {
    entered();
    return super.toJson();
  }
}
