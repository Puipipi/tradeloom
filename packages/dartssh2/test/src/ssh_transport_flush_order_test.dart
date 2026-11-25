@TestOn('vm')
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:dartssh2/src/message/msg_ignore.dart';
import 'package:test/test.dart';

void main() {
  test('packets wait for a pending native flush in their original order',
      () async {
    final socket = _GatedSocket();
    final transport = SSHTransport(socket);
    socket.writes.clear();
    final flushed = transport.flush();
    try {
      transport
          .sendPacket(SSH_Message_Ignore(Uint8List.fromList([70])).encode());
      transport
          .sendPacket(SSH_Message_Ignore(Uint8List.fromList([71])).encode());
      expect(socket.writes, isEmpty);
    } finally {
      socket.release();
    }
    await flushed;
    final lastFlush = transport.flush();
    await socket.started(2);
    expect(socket.payloads, [
      [70],
      [71]
    ]);
    socket.release();
    await lastFlush;
    await transport.close();
  });

  test('a later flush follows all packets accepted before that call', () async {
    final socket = _GatedSocket();
    final transport = SSHTransport(socket);
    socket.writes.clear();
    final first = transport.flush();
    Future<void>? second;
    try {
      transport
          .sendPacket(SSH_Message_Ignore(Uint8List.fromList([72])).encode());
      second = transport.flush();
      transport
          .sendPacket(SSH_Message_Ignore(Uint8List.fromList([73])).encode());
      expect(socket.flushCount, 1);
    } finally {
      socket.release();
    }
    await first;
    await socket.started(2);
    expect(socket.payloads, [
      [72]
    ]);
    socket.release();
    await second;
    final last = transport.flush();
    await socket.started(3);
    expect(socket.payloads, [
      [72],
      [73]
    ]);
    socket.release();
    await last;
    await transport.close();
  });

  test('normal close drains accepted writes after the pending flush', () async {
    final socket = _GatedSocket();
    final transport = SSHTransport(socket);
    socket.writes.clear();
    final flushed = transport.flush();
    Future<void>? closed;
    try {
      transport
          .sendPacket(SSH_Message_Ignore(Uint8List.fromList([74])).encode());
      closed = transport.close();
      expect(socket.closed, isFalse);
    } finally {
      socket.release();
    }
    await flushed;
    await closed;
    expect(socket.payloads, [
      [74]
    ]);
    expect(socket.closed, isTrue);
  });

  test('a failed native flush terminates queued writes and reports the error',
      () async {
    final socket = _GatedSocket();
    final transport = SSHTransport(socket);
    socket.writes.clear();
    final failure = StateError('synthetic flush failure');
    final flushed = transport.flush();
    final flushError = expectLater(flushed, throwsA(same(failure)));
    final transportError =
        expectLater(transport.done, throwsA(isA<SSHSocketError>()));
    try {
      transport
          .sendPacket(SSH_Message_Ignore(Uint8List.fromList([75])).encode());
    } finally {
      socket.release(failure);
    }
    await flushError;
    await transportError;
    expect(socket.writes, isEmpty);
    expect(socket.destroyed, isTrue);
    expect(transport.isClosed, isTrue);
  });

  test(
      'a queued packet write failure reaches transport.done and the next flush',
      () async {
    final socket = _GatedSocket();
    final transport = SSHTransport(socket);
    socket.writes.clear();
    final failure = StateError('synthetic write failure');
    final flushed = transport.flush();
    final transportError =
        expectLater(transport.done, throwsA(isA<SSHSocketError>()));
    transport.sendPacket(SSH_Message_Ignore(Uint8List.fromList([76])).encode());
    socket.writeFailure = failure;
    final nextFlush = expectLater(transport.flush(), throwsA(same(failure)));
    socket.release();
    await flushed;
    await nextFlush;
    await transportError;
    expect(socket.writes, isEmpty);
    expect(socket.destroyed, isTrue);
  });

  test('transport termination aborts the native flush and its queued packets',
      () async {
    final socket = _GatedSocket();
    final transport = SSHTransport(socket);
    socket.writes.clear();
    final failure = SSHHandshakeError('synthetic disconnect');
    final flushed = expectLater(transport.flush(), throwsA(isA<StateError>()));
    final transportError = expectLater(transport.done, throwsA(same(failure)));
    transport.sendPacket(SSH_Message_Ignore(Uint8List.fromList([77])).encode());
    transport.closeWithError(failure);
    await flushed;
    await transportError;
    expect(socket.writes, isEmpty);
    expect(socket.destroyed, isTrue);
  });

  test('remote EOF observes a late flush error without an uncaught close error',
      () async {
    final uncaught = <Object>[];
    final finished = Completer<void>();
    final failure = StateError('synthetic late flush failure');
    Object? observed;
    var closed = false;
    runZonedGuarded(() async {
      try {
        final socket = _GatedSocket();
        final transport = SSHTransport(socket);
        final flushed = transport.flush().catchError((Object error) {
          observed = error;
        });
        await socket._incoming.close();
        await transport.done;
        socket.release(failure);
        await flushed;
        // The close continuation and its error are microtasks; this event-loop
        // barrier observes them without delaying any product operation.
        await Future<void>.delayed(Duration.zero);
        closed = socket.closed;
      } finally {
        finished.complete();
      }
    }, (error, stackTrace) {
      uncaught.add(error);
    });
    await finished.future;
    expect(observed, same(failure));
    expect(closed, isTrue);
    expect(uncaught, isEmpty);
  });
}

