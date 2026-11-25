// In-memory DSH Host behind a DSH Remote tunnel, for traffic measurements
// with fake time. It mirrors what `RemoteTunnelCarrier` adds on top of the
// app's own calls: one session open (Relay hello, Noise IK, capability
// probe) per link and a `harness.transport.describe` health probe every 25 s
// while a link is up. Payload shapes follow the fixtures captured from
// `dsh web` (packages/dsh_client/test/fixtures); sizes are moderate guesses
// for a real coding session (see [FakeHost] parameters).
import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:dsh_remote/dsh_remote.dart' show harnessRemoteAllowlist;

import 'traffic_meter.dart';

String _text(int bytes, [String seed = 'lorem ipsum dolor sit amet ']) {
  final out = StringBuffer();
  while (out.length < bytes) {
    out.write(seed);
  }
  return out.toString().substring(0, bytes);
}

/// The capability probe a Host answers (ds-harness-remote 0.5.20).
const _capabilities = [
  'transport.relay',
  'harness.remote.v3',
  'harness.remote.transfer.v1',
  'harness.remote.stream.transfer.v1',
  'remote.history.compact.v1',
  'harness.terminal.v1',
  'workspace.upload.v1',
  'codex.appserver.v1',
];

class FakeSession {
  FakeSession(this.id, {this.parent, this.cwd = '/home/user/proj', this.title, this.resident = false});

  final String id;
  final String? parent;
  final String cwd;
  String? title;
  bool resident;
  bool running = false;
  int turns = 0;
  final List<Map<String, Object?>> log = [];
  final DateTime createdAt = DateTime.utc(2026, 10, 20);

  int get cursor => log.length - 1;
  int _time = 1792700000000;

  Map<String, Object?> event(String type, Map<String, Object?> data) {
    final record = {
      'type': 'event',
      'event': {'type': type, 'seq': log.length, 'time': _time += 1000, 'data': data},
    };
    log.add(record);
    return record;
  }

  bool isMessage(Map<String, Object?> record) {
    final type = (record['event']! as Map)['type'];
    return type == 'user/message' || type == 'assistant/message' || type == 'tool/result';
  }

  bool isTurnStart(Map<String, Object?> record) => (record['event']! as Map)['type'] == 'turn/start';

