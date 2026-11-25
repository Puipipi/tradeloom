// Real REST, Control/Relay WebSockets, Noise and RemoteRpcClient. Only the
// existing RPC deadline and the Host's open reply are explicitly scheduled.
import 'dart:async';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';

// Public per-call deadline, below the existing 25-second health interval.
const _callTimeout = Duration(seconds: 3);
const _watchdog = Duration(seconds: 5);
final _largeText = 'x' * (3 * 1024 * 1024);

class _Deadline implements Timer {
  _Deadline(this.callback);
  final void Function() callback;
  bool active = true;
  int ticks = 0;

  void fire() {
    expect(active, isTrue);
    active = false;
    ticks++;
    callback();
  }

  @override
  void cancel() => active = false;
  @override
  bool get isActive => active;
  @override
  int get tick => ticks;
}

class _RpcDeadlines {
  final timers = <_Deadline>[];

  Future<T> run<T>(Future<T> Function() body) => runZoned(
    body,
    zoneSpecification: ZoneSpecification(
      createTimer: (self, parent, zone, duration, callback) {
        if (duration != _callTimeout) return parent.createTimer(zone, duration, callback);
        final timer = _Deadline(callback);
        timers.add(timer);
        return timer;
      },
    ),
  );
}

class _OpenGate {
  final entered = Completer<String>();
  final reply = Completer<void>();

  Future<void> hold(String transferId) {
    entered.complete(transferId);
    return reply.future;
  }

  void release() {
    if (!reply.isCompleted) reply.complete();
  }
}

