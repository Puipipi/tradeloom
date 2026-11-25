import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dsh_remote/dsh_remote.dart' as remote;
import 'package:flutter_webrtc/flutter_webrtc.dart';

/// [remote.RemotePeerConnector] over flutter_webrtc (libwebrtc): the
/// DataChannel that carries DSH Remote's direct path (LAN / P2P / TURN).
/// Data only: no microphone or camera tracks. The native factory still creates
/// an audio device module, configured below before its first initialization.
Future<remote.RemotePeerConnection> flutterPeerConnector(
  List<remote.RemoteIceServer> iceServers,
  remote.RemotePeerHandlers handlers,
) async {
  await (_webRtcInitialization ??= _initializeWebRtc());
  final pc = await createPeerConnection({
    'iceServers': [for (final server in iceServers) server.toJson()],
    'sdpSemantics': 'unified-plan',
    'iceTransportPolicy': handlers.iceTransportPolicy.name,
  });
  return _FlutterPeer(pc, handlers);
}

Future<void>? _webRtcInitialization;

Future<void> _initializeWebRtc() async {
  try {
    // The factory keeps the first configuration for the process. Even a data-only
    // peer can start its playout track; never classify it as a phone call. These
    // attributes configure the device module, not AudioSwitch or audio focus.
    await WebRTC.initialize(
      options: {
        'androidAudioConfiguration': AndroidAudioConfiguration(
          androidAudioAttributesUsageType: AndroidAudioAttributesUsageType.media,
          androidAudioAttributesContentType: AndroidAudioAttributesContentType.music,
        ).toMap(),
      },
    );
  } catch (_) {
    // Share in-flight initialization, but let a later connection retry failures.
    _webRtcInitialization = null;
    rethrow;
  }
}

class _FlutterPeer implements remote.RemotePeerConnection {
  _FlutterPeer(this._pc, this._handlers) {
    _pc
      ..onIceCandidate = (candidate) {
        if (!_closed && candidate.candidate != null) {
          _handlers.onIceCandidate((candidate.toMap() as Map).cast<String, Object?>());
        }
      }
      ..onConnectionState = (state) {
        if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
            state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
          _end('connection ${state.name}');
        }
      }
      ..onIceConnectionState = (state) {
        if (state == RTCIceConnectionState.RTCIceConnectionStateFailed ||
            state == RTCIceConnectionState.RTCIceConnectionStateClosed) {
          _end('ICE ${state.name}');
        }
      };
  }

  final RTCPeerConnection _pc;
  final remote.RemotePeerHandlers _handlers;
  RTCDataChannel? _channel;
  bool _closed = false;
  Future<void>? _releasing;

  void _end(String reason) {
    if (_closed) return;
    _closed = true;
    unawaited(_release());
    _handlers.onClosed(reason);
  }

  @override
  Future<String> createOffer(String channelLabel) async {
    _checkOpen();
    final channel = await _pc.createDataChannel(channelLabel, RTCDataChannelInit()..ordered = true);
    // Native creation can finish after dispose has already drained its channels.
    if (_closed) {
      try {
        await channel.close();
      } catch (_) {
        // The peer may already be gone on the platform side.
      }
      _checkOpen();
    }
    _channel = channel;
    channel
      ..onDataChannelState = (state) {
        if (_closed) return;
        if (state == RTCDataChannelState.RTCDataChannelOpen) _handlers.onOpen();
        if (state == RTCDataChannelState.RTCDataChannelClosed) _end('DataChannel closed');
      }
      ..onMessage = (message) {
        if (!_closed) _handlers.onMessage(message.isBinary ? message.binary : utf8.encode(message.text));
      };
    // flutter_webrtc otherwise offers to receive audio and video by default.
    final offer = await _pc.createOffer({
      'mandatory': {'OfferToReceiveAudio': false, 'OfferToReceiveVideo': false},
      'optional': [],
    });
    _checkOpen();
    await _pc.setLocalDescription(offer);
    _checkOpen();
    return offer.sdp!;
  }

  void _checkOpen() {
    if (_closed) throw StateError('The WebRTC peer is closed.');
  }

  @override
  Future<void> setAnswer(String sdp) => _pc.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));

  @override
  Future<void> addIceCandidate(Map<String, Object?> candidate) => _pc.addCandidate(
    RTCIceCandidate(
      candidate['candidate'] as String?,
      candidate['sdpMid'] as String?,
      (candidate['sdpMLineIndex'] as num?)?.toInt(),
    ),
  );

  @override
  Future<void> send(Uint8List data) => _channel!.send(RTCDataChannelMessage.fromBinary(data));

  @override
  Future<List<Map<String, Object?>>> stats() async => [
    for (final report in await _pc.getStats())
      {...report.values.cast<String, Object?>(), 'id': report.id, 'type': report.type},
  ];

  @override
  Future<void> close() {
    _closed = true;
    return _release();
  }

  Future<void> _release() => _releasing ??= _disposePeer();

  Future<void> _disposePeer() async {
    _channel = null;
    try {
      await _pc.close();
    } catch (_) {
      // A failed close must not skip disposal of the native event subscriptions.
    }
    try {
      await _pc.dispose();
    } catch (_) {
      // Already gone on the platform side.
    }
  }
}