  Map<String, Object?> projections() => {
    'title': title,
    'goal': null,
    'tokenUsage': {'uncachedInputTokens': 120000 + turns, 'outputTokens': 9000, 'cacheReadTokens': 880000, 'cacheWriteTokens': 0},
    'contextPressure': {'pressureTokens': 61234, 'projectedTokens': 61290, 'contextWindow': 1000000},
    'contextBreakdown': {'systemTokens': 1467, 'toolsTokens': 5157, 'messageTokens': 54610},
    'inbox': {'next-turn': <Object?>[], 'next-step': <Object?>[]},
    'sessionStats': {
      'turns': turns,
      'steps': turns * 6,
      'llmMs': 912345,
      'toolMs': 81234,
      'ttftMs': 41234,
      'ttftSteps': turns * 6,
      'decodeMs': 412345,
      'decodeTokens': 90000,
    },
    'turnOutline': [
      for (var t = 1; t <= turns; t++)
        {'turn': t, 'seq': t * 40, 'prompt': '${_text(48, 'fix the login form ')}…', 'response': '${_text(48, 'done: ')}…'},
    ],
    'agentPreset': 'standard',
    'userQuestions': {'active': <Object?>[], 'settled': <Object?>[]},
    'subagentCatalog': <Object?>[],
    'subagentTiming': {'settledMs': 0},
    'subagent': null,
    'permissions': {'currentValue': 'workspace-write'},
    'todos': null,
    'plan': {'active': false, 'pending': false},
    'modelSelection': {
      'lastUsed': {'provider': 'deepseek-official', 'model': 'deepseek-v4-pro', 'reasoningEffort': 'high'},
      'next': {'provider': 'deepseek-official', 'model': 'deepseek-v4-pro', 'reasoningEffort': 'high'},
    },
    'sessionListMetadata': {'blank': turns == 0, 'lastPromptAt': turns == 0 ? null : 1792700000000},
    'imageLimits': {
      'maxImageBytes': 20971520,
      'maxImagesPerMessage': 20,
      'maxMessageImageBytes': 209715200,
      'maxImagePixels': 64000000,
      'maxImageDimension': 8192,
      'mediaTypes': ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
  };

  Map<String, Object?> summary() => {
    'sessionId': id,
    'updatedAt': _time,
    'agentAvailable': resident,
    'running': running,
    'blank': turns == 0,
    'cwd': cwd,
    if (parent != null) 'parentSessionId': parent,
    if (parent != null) 'origin': 'subagent',
    'projections': {'kind': resident ? 'sequenced' : 'cached', 'asOfSeq': cursor, 'values': projections()},
  };

  /// One finished turn of [steps] tool steps and a closing answer.
  void addTurn({int steps = 5, int toolOutput = 3000}) {
    final turn = ++turns;
    event('turn/start', {'turn': turn});
    event('user/message', {
      'content': [
        {'type': 'text', 'text': _text(220, 'please look at the failing test and fix it ')},
      ],
      'source': {'kind': 'user', 'rpcId': 'rpc-$id-$turn'},
      'role': 'user',
      'id': 'u-$id-$turn',
    });
    for (var step = 1; step <= steps + 1; step++) {
      final last = step == steps + 1;
      event('step/start', {'turn': turn, 'step': step});
      if (turn == 1 && step == 1) {
        event('request/header', {
          'header': {
            'config': {'provider': 'deepseek-official', 'model': 'deepseek-v4-pro', 'reasoningEffort': 'high'},
            'tools': [
              for (var i = 0; i < 26; i++)
                {'name': 'tool_$i', 'description': _text(400), 'parameters': {'type': 'object', 'note': _text(500)}},
            ],
          },
          'reason': 'initial',
        });
      }
      event('request/context', {
        'provider': 'deepseek-official',
        'model': 'deepseek-v4-pro',
        'contextWindow': 1000000,
        'systemPromptUpdate': 'in-history',
      });
      final callId = 'call-$id-$turn-$step';
      final reasoning = _text(700, 'the user wants the test fixed so first read the file ');
      event('assistant/message', {
        'turn': turn,
        'step': step,
        'message': {
          'role': 'assistant',
          'content': [
            {'type': 'reasoning', 'text': reasoning},
            {'type': 'text', 'text': _text(last ? 1200 : 200, 'Fixed: the form now submits once. ')},
            if (!last) {'type': 'tool-call', 'id': callId, 'name': 'bash', 'arguments': '{"command": "flutter test test/auth"}'},
          ],
          'source': {'kind': 'model', 'provider': 'deepseek-official', 'model': 'deepseek-v4-pro'},
          'id': 'a-$id-$turn-$step',
        },
        'usage': {'inputTokens': 3775, 'outputTokens': 209, 'cacheReadTokens': 6400, 'cacheWriteTokens': 0, 'totalTokens': 10384},
        'stream': [
          {
            'type': 'reasoning-chunks',
            'time0': 1792712156211,
            'index': 0,
            'dt': List.filled(120, 11),
            'texts': List.filled(120, ' token'),
          },
        ],
      });
      if (!last) {
        event('tool/call', {
          'turn': turn,
          'step': step,
          'callId': callId,
          'name': 'bash',
          'arguments': '{"command": "flutter test test/auth", "description": "run the auth tests"}',
        });
        event('tool/result', {
          'turn': turn,
          'step': step,
          'message': {
            'role': 'tool',
            'source': {'kind': 'tool', 'callId': callId},
            'toolCallId': callId,
            'content': [
              {'type': 'text', 'text': _text(toolOutput, '00:03 +12: test/auth/login_test.dart: submits once\n')},
            ],
            'isError': false,
            'id': 'r-$id-$turn-$step',
          },
        });
      }
      event('step/end', {'turn': turn, 'step': step});
    }
    event('turn/end', {
      'turn': turn,
      'reason': {'kind': 'completed'},
    });
  }

  /// Records from the turn start that makes the window hold at least
  /// [minMessages] messages and [minTurns] turns, at most [maxMessages]
  /// messages (DSH's turn-aligned window), ending before [before].
  (List<Map<String, Object?>>, bool) window({int? before, int minMessages = 50, int minTurns = 2, int maxMessages = 500}) {
    final end = before ?? log.length;
    var start = end;
    var messages = 0;
    var turnsSeen = 0;
    while (start > 0) {
      final record = log[start - 1];
      if (isMessage(record)) {
        if (messages >= maxMessages) break;
        messages++;
      }
      start--;
      if (isTurnStart(record)) {
        turnsSeen++;
        if (messages >= minMessages && turnsSeen >= minTurns) break;
      }
    }
    return (log.sublist(start, end), start > 0);
  }
}

/// Scriptable Host. Tune the session fleet with the constructor.
class FakeHost {
  FakeHost({int topLevel = 60, int subagents = 60, int resident = 5, this.longTurns = 40}) {
    for (var i = 0; i < topLevel; i++) {
      final s = sessions['S$i'] = FakeSession('S$i', title: 'Session $i', resident: i < resident);
      s.turns = i == 0 ? 0 : 3 + i % 20;
      s.event('permission/preset', {'preset': 'workspace-write'});
    }
    final long = sessions['S0']!;
    for (var t = 0; t < longTurns; t++) {
      long.addTurn();
    }
    for (var i = 0; i < subagents; i++) {
      final s = sessions['A$i'] = FakeSession('A$i', parent: 'S${i % topLevel}', title: 'Subagent $i');
      s.turns = 1;
    }
  }

