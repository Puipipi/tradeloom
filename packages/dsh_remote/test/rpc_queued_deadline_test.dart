import 'dart:async';
import 'dart:typed_data';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';
import 'support/fake_rtc.dart';

const _deadline = Duration(seconds: 3);
const _watchdog = Duration(seconds: 5);

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

class _Clock {
  final entered = Completer<_Deadline>();

  Future<T> run<T>(Future<T> Function() body) => runZoned(
    body,
    zoneSpecification: ZoneSpecification(
      createTimer: (self, parent, zone, duration, callback) {
        if (duration != _deadline) return parent.createTimer(zone, duration, callback);
        final timer = _Deadline(callback);
        entered.complete(timer);
        return timer;
      },
    ),
  );
}

class _SendGate {
  final entered = Completer<void>();
  final released = Completer<void>();

  void release() {
    if (!released.isCompleted) released.complete();
  }
}

/// Delegates to the repository's ordered peer. Only one native-style send
/// Future is held, then released; no handler is emitted after close.
class _GatedPeer implements RemotePeerConnection {
  _GatedPeer(this.inner);
  final RemotePeerConnection inner;
  _SendGate? gate;
  int passBeforeGate = 0;

  @override
  Future<void> send(Uint8List data) async {
    final waiting = gate;
    if (waiting != null) {
      if (passBeforeGate > 0) {
        passBeforeGate--;
      } else {
        gate = null;
        waiting.entered.complete();
        await waiting.released.future;
      }
    }
    await inner.send(data);
  }

  @override
  Future<String> createOffer(String label) => inner.createOffer(label);
  @override
  Future<void> setAnswer(String sdp) => inner.setAnswer(sdp);
  @override
  Future<void> addIceCandidate(Map<String, Object?> candidate) => inner.addIceCandidate(candidate);
  @override
  Future<List<Map<String, Object?>>> stats() => inner.stats();
  @override
  Future<void> close() => inner.close();
}

