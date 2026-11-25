// Regressions integrated from the independent review of P12 a07b2d4.
// Original same-byte evidence remains in independent-dart-review/.
// The transport controls response timing; DshClient and ChatController are real.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/pets/pet_signals.dart';
import 'package:dsh_app/state/attachments.dart';
import 'package:dsh_app/state/chat_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _Selection extends Notifier<AsyncValue<HostConnection?>> {
  @override
  AsyncValue<HostConnection?> build() => const AsyncData(null);
  void use(_Client? client) =>
      state = AsyncData(client == null ? null : HostConnection(client: client, label: client.wire.name, isLocal: true));
}

final _selection = NotifierProvider<_Selection, AsyncValue<HostConnection?>>(_Selection.new);

class _Local extends LocalConnectionController {
  @override
  Future<HostConnection?> build() async => ref.watch(_selection).value;
}

class _Call {
  _Call(this.endpoint, this.args);
  final String endpoint;
  final Map<String, Object?> args;
  final done = Completer<RpcResult>();
  Map<String, Object?> get json => {'endpoint': endpoint, 'args': args, 'completed': done.isCompleted};
}

class _Link extends DshMuxLink {
  _Link(this.number);
  final int number;
  late DshMuxFrameHandler frames;
  @override
  void start({required DshMuxFrameHandler onFrame, required DshMuxLossHandler onLost}) => frames = onFrame;
  @override
  void open(String streamId, String endpoint, Map<String, Object?> payload) {
    if (endpoint == r'$events') {
      scheduleMicrotask(
        () => frames({
          'type': 'item',
          'streamId': streamId,
          'value': {
            'type': 'ready',
            'clientId': 'generation-$number',
            'host': {'home': '/test'},
          },
        }),
      );
    }
  }

  @override
  void sendItem(String streamId, Object? value) {}
  @override
  void endUplink(String streamId) {}
  @override
  void cancel(String streamId) {}
  @override
  Future<void> close(int code, String reason) async {}
}

class _Wire extends DshCarrier {
  _Wire(this.name, {this.real});
  final String name;
  final DshHttpCarrier? real;
  final hold = <String>{'session/cancel', 'session/list'};
  final calls = <_Call>[];
  final links = <_Link>[];
  bool closed = false;
  @override
  String get kind => 'independent-controlled-live';
  @override
  DshTracer? get tracer => null;
  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) {
    final call = _Call(endpoint, args);
    calls.add(call);
    if (real case final carrier?) {
      unawaited(
        carrier.call(endpoint, args, timeout: timeout).then(call.done.complete, onError: call.done.completeError),
      );
      return call.done.future;
    }
    if (!hold.contains(endpoint)) call.done.complete(const RpcOk(null));
    return call.done.future;
  }

  List<_Call> at(String endpoint) => calls.where((c) => c.endpoint == endpoint).toList();
  void answer(String endpoint, int index, [RpcResult result = const RpcOk(null)]) =>
      at(endpoint)[index].done.complete(result);
  @override
  Future<DshMuxLink> openLink(MuxOptions options) async {
    final link = _Link(links.length + 1);
    links.add(link);
    return link;
  }

  @override
  Future<void> close() async {
    closed = true;
    await real?.close();
  }
}

class _RealHttp extends HttpOverrides {}

class _Peer {
  _Peer(this.server) {
    server.listen((request) async {
      final body = jsonDecode(await utf8.decoder.bind(request).join()) as Map<String, dynamic>;
      final endpoint = body['method'] as String;
      final payload = body['payload'] as Map<String, dynamic>;
      final call = _Call(endpoint, Map<String, Object?>.from(payload['args'] as Map));
      received.add(call);
      if (!hold.contains(endpoint)) call.done.complete(const RpcOk(null));
      final result = await call.done.future;
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'type': 'server-response',
          'rpcId': body['rpcId'],
          'result': switch (result) {
            RpcOk(:final value) => {'ok': true, 'value': value},
            RpcError(:final error) => {
              'ok': false,
              'error': {'code': error.code, 'message': error.message},
            },
          },
        }),
      );
      await request.response.close();
    });
  }
  final HttpServer server;
  final hold = <String>{};
  final received = <_Call>[];
  static Future<_Peer> start() async => _Peer(await HttpServer.bind(InternetAddress.loopbackIPv4, 0));
  DshHttpCarrier carrier() => DshHttpCarrier(DshConnection(Uri.parse('http://127.0.0.1:${server.port}')));
  List<_Call> at(String endpoint) => received.where((c) => c.endpoint == endpoint).toList();
  Future<void> close() async {
    for (final c in received) {
      if (!c.done.isCompleted) c.done.complete(const RpcOk(null));
    }
    await server.close(force: true);
  }
}

