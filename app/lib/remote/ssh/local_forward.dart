import 'dart:async';
import 'dart:io';

import 'ssh_transport.dart';

/// Opens a channel to the remote `dsh web` over whatever SSH connection is
/// current; may wait for a reconnect.
typedef TunnelOpener = Future<TunnelChannel> Function();

/// `127.0.0.1:<ephemeral>` on the phone, piped to the remote `dsh web`.
///
/// The listener outlives individual SSH connections: when SSH drops, open
/// sockets die (so DshClient's mux notices and retries), and new sockets wait
/// in [TunnelOpener] until the link has reconnected. The local port, and so
/// the DshClient's base URL, stays the same across reconnects.
class LocalForwarder {
  LocalForwarder._(this._server, this._open);

  final ServerSocket _server;
  final TunnelOpener _open;
  final Set<_Pair> _pairs = {};
  final Set<Socket> _pending = {};
  bool _closed = false;

  static Future<LocalForwarder> bind(TunnelOpener open) async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final forwarder = LocalForwarder._(server, open);
    server.listen(forwarder._accept, onError: (_) {});
    return forwarder;
  }

  int get port => _server.port;

  /// Number of live socket ↔ channel pairs.
  int get activeConnections => _pairs.length;

  Future<void> _accept(Socket socket) async {
    if (_closed) {
      socket.destroy();
      return;
    }
    socket.setOption(SocketOption.tcpNoDelay, true);
    _pending.add(socket);
    final TunnelChannel channel;
    try {
      channel = await _open();
    } catch (_) {
      _pending.remove(socket);
      socket.destroy();
      return;
    }
    if (!_pending.remove(socket) || _closed) {
      channel.destroy();
      socket.destroy();
      return;
    }
    final pair = _Pair(socket, channel, onDone: (p) => _pairs.remove(p));
    _pairs.add(pair);
    pair.start();
  }

  /// Cuts every open connection (SSH is gone; let clients notice now rather
  /// than at their next write).
  void dropConnections() {
    for (final socket in _pending) {
      socket.destroy();
    }
    _pending.clear();
    for (final pair in [..._pairs]) {
      pair.destroy();
    }
    _pairs.clear();
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    dropConnections();
    await _server.close();
  }
}

class _Pair {
  _Pair(this.socket, this.channel, {required this.onDone});

  final Socket socket;
  final TunnelChannel channel;
  final void Function(_Pair) onDone;
  StreamSubscription<List<int>>? _up;
  StreamSubscription<List<int>>? _down;
  bool _done = false;

  void start() {
    _up = socket.listen(
      channel.sink.add,
      onDone: () {
        unawaited(channel.sink.close().catchError((_) {}));
      },
      onError: (_) => destroy(),
      cancelOnError: true,
    );
    _down = channel.stream.listen(
      socket.add,
      onDone: () async {
        try {
          await socket.flush();
        } catch (_) {}
        destroy();
      },
      onError: (_) => destroy(),
      cancelOnError: true,
    );
  }

  void destroy() {
    if (_done) return;
    _done = true;
    unawaited(_up?.cancel());
    unawaited(_down?.cancel());
    try {
      channel.destroy();
    } catch (_) {}
    socket.destroy();
    onDone(this);
  }
}