void main() {
  late FakeRemoteServer server;
  late FakeRemoteHost host;
  late FakeRtcNetwork network;
  late RemoteAccount account;
  late DshClient client;
  late _GatedPeer peer;
  final gates = <_SendGate>[];

  setUp(() async {
    gates.clear();
    server = await FakeRemoteServer.start()
      ..webrtc = true;
    network = FakeRtcNetwork();
    host = await FakeRemoteHost.start(server)
      ..webrtc = true
      ..rtcNetwork = network;
    await host.goOffline();
    await host.goOnline();
    host.handlers['session/list'] = (_) => {
      'ok': true,
      'value': {'items': <Object?>[]},
    };
    host.handlers['session/prompt'] = (_) => {
      'ok': true,
      'value': {'accepted': true},
    };
    account = RemoteAccount(
      secrets: MemorySecretStore(),
      serverUrl: server.url,
      peerConnector: (servers, handlers) async {
        peer = _GatedPeer(await network.connector(servers, handlers));
        return peer;
      },
    );
    await account.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    client = await account.connectHost((await account.listHosts()).single);
    expect(await client.listSessions(), isEmpty);
    expect(client.remoteCarrier!.state!.transport, 'lan');
  });

  tearDown(() async {
    for (final gate in gates) {
      gate.release();
    }
    try {
      await client.listSessions().timeout(_watchdog);
    } finally {
      await account.close();
      await host.close();
      await server.close();
    }
    expect(server.protocolErrors, isEmpty);
  });

  _SendGate holdSend({int afterSends = 0}) {
    final gate = _SendGate();
    gates.add(gate);
    peer
      ..gate = gate
      ..passBeforeGate = afterSends;
    return gate;
  }

  Future<Object?> prompt(String tag, {Duration? timeout, String? text}) => client.rpc.call('session/prompt', {
    'request': {
      'requestId': tag,
      'sessionId': 'session-1',
      'mode': 'queue',
      'content': [
        {'type': 'text', 'text': text ?? tag},
      ],
    },
  }, timeout);

  List<Object?> tags() => [
    for (final call in host.calls)
      if (call.$1 == 'session/prompt') (call.$2['request']! as Map)['requestId'],
  ];

  Matcher timedOut() => isA<DshTransportException>().having(
    (error) => error.cause,
    'cause',
    isA<RemoteRpcException>()
        .having((error) => error.code, 'code', 'RPC_TIMEOUT')
        .having((error) => error.isLocal, 'isLocal', isTrue),
  );

  test('a queued expired RPC is not first sent after its caller has failed', () async {
    final session = client.remoteCarrier!.session;
    final gate = holdSend();
    final first = prompt('first');
    await gate.entered.future.timeout(_watchdog);
    final clock = _Clock();
    final expired = clock.run(() => prompt('expired', timeout: _deadline));
    final failed = expectLater(expired, throwsA(timedOut()));
    (await clock.entered.future.timeout(_watchdog)).fire();
    await failed;
    expect(tags(), isEmpty, reason: 'the earlier send still owns the queue');

    gate.release();
    await first.timeout(_watchdog);
    await prompt('barrier').timeout(_watchdog);
    // The ordered same-session barrier is behind the abandoned send, so this
    // observes its actual drain rather than checking before it can run.
    expect(client.remoteCarrier!.session, same(session));
    expect(tags(), ['first', 'barrier']);
    expect(host.handshakes, hasLength(1));
    expect(server.controlRelayFrames, 0);
    expect(server.relayFrames, 0);
  });

  test('retiring one queued RPC preserves the next live request and nonce order', () async {
    final gate = holdSend();
    final first = prompt('first');
    await gate.entered.future.timeout(_watchdog);
    final clock = _Clock();
    final expired = clock.run(() => prompt('expired', timeout: _deadline));
    final failed = expectLater(expired, throwsA(timedOut()));
    final timer = await clock.entered.future.timeout(_watchdog);
    final live = prompt('live');
    timer.fire();
    await failed;
    gate.release();
    await first.timeout(_watchdog);
    expect(await live.timeout(_watchdog), {'accepted': true});
    expect(await prompt('barrier').timeout(_watchdog), {'accepted': true});
    expect(tags(), ['first', 'live', 'barrier']);
    expect(host.handshakes, hasLength(1));
  });

  test('a queued RPC whose deadline stays active is sent normally', () async {
    final gate = holdSend();
    final first = prompt('first');
    await gate.entered.future.timeout(_watchdog);
    final clock = _Clock();
    final timely = clock.run(() => prompt('timely', timeout: _deadline));
    final timer = await clock.entered.future.timeout(_watchdog);
    expect(timer.isActive, isTrue);
    gate.release();
    await first.timeout(_watchdog);
    expect(await timely.timeout(_watchdog), {'accepted': true});
    expect(timer.isActive, isFalse);
    expect(tags(), ['first', 'timely']);
  });

  test('expiry after the first fragment does not truncate the started message', () async {
    final connection = host.connections.values.single;
    final sentBefore = network.clients.single.sent;
    final gate = holdSend(afterSends: 1);
    final clock = _Clock();
    final text = 'x' * (160 * 1024);
    final started = clock.run(() => prompt('started', text: text, timeout: _deadline));
    final failed = expectLater(started, throwsA(timedOut()));
    await gate.entered.future.timeout(_watchdog);
    expect(network.clients.single.sent, sentBefore + 1);
    expect(tags(), isEmpty, reason: 'the complete fragmented request is not yet available');
    (await clock.entered.future.timeout(_watchdog)).fire();
    await failed;
    gate.release();
    expect(await prompt('barrier').timeout(_watchdog), {'accepted': true});
    expect(host.connections.values.single, same(connection));
    expect(tags(), ['started', 'barrier']);
    final request = host.calls.firstWhere((call) => call.$1 == 'session/prompt').$2['request']! as Map;
    expect(request['content'], [
      {'type': 'text', 'text': text},
    ]);
    expect(host.handshakes, hasLength(1));
  });
}
