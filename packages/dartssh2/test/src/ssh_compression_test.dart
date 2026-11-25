@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';
import 'dart:mirrors';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:dartssh2/src/compression/ssh_zlib.dart';
import 'package:dartssh2/src/message/msg_kex.dart';
import 'package:dartssh2/src/message/msg_userauth.dart';
import 'package:dartssh2/src/ssh_packet.dart';
import 'package:test/test.dart';

final _library = reflectClass(SSHTransport).owner as LibraryMirror;
Symbol _private(String name) => MirrorSystem.getSymbol(name, _library);
void _set(SSHTransport transport, String field, Object? value) =>
    reflect(transport).setField(_private(field), value);
T _get<T>(SSHTransport transport, String field) =>
    reflect(transport).getField(_private(field)).reflectee as T;
dynamic _call(SSHTransport transport, String method, [List<Object?> args = const []]) =>
    reflect(transport).invoke(_private(method), args).reflectee;

Uint8List _bytes(List<int> bytes) => Uint8List.fromList(bytes);
Uint8List _payload(Uint8List packet) => Uint8List.sublistView(
      packet, 5, packet.length - SSHPacket.readPaddingLength(packet));

void _ready(SSHTransport transport, {SSHCipherType? cipher,
    SSHMacType mac = SSHMacType.hmacSha256Etm}) {
  _get<dynamic>(transport, '_localPacketSN').reset();
  _get<dynamic>(transport, '_remotePacketSN').reset();
  _set(transport, '_remoteVersion', 'SSH-2.0-test');
  _set(transport, '_kexInProgress', false);
  _set(transport, '_isFirstKex', false);
  _set(transport, '_kexType', SSHKexType.x25519);
  _set(transport, '_sharedSecret', BigInt.from(5));
  _set(transport, '_exchangeHash', Uint8List(32));
  transport.sessionId = Uint8List(32);
  _set(transport, '_clientCipherType', cipher);
  _set(transport, '_serverCipherType', cipher);
  _set(transport, '_clientMacType', mac);
  _set(transport, '_serverMacType', mac);
  _set(transport, '_clientCompression', 'zlib@openssh.com');
  _set(transport, '_serverCompression', 'zlib@openssh.com');
  _set(transport, '_localCompressionName', 'zlib@openssh.com');
  _set(transport, '_remoteCompressionName', 'zlib@openssh.com');
  if (cipher != null) {
    _call(transport, '_applyLocalKeys');
    _call(transport, '_applyRemoteKeys');
  }
}

Future<void> _receive(SSHTransport transport, List<int> wire) async {
  final dynamic buffer = _get<dynamic>(transport, '_buffer');
  buffer.add(_bytes(wire));
  await _call(transport, '_processPackets');
}

SSH_Message_KexInit _offer(List<String> outgoing, List<String> incoming) =>
    SSH_Message_KexInit(
      kexAlgorithms: [SSHKexType.x25519.name],
      serverHostKeyAlgorithms: [SSHHostkeyType.ed25519.name],
      encryptionClientToServer: [SSHCipherType.aes128ctr.name],
      encryptionServerToClient: [SSHCipherType.aes128ctr.name],
      macClientToServer: [SSHMacType.hmacSha256.name],
      macServerToClient: [SSHMacType.hmacSha256.name],
      compressionClientToServer: outgoing,
      compressionServerToClient: incoming,
      firstKexPacketFollows: false,
    );