void main() {
  late FakeRemoteServer server;
  late FakeRemoteHost host;
  late RemoteAccount account;
  late DshClient client;
  final gates = <_OpenGate>[];

  setUp(() async {
    gates.clear();
    server = await FakeRemoteServer.start();
    host = await FakeRemoteHost.start(server);
    host.handlers['session/list'] = (_) => {
      'ok': true,
      'value': {'items': <Object?>[]},
    };
    host.handlers['session/prompt'] = (_) => {
      'ok': true,
      'value': {'accepted': true},
    };
    account = RemoteAccount(secrets: MemorySecretStore(), serverUrl: server.url);
    await account.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    client = await account.connectHost((await account.listHosts()).single);
  });

  tearDown(() async {
    for (final gate in gates) {
      gate.release();
    }
    try {
      // Release held replies before closing the real sockets, including when
      // an assertion failed. The same-connection reply drains earlier frames.
      await client.listSessions().timeout(_watchdog);
    } finally {
      await account.close();
      await host.close();
      await server.close();
    }
    expect(server.protocolErrors, isEmpty);
  });

  _OpenGate newGate() {
    final gate = _OpenGate();
    gates.add(gate);
    return gate;
  }

  Matcher timedOut() => isA<DshTransportException>().having(
    (error) => error.cause,
    'cause',
    isA<RemoteRpcException>()
        .having((error) => error.code, 'code', 'RPC_TIMEOUT')
        .having((error) => error.isLocal, 'isLocal', isTrue),
  );

  Future<Object?> largeCall(String requestId) => client.rpc.call('session/prompt', {
    'request': {
      'requestId': requestId,
      'sessionId': 'session-1',
      'mode': 'queue',
      'content': [
        {'type': 'text', 'text': _largeText},
      ],
    },
  }, _callTimeout);

  int calls(String method) => host.rpcMethods.where((value) => value == method).length;

  test('open timeout releases an accepted transfer after its late real reply', () async {
    final gate = newGate();
    host.beforeTransferOpenResponse = gate.hold;
    final deadlines = _RpcDeadlines();
    final pending = deadlines.run(() => largeCall('expired'));
    final failed = expectLater(pending, throwsA(timedOut()));
    final transferId = await gate.entered.future.timeout(_watchdog);
    final connection = host.connections.values.single;
    expect(connection.transfers.keys, [transferId]);
    expect(deadlines.timers, hasLength(1));
    deadlines.timers.single.fire();
    await failed;

    // Completing the caller's Future is not evidence that cleanup has arrived.
    // Release the old reply, then receive a later real RPC on the same ordered
    // encrypted connection before inspecting the Host's transfer allocation.
    gate.release();
    await client.listSessions().timeout(_watchdog);
    expect(host.connections.values.single, same(connection));
    expect(connection.transfers, isEmpty);
    expect(calls('harness.remote.transfer.open'), 1);
    expect(calls('harness.remote.transfer.close'), 1);
    expect(calls('harness.remote.transfer.chunk'), 0);
    expect(calls('harness.remote.transfer.commit'), 0);
    expect(host.calls.where((call) => call.$1 == 'session/prompt'), isEmpty);
  });

  test('an expired open closes only its UUID while another open is pending', () async {
    final firstGate = newGate();
    final secondGate = newGate();
    var opens = 0;
    host.beforeTransferOpenResponse = (id) => (opens++ == 0 ? firstGate : secondGate).hold(id);
    final firstDeadlines = _RpcDeadlines();
    final first = firstDeadlines.run(() => largeCall('first'));
    final firstFailed = expectLater(first, throwsA(timedOut()));
    final firstId = await firstGate.entered.future.timeout(_watchdog);
    final secondDeadlines = _RpcDeadlines();
    final second = secondDeadlines.run(() => largeCall('second'));
    second.ignore(); // A failed assertion still permits teardown to close it.
    final secondId = await secondGate.entered.future.timeout(_watchdog);
    final connection = host.connections.values.single;
    expect(secondId, isNot(firstId));
    expect(connection.transfers.keys, unorderedEquals([firstId, secondId]));
    firstDeadlines.timers.single.fire();
    await firstFailed;
    firstGate.release();
    await client.listSessions().timeout(_watchdog);
    expect(connection.transfers.keys, [secondId]);
    expect(calls('harness.remote.transfer.close'), 1);
    expect(host.calls.where((call) => call.$1 == 'session/prompt'), isEmpty);

    secondGate.release();
    expect(await second.timeout(_watchdog), {'accepted': true});
    await client.listSessions().timeout(_watchdog);
    expect(host.connections.values.single, same(connection));
    expect(connection.transfers, isEmpty);
    expect(calls('harness.remote.transfer.open'), 2);
    expect(calls('harness.remote.transfer.commit'), 1);
    expect(calls('harness.remote.transfer.close'), 2);
    final prompts = host.calls.where((call) => call.$1 == 'session/prompt').toList();
    expect(prompts, hasLength(1));
    expect((prompts.single.$2['request']! as Map)['requestId'], 'second');
  });

  test('a timely large prompt still commits once and closes its transfer', () async {
    final result = await client.prompt('session-1', _largeText, requestId: 'timely');
    await client.listSessions().timeout(_watchdog);
    expect(result, 'timely');
    expect(host.connections.values.single.transfers, isEmpty);
    expect(calls('harness.remote.transfer.open'), 1);
    expect(calls('harness.remote.transfer.commit'), 1);
    expect(calls('harness.remote.transfer.close'), 1);
    final prompt = host.calls.singleWhere((call) => call.$1 == 'session/prompt').$2['request']! as Map;
    expect((prompt['content']! as List).single, {'type': 'text', 'text': _largeText});
  });

  test('a small prompt remains a direct call without any transfer cleanup', () async {
    expect(await client.prompt('session-1', 'hello', requestId: 'small'), 'small');
    await client.listSessions().timeout(_watchdog);
    expect(host.rpcMethods.where((method) => method.startsWith('harness.remote.transfer.')), isEmpty);
    expect(host.calls.where((call) => call.$1 == 'session/prompt'), hasLength(1));
    expect(host.connections.values.single.transfers, isEmpty);
  });
}
