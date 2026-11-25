@TestOn('browser')
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:dartssh2/src/compression/ssh_zlib.dart';
import 'package:dartssh2/src/message/msg_kex.dart';
import 'package:dartssh2/src/ssh_packet.dart';
import 'package:test/test.dart';

Uint8List _bytes(List<int> bytes) => Uint8List.fromList(bytes);

void main() {
  test('Web remains none-only even when compression is requested', () async {
    expect(sshZlibSupported, isFalse);
    final socket = _Socket();
    final transport = SSHTransport(socket, compression: true);
    final packet = socket.packets[1];
    final offer = SSH_Message_KexInit.decode(Uint8List.sublistView(
      packet, 5, packet.length - SSHPacket.readPaddingLength(packet)));
    expect(offer.compressionClientToServer, ['none']);
    expect(offer.compressionServerToClient, ['none']);
    await transport.close();
  });
}

class _Socket implements SSHSocket {
  final _input = StreamController<Uint8List>();
  final _done = Completer<void>();
  final packets = <Uint8List>[];
  @override
  Stream<Uint8List> get stream => _input.stream;
  @override
  StreamSink<List<int>> get sink => _Sink(packets);
  @override
  Future<void> get done => _done.future;
  @override
  Future<void> close() async {
    if (!_done.isCompleted) _done.complete();
    await _input.close();
  }
  @override
  void destroy() {
    if (!_done.isCompleted) _done.complete();
    unawaited(_input.close());
  }
  @override
  Future<void> flush() async {}
}

class _Sink implements StreamSink<List<int>> {
  _Sink(this.packets);
  final List<Uint8List> packets;
  @override
  void add(List<int> data) => packets.add(_bytes(data));
  @override
  Future<void> addStream(Stream<List<int>> stream) async {
    await for (final data in stream) { add(data); }
  }
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> close() async {}
  @override
  Future<void> get done async {}
}