  final int longTurns;
  final meter = TrafficMeter();
  final sessions = <String, FakeSession>{};
  final links = <FakeHostLink>[];
  final calls = <String>[];
  final unknown = <String>{};
  bool online = true;

  /// While set, `session/list` answers wait for it (a slow Relay).
  Completer<void>? listsHeld;
  int _generation = 0;
  int connects = 0;

  /// Unary handlers by endpoint; return the `value`.
  final handlers = <String, Object? Function(Map<String, Object?> args)>{};

  FakeHostLink? get live {
    for (final link in links.reversed) {
      if (!link.closed) return link;
    }
    return null;
  }

  Iterable<({FakeHostLink link, String streamId, String endpoint, Map<String, Object?> args})> streams(
    String endpoint,
  ) sync* {
    for (final link in links) {
      if (link.closed) continue;
      for (final e in link.streams.entries) {
        if (e.value.endpoint == endpoint) yield (link: link, streamId: e.key, endpoint: endpoint, args: e.value.args);
      }
    }
  }

  // ── Unary ──────────────────────────────────────────────────────────────

  /// Endpoints whose callers are recorded in [callers] (investigation aid).
  final traced = <String>{};
  final callers = <String>[];

  Object? handle(String endpoint, Map<String, Object?> args) {
    calls.add(endpoint);
    if (traced.contains(endpoint)) callers.add('$endpoint <- ${StackTrace.current}');
    final custom = handlers[endpoint];
    if (custom != null) return custom(args);
    switch (endpoint) {
      case 'session/list':
        return {
          'items': [for (final s in sessions.values) s.summary()],
        };
      case 'session/page':
        final request = (args['request']! as Map).cast<String, Object?>();
        final session = sessions[((request['address']! as Map)['sessionId'])]!;
        final turnWindow = request['turnWindow'] as Map?;
        final (records, hasMore) = session.window(
          before: request['beforeSeq'] as int?,
          minMessages: (turnWindow?['minMessages'] as int?) ?? (request['maxMessages'] as int? ?? 50),
          minTurns: (turnWindow?['minTurns'] as int?) ?? 0,
          maxMessages: request['maxMessages'] as int? ?? 50,
        );
        return {'records': records, 'hasMore': hasMore};
      case 'session/projections':
        final request = (args['request']! as Map).cast<String, Object?>();
        final session = sessions[request['sessionId']];
        return session == null ? null : {'asOfSeq': session.cursor, 'values': session.projections()};
      default:
        unknown.add(endpoint);
        return null;
    }
  }