void main() {
  test('advertises delayed compression only with opt-in', () async {
    for (final enabled in [false, true]) {
      final socket = _Socket();
      final transport = SSHTransport(socket, compression: enabled);
      final offer = SSH_Message_KexInit.decode(_payload(socket.packets[1]));
      final expected = enabled ? ['zlib@openssh.com', 'none'] : ['none'];
      expect(offer.compressionClientToServer, expected);
      expect(offer.compressionServerToClient, expected);
      await transport.close();
    }
  });

  test('negotiates directions independently with client preference', () async {
    final transport = SSHTransport(_Socket(), compression: true);
    addTearDown(transport.close);
    await _call(transport, '_handleMessageKexInit', [
      _offer(['none', 'zlib@openssh.com'], ['none']).encode(),
    ]);
    expect(_get<String>(transport, '_clientCompression'), 'zlib@openssh.com');
    expect(_get<String>(transport, '_serverCompression'), 'none');
    expect(_get<Object?>(transport, '_localCompression'), isNull);
    expect(_get<Object?>(transport, '_remoteCompression'), isNull);
  });

  test('disabled compression selects none and rejects zlib-only peer', () async {
    final transport = SSHTransport(_Socket());
    addTearDown(transport.close);
    expect(_call(transport, '_selectCompression', [
      ['zlib@openssh.com', 'none'],
    ]), 'none');
    expect(() => _call(transport, '_selectCompression', [
      ['zlib'],
    ]), throwsA(isA<SSHHandshakeError>()));
    expect(() => _call(transport, '_selectCompression', [
      ['zlib@openssh.com'],
    ]), throwsA(isA<SSHHandshakeError>()));
  });

  test('server honors client preference, not server ordering', () async {
    final transport = SSHTransport(_Socket(), isServer: true, compression: true);
    addTearDown(transport.close);
    expect(_call(transport, '_selectCompression', [
      ['none', 'zlib@openssh.com'],
    ]), 'none');
  });

  group('continuous zlib stream', () {
    test('retains dictionary and drains exactly one sync flush per packet', () {
      final encoder = SSHZlib(compress: true);
      final decoder = SSHZlib(compress: false);
      addTearDown(encoder.close);
      addTearDown(decoder.close);
      final payload = _bytes(List.generate(32768, (i) => (i * 13 + i ~/ 251) & 255));
      final first = encoder.process(payload);
      final second = encoder.process(payload);
      expect(decoder.process(first), payload);
      expect(decoder.process(second), payload);
      expect(second.length, lessThan(first.length));
      // A fresh inflater cannot decode the second packet by itself: the stream
      // has neither restarted nor acquired a second zlib header.
      final fresh = SSHZlib(compress: false);
      addTearDown(fresh.close);
      expect(() => fresh.process(second), throwsA(isA<SSHPacketError>()));
    });

    test('accepts channel payload plus message header at the upper boundary', () {
      final encoder = SSHZlib(compress: true);
      final decoder = SSHZlib(compress: false);
      addTearDown(encoder.close);
      addTearDown(decoder.close);
      for (final size in [32768 + 9, SSHPacket.maxLength]) {
        final payload = Uint8List(size);
        expect(decoder.process(encoder.process(payload)), payload);
      }
    });

    test('bounds accumulated output across native chunks, not compressed size', () {
      final encoder = SSHZlib(compress: true);
      final decoder = SSHZlib(compress: false);
      addTearDown(encoder.close);
      addTearDown(decoder.close);
      final compressed = encoder.process(Uint8List(SSHPacket.maxLength + 1));
      expect(compressed.length, lessThan(1000));
      expect(() => decoder.process(compressed), throwsA(isA<SSHPacketError>()));
    });

    test('rejects malformed data as a packet error', () {
      final decoder = SSHZlib(compress: false);
      addTearDown(decoder.close);
      expect(() => decoder.process(_bytes([1, 2, 3, 4])),
          throwsA(isA<SSHPacketError>()));
    });

    test('wire format agrees with an independent zlib decoder', () {
      final encoder = SSHZlib(compress: true);
      addTearDown(encoder.close);
      final payload = _bytes(List.filled(1200, 42));
      final wire = encoder.process(payload);
      final filter = RawZLibFilter.inflateFilter();
      filter.process(wire, 0, wire.length);
      final output = BytesBuilder();
      while (true) {
        final chunk = filter.processed(flush: false);
        if (chunk == null) break;
        output.add(chunk);
      }
      expect(output.takeBytes(), payload);
      expect(wire.take(2), [0x78, 0x9c]);
    });
  });

  // All four existing framing paths: AEAD GCM, AEAD ChaCha, EtM and classic MAC.
  for (final mode in [
    (SSHCipherType.aes128gcm, SSHMacType.hmacSha256),
    (SSHCipherType.chacha20poly1305, SSHMacType.hmacSha256),
    (SSHCipherType.aes128ctr, SSHMacType.hmacSha256Etm),
    (SSHCipherType.aes128ctr, SSHMacType.hmacSha256),
  ]) {
    test('auth success and compressed packets in one chunk: ${mode.$1.name}/${mode.$2.name}', () async {
      final senderSocket = _Socket();
      final receiverSocket = _Socket();
      final sender = SSHTransport(senderSocket, isServer: true, compression: true);
      final received = <Uint8List>[];
      late SSHTransport receiver;
      receiver = SSHTransport(receiverSocket, compression: true, onMessage: (data) {
        received.add(data);
        if (data.first == SSH_Message_Userauth_Success.messageId) {
          // Compression must already be active before application callbacks.
          receiver.sendPacket(_bytes([80, 0, 0, 0, 0]));
        }
        return true;
      });
      addTearDown(sender.close);
      addTearDown(receiver.close);
      _ready(sender, cipher: mode.$1, mac: mode.$2);
      _ready(receiver, cipher: mode.$1, mac: mode.$2);
      senderSocket.packets.clear();
      receiverSocket.packets.clear();
      final before = _bytes([80, 1, 2, 3]);
      sender.sendPacket(before);
      await _receive(receiver, senderSocket.packets.removeLast());
      expect(received.removeLast(), before);
      expect(_get<Object?>(receiver, '_remoteCompression'), isNull);
      final auth = _bytes([SSH_Message_Userauth_Success.messageId]);
      final first = _bytes([80, ...List.filled(32768, 65)]);
      final second = _bytes([80, ...List.filled(32768, 65)]);
      sender.sendPacket(auth);
      sender.sendPacket(first);
      sender.sendPacket(second);
      final wire = senderSocket.packets.expand((packet) => packet).toList();
      await _receive(receiver, wire.sublist(0, 3));
      expect(received, isEmpty);
      await _receive(receiver, wire.sublist(3));
      expect(received, [auth, first, second]);
      expect(_get<Object?>(receiver, '_localCompression'), isNotNull);
      // Verify the client's immediate compressed response in the reverse direction.
      final reverse = <Uint8List>[];
      // _consumePacket checks the actual cipher/MAC, then decompress below.
      final dynamic buffer = _get<dynamic>(sender, '_buffer');
      buffer.add(receiverSocket.packets.single);
      final packet = _call(sender, '_consumePacket') as Uint8List;
      reverse.add(_get<SSHZlib>(sender, '_remoteCompression').process(packet));
      expect(reverse.single, [80, 0, 0, 0, 0]);
    });
  }

  test('NEWKEYS uses old stream then resets only its own direction', () async {
    final socket = _Socket();
    final transport = SSHTransport(socket, compression: true);
    addTearDown(transport.close);
    _ready(transport, cipher: SSHCipherType.aes128gcm);
    _call(transport, '_activateCompression');
    final oldLocal = _get<SSHZlib>(transport, '_localCompression');
    final oldRemote = _get<SSHZlib>(transport, '_remoteCompression');
    final peerDecoder = SSHZlib(compress: false);
    addTearDown(peerDecoder.close);
    transport.sendPacket(_bytes([80, 3]));
    // Decode ciphertext independently of the receive state under test.
    final peer = SSHTransport(_Socket(), isServer: true, compression: true);
    addTearDown(peer.close);
    _ready(peer, cipher: SSHCipherType.aes128gcm);
    final dynamic peerBuffer = _get<dynamic>(peer, '_buffer');
    peerBuffer.add(socket.packets.last);
    expect(peerDecoder.process(_call(peer, '_consumePacket') as Uint8List), [80, 3]);
    // Advance only the peer cipher sequence before consuming the next packet.
    final dynamic sequence = _get<dynamic>(peer, '_remotePacketSN');
    sequence.increase();
    _call(transport, '_sendNewKeys');
    peerBuffer.add(socket.packets.last);
    expect(peerDecoder.process(_call(peer, '_consumePacket') as Uint8List),
        [SSH_Message_NewKeys.messageId]);
    expect(_get<SSHZlib>(transport, '_localCompression'), isNot(same(oldLocal)));
    expect(_get<SSHZlib>(transport, '_remoteCompression'), same(oldRemote));
    await _call(transport, '_handleMessageNewKeys', [_bytes([21])]);
    expect(_get<SSHZlib>(transport, '_remoteCompression'), isNot(same(oldRemote)));
    // New stream has a fresh RFC 1950 header, not the previous dictionary.
    final fresh = SSHZlib(compress: false);
    addTearDown(fresh.close);
    final payload = _bytes([80, 4]);
    expect(fresh.process(_get<SSHZlib>(transport, '_localCompression').process(payload)), payload);
    // Rekey to none stops only after NEWKEYS, not at algorithm negotiation.
    _set(transport, '_clientCompression', 'none');
    _set(transport, '_serverCompression', 'none');
    expect(_get<Object?>(transport, '_localCompression'), isNotNull);
    _call(transport, '_sendNewKeys');
    expect(_get<Object?>(transport, '_localCompression'), isNull);
    expect(_get<Object?>(transport, '_remoteCompression'), isNotNull);
    await _call(transport, '_handleMessageNewKeys', [_bytes([21])]);
    expect(_get<Object?>(transport, '_remoteCompression'), isNull);
  });

  test('oversized decompression closes transport and releases contexts', () async {
    final socket = _Socket();
    final transport = SSHTransport(socket, compression: true);
    _ready(transport);
    _call(transport, '_activateCompression');
    final encoder = SSHZlib(compress: true);
    addTearDown(encoder.close);
    final failed = expectLater(transport.done, throwsA(isA<SSHPacketError>()));
    socket._input.add(SSHPacket.pack(
      encoder.process(Uint8List(SSHPacket.maxLength + 1)), align: 8));
    await failed;
    expect(transport.isClosed, isTrue);
    expect(_get<Object?>(transport, '_localCompression'), isNull);
    expect(_get<Object?>(transport, '_remoteCompression'), isNull);
  });

  test('close clears both compression contexts', () async {
    final transport = SSHTransport(_Socket(), compression: true);
    _ready(transport);
    _call(transport, '_activateCompression');
    await transport.close();
    expect(_get<Object?>(transport, '_localCompression'), isNull);
    expect(_get<Object?>(transport, '_remoteCompression'), isNull);
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
