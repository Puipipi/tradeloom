// Regressions integrated from independent P12 probes (baseline d2abfb6).
// The original same-byte evidence is retained in stop-investigation/.
// Only event delivery and the transport are scripted. ChatController and
// DshClient.cancel/updateQueue/prompt retain their real implementations.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/links/launcher_entries.dart';
import 'package:dsh_app/pets/pet_signals.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/chat_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/provider_keys.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/shell/system_entry_host.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../remote/support/ready_mux.dart';

class _Connection extends Notifier<AsyncValue<HostConnection?>> {
  @override
  AsyncValue<HostConnection?> build() => const AsyncData(null);
  void use(DshClient? client, {String label = 'probe'}) =>
      state = AsyncData(client == null ? null : HostConnection(client: client, label: label, isLocal: true));
}

final _connection = NotifierProvider<_Connection, AsyncValue<HostConnection?>>(_Connection.new);

class _Carrier extends DshCarrier {
  _Carrier(this.name, {this.realHttp});
  final String name;
  final DshHttpCarrier? realHttp;
  final calls = <Map<String, Object?>>[];
  final cancels = <Completer<RpcResult>>[];
  final lists = <Completer<RpcResult>>[];
  bool closed = false;

  @override
  String get kind => 'p12-controlled';
  @override
  DshTracer? get tracer => null;
  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) async {
    calls.add({'client': name, 'endpoint': endpoint, 'args': args});
    if (realHttp case final real?) return real.call(endpoint, args, timeout: timeout);
    switch (endpoint) {
      case 'session/cancel':
        final done = Completer<RpcResult>();
        cancels.add(done);
        return done.future;
      case 'session/updateQueue':
      case 'session/prompt':
        return const RpcOk(null);
      case 'session/list':
        final done = Completer<RpcResult>();
        lists.add(done);
        return done.future;
      default:
        throw StateError('Unexpected real DshClient endpoint: $endpoint $args');
    }
  }

  @override
  Future<DshMuxLink> openLink(MuxOptions options) => throw StateError('No network expected in this probe');
  @override
  Future<void> close() async {
    closed = true;
    await realHttp?.close();
  }
}

class _Client extends DshClient {
  _Client(this.wire) : super.withCarrier(wire);
  final _Carrier wire;
  final _mux = ReadyMux();
  @override
  DshMux get mux => _mux;
  final streams = <String, StreamController<DshEvent>>{};
  final watched = <String>[];
  final hosts = StreamController<HostEvent>.broadcast();

  @override
  Stream<HostEvent> get hostEvents => hosts.stream;

  @override
  Stream<DshEvent> watch(String sessionId, {WatchOptions options = const WatchOptions()}) {
    watched.add(sessionId);
    return streams.putIfAbsent(sessionId, () => StreamController<DshEvent>.broadcast()).stream;
  }

  void running(String sessionId, {List<Map<String, Object?>> inbox = const []}) {
    final stream = streams[sessionId]!;
    stream.add(
      SessionSnapshotEvent.fromJson(sessionId, {
        'cursor': -1,
        'records': <Object?>[],
        'projections': {
          'asOfSeq': -1,
          'values': {
            'inbox': {'next-turn': inbox, 'next-step': <Object?>[]},
          },
        },
      }),
    );
    stream.add(SessionStatusEvent(sessionId, true));
  }

  Future<void> finish() async {
    for (final c in streams.values) {
      await c.close();
    }
    await hosts.close();
    await close();
  }
}

Map<String, Object?> _item(String id, String text) => {
  'id': id,
  'role': 'user',
  'content': [
    {'type': 'text', 'text': text},
  ],
  'source': {'kind': 'user', 'rpcId': 'request-$id'},
};

class _Harness {
  _Harness() {
    c = ProviderContainer(overrides: [activeConnectionProvider.overrideWith((ref) => ref.watch(_connection))]);
    c.listen(chatProvider('S'), (_, _) {});
  }
  late final ProviderContainer c;
  final clients = <_Client>[];
  _Client client(String name) {
    final client = _Client(_Carrier(name));
    clients.add(client);
    return client;
  }

  ChatController get chat => c.read(chatProvider('S').notifier);
  ChatState get state => c.read(chatProvider('S'));
  Future<void> use(_Client? client) async {
    c.read(_connection.notifier).use(client);
    await c.pump();
  }