  // ── Streams ────────────────────────────────────────────────────────────

  void onOpen(FakeHostLink link, String streamId, String endpoint, Map<String, Object?> args) {
    switch (endpoint) {
      case r'$events':
        link.item(streamId, {
          'type': 'ready',
          'clientId': 'client-${++_generation}',
          'host': {'home': '/home/user'},
        });
      case 'session/follow':
        final request = (args['request']! as Map).cast<String, Object?>();
        final session = sessions[(request['address']! as Map)['sessionId']];
        if (session == null) {
          link.error(streamId, 'session/not-found', 'no such session');
          return;
        }
        link.revisions[streamId] = 0;
        final turnWindow = request['turnWindow'] as Map?;
        final (records, hasMore) = request['activate'] == true
            ? session.window(minMessages: 1, minTurns: 0, maxMessages: 1)
            : session.window(
                minMessages: (turnWindow?['minMessages'] as int?) ?? (request['maxMessages'] as int? ?? 50),
                minTurns: (turnWindow?['minTurns'] as int?) ?? 0,
                maxMessages: request['maxMessages'] as int? ?? 50,
              );
        link.item(streamId, {
          'type': 'snapshot',
          'header': {
            'version': 4,
            'id': session.id,
            'createdAt': session.createdAt.millisecondsSinceEpoch,
            'cwd': session.cwd,
            'isSeeded': false,
            'agentPreset': 'standard',
          },
          'cursor': session.cursor,
          'records': records,
          'hasMore': hasMore,
          'projections': {'asOfSeq': session.cursor, 'values': session.projections()},
          'assistantStream': {'revision': 0},
        });
      case 'workspace/follow':
        link.item(streamId, {
          'type': 'baseline',
          'value': {
            'items': [
              for (var w = 0; w < 6; w++)
                {
                  'workspaceId': 'ws-$w',
                  'path': '/home/user/proj-$w',
                  'title': 'proj-$w',
                  'sessionIds': [
                    for (final s in sessions.values)
                      if (s.parent == null && s.id.hashCode % 6 == w) s.id,
                  ],
                  'createdAt': '2026-10-20T10:00:00.000Z',
                  'updatedAt': '2026-10-29T10:00:00.000Z',
                },
            ],
            'archivedSessionIds': [for (var i = 40; i < 55; i++) 'S$i'],
            'pinnedSessionIds': ['S1'],
          },
        });
      case 'session/control':
        link.item(streamId, {
          'type': 'baseline',
          'value': {
            'projections': {
              for (final s in sessions.values)
                if (s.resident) s.id: {'asOfSeq': s.cursor, 'values': s.projections()},
            },
          },
        });
      default:
        break; // held open
    }
  }

  // ── Host behaviour ─────────────────────────────────────────────────────

  void emit(String event, List<Object?> args) {
    for (final s in streams(r'$events')) {
      s.link.item(s.streamId, {'type': 'emit', 'event': event, 'args': args});
    }
  }

  /// Pushes to every follow of [sessionId]; [tokens] only to those that
  /// asked for the assistant stream.
  void _follow(
    String sessionId,
    Map<String, Object?> Function(FakeHostLink link, String streamId) frame, {
    bool tokens = false,
  }) {
    for (final s in streams('session/follow')) {
      final request = s.args['request']! as Map;
      if ((request['address']! as Map)['sessionId'] != sessionId) continue;
      if (tokens && request['assistantStream'] != true) continue;
      s.link.item(s.streamId, frame(s.link, s.streamId));
    }
  }

