import 'dart:async';

import 'package:dsh_app/remote/relay/webrtc_peer.dart';
import 'package:dsh_remote/dsh_remote.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _NativePeer native;
  late RemotePeerHandlers handlers;
  late List<String> closed;

  setUp(() {
    native = _NativePeer()..install();
    closed = [];
    handlers = RemotePeerHandlers(onIceCandidate: (_) {}, onOpen: () {}, onMessage: (_) {}, onClosed: closed.add);
  });

  tearDown(() => native.uninstall());

  test('the data-only offer does not request audio or video', () async {
    final peer = await flutterPeerConnector([], handlers);
    addTearDown(peer.close);
    await peer.createOffer('dsh');

    final offer = native.calls.singleWhere((call) => call.method == 'createOffer');
    expect((offer.arguments as Map)['constraints'], {
      'mandatory': {'OfferToReceiveAudio': false, 'OfferToReceiveVideo': false},
      'optional': [],
    });
    expect(native.calls.map((call) => call.method), isNot(contains('getUserMedia')));
  });

  test('close failure still disposes the peer and its event subscription', () async {
    native.closeThrows = true;
    final peer = await flutterPeerConnector([], handlers);
    await peer.createOffer('dsh');

    await peer.close();

    expect(native.count('peerConnectionClose'), 1);
    expect(native.count('peerConnectionDispose'), 1);
    expect(native.cancelled, contains(_NativePeer.peerEvents));
    expect(closed, isEmpty);
  });

  test('concurrent closes join the same cleanup, including after native failure', () async {
    final gate = native.closeGate = Completer<void>();
    final peer = await flutterPeerConnector([], handlers);
    await native.emitPeer({'event': 'iceConnectionState', 'state': 'failed'});
    expect(closed, hasLength(1));

    var completed = false;
    final closing = peer.close().then((_) => completed = true);
    await Future<void>.delayed(Duration.zero);
    expect(completed, isFalse, reason: 'close joins the cleanup already started by the native event');
    gate.complete();
    await closing;
    await peer.close();

    expect(native.count('peerConnectionClose'), 1);
    expect(native.count('peerConnectionDispose'), 1);
    expect(closed, hasLength(1));
  });

  test('a DataChannel created after close is closed without generating an offer', () async {
    final gate = native.channelGate = Completer<Map<String, Object?>>();
    final peer = await flutterPeerConnector([], handlers);
    final offering = peer.createOffer('dsh');
    await native.channelStarted.future;
    await peer.close();

    final rejected = expectLater(offering, throwsStateError);
    gate.complete(_NativePeer.channel);
    await rejected;

    expect(native.count('createOffer'), 0);
    expect(native.count('setLocalDescription'), 0);
    expect(native.count('dataChannelClose'), 1);
    expect(native.cancelled, contains(_NativePeer.channelEvents));
    expect(closed, isEmpty);
  });

  test('an offer returned after close is not applied to the disposed peer', () async {
    final gate = native.offerGate = Completer<Map<String, Object?>>();
    final peer = await flutterPeerConnector([], handlers);
    final offering = peer.createOffer('dsh');
    await native.offerStarted.future;
    await peer.close();

    final rejected = expectLater(offering, throwsStateError);
    gate.complete({'sdp': 'v=0\r\n', 'type': 'offer'});
    await rejected;

    expect(native.count('setLocalDescription'), 0);
    expect(native.count('peerConnectionDispose'), 1);
    expect(closed, isEmpty);
  });
}

class _NativePeer {
  static const peerEvents = 'FlutterWebRTC/peerConnectionEventtest-peer';
  static const channelEvents = 'FlutterWebRTC/dataChannelEventtest-peertest-channel';
  static const channel = <String, Object?>{'id': 0, 'flutterId': 'test-channel'};
  static const methodChannel = MethodChannel('FlutterWebRTC.Method');
  static const eventChannels = ['FlutterWebRTC.Event', peerEvents, channelEvents];

  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final calls = <MethodCall>[];
  final cancelled = <String>[];
  final channelStarted = Completer<void>();
  final offerStarted = Completer<void>();
  bool closeThrows = false;
  Completer<void>? closeGate;
  Completer<Map<String, Object?>>? channelGate;
  Completer<Map<String, Object?>>? offerGate;

  int count(String method) => calls.where((call) => call.method == method).length;

  void install() {
    for (final name in eventChannels) {
      messenger.setMockMethodCallHandler(MethodChannel(name), (call) async {
        if (call.method == 'cancel') cancelled.add(name);
        return null;
      });
    }
    messenger.setMockMethodCallHandler(methodChannel, (call) async {
      calls.add(call);
      switch (call.method) {
        case 'createPeerConnection':
          return {'peerConnectionId': 'test-peer'};
        case 'createDataChannel':
          channelStarted.complete();
          return channelGate == null ? channel : await channelGate!.future;
        case 'createOffer':
          offerStarted.complete();
          return offerGate == null ? {'sdp': 'v=0\r\n', 'type': 'offer'} : await offerGate!.future;
        case 'peerConnectionClose':
          if (closeThrows) throw PlatformException(code: 'already-closed');
          await closeGate?.future;
          return null;
        default:
          return null;
      }
    });
  }

  void uninstall() {
    messenger.setMockMethodCallHandler(methodChannel, null);
    for (final name in eventChannels) {
      messenger.setMockMethodCallHandler(MethodChannel(name), null);
    }
  }

  Future<void> emitPeer(Map<String, Object?> event) async {
    await messenger.handlePlatformMessage(peerEvents, const StandardMethodCodec().encodeSuccessEnvelope(event), (_) {});
    await Future<void>.delayed(Duration.zero);
  }
}