class _GatedSocket implements SSHSocket {
  final _incoming = StreamController<Uint8List>();
  final _done = Completer<void>();
  final writes = <Uint8List>[];
  final _started = <int, Completer<void>>{};
  Completer<void>? _flush;
  var flushCount = 0;
  var closed = false;
  var destroyed = false;
  Object? writeFailure;

  List<List<int>> get payloads => writes.map((packet) {
        final length = ByteData.sublistView(packet).getUint32(0);
        return SSH_Message_Ignore.decode(
          packet.sublist(5, 4 + length - packet[4]),
        ).data;
      }).toList();

  Future<void> started(int count) => count <= flushCount
      ? Future<void>.value()
      : (_started[count] ??= Completer<void>()).future;

  void release([Object? error]) {
    final pending = _flush!;
    _flush = null;
    if (error == null) {
      pending.complete();
    } else {
      pending.completeError(error);
    }
  }

  @override
  Future<void> flush() {
    if (_flush != null) throw StateError('StreamSink is bound to a stream');
    _flush = Completer<void>();
    flushCount++;
    _started.remove(flushCount)?.complete();
    return _flush!.future;
  }

  @override
  late final StreamSink<List<int>> sink = _GatedSink(this);

  @override
  Stream<Uint8List> get stream => _incoming.stream;

  @override
  Future<void> get done => _done.future;

  @override
  Future<void> close() async {
    if (_flush != null) throw StateError('StreamSink is bound to a stream');
    closed = true;
    if (!_done.isCompleted) _done.complete();
  }

  @override
  void destroy() {
    destroyed = true;
    if (_flush != null) release(StateError('Socket is destroyed'));
    if (!_done.isCompleted) _done.complete();
  }
}

class _GatedSink implements StreamSink<List<int>> {
  _GatedSink(this.socket);
  final _GatedSocket socket;

  @override
  void add(List<int> data) {
    if (socket._flush != null) {
      throw StateError('StreamSink is bound to a stream');
    }
    if (socket.closed || socket.destroyed) throw StateError('Socket is closed');
    if (socket.writeFailure case final failure?) throw failure;
    socket.writes.add(Uint8List.fromList(data));
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      throw UnimplementedError();

  @override
  Future<void> addStream(Stream<List<int>> stream) =>
      throw UnimplementedError();

  @override
  Future<void> close() => socket.close();

  @override
  Future<void> get done => socket.done;
}
