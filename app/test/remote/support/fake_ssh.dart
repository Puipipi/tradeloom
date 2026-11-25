import 'dart:async';
import 'dart:typed_data';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/ssh/remote_shell.dart';
import 'package:dsh_app/remote/ssh/ssh_host_config.dart';
import 'package:dsh_app/remote/ssh/ssh_transport.dart';
import 'package:dsh_client/dsh_client.dart';

/// Imitates the remote machine: dsh-app's managed `dsh web` and its log.
class FakeRemote {
  int launches = 0;
  int? pid;
  int port = 40100;
  String token = 'tok-0';
  bool sameCommand = true;
  bool hasLaunchLine = true;

  /// What `dsh` does when started.
  bool dshInstalled = true;
  final List<Object> tunnelErrors = [];

  /// Kills the managed server (reboot / crash).
  void killServer() => pid = null;

  RemoteExecResult run(String script) {
    if (script.contains('DSHAPP started')) {
      if (!dshInstalled) return const RemoteExecResult(127, 'DSHAPP home /home/me\nDSHAPP nodsh\n', '');
      launches++;
      pid = 1000 + launches;
      port = 40100 + launches;
      token = 'tok-$launches';
      return RemoteExecResult(
        0,
        'DSHAPP home /home/me\nDSHAPP dsh /usr/bin/dsh\nDSHAPP started $pid\n'
            'DSHAPP url dsh web: http://127.0.0.1:$port/?token=$token\n',
        '',
      );
    }
    if (script.contains('DSHAPP alive')) {
      final alive = pid;
      return RemoteExecResult(
        0,
        alive == null
            ? 'DSHAPP home /home/me\n'
            : 'DSHAPP home /home/me\nDSHAPP alive $alive\n'
                  '${sameCommand ? 'DSHAPP samecmd\n' : ''}'
                  '${hasLaunchLine ? 'DSHAPP url dsh web: http://127.0.0.1:$port/?token=$token\n' : ''}',
        '',
      );
    }
    return const RemoteExecResult(0, '', '');
  }
}

/// In-memory channel; echoes when [echo] is set.
class FakeChannel implements TunnelChannel {
  FakeChannel({this.echo = false}) {
    _in.stream.listen((data) {
      if (echo) _out.add(Uint8List.fromList(data));
    }, onDone: () => _out.close());
  }

  final bool echo;
  final _in = StreamController<List<int>>();
  final _out = StreamController<Uint8List>();
  bool destroyed = false;

  @override
  Stream<Uint8List> get stream => _out.stream;

  @override
  StreamSink<List<int>> get sink => _in.sink;

  @override
  void destroy() {
    destroyed = true;
    if (!_out.isClosed) unawaited(_out.close());
  }
}

class FakeTransport implements SshTransport {
  FakeTransport(this.remote, {this.pingOk = true});

  final FakeRemote remote;
  bool pingOk;
  final _done = Completer<void>();
  final List<String> scripts = [];
  final List<(String, int)> tunnels = [];

  /// Simulates the network dropping the connection.
  void drop() {
    if (!_done.isCompleted) _done.complete();
  }

  @override
  Future<RemoteExecResult> run(String script, {Duration timeout = const Duration(seconds: 30)}) async {
    if (_done.isCompleted) throw const HostLinkError(HostLinkErrorKind.unreachable, 'closed', retryable: true);
    scripts.add(script);
    return remote.run(script);
  }

  @override
  Future<TunnelChannel> openTunnel(String host, int port) async {
    tunnels.add((host, port));
    if (remote.tunnelErrors.isNotEmpty) throw remote.tunnelErrors.removeAt(0);
    if (remote.pid == null || port != remote.port) throw const TunnelRefused();
    return FakeChannel(echo: true);
  }

  @override
  Future<void> ping({Duration timeout = const Duration(seconds: 10)}) async {
    if (!pingOk || _done.isCompleted) throw TimeoutException('ping');
  }

  @override
  Future<void> get done => _done.future;

  @override
  bool get isClosed => _done.isCompleted;

  @override
  void close() => drop();
}

/// Builds transports against a [FakeRemote], presenting [hostKey]; can be
/// told to fail the next connects.
class FakeSshServer {
  FakeSshServer({PresentedHostKey? hostKey})
    : hostKey = hostKey ?? const PresentedHostKey('ssh-ed25519', 'SHA256:goodkeygoodkeygoodkeygoodkeygoodkey00000');

  final remote = FakeRemote();
  PresentedHostKey hostKey;
  final List<FakeTransport> transports = [];
  final List<SshConnectParams> connects = [];

  /// Errors thrown by the next connect attempts, in order.
  final List<HostLinkError> failNext = [];

  FakeTransport get last => transports.last;

  Future<SshTransport> connect(SshConnectParams params, HostKeyCheck verify) async {
    connects.add(params);
    if (failNext.isNotEmpty) throw failNext.removeAt(0);
    final ok = await verify(hostKey);
    if (!ok) throw const HostLinkError(HostLinkErrorKind.hostKeyRejected, 'rejected');
    final t = FakeTransport(remote);
    transports.add(t);
    return t;
  }
}

/// Records connector calls and hands out unconnected clients.
class FakeConnector {
  final List<({Uri baseUri, String token, String hostHeader})> calls = [];
  final List<DshClient> clients = [];
  final List<Object> failNext = [];

  Future<DshClient> call({required Uri baseUri, required String token, required String hostHeader}) async {
    calls.add((baseUri: baseUri, token: token, hostHeader: hostHeader));
    if (failNext.isNotEmpty) throw failNext.removeAt(0);
    // Never connected: points at a closed port. Only identity matters here.
    final client = DshClient(DshConnection(Uri.parse('http://127.0.0.1:9')));
    clients.add(client);
    return client;
  }
}

const sampleSsh = SshHostConfig(
  id: 'ssh-test',
  name: '电脑',
  host: '192.168.1.20',
  user: 'me',
  hostKeyType: 'ssh-ed25519',
  hostKeyFingerprint: 'SHA256:goodkeygoodkeygoodkeygoodkeygoodkey00000',
);
