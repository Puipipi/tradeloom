// Byte and message counter at the DshCarrier boundary of a DSH Remote
// client. Sizes are the JSON a `RemoteTunnelCarrier` hands to the secure
// channel (before Noise + Relay framing, which add roughly a third plus a
// fixed envelope per frame), counted the way the tunnel maps them:
//
//   unary call   harness.remote.call {endpoint, payload:{args}}  -> {ok, value}   2 messages
//   stream open  harness.remote.stream.open {streamId, endpoint, payload}        2 messages
//   stream item  harness.remote.frame {streamId, hasValue, value}                1 message
//   stream end   harness.remote.stream.closed {streamId, reason}                 1 message
//   cancel       harness.remote.stream.close {streamId}                          2 messages
import 'dart:convert';

import 'package:dsh_client/dsh_client.dart';

int jsonBytes(Object? value) => utf8.encode(jsonEncode(value)).length;

class TrafficRow {
  int count = 0;
  int messages = 0;
  int up = 0;
  int down = 0;
  int get bytes => up + down;
}

class TrafficMeter {
  final Map<String, TrafficRow> rows = {};

  void record(String name, {int up = 0, int down = 0, int messages = 1}) {
    final row = rows.putIfAbsent(name, TrafficRow.new);
    row.count++;
    row.messages += messages;
    row.up += up;
    row.down += down;
  }

  int get messages => rows.values.fold(0, (sum, r) => sum + r.messages);
  int get bytes => rows.values.fold(0, (sum, r) => sum + r.bytes);
  int count(String name) => rows[name]?.count ?? 0;

  /// Rows whose name starts with [prefix] (`call session/list`, `open `, ...).
  int countWhere(bool Function(String name) test) =>
      rows.entries.where((e) => test(e.key)).fold(0, (sum, e) => sum + e.value.count);

  void reset() => rows.clear();

  /// One line per row, biggest first.
  String table({int top = 12}) {
    final sorted = rows.entries.toList()..sort((a, b) => b.value.bytes.compareTo(a.value.bytes));
    final out = StringBuffer('  messages $messages, bytes ${_kb(bytes)}\n');
    for (final e in sorted.take(top)) {
      out.writeln(
        '  ${e.key.padRight(44)} x${e.value.count.toString().padRight(5)} '
        'msgs ${e.value.messages.toString().padRight(5)} up ${_kb(e.value.up).padRight(9)} down ${_kb(e.value.down)}',
      );
    }
    return out.toString();
  }

  static String _kb(int bytes) => bytes < 1024 ? '$bytes B' : '${(bytes / 1024).toStringAsFixed(1)} KB';

  Map<String, Object?> summary({int top = 6}) {
    final sorted = rows.entries.toList()..sort((a, b) => b.value.bytes.compareTo(a.value.bytes));
    return {
      'messages': messages,
      'bytes': bytes,
      'top': [for (final e in sorted.take(top)) '${e.key} x${e.value.count} ${_kb(e.value.bytes)}'],
    };
  }
}

/// [DshCarrier] decorator recording every call and stream frame in [meter].
class MeteredCarrier extends DshCarrier {
  MeteredCarrier(this.inner, this.meter);

  final DshCarrier inner;
  final TrafficMeter meter;

  @override
  String get kind => inner.kind;

  @override
  String? get hostVersion => inner.hostVersion;

  @override
  DshTracer? get tracer => inner.tracer;

  @override
  bool get supportsUplink => inner.supportsUplink;

  @override
  bool allowsEndpoint(String endpoint) => inner.allowsEndpoint(endpoint);

  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) async {
    final up = jsonBytes({
      'endpoint': endpoint,
      'payload': {'args': args},
    });
    final RpcResult result;
    try {
      result = await inner.call(endpoint, args, timeout: timeout);
    } on Object {
      // Failed before it reached the Host (no tunnel): nothing was relayed.
      meter.record('call $endpoint', messages: 0);
      rethrow;
    }
    final down = switch (result) {
      RpcOk(:final value) => jsonBytes({'ok': true, 'value': value}),
      RpcError(:final error) => jsonBytes({
        'ok': false,
        'error': {'code': error.code, 'message': error.message},
      }),
    };
    meter.record('call $endpoint', up: up, down: down, messages: 2);
    return result;
  }

  @override
  Future<DshMuxLink> openLink(MuxOptions options) async => _MeteredLink(await inner.openLink(options), meter);

  @override
  Future<void> close() => inner.close();
}

class _MeteredLink implements DshMuxLink {
  _MeteredLink(this._inner, this._meter);

  final DshMuxLink _inner;
  final TrafficMeter _meter;
  final Map<String, String> _endpoints = {};

  @override
  void start({required DshMuxFrameHandler onFrame, required DshMuxLossHandler onLost}) {
    _inner.start(
      onFrame: (frame) {
        final streamId = frame['streamId'] as String?;
        final endpoint = _endpoints[streamId] ?? '?';
        switch (frame['type']) {
          case 'item':
            final value = frame['value'];
            // Follow items by kind: snapshot, durable event or streamed token.
            final kind = endpoint == 'session/follow' && value is Map ? ':${value['type']}' : '';
            _meter.record(
              'item $endpoint$kind',
              down: jsonBytes({'streamId': streamId, 'hasValue': true, 'value': value}),
            );
          case 'end':
            _meter.record('end $endpoint', down: jsonBytes({'streamId': streamId, 'reason': 'completed'}));
          case 'error':
            _meter.record('error $endpoint', down: jsonBytes(frame));
        }
        onFrame(frame);
      },
      onLost: onLost,
    );
  }

  @override
  void open(String streamId, String endpoint, Map<String, Object?> payload) {
    _endpoints[streamId] = endpoint;
    _meter.record(
      'open $endpoint',
      up: jsonBytes({'streamId': streamId, 'endpoint': endpoint, 'payload': payload, 'transferFrames': true}),
      down: 2,
      messages: 2,
    );
    _inner.open(streamId, endpoint, payload);
  }

  @override
  void cancel(String streamId) {
    _meter.record('cancel ${_endpoints[streamId] ?? '?'}', up: jsonBytes({'streamId': streamId}), down: 2, messages: 2);
    _inner.cancel(streamId);
  }

  @override
  void sendItem(String streamId, Object? value) => _inner.sendItem(streamId, value);

  @override
  void endUplink(String streamId) => _inner.endUplink(streamId);

  @override
  Future<void> close(int code, String reason) => _inner.close(code, reason);
}