  Future<void> running(_Client client, {String sessionId = 'S', List<Map<String, Object?>> inbox = const []}) async {
    final ready = Completer<void>();
    final subscription = c.listen(chatProvider(sessionId), (_, next) {
      if (!ready.isCompleted && next.running) ready.complete();
    });
    try {
      client.running(sessionId, inbox: inbox);
      await ready.future;
      expect(c.read(chatProvider(sessionId)).running, isTrue, reason: 'Probe must start with a live running session');
    } finally {
      subscription.close();
    }
  }

  Future<void> close() async {
    c.dispose();
    for (final client in clients) {
      for (final cancel in client.wire.cancels) {
        if (!cancel.isCompleted) cancel.complete(const RpcOk(null));
      }
      await client.finish();
    }
  }
}

Future<void> flush() => Future<void>.delayed(const Duration(milliseconds: 60));
void trace(String scenario, Object value) => debugPrint('P12 ${jsonEncode({'scenario': scenario, 'value': value})}');

class _Runtime extends LocalRuntimeController {
  @override
  LocalRuntimeState build() => _running('A');
  int starts = 0;
  static LocalRuntimeState _running(String token) => LocalRuntimeState(
    loaded: true,
    status: RuntimeStatus.fromMap({'phase': 'running', 'baseUrl': 'http://127.0.0.1:9', 'token': token}),
  );
  void replace(String token) => state = _running(token);
  @override
  Future<void> start() async => starts++;
}

class _Settings extends SettingsController {
  @override
  AppSettings build() => const AppSettings(loaded: true);
}

class _EmptyKeys implements ProviderKeyVault {
  @override
  Future<Map<String, String>> readAll() async => {};
  @override
  Future<void> write(String id, String key) async {}
  @override
  Future<void> delete(String id) async {}
}

class _LocalHarness {
  _LocalHarness() {
    c = ProviderContainer(
      overrides: [
        settingsProvider.overrideWith(_Settings.new),
        localRuntimeProvider.overrideWith(_Runtime.new),
        networkKicksProvider.overrideWithValue(const Stream.empty()),
        providerKeyVaultProvider.overrideWithValue(_EmptyKeys()),
        recentShortcutsProvider.overrideWithValue(const []),
        localClientConnectorProvider.overrideWithValue(({required baseUri, required token}) {
          final done = Completer<DshClient>();
          connects.add((token, done));
          return done.future;
        }),
      ],
    );
    c.listen(activeConnectionProvider, (_, _) {});
    c.listen(chatProvider('S'), (_, _) {});
  }
  late final ProviderContainer c;
  final connects = <(String, Completer<DshClient>)>[];
  final clients = <_Client>[];
  _Runtime get runtime => c.read(localRuntimeProvider.notifier) as _Runtime;
  ChatController get chat => c.read(chatProvider('S').notifier);
  ChatState get state => c.read(chatProvider('S'));
  _Client complete(String token, {_Carrier? carrier}) {
    final client = _Client(carrier ?? _Carrier('local-$token'));
    clients.add(client);
    connects.singleWhere((entry) => entry.$1 == token).$2.complete(client);
    return client;
  }

  Future<void> close() async {
    c.dispose();
    for (final client in clients) {
      for (final cancel in client.wire.cancels) {
        if (!cancel.isCompleted) cancel.complete(const RpcOk(null));
      }
      for (final list in client.wire.lists) {
        if (!list.isCompleted) list.complete(const RpcOk({'items': <Object?>[]}));
      }
      await client.finish();
    }
  }
}