class _Client extends DshClient {
  _Client(String name) : this._(_Wire(name));
  _Client._(this.wire) : super.withCarrier(wire);
  final _Wire wire;
  final events = StreamController<DshEvent>.broadcast();
  final hosts = StreamController<HostEvent>.broadcast();
  int watches = 0;
  @override
  Stream<DshEvent> watch(String sessionId, {WatchOptions options = const WatchOptions()}) {
    watches++;
    return events.stream;
  }

  @override
  Stream<HostEvent> get hostEvents => hosts.stream;
  void running({List<String> inbox = const []}) {
    events.add(
      SessionSnapshotEvent.fromJson('S', {
        'cursor': -1,
        'records': <Object?>[],
        'projections': {
          'asOfSeq': -1,
          'values': {
            'inbox': {
              'next-turn': [
                for (final id in inbox)
                  {
                    'id': id,
                    'role': 'user',
                    'content': [
                      {'type': 'text', 'text': id},
                    ],
                    'source': {'kind': 'user', 'rpcId': 'request-$id'},
                  },
              ],
              'next-step': <Object?>[],
            },
          },
        },
      }),
    );
    events.add(const SessionStatusEvent('S', true));
  }

  Future<void> finish() async {
    for (final call in wire.calls) {
      if (!call.done.isCompleted) {
        call.done.complete(call.endpoint == 'session/list' ? const RpcOk({'items': <Object?>[]}) : const RpcOk(null));
      }
    }
    await events.close();
    await hosts.close();
    await close();
  }
}

class _Harness {
  _Harness({bool pets = false}) {
    container = ProviderContainer(
      overrides: [
        activeConnectionProvider.overrideWith((ref) => ref.watch(_selection)),
        if (pets) localConnectionProvider.overrideWith(_Local.new),
      ],
    );
    container.listen(chatProvider('S'), (_, _) {});
    if (pets) container.listen(petRunsProvider, (_, _) {});
  }
  late final ProviderContainer container;
  final clients = <_Client>[];
  _Client client(String name) {
    final c = _Client(name);
    clients.add(c);
    return c;
  }

  ChatController get chat => container.read(chatProvider('S').notifier);
  ChatState get state => container.read(chatProvider('S'));
  void select(_Client c) => container.read(_selection.notifier).use(c);
  Future<void> use(_Client c) async {
    select(c);
    await container.pump();
  }

  Future<void> ready(_Client c, {List<String> inbox = const []}) async {
    c.running(inbox: inbox);
    // The controller publishes the status on its next coalesced frame (a
    // 32 ms timer started when the event is handled). Wait for that state,
    // not for a fixed 60 ms: on a loaded machine the event can be handled
    // late enough that the fixed wait ends first (the file's first test,
    // still compiling, under the full suite).
    await until(() => state.running);
    await settle();
    expect(state.running, isTrue);
  }