  void _projection(FakeSession session, String key) {
    for (final s in streams('session/control')) {
      s.link.item(s.streamId, {
        'type': 'projection',
        'sessionId': session.id,
        'key': key,
        'value': session.projections()[key],
        'seq': session.cursor,
      });
    }
  }

  Map<String, Object?> _stream(FakeHostLink link, String streamId, Map<String, Object?> frame) => {
    'type': 'assistant-stream',
    'frame': {...frame, 'revision': link.revisions[streamId] = (link.revisions[streamId] ?? 0) + 1},
  };

  /// A live turn on [sessionId]: status edges on `$events`, streamed tokens
  /// (one frame each, [tokens] per step: a reasoning model's step) and
  /// durable events on every follow, projection frames on every
  /// `session/control`. [pump] runs before each step's first token and after
  /// each step.
  Future<void> runTurn(String sessionId, Future<void> Function() pump, {int steps = 3, int tokens = 800}) async {
    final session = sessions[sessionId]!;
    session
      ..running = true
      ..resident = true;
    emit('api-session/status', [sessionId, true]);
    final before = session.log.length;
    session.addTurn(steps: steps);
    final added = session.log.sublist(before);
    session.log.removeRange(before, session.log.length);
    var step = 0;
    for (final record in added) {
      final type = (record['event']! as Map)['type'];
      if (type == 'step/start') {
        step++;
        emit('api-session/activity', [sessionId, 1792700000000 + step]);
      }
      if (type == 'assistant/message') {
        final attempt = '$sessionId:${session.cursor}';
        _follow(
          sessionId,
          (link, id) => _stream(link, id, {
            'type': 'start',
            'attemptId': attempt,
            'turn': session.turns,
            'step': step,
            'startedAfterSeq': session.cursor,
          }),
          tokens: true,
        );
        for (var i = 0; i < tokens; i++) {
          _follow(
            sessionId,
            (link, id) => _stream(link, id, {
              'type': 'chunk',
              'attemptId': attempt,
              'index': i,
              'time': 1792700000000 + i,
              'chunk': {'type': 'text-delta', 'index': 1, 'text': ' token'},
            }),
            tokens: true,
          );
        }
        _follow(
          sessionId,
          (link, id) => _stream(link, id, {
            'type': 'end',
            'attemptId': attempt,
            'index': tokens,
            'outcome': {'kind': 'committed', 'eventType': 'assistant/message', 'seq': session.cursor + 1},
          }),
          tokens: true,
        );
      }
      final event = (record['event']! as Map).cast<String, Object?>();
      final durable = {
        'type': 'event',
        'event': {...event, 'seq': session.log.length},
      };
      session.log.add(durable);
      _follow(sessionId, (_, _) => durable);
      // The model's first token takes a moment.
      if (type == 'step/start') await pump();
      if (type == 'step/end') {
        for (final key in ['contextBreakdown', 'contextPressure', 'tokenUsage', 'sessionStats', 'turnOutline']) {
          _projection(session, key);
        }
        await pump();
      }
    }
    session.running = false;
    emit('api-session/status', [sessionId, false]);
    await pump();
  }

  /// The Relay drops the live link (network change, Server restart).
  void drop() => live?.lose();
}

/// [DshCarrier] to [FakeHost] that behaves like `RemoteTunnelCarrier`.
class FakeTunnelCarrier extends DshCarrier {
  FakeTunnelCarrier(this.host, {this.healthInterval = const Duration(seconds: 25)});

  final FakeHost host;
  final Duration healthInterval;
  bool _closed = false;

  TrafficMeter get meter => host.meter;

  @override
  String get kind => 'remote-relay';