Future<void> _waitFor(bool Function() ready) async {
  for (var i = 0; i < 200 && !ready(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  expect(ready(), isTrue, reason: 'Probe setup did not reach the expected provider state');
}

RpcOk _sessions(String id, bool running) => RpcOk({
  'items': [
    {'sessionId': id, 'running': running, 'updatedAt': 1792700000000, 'blank': false, 'agentAvailable': true},
  ],
});

class _Loopback {
  _Loopback(this.server) {
    server.listen((request) async {
      final body = jsonDecode(await utf8.decoder.bind(request).join()) as Map<String, dynamic>;
      received.add({'path': request.uri.path, 'body': body});
      if (!requestReceived.isCompleted) requestReceived.complete();
      final answer = await result.future;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({'type': 'server-response', 'rpcId': body['rpcId'], 'result': answer}));
      await request.response.close();
    });
  }
  final HttpServer server;
  final requestReceived = Completer<void>();
  final result = Completer<Map<String, Object?>>();
  final received = <Map<String, Object?>>[];
  static Future<_Loopback> start() async => _Loopback(await HttpServer.bind(InternetAddress.loopbackIPv4, 0));
  _Carrier carrier() =>
      _Carrier('real-http-A', realHttp: DshHttpCarrier(DshConnection(Uri.parse('http://127.0.0.1:${server.port}'))));
  Future<void> close() async {
    if (!result.isCompleted) result.complete({'ok': true});
    await server.close(force: true);
  }
}

// The inherited method constructs Dart's real HttpClient, without consulting
// Flutter's global test override (Dart 3.13.7 _http/overrides.dart:80).
class _RealHttp extends HttpOverrides {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('running fixture waits for a delayed status publication', (tester) async {
    var publications = 0;
    await runZoned(
      () async {
        final h = _Harness();
        try {
          final a = h.client('engine-A');
          final connecting = h.use(a);
          await tester.binding.delayed(Duration.zero);
          await connecting;
          expect(a.watched, ['S']);
          expect(a.streams['S']!.hasListener, isTrue);

          var prepared = false;
          Object? setupError;
          final preparing = h
              .running(a, inbox: [_item('queued', 'queued text')])
              .then<void>((_) => prepared = true, onError: (Object error) => setupError = error);
          await tester.binding.delayed(Duration.zero);
          await tester.binding.delayed(const Duration(milliseconds: 60));
          expect(publications, 1);
          expect(h.state.controlReady, isTrue);
          expect(h.state.running, isFalse);
          expect(h.state.pending.single.inboxId, 'queued');
          final returnedBeforePublication = prepared;
          expect(await h.chat.cancel(), isEmpty);
          expect(a.wire.calls, isEmpty);

          await tester.binding.delayed(const Duration(milliseconds: 60));
          await preparing;
          expect(h.state.running, isTrue);
          final cancel = h.chat.cancel();
          expect((a.wire.calls.single['args']! as Map)['request'], {'sessionId': 'S'});
          a.wire.cancels.single.complete(const RpcOk(null));
          expect(await cancel, isEmpty);
          expect(a.wire.calls.map((call) => call['endpoint']), [
            'session/cancel',
            'session/updateQueue',
            'session/prompt',
          ]);
          expect(setupError, isNull, reason: 'Setup must wait for the public running state.');
          expect(returnedBeforePublication, isFalse);
          expect(prepared, isTrue);
        } finally {
          await h.close();
        }
      },
      zoneSpecification: ZoneSpecification(
        createTimer: (self, parent, zone, duration, callback) {
          // The snapshot arrives normally; only its following running status
          // is published after the old fixture's fixed 60ms wait.
          if (duration == const Duration(milliseconds: 32) && ++publications == 1) {
            duration = const Duration(milliseconds: 120);
          }
          return parent.createTimer(zone, duration, callback);
        },
      ),
    );
  });

  test('P12 B1 stale cancel failure must not clear replacement client stop', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('engine-A');
    final b = h.client('engine-B');
    await h.use(a);
    await h.running(a);
    final original = h.chat;
    final oldCancel = h.chat.cancel();
    expect(a.wire.cancels, hasLength(1));
    await h.use(b);
    expect(h.chat, same(original));
    await h.running(b);
    final newCancel = h.chat.cancel();
    expect(b.wire.cancels, hasLength(1));
    expect(h.state.stopping, isTrue);
    a.wire.cancels.single.complete(const RpcError(DshRemoteException('probe/old-engine', 'old engine failed')));
    await oldCancel;
    final observed = {
      'sameController': identical(original, h.chat),
      'stopping': h.state.stopping,
      'error': h.state.error,
      'callsA': a.wire.calls,
      'callsB': b.wire.calls,
    };
    trace('B1-old-failure-new-stop-pending', observed);
    b.wire.cancels.single.complete(const RpcOk(null));
    await newCancel;
    expect(observed['stopping'], isTrue, reason: 'An earlier build must not complete the new client stop');
    expect(observed['error'], isNull, reason: 'An earlier build failure must not become the new client banner');
  });

  test('P12 B2 stale cancel success must not send new inbox through old client', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('engine-A');
    final b = h.client('engine-B');
    await h.use(a);
    await h.running(a);
    final oldCancel = h.chat.cancel();
    await h.use(b);
    await h.running(b, inbox: [_item('only-on-B', 'new engine private queued text')]);
    expect(h.state.pending.single.inboxId, 'only-on-B');
    a.wire.cancels.single.complete(const RpcOk(null));
    await oldCancel;
    trace('B2-old-success-new-inbox', {
      'callsA': a.wire.calls,
      'callsB': b.wire.calls,
      'pending': h.state.pending.map((p) => {'id': p.requestId, 'inboxId': p.inboxId}).toList(),
    });
    expect(a.wire.calls.map((call) => call['endpoint']), [
      'session/cancel',
    ], reason: 'The captured old client must not consume an inbox delivered by its replacement');
    expect(b.wire.calls, isEmpty);
  });

  test('P12 C1 new stop after replacement uses current client and exact selected session', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('engine-A');
    final b = h.client('engine-B');
    await h.use(a);
    await h.running(a);
    await h.use(b);
    await h.running(b);
    final cancel = h.chat.cancel();
    expect(a.wire.calls, isEmpty);
    expect(b.wire.calls.single, {
      'client': 'engine-B',
      'endpoint': 'session/cancel',
      'args': {
        'request': {'sessionId': 'S'},
      },
    });
    b.wire.cancels.single.complete(const RpcOk(null));
    await cancel;
    trace('C1-new-stop-current-client', b.wire.calls);
  });

  test('P12 C2 disconnected or not-yet-running replacement cannot issue cancel', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('engine-A');
    final b = h.client('engine-B');
    await h.use(a);
    await h.running(a);
    await h.use(null);
    expect(h.state.running, isFalse);
    await h.chat.cancel();
    await h.use(b);
    expect(h.state.running, isFalse);
    await h.chat.cancel();
    expect(a.wire.calls, isEmpty);
    expect(b.wire.calls, isEmpty);
    trace('C2-disconnected-gap', {'cancelCalls': 0, 'bWatched': b.watched});
  });

  test('P12 C3 provider family routes different sessions independently', () async {
    final h = _Harness();
    addTearDown(h.close);
    final b = h.client('engine-B');
    h.c.listen(chatProvider('other-S'), (_, _) {});
    await h.use(b);
    await h.running(b);
    await h.running(b, sessionId: 'other-S');
    final first = h.chat.cancel();
    final second = h.c.read(chatProvider('other-S').notifier).cancel();
    expect(b.wire.calls.map((call) => (call['args']! as Map)['request']), [
      {'sessionId': 'S'},
      {'sessionId': 'other-S'},
    ]);
    for (final cancel in b.wire.cancels) {
      cancel.complete(const RpcOk(null));
    }
    await Future.wait([first, second]);
    trace('C3-session-targets', b.wire.calls);
  });

  test('P12 C4 normal stop wakes resendable inbox by real remove then prompt RPC', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('engine-A');
    await h.use(a);
    await h.running(a, inbox: [_item('first', 'first queued'), _item('last', 'last queued')]);
    final cancel = h.chat.cancel();
    a.wire.cancels.single.complete(const RpcOk(null));
    expect(await cancel, isEmpty);
    expect(a.wire.calls.map((call) => call['endpoint']), ['session/cancel', 'session/updateQueue', 'session/prompt']);
    expect((a.wire.calls[1]['args']! as Map)['request'], {
      'sessionId': 'S',
      'itemId': 'last',
      'action': {'kind': 'remove'},
    });
    expect((a.wire.calls[2]['args']! as Map)['request'], containsPair('requestId', 'request-last'));
    expect(
      (a.wire.calls[2]['args']! as Map)['request'],
      containsPair('content', [
        {'type': 'text', 'text': 'last queued'},
      ]),
    );
    trace('C4-stop-inbox-order', a.wire.calls);
  });

  test('P12 C5 fully disposed old controller cannot pollute a new container', () async {
    final old = _Harness();
    final a = old.client('engine-A');
    await old.use(a);
    await old.running(a);
    final oldCancel = old.chat.cancel();
    old.c.dispose();
    final current = _Harness();
    addTearDown(current.close);
    final b = current.client('engine-B');
    await current.use(b);
    await current.running(b);
    final currentCancel = current.chat.cancel();
    a.wire.cancels.single.complete(const RpcError(DshRemoteException('probe/old-engine', 'old engine failed')));
    await oldCancel;
    expect(current.state.stopping, isTrue);
    expect(current.state.error, isNull);
    b.wire.cancels.single.complete(const RpcOk(null));
    await currentCancel;
    await a.finish();
    trace('C5-full-controller-dispose', {'stopping': current.state.stopping, 'error': current.state.error});
  });

  test('P12 C6 same-client metadata refresh preserves the in-flight operation', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('engine-A');
    await h.use(a);
    await h.running(a, inbox: [_item('last', 'queued text')]);
    final cancel = h.chat.cancel();
    h.c.read(_connection.notifier).use(a, label: 'renamed label');
    await h.c.pump();
    expect(a.watched, ['S'], reason: 'Selecting the identical client must not rebuild the controller');
    expect(h.state.stopping, isTrue);
    a.wire.cancels.single.complete(const RpcOk(null));
    await cancel;
    expect(a.wire.calls.map((call) => call['endpoint']), ['session/cancel', 'session/updateQueue', 'session/prompt']);
    trace('C6-same-client-metadata', {'watchCount': a.watched.length, 'calls': a.wire.calls});
  });

  test('P12 B3 stale completion after A B A must be invalid even with same client identity', () async {
    final h = _Harness();
    addTearDown(h.close);
    final a = h.client('engine-A');
    final b = h.client('engine-B');
    await h.use(a);
    await h.running(a);
    final oldCancel = h.chat.cancel();
    await h.use(b);
    await h.running(b);
    await h.use(a);
    await h.running(a);
    final newCancel = h.chat.cancel();
    a.wire.cancels.first.complete(const RpcError(DshRemoteException('probe/old-generation', 'old generation')));
    await oldCancel;
    final stopping = h.state.stopping;
    trace('B3-ABA', {'watchA': a.watched.length, 'stopping': stopping, 'error': h.state.error, 'callsA': a.wire.calls});
    a.wire.cancels.last.complete(const RpcOk(null));
    await newCancel;
    expect(stopping, isTrue, reason: 'Client identity alone cannot distinguish A before and after B');
  });

  test('P12 B4 actual local token rebuild still exposes the stale cancel failure', () async {
    final h = _LocalHarness();
    addTearDown(h.close);
    await _waitFor(() => h.connects.isNotEmpty);
    final a = h.complete('A');
    await _waitFor(() => a.watched.isNotEmpty);
    a.running('S');
    await flush();
    final oldCancel = h.chat.cancel();
    h.runtime.replace('B');
    await _waitFor(() => h.connects.length == 2);
    final b = h.complete('B');
    await _waitFor(() => b.watched.isNotEmpty);
    b.running('S');
    await flush();
    final newCancel = h.chat.cancel();
    expect(a.wire.closed, isTrue, reason: 'Real LocalConnectionController must close the superseded client');
    a.wire.cancels.single.complete(const RpcError(DshRemoteException('probe/old-engine', 'late old engine failure')));
    await oldCancel;
    final stopping = h.state.stopping;
    trace('B4-real-local-controller', {
      'connectTokens': h.connects.map((e) => e.$1).toList(),
      'oldClientClosed': a.wire.closed,
      'stopping': stopping,
      'error': h.state.error,
      'callsA': a.wire.calls,
      'callsB': b.wire.calls,
    });
    b.wire.cancels.single.complete(const RpcOk(null));
    await newCancel;
    expect(stopping, isTrue);
  });

  test('P12 C7 late local connector closes A and only B becomes active', () async {
    final h = _LocalHarness();
    addTearDown(h.close);
    await _waitFor(() => h.connects.isNotEmpty);
    h.runtime.replace('B');
    await _waitFor(() => h.connects.length == 2);
    final a = h.complete('A');
    await _waitFor(() => a.wire.closed);
    final b = h.complete('B');
    await _waitFor(() => b.watched.isNotEmpty);
    expect(h.c.read(activeConnectionProvider).value!.client, same(b));
    expect(a.watched, isEmpty);
    trace('C7-late-connector', {'oldClosed': a.wire.closed, 'oldWatched': a.watched, 'active': b.wire.name});
  });

  test('P12 C8 old PetRuns list completion cannot overwrite replacement client runs', () async {
    final h = _LocalHarness();
    addTearDown(h.close);
    h.c.listen(petRunsProvider, (_, _) {});
    await _waitFor(() => h.connects.isNotEmpty);
    final a = h.complete('A');
    await _waitFor(() => a.hosts.hasListener);
    a.hosts.add(const HostReadyEvent('A', '/home/a'));
    await _waitFor(() => a.wire.lists.isNotEmpty);
    h.runtime.replace('B');
    await _waitFor(() => h.connects.length == 2);
    final b = h.complete('B');
    await _waitFor(() => b.hosts.hasListener);
    b.hosts.add(const HostReadyEvent('B', '/home/b'));
    await _waitFor(() => b.wire.lists.isNotEmpty);
    b.wire.lists.single.complete(_sessions('B-session', true));
    await _waitFor(() => h.c.read(petRunsProvider).isNotEmpty);
    a.wire.lists.single.complete(_sessions('A-session', true));
    await flush();
    final runs = h.c.read(petRunsProvider).map((r) => r.sessionId).toList();
    expect(runs, ['B-session']);
    trace('C8-PetRuns-late-old-list', {'runs': runs, 'oldClosed': a.wire.closed});
  });

  testWidgets('P12 C9 actual launcher channel selects session without reconnecting same host', (tester) async {
    const channel = MethodChannel('dsh/shortcuts');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (_) async => true);
    final h = _LocalHarness();
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: h.c,
        child: const MaterialApp(home: Scaffold(body: SystemEntryHost())),
      ),
    );
    await tester.pump();
    final a = h.complete('A');
    await tester.pump();
    await tester.pump();
    final original = h.chat;
    Future<void> entry(String sessionId) async {
      await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('entry', {'kind': 'chat', 'sessionId': sessionId, 'host': HostRef.local.encode()}),
        ),
        (_) {},
      );
      await tester.pump();
      await tester.pump();
    }

    await entry('pet-session');
    expect(h.c.read(activeHostProvider), HostRef.local);
    expect(h.c.read(currentSessionProvider), 'pet-session');
    expect(h.connects.map((e) => e.$1), ['A']);
    expect(h.chat, same(original));
    expect(h.runtime.starts, 0);
    h.runtime.replace('B');
    await tester.pump();
    final b = h.complete('B');
    await tester.pump();
    await tester.pump();
    h.c.listen(chatProvider('pet-session'), (_, _) {});
    await entry('pet-session');
    b.running('pet-session');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    final cancel = h.c.read(chatProvider('pet-session').notifier).cancel();
    expect(b.wire.cancels, hasLength(1));
    expect(a.wire.calls, isEmpty);
    b.wire.cancels.single.complete(const RpcOk(null));
    await tester.pump();
    await cancel;
    expect(b.wire.calls.single['args'], {
      'request': {'sessionId': 'pet-session'},
    });
    trace('C9-native-entry-real-local-real-chat', {
      'tokens': h.connects.map((e) => e.$1).toList(),
      'runtimeStartCalls': h.runtime.starts,
      'selected': h.c.read(currentSessionProvider),
      'callsB': b.wire.calls,
    });
    await tester.pumpWidget(const SizedBox.shrink());
    await h.close();
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  testWidgets('P12 B5 real HTTP in-flight failure after graceful close pollutes new stop', (tester) async {
    // Keep real loopback I/O, but drive provider updates and the chat's 32 ms
    // publication timer with the test clock rather than a wall-clock sleep.
    await HttpOverrides.runWithHttpOverrides(() async {
      final host = (await tester.runAsync(_Loopback.start))!;
      final h = _LocalHarness();
      try {
        await tester.pump(Duration.zero);
        expect(h.connects.map((entry) => entry.$1), ['A']);
        final a = h.complete('A', carrier: host.carrier());
        await tester.pump(Duration.zero);
        expect(a.watched, ['S']);
        a.running('S');
        await tester.pump(Duration.zero);
        await tester.pump(const Duration(milliseconds: 32));
        expect(h.state.running, isTrue);
        expect(h.state.syncing, isFalse);
        late Future<List<PendingPrompt>> oldCancel;
        await tester.runAsync(() async {
          oldCancel = h.chat.cancel();
          await host.requestReceived.future;
        });
        expect(host.received.single['path'], '/api/session/cancel');
        h.runtime.replace('B');
        await tester.pump(Duration.zero);
        expect(h.connects.map((entry) => entry.$1), ['A', 'B']);
        final b = h.complete('B');
        await tester.pump(Duration.zero);
        expect(b.watched, ['S']);
        b.running('S');
        // Deliver the asynchronous status first, then advance its publication
        // timer. A watched stream alone does not mean cancel() can run yet.
        await tester.pump(Duration.zero);
        await tester.pump(const Duration(milliseconds: 32));
        expect(h.state.running, isTrue, reason: 'The replacement status must publish before cancel');
        expect(h.state.syncing, isFalse);
        final newCancel = h.chat.cancel();
        expect(b.wire.cancels, hasLength(1));
        expect(b.wire.cancels.single.isCompleted, isFalse);
        expect(h.state.stopping, isTrue);
        expect(a.wire.closed, isTrue);
        await tester.runAsync(() async {
          host.result.complete({
            'ok': false,
            'error': {'code': 'probe/late-failure', 'message': 'old response after close'},
          });
          await oldCancel;
        });
        final stopping = h.state.stopping;
        trace('B5-real-HTTP-graceful-close-failure', {
          'oldClientClosed': a.wire.closed,
          'serverReceived': host.received,
          'stopping': stopping,
          'error': h.state.error,
        });
        b.wire.cancels.single.complete(const RpcOk(null));
        await newCancel;
        expect(stopping, isTrue);
        expect(h.state.error, isNull);
      } finally {
        await h.close();
        await tester.runAsync(host.close);
      }
    }, _RealHttp());
  });

  test('P12 B6 real HTTP closed client blocks stale queue RPC but new state is still polluted', () async {
    await HttpOverrides.runWithHttpOverrides(() async {
      final host = await _Loopback.start();
      final h = _LocalHarness();
      addTearDown(() async {
        await h.close();
        await host.close();
      });
      await _waitFor(() => h.connects.isNotEmpty);
      final a = h.complete('A', carrier: host.carrier());
      await _waitFor(() => a.watched.isNotEmpty);
      a.running('S');
      await flush();
      final oldCancel = h.chat.cancel();
      await _waitFor(() => host.received.isNotEmpty);
      h.runtime.replace('B');
      await _waitFor(() => h.connects.length == 2);
      final b = h.complete('B');
      await _waitFor(() => b.watched.isNotEmpty);
      b.running('S', inbox: [_item('only-on-B', 'new engine queued text')]);
      await flush();
      expect(a.wire.closed, isTrue);
      host.result.complete({
        'ok': true,
        'value': {'accepted': true},
      });
      await oldCancel;
      trace('B6-real-HTTP-closed-success', {
        'oldClientClosed': a.wire.closed,
        'serverReceived': host.received,
        'oldClientAttempts': a.wire.calls,
        'error': h.state.error,
      });
      expect(host.received.map((request) => request['path']), [
        '/api/session/cancel',
      ], reason: 'A closed real HttpClient must not physically send the subsequent queue mutation');
      expect(
        h.state.error,
        isNull,
        reason: 'A stale post-close continuation still must not pollute the new client state',
      );
    }, _RealHttp());
  });

  test('P12 B7 same-client late PetRuns list must not resurrect a stopped run', () async {
    final h = _LocalHarness();
    addTearDown(h.close);
    h.c.listen(petRunsProvider, (_, _) {});
    await _waitFor(() => h.connects.isNotEmpty);
    final a = h.complete('A');
    await _waitFor(() => a.hosts.hasListener);
    a.hosts.add(const HostReadyEvent('A-first', '/home/a'));
    await _waitFor(() => a.wire.lists.length == 1);
    a.wire.lists.first.complete(_sessions('S', true));
    await _waitFor(() => h.c.read(petRunsProvider).isNotEmpty);
    a.hosts.add(const HostReadyEvent('A-reconnected', '/home/a'));
    await _waitFor(() => a.wire.lists.length == 2);
    // Valid network ordering: the unary list snapshot was taken while S
    // ran, then a later status edge arrived before that delayed response.
    a.hosts.add(const SessionStatusEvent('S', false));
    await _waitFor(() => h.c.read(petRunsProvider).isEmpty);
    a.wire.lists.last.complete(_sessions('S', true));
    await flush();
    final runs = h.c.read(petRunsProvider).map((r) => r.sessionId).toList();
    trace('B7-PetRuns-same-client-list-status-race', {
      'runsAfterStopAndLateList': runs,
      'listCalls': a.wire.lists.length,
    });
    expect(runs, isEmpty, reason: 'A list cut before a newer stop edge must not revive its stale running bit');
  });
}