  Future<void> close() async {
    container.dispose();
    for (final c in clients) {
      await c.finish();
    }
  }
}

Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 60));
Future<void> until(bool Function() predicate) async {
  for (var i = 0; i < 200 && !predicate(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  expect(predicate(), isTrue, reason: 'Independent setup must reach the requested await boundary');
}

RpcError oldFailure() => const RpcError(DshRemoteException('independent/old-failure', 'retired operation'));
void _trace(String scenario, _Harness h, _Client a, [_Client? b]) => debugPrint(
  'P12_REVIEW ${jsonEncode({'scenario': scenario, 'stopping': h.state.stopping, 'error': h.state.error, 'pending': h.state.pending.map((p) => p.requestId).toList(), 'callsA': a.wire.calls.map((c) => c.json).toList(), if (b != null) 'callsB': b.wire.calls.map((c) => c.json).toList()})}',
);

Map<String, Object?> summary(String id, bool running, {String? parent}) => {
  'sessionId': id,
  'running': running,
  'updatedAt': 1792700000000,
  'blank': false,
  'agentAvailable': true,
  if (parent != null) ...{'origin': 'subagent', 'parentSessionId': parent},
};
RpcOk sessions(List<Map<String, Object?>> items) => RpcOk({'items': items});
Future<(_Harness, _Client)> _petHarness() async {
  final h = _Harness(pets: true), a = _Client('pet-A');
  h.clients.add(a);
  await h.use(a);
  await until(() => a.hosts.hasListener);
  a.hosts.add(const HostReadyEvent('ready-1', '/test'));
  await until(() => a.wire.at('session/list').length == 1);
  return (h, a);
}

void _petTrace(String scenario, _Harness h, _Client a) => debugPrint(
  'P12_REVIEW ${jsonEncode({
    'scenario': scenario,
    'listCalls': a.wire.at('session/list').length,
    'runs': h.container.read(petRunsProvider).map((r) => {'id': r.sessionId, 'root': r.root, 'subagent': r.subagent}).toList(),
  })}',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('D1 cancel: old queue removal failure must not write replacement state', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('A'), b = h.client('B');
    a.wire.hold.add('session/updateQueue');
    await h.use(a);
    await h.ready(a, inbox: ['old-last']);
    final old = h.chat.cancel();
    a.wire.answer('session/cancel', 0);
    await until(() => a.wire.at('session/updateQueue').isNotEmpty);
    await h.use(b);
    await h.ready(b);
    final current = h.chat.cancel();
    a.wire.answer('session/updateQueue', 0, oldFailure());
    await old;
    _trace('D1-takeOut-late-failure', h, a, b);
    final error = h.state.error;
    b.wire.answer('session/cancel', 0);
    await current;
    expect(error, isNull, reason: 'The guard after _takeOut is too late to undo its catch mutation');
  });

  test('D2 cancel: old putBack prompt failure must not write replacement state', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('A'), b = h.client('B');
    a.wire.hold.add('session/prompt');
    await h.use(a);
    await h.ready(a, inbox: ['old-last']);
    final old = h.chat.cancel();
    a.wire.answer('session/cancel', 0);
    await until(() => a.wire.at('session/prompt').isNotEmpty);
    await h.use(b);
    await h.ready(b);
    final current = h.chat.cancel();
    a.wire.answer('session/prompt', 0, oldFailure());
    await old;
    _trace('D2-putBack-late-failure', h, a, b);
    final error = h.state.error;
    b.wire.answer('session/cancel', 0);
    await current;
    expect(error, isNull, reason: '_putBack must carry the original operation identity through its own awaits');
  });

  test('D3 sendNow: replacement during first remove must not dequeue later old items', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('A'), b = h.client('B');
    a.wire.hold.add('session/updateQueue');
    await h.use(a);
    await h.ready(a, inbox: ['first', 'behind']);
    final prompt = h.state.pending.singleWhere((p) => p.inboxId == 'first');
    final old = h.chat.sendNow(prompt);
    await until(() => a.wire.at('session/updateQueue').length == 1);
    await h.use(b);
    await h.ready(b);
    a.wire.hold.removeAll(['session/updateQueue', 'session/cancel']);
    a.wire.answer('session/updateQueue', 0);
    await old;
    _trace('D3-sendNow-late-remove', h, a, b);
    expect(
      a.wire.at('session/updateQueue'),
      hasLength(1),
      reason: 'Restoring an already removed item is a separate policy; removing additional items after retirement is not compensation',
    );
  });

  test('D4 interrupt: stale stop result must not become a new steer on the old client', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('A'), b = h.client('B');
    await h.use(a);
    await h.ready(a);
    final old = h.chat.send('old interrupt text', mode: SendMode.interrupt);
    await until(() => a.wire.at('session/cancel').length == 1);
    await h.use(b);
    await h.ready(b);
    a.wire.answer('session/cancel', 0);
    final result = await old;
    _trace('D4-interrupt-stale-stop', h, a, b);
    debugPrint('P12_REVIEW interruptReturned=$result');
    expect(
      a.wire.at('session/prompt'),
      isEmpty,
      reason: 'Connection retirement is not the genuine stop rejection that permits steering fallback',
    );
    expect(h.state.error, isNull);
  });

  testWidgets('D5 same-client ten-second retry: first failure must not end second stop', (tester) async {
    final h = _Harness();
    final a = h.client('A');
    h.select(a);
    h.state;
    await tester.pump();
    expect(a.watches, 1, reason: 'Subscribe before the broadcast snapshot is sent');
    a.running();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(h.state.running, isTrue);
    final first = h.chat.cancel();
    await tester.pump(const Duration(seconds: 10));
    expect(h.state.stopping, isFalse);
    final second = h.chat.cancel();
    expect(a.wire.at('session/cancel'), hasLength(2));
    a.wire.answer('session/cancel', 0, oldFailure());
    await tester.pump();
    await first;
    final stopping = h.state.stopping;
    _trace('D5-same-client-stop-retry', h, a);
    a.wire.answer('session/cancel', 1);
    await tester.pump();
    await second;
    await h.close();
    expect(stopping, isTrue, reason: 'Ref and client are unchanged; an operation identity is also needed');
  });

  test('D6 actual mux generation: late old failure must not end the new stop', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('A');
    expect((await a.mux.start()).number, 1);
    await h.use(a);
    await h.ready(a);
    final first = h.chat.cancel();
    a.mux.reconnect();
    expect((await a.mux.ready()).number, 2);
    a.events.add(const SessionStatusEvent('S', false));
    await settle();
    await h.ready(a);
    final second = h.chat.cancel();
    expect(a.wire.at('session/cancel'), hasLength(2));
    a.wire.answer('session/cancel', 0, oldFailure());
    await first;
    final stopping = h.state.stopping;
    _trace('D6-real-mux-generation', h, a);
    debugPrint('P12_REVIEW generation=${a.mux.generation?.number} watches=${a.watches}');
    a.wire.answer('session/cancel', 1);
    await second;
    expect(stopping, isTrue, reason: 'A real new mux ready generation did not rebuild the same client provider');
  });

  test('D7 putBack upload: retirement before receipt must prevent the following old prompt', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('A'), b = h.client('B');
    a.wire.hold.add('fileUploads/upload');
    await h.use(a);
    await h.ready(a, inbox: ['file-item']);
    final prompt = PendingPrompt(
      requestId: 'request-file-item',
      text: 'file-item',
      time: DateTime.now(),
      mode: SendMode.queue,
      inboxId: 'file-item',
      slot: InboxSlot.nextTurn,
      attachments: [
        DraftAttachment.sniff('notes.txt', Uint8List.fromList([65, 66, 67])),
      ],
    );
    final old = h.chat.sendNow(prompt);
    await until(() => a.wire.at('session/cancel').length == 1);
    a.wire.answer('session/cancel', 0);
    await until(() => a.wire.at('fileUploads/upload').length == 1);
    await h.use(b);
    await h.ready(b);
    a.wire.answer(
      'fileUploads/upload',
      0,
      const RpcOk({
        'receiptId': 'old-receipt',
        'file': {'name': 'notes.txt', 'bytes': 3},
      }),
    );
    await old;
    _trace('D7-putBack-receipt-late', h, a, b);
    expect(
      a.wire.at('session/prompt'),
      isEmpty,
      reason: 'The receipt wait is another operation boundary before a new RPC',
    );
  });

  test('D8 real closed HTTP: late in-flight queue error must not pollute replacement', () async {
    await HttpOverrides.runWithHttpOverrides(() async {
      final peer = await _Peer.start();
      peer.hold.add('session/updateQueue');
      final h = _Harness();
      addTearDown(() async {
        await h.close();
        await peer.close();
      });
      final a = _Client._(_Wire('closed-HTTP-A', real: peer.carrier()));
      h.clients.add(a);
      final b = h.client('B');
      await h.use(a);
      await h.ready(a, inbox: ['old-last']);
      final old = h.chat.cancel();
      await until(() => peer.at('session/updateQueue').isNotEmpty);
      await a.close();
      expect(a.wire.closed, isTrue);
      await h.use(b);
      await h.ready(b);
      final current = h.chat.cancel();
      peer.at('session/updateQueue').single.done.complete(oldFailure());
      await old;
      _trace('D8-closed-HTTP-inflight-queue', h, a, b);
      debugPrint('P12_REVIEW peerReceived=${jsonEncode(peer.received.map((c) => c.json).toList())}');
      final error = h.state.error;
      b.wire.answer('session/cancel', 0);
      await current;
      expect(peer.received.map((c) => c.endpoint), ['session/cancel', 'session/updateQueue']);
      expect(error, isNull, reason: 'Graceful close permits the already sent remove response to arrive late');
    }, _RealHttp());
  });

  test('D9 surviving HTTP: invalidated interrupt must not physically send an old steer', () async {
    await HttpOverrides.runWithHttpOverrides(() async {
      final peer = await _Peer.start();
      peer.hold.add('session/cancel');
      final h = _Harness();
      addTearDown(() async {
        await h.close();
        await peer.close();
      });
      final a = _Client._(_Wire('retained-HTTP-A', real: peer.carrier()));
      h.clients.add(a);
      final b = h.client('B');
      await h.use(a);
      await h.ready(a);
      final old = h.chat.send('old host text', mode: SendMode.interrupt);
      await until(() => peer.at('session/cancel').isNotEmpty);
      await h.use(b);
      await h.ready(b);
      expect(a.wire.closed, isFalse);
      peer.at('session/cancel').single.done.complete(const RpcOk(null));
      await old;
      _trace('D9-surviving-HTTP-interrupt', h, a, b);
      debugPrint('P12_REVIEW peerReceived=${jsonEncode(peer.received.map((c) => c.json).toList())}');
      expect(
        peer.at('session/prompt'),
        isEmpty,
        reason: 'An old carrier may remain usable when another observer retains that host',
      );
    }, _RealHttp());
  });

  test('P1 PetRuns: already-false status during list must defeat old true', () async {
    final (h, a) = await _petHarness();
    addTearDown(h.close);
    a.hosts.add(const SessionStatusEvent('S', false));
    a.hosts.add(const SessionStatusEvent('S', false));
    await settle();
    a.wire.answer('session/list', 0, sessions([summary('S', true)]));
    await settle();
    _petTrace('P1-idempotent-false', h, a);
    expect(h.container.read(petRunsProvider), isEmpty);
    expect(a.wire.at('session/list'), hasLength(1));
  });

  test('P2 PetRuns: removal during list must leave a tombstone', () async {
    final (h, a) = await _petHarness();
    addTearDown(h.close);
    a.hosts.add(const SessionRemovedEvent('S'));
    await settle();
    a.wire.answer('session/list', 0, sessions([summary('S', true)]));
    await settle();
    _petTrace('P2-removed', h, a);
    expect(h.container.read(petRunsProvider), isEmpty);
  });

  test('P3 PetRuns: newer added lineage survives the older list', () async {
    final (h, a) = await _petHarness();
    addTearDown(h.close);
    a.hosts.add(SessionAddedEvent(SessionSummary.fromJson(summary('child', true, parent: 'new-parent'))));
    await settle();
    a.wire.answer('session/list', 0, sessions([summary('child', true, parent: 'old-parent')]));
    await settle();
    _petTrace('P3-new-info', h, a);
    final run = h.container.read(petRunsProvider).single;
    expect(run.root, 'new-parent');
    expect(run.subagent, isTrue);
  });

  test('P4 PetRuns: remove then add false cannot resurrect the previous incarnation', () async {
    final (h, a) = await _petHarness();
    addTearDown(h.close);
    a.hosts.add(const SessionRemovedEvent('S'));
    a.hosts.add(SessionAddedEvent(SessionSummary.fromJson(summary('S', false))));
    a.hosts.add(const SessionStatusEvent('S', false));
    await settle();
    a.wire.answer('session/list', 0, sessions([summary('S', true)]));
    await settle();
    _petTrace('P4-remove-add', h, a);
    expect(h.container.read(petRunsProvider), isEmpty);
  });

  test('P5 PetRuns: ready burst discards old result and requests exactly one fresh list', () async {
    final (h, a) = await _petHarness();
    addTearDown(h.close);
    a.hosts.add(const HostReadyEvent('ready-2', '/test'));
    a.hosts.add(const HostReadyEvent('ready-3', '/test'));
    await settle();
    a.wire.answer('session/list', 0, sessions([summary('old', true)]));
    await until(() => a.wire.at('session/list').length == 2);
    expect(h.container.read(petRunsProvider), isEmpty);
    a.wire.answer('session/list', 1, sessions([summary('new', true)]));
    await settle();
    _petTrace('P5-ready-burst', h, a);
    expect(h.container.read(petRunsProvider).map((r) => r.sessionId), ['new']);
    expect(a.wire.at('session/list'), hasLength(2));
  });

  test('P6 PetRuns: ready queued behind a failed list still refreshes exactly once', () async {
    final (h, a) = await _petHarness();
    addTearDown(h.close);
    a.hosts.add(const HostReadyEvent('ready-2', '/test'));
    await settle();
    a.wire.answer('session/list', 0, oldFailure());
    await until(() => a.wire.at('session/list').length == 2);
    a.wire.answer('session/list', 1, sessions([summary('current', true)]));
    await settle();
    _petTrace('P6-retry-after-list-failure', h, a);
    expect(h.container.read(petRunsProvider).map((r) => r.sessionId), ['current']);
    expect(a.wire.at('session/list'), hasLength(2));
  });
}