  @override
  DshTracer? get tracer => null;

  @override
  bool get supportsUplink => false;

  @override
  bool allowsEndpoint(String endpoint) => harnessRemoteAllowlist.contains(endpoint);

  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) async {
    if (_closed) throw const DshClosedException('remote carrier closed');
    if (!host.online) {
      // No tunnel: the call tries to open one (`api.device` says offline).
      meter.record('rest api.device', up: 300, down: 600, messages: 0);
      throw const DshTransportException('HOST_OFFLINE: The Host is offline.');
    }
    if (!allowsEndpoint(endpoint)) {
      return RpcError(DshRemoteException('METHOD_NOT_ALLOWED', 'The endpoint $endpoint is not available.', const {}));
    }
    await Future<void>.delayed(Duration.zero);
    // Answered when asked; [FakeHost.listsHeld] delays only the delivery.
    final value = host.handle(endpoint, args);
    if (endpoint == 'session/list') await host.listsHeld?.future;
    return RpcOk(value);
  }

  @override
  Future<DshMuxLink> openLink(MuxOptions options) async {
    // `api.device` (Server REST) before every session open, online or not.
    meter.record('rest api.device', up: 300, down: 600, messages: 0);
    await Future<void>.delayed(Duration.zero);
    if (_closed) throw const DshClosedException('remote carrier closed');
    if (!host.online) throw const DshTransportException('HOST_OFFLINE: The Host is offline.');
    host.connects++;
    // Relay hello / connect.request / Noise IK messages 1+2, then the
    // mandatory capability probe.
    meter.record('connect (hello+noise)', up: 900, down: 700, messages: 6);
    _describe();
    final link = FakeHostLink(host, this);
    host.links.add(link);
    link.health = Timer.periodic(healthInterval, (_) {
      if (!link.closed) _describe();
    });
    return link;
  }

  void _describe() => meter.record(
    'probe harness.transport.describe',
    up: jsonBytes({'method': 'harness.transport.describe', 'params': const <String, Object?>{}}),
    down: jsonBytes({'capabilities': _capabilities}),
    messages: 2,
  );

  @override
  Future<void> close() async {
    _closed = true;
    for (final link in host.links) {
      link.closed = true;
      link.health?.cancel();
    }
  }
}

class FakeHostLink implements DshMuxLink {
  FakeHostLink(this.host, this.carrier);

  final FakeHost host;
  final FakeTunnelCarrier carrier;
  final streams = <String, ({String endpoint, Map<String, Object?> args})>{};
  final revisions = <String, int>{};
  Timer? health;
  bool closed = false;
  DshMuxFrameHandler? _onFrame;
  DshMuxLossHandler? _onLost;

  @override
  void start({required DshMuxFrameHandler onFrame, required DshMuxLossHandler onLost}) {
    _onFrame = onFrame;
    _onLost = onLost;
  }

  @override
  void open(String streamId, String endpoint, Map<String, Object?> payload) {
    if (closed) return;
    final args = ((payload['args'] as Map?) ?? const {}).cast<String, Object?>();
    streams[streamId] = (endpoint: endpoint, args: args);
    scheduleMicrotask(() {
      if (!closed && streams.containsKey(streamId)) host.onOpen(this, streamId, endpoint, args);
    });
  }

  void item(String streamId, Object? value) {
    if (closed || !streams.containsKey(streamId)) return;
    // Wire round trip: the client never shares the Host's maps.
    _onFrame?.call({'type': 'item', 'streamId': streamId, 'value': jsonDecode(jsonEncode(value))});
  }

  void error(String streamId, String code, String message) {
    if (closed || streams.remove(streamId) == null) return;
    _onFrame?.call({
      'type': 'error',
      'streamId': streamId,
      'error': {'code': code, 'message': message, 'details': const <String, Object?>{}},
    });
  }

