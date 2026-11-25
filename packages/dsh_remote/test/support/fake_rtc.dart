// In-memory WebRTC for tests: the client's [RemotePeerConnection] (what the
// app implements over flutter_webrtc) and the Host's answering side, joined
// once the offer was answered and candidates crossed both ways.
import 'dart:async';
import 'dart:typed_data';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:dsh_remote/src/util/bytes.dart';

enum FakeRtcOutcome {
  /// ICE succeeds and the DataChannel opens.
  open,

  /// ICE fails after the answer.
  fail,

  /// Nothing ever connects (the client's negotiation times out).
  silent,
}

/// Selected-pair stats as libwebrtc reports them.
List<JsonMap> pairStats(String localType, String localAddress, String remoteType, String remoteAddress) => [
  {'type': 'local-candidate', 'id': 'L1', 'candidateType': localType, 'address': localAddress},
  {'type': 'remote-candidate', 'id': 'R1', 'candidateType': remoteType, 'address': remoteAddress},
  {'type': 'candidate-pair', 'id': 'P1', 'localCandidateId': 'L1', 'remoteCandidateId': 'R1', 'nominated': true},
  {'type': 'transport', 'id': 'T1', 'selectedCandidatePairId': 'P1'},
];

class FakeRtcNetwork {
  FakeRtcOutcome outcome = FakeRtcOutcome.open;
  final Map<RemoteIceTransportPolicy, FakeRtcOutcome> policyOutcomes = {};
  final List<RemoteIceTransportPolicy> policies = [];
  final List<JsonMap> extraLocalCandidates = [];

  /// Gates exercise native calls completing late or never completing.
  Future<void>? creationGate;
  Future<void>? offerGate;
  Future<void>? statsGate;
  Future<void>? closeGate;

  /// What the client's peer reports from `getStats()` once open.
  List<JsonMap> stats = pairStats('host', '192.168.1.20', 'host', '192.168.1.30');
  List<JsonMap> turnStats = pairStats('relay', '198.51.100.9', 'host', '192.168.1.30');

  /// ICE servers each client peer was created with.
  final List<List<RemoteIceServer>> iceServers = [];
  final List<FakeClientPeer> clients = [];
  final Map<String, FakeClientPeer> _byOffer = {};
  int _ids = 0;

  /// The [RemotePeerConnector] the client uses.
  Future<RemotePeerConnection> connector(List<RemoteIceServer> servers, RemotePeerHandlers handlers) async {
    iceServers.add(servers);
    policies.add(handlers.iceTransportPolicy);
    final peer = FakeClientPeer._(this, handlers, ++_ids);
    clients.add(peer);
    await creationGate;
    return peer;
  }

  /// The Host answers [offer]; `null` for an offer no client made.
  FakeHostPeer? answer(String offer, {required void Function(Uint8List data) onMessage, void Function()? onOpen}) {
    final client = _byOffer[offer];
    if (client == null) return null;
    return client._host = FakeHostPeer._(client, onMessage, onOpen);
  }
}

class FakeClientPeer implements RemotePeerConnection {
  FakeClientPeer._(this.network, this.handlers, this.id);

  final FakeRtcNetwork network;
  final RemotePeerHandlers handlers;
  final int id;
  FakeHostPeer? _host;
  String? channelLabel;
  String? answer;
  final List<JsonMap> remoteCandidates = [];
  bool open = false;
  bool closed = false;

  /// DataChannel messages this peer sent.
  int sent = 0;

  @override
  Future<String> createOffer(String channelLabel) async {
    await network.offerGate;
    this.channelLabel = channelLabel;
    final offer = 'v=0 fake-offer-$id';
    network._byOffer[offer] = this;
    // Real stacks may report candidates before the offer call returns.
    handlers.onIceCandidate({
      'candidate': 'candidate:1 1 udp 2122260223 192.168.1.20 5000$id typ host',
      'sdpMid': '0',
      'sdpMLineIndex': 0,
    });
    network.extraLocalCandidates.forEach(handlers.onIceCandidate);
    return offer;
  }

  @override
  Future<void> setAnswer(String sdp) async {
    if (!sdp.startsWith('v=0 fake-answer')) throw ArgumentError('bad answer');
    answer = sdp;
    _maybeConnect();
  }

  @override
  Future<void> addIceCandidate(JsonMap candidate) async {
    remoteCandidates.add(candidate);
    _maybeConnect();
  }

  void _maybeConnect() {
    if (answer == null || remoteCandidates.isEmpty || open || closed) return;
    switch (network.policyOutcomes[handlers.iceTransportPolicy] ?? network.outcome) {
      case FakeRtcOutcome.open:
        open = true;
        scheduleMicrotask(() {
          if (closed) return;
          _host?._opened();
          handlers.onOpen();
        });
      case FakeRtcOutcome.fail:
        scheduleMicrotask(() {
          if (!closed) handlers.onClosed('ICE failed');
        });
      case FakeRtcOutcome.silent:
        break;
    }
  }

  @override
  Future<void> send(Uint8List data) async {
    if (!open || closed) throw StateError('DataChannel is not open');
    sent++;
    final copy = Uint8List.fromList(data);
    final host = _host!;
    scheduleMicrotask(() {
      if (!host.closed) host.onMessage(copy);
    });
  }

  @override
  Future<List<JsonMap>> stats() async {
    await network.statsGate;
    return handlers.iceTransportPolicy == RemoteIceTransportPolicy.relay ? network.turnStats : network.stats;
  }

  @override
  Future<void> close() async {
    if (closed) return;
    closed = true;
    _host?._remoteClosed();
    await network.closeGate;
  }
}

/// The Host's end of one client's DataChannel.
class FakeHostPeer {
  FakeHostPeer._(this._client, this.onMessage, this._onOpen);

  final FakeClientPeer _client;
  final void Function(Uint8List data) onMessage;
  final void Function()? _onOpen;
  bool closed = false;

  /// DataChannel messages the Host sent.
  int sent = 0;

  void _opened() => _onOpen?.call();

  void _remoteClosed() => closed = true;

  void send(Uint8List data) {
    if (closed || _client.closed) return;
    sent++;
    final copy = Uint8List.fromList(data);
    scheduleMicrotask(() {
      if (!_client.closed) _client.handlers.onMessage(copy);
    });
  }

  /// The Host side closes (the client sees the DataChannel close).
  void close() {
    if (closed) return;
    closed = true;
    scheduleMicrotask(() {
      if (!_client.closed) _client.handlers.onClosed('DataChannel closed');
    });
  }
}
