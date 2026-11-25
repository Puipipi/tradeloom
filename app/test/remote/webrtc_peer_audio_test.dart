import 'dart:async';

import 'package:dsh_app/remote/relay/webrtc_peer.dart';
import 'package:dsh_remote/dsh_remote.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // One lifecycle test: the real plugin's factory and initializer are global.
  test('peers await media initialization, share it, retry failures and reuse success', () async {
    const channel = MethodChannel('FlutterWebRTC.Method');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final calls = <MethodCall>[];
    final peers = <RemotePeerConnection>[];
    final eventChannels = <String>['FlutterWebRTC.Event'];
    messenger.setMockMethodCallHandler(MethodChannel(eventChannels.single), (_) async => null);
    var initializeGate = Completer<void>();
    var initializeStarted = Completer<void>();
    var peerCount = 0;
    final handlers = RemotePeerHandlers(onIceCandidate: (_) {}, onOpen: () {}, onMessage: (_) {}, onClosed: (_) {});

    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      switch (call.method) {
        case 'initialize':
          initializeStarted.complete();
          await initializeGate.future;
          return null;
        case 'createPeerConnection':
          final id = 'peer-${++peerCount}';
          final events = 'FlutterWebRTC/peerConnectionEvent$id';
          eventChannels.add(events);
          messenger.setMockMethodCallHandler(MethodChannel(events), (_) async => null);
          return {'peerConnectionId': id};
        case 'peerConnectionClose':
        case 'peerConnectionDispose':
          return null;
        default:
          fail('Unexpected WebRTC method: ${call.method}');
      }
    });
    addTearDown(() async {
      for (final peer in peers) {
        await peer.close();
      }
      messenger.setMockMethodCallHandler(channel, null);
      for (final events in eventChannels) {
        messenger.setMockMethodCallHandler(MethodChannel(events), null);
      }
    });

    final firstFailure = expectLater(flutterPeerConnector([], handlers), throwsA(isA<PlatformException>()));
    final secondFailure = expectLater(flutterPeerConnector([], handlers), throwsA(isA<PlatformException>()));
    await initializeStarted.future;
    await Future<void>.delayed(Duration.zero);
    expect(calls.map((call) => call.method), ['initialize']);
    initializeGate.completeError(PlatformException(code: 'initialize-failed'));
    await Future.wait([firstFailure, secondFailure]);
    expect(peerCount, 0);

    initializeGate = Completer<void>();
    initializeStarted = Completer<void>();
    final firstPeer = flutterPeerConnector([], handlers);
    final secondPeer = flutterPeerConnector([], handlers);
    await initializeStarted.future;
    await Future<void>.delayed(Duration.zero);
    expect(calls.map((call) => call.method), ['initialize', 'initialize']);
    for (final call in calls) {
      expect(((call.arguments as Map)['options'] as Map)['androidAudioConfiguration'], {
        'androidAudioAttributesUsageType': 'media',
        'androidAudioAttributesContentType': 'music',
      });
    }
    initializeGate.complete();
    peers.addAll(await Future.wait([firstPeer, secondPeer]));
    expect(calls.map((call) => call.method), [
      'initialize',
      'initialize',
      'createPeerConnection',
      'createPeerConnection',
    ]);

    for (final peer in peers) {
      await peer.close();
    }
    peers.add(await flutterPeerConnector([], handlers));
    expect(peerCount, 3);
    expect(calls.where((call) => call.method == 'initialize'), hasLength(2));
  });
}