  void lose() {
    if (closed) return;
    closed = true;
    health?.cancel();
    _onLost?.call(
      const DshCarrierLostException('remote connection closed (CONNECTION_FAILED)'),
      const DshTransportException('CONNECTION_FAILED: relay dropped'),
    );
  }

  @override
  void cancel(String streamId) => streams.remove(streamId);

  @override
  void sendItem(String streamId, Object? value) => throw UnsupportedError('no uplink');

  @override
  void endUplink(String streamId) => throw UnsupportedError('no uplink');

  @override
  Future<void> close(int code, String reason) async {
    closed = true;
    health?.cancel();
  }
}

/// [RelayBackend] whose Host connections go to [host] through a metered
/// fake tunnel, with the mux options of `DshRemoteRelayBackend`.
class TrafficRelayBackend implements RelayBackend {
  TrafficRelayBackend(this.host);

  final FakeHost host;
  final clients = <DshClient>[];

  static const muxOptions = MuxOptions(
    retryCaps: [
      Duration(milliseconds: 500),
      Duration(seconds: 1),
      Duration(seconds: 2),
      Duration(seconds: 4),
      Duration(seconds: 8),
      Duration(seconds: 15),
      Duration(seconds: 30),
      Duration(seconds: 60),
    ],
  );

  static const relayHost = RelayHost(id: 'mac', name: '家里的 Mac', online: true, platform: 'darwin');

  @override
  bool get available => true;

  @override
  String get serverLabel => 'dsh.r2049.cn';

  @override
  Future<RelayUser?> currentUser() async => const RelayUser(id: 'u1', displayName: 'chimney', provider: 'github');

  @override
  Future<List<RelayAuthProvider>> loginProviders() async => const [];

  @override
  Future<RelayLoginSession> login({String? providerId}) => throw UnimplementedError();

  @override
  Future<RelayUser> loginWithPassword(String email, String password) => throw UnimplementedError();

  @override
  Future<void> logout() async {}

  @override
  Future<List<RelayHost>> listHosts({bool refresh = false}) async {
    host.meter.record('rest hosts', up: 300, down: 900, messages: 0);
    return [
      RelayHost(id: relayHost.id, name: relayHost.name, online: host.online, platform: relayHost.platform),
    ];
  }

  @override
  void approveHost(RelayHost host) {}

  @override
  Future<void> forgetHost(RelayHost host) async {}

  @override
  bool reconnect(DshClient client) {
    if (!clients.contains(client)) return false;
    client.mux.reconnect();
    return true;
  }

  @override
  Future<bool> probe(DshClient client) async {
    if (!clients.contains(client)) return true;
    final carrier = (client.carrier as MeteredCarrier).inner as FakeTunnelCarrier;
    final link = host.live;
    if (link == null || link.carrier != carrier) return true;
    carrier._describe();
    return true;
  }

  @override
  RelayPath? pathOf(DshClient client) => null;

  @override
  Future<DshClient> connectHost(RelayHost relayHost, {RelayStateCallback? onState}) async {
    if (!host.online) {
      host.meter.record('rest api.device', up: 300, down: 600, messages: 0);
      throw HostLinkError(HostLinkErrorKind.hostOffline, 'offline', retryable: true);
    }
    final carrier = MeteredCarrier(FakeTunnelCarrier(host), host.meter);
    final client = DshClient.withCarrier(carrier, muxOptions: muxOptions);
    clients.add(client);
    client.mux.states.listen((state) {
      onState?.call(switch (state) {
        DshConnectionState.idle || DshConnectionState.connecting => RelayConnectionState.connecting,
        DshConnectionState.connected => RelayConnectionState.connected,
        DshConnectionState.reconnecting => RelayConnectionState.reconnecting,
        DshConnectionState.unauthorized => RelayConnectionState.failed,
        DshConnectionState.closed => RelayConnectionState.disconnected,
      }, null);
    });
    await client.mux.ready(timeout: const Duration(seconds: 30));
    return client;
  }
}
