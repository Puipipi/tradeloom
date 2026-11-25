import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';

import '../../diagnostics/redact.dart';
import '../../l10n/l10n.dart';
import '../link_status.dart';
import 'remote_shell.dart';
import 'ssh_host_config.dart';

/// A byte pipe to `host:port` on the remote side of the SSH connection.
abstract class TunnelChannel {
  Stream<Uint8List> get stream;
  StreamSink<List<int>> get sink;
  void destroy();
}

/// A reachable SSH server refused the destination TCP connection.
class TunnelRefused implements Exception {
  const TunnelRefused([this.cause]);
  final Object? cause;

  @override
  String toString() => 'TunnelRefused: $cause';
}

/// Host key presented by the server: algorithm and OpenSSH-style
/// `SHA256:<base64>` fingerprint (same text `ssh-keygen -lf` prints).
class PresentedHostKey {
  const PresentedHostKey(this.type, this.fingerprint);

  final String type;
  final String fingerprint;

  /// `ED25519` / `RSA` / `ECDSA` for display.
  String get shortType {
    final t = type.toLowerCase();
    if (t.contains('ed25519')) return 'ED25519';
    if (t.contains('rsa')) return 'RSA';
    if (t.contains('ecdsa')) return 'ECDSA';
    return type;
  }
}

/// Decides whether to trust the server's key. Return false to abort.
typedef HostKeyCheck = FutureOr<bool> Function(PresentedHostKey key);

/// Everything needed to open one SSH connection.
class SshConnectParams {
  const SshConnectParams({
    required this.host,
    required this.port,
    required this.username,
    required this.auth,
    required this.secrets,
    this.compression = true,
    this.connectTimeout = const Duration(seconds: 12),
  });

  factory SshConnectParams.of(SshHostConfig config, SshSecrets secrets) => SshConnectParams(
    host: config.host.trim(),
    port: config.port,
    username: config.user.trim(),
    auth: config.auth,
    secrets: secrets,
    compression: config.compression,
  );

  final String host;
  final int port;
  final String username;
  final SshAuthMethod auth;
  final SshSecrets secrets;
  final bool compression;
  final Duration connectTimeout;
}

/// One authenticated SSH connection.
abstract class SshTransport implements RemoteShell {
  /// Opens a direct-tcpip channel to [host]:[port] as seen from the server.
  Future<TunnelChannel> openTunnel(String host, int port);

  /// Round-trips a keepalive; throws or times out when the link is dead.
  Future<void> ping({Duration timeout = const Duration(seconds: 10)});

  /// Completes when the connection closes for any reason.
  Future<void> get done;

  bool get isClosed;

  void close();
}

typedef SshTransportFactory = Future<SshTransport> Function(SshConnectParams params, HostKeyCheck verifyHostKey);

/// dartssh2-backed transport.
class DartSshTransport implements SshTransport, RemoteBootstrapShell {
  /// Takes ownership of an authenticated client, including closing it.
  DartSshTransport.fromClient(this._client);

  final SSHClient _client;

  static Future<SshTransport> connect(SshConnectParams params, HostKeyCheck verifyHostKey) async {
    List<SSHKeyPair>? identities;
    if (params.auth == SshAuthMethod.privateKey) {
      identities = await decodePrivateKey(params.secrets.privateKey ?? '', params.secrets.passphrase);
    } else if ((params.secrets.password ?? '').isEmpty) {
      throw HostLinkError(HostLinkErrorKind.authFailed, appL10n.remoteErrPasswordMissing);
    }

    final SSHSocket socket;
    try {
      socket = await SSHSocket.connect(params.host, params.port, timeout: params.connectTimeout);
    } on SocketException catch (e) {
      throw describeSocketError(e, params);
    } on TimeoutException {
      throw HostLinkError(
        HostLinkErrorKind.unreachable,
        appL10n.remoteErrAddressUnresponsive(params.host, params.port),
        retryable: true,
      );
    }

    HostLinkError? keyVerdict;
    final client = SSHClient(
      socket,
      username: params.username,
      compression: params.compression,
      identities: identities,
      onPasswordRequest: params.auth == SshAuthMethod.password ? () => params.secrets.password : null,
      // Keyboard-interactive servers ask for the same password.
      onUserInfoRequest: params.auth == SshAuthMethod.password
          ? (request) => [for (final _ in request.prompts) params.secrets.password ?? '']
          : null,
      onVerifyHostKey: (type, fingerprint) async {
        final key = PresentedHostKey(type, utf8.decode(fingerprint, allowMalformed: true));
        try {
          return await verifyHostKey(key);
        } on HostLinkError catch (e) {
          keyVerdict = e;
          return false;
        }
      },
      // The link runs its own keepalive with a timeout (dartssh2's never
      // notices a dead socket on its own).
      keepAliveInterval: null,
      handshakeTimeout: const Duration(seconds: 20),
      authTimeout: const Duration(seconds: 30),
    );
    try {
      await client.authenticated;
    } catch (e) {
      client.close();
      if (keyVerdict != null) throw keyVerdict!;
      throw describeSshError(e, params);
    }
    return DartSshTransport.fromClient(client);
  }

  /// Parses a PEM private key, mapping failures to a person-readable error.
  static Future<List<SSHKeyPair>> decodePrivateKey(String pem, String? passphrase) async {
    final text = pem.trim();
    if (text.isEmpty) {
      throw HostLinkError(HostLinkErrorKind.badPrivateKey, appL10n.remoteErrPrivateKeyMissing);
    }
    try {
      final pass = (passphrase == null || passphrase.isEmpty) ? null : passphrase;
      // PEM parsing and the encrypted-key KDF are synchronous CPU work.
      // Keep localization on the caller isolate; send only key material.
      final pairs = await Isolate.run(() {
        if (pass == null && SSHKeyPair.isEncryptedPem(text)) return null;
        return SSHKeyPair.fromPem(text, pass);
      }, debugName: 'ssh-private-key');
      if (pairs == null) {
        throw HostLinkError(HostLinkErrorKind.badPrivateKey, appL10n.remoteErrKeyNeedsPassword);
      }
      if (pairs.isEmpty) throw const FormatException('no keys');
      return pairs;
    } on HostLinkError {
      rethrow;
    } on SSHKeyDecryptError catch (e) {
      throw HostLinkError(HostLinkErrorKind.badPrivateKey, appL10n.remoteErrKeyPassword, detail: e.message);
    } catch (e) {
      throw HostLinkError(
        HostLinkErrorKind.badPrivateKey,
        appL10n.remoteErrKeyUnreadable,
        detail: appL10n.remotePrivateKeyFormats(e.toString()),
      );
    }
  }

  static HostLinkError describeSocketError(SocketException e, SshConnectParams params) {
    final os = e.osError?.message ?? e.message;
    final text = '$os ${e.message}'.toLowerCase();
    final where = '${params.host}:${params.port}';
    if (text.contains('refused')) {
      return HostLinkError(
        HostLinkErrorKind.unreachable,
        appL10n.remoteErrAddressRejected(where),
        detail: os,
        retryable: true,
      );
    }
    if (text.contains('host lookup') || text.contains('name') && text.contains('resol') || text.contains('nodename')) {
      return HostLinkError(
        HostLinkErrorKind.unreachable,
        appL10n.remoteErrSshHostNotFound(params.host),
        detail: os,
        retryable: true,
      );
    }
    return HostLinkError(
      HostLinkErrorKind.unreachable,
      appL10n.remoteErrSshAddressUnresponsive(where),
      detail: os,
      retryable: true,
    );
  }

  static HostLinkError describeSshError(Object e, SshConnectParams params) {
    if (e is HostLinkError) return e;
    if (e is SSHAuthAbortError) {
      final reason = e.reason;
      if (reason is SSHHostkeyError) return describeSshError(reason, params);
      // dartssh2 uses a null reason for EOF and authentication deadlines, and a
      // peer can report the loss itself (RFC 4253 reason 10).
      // The link owns cancellation; explicit peer refusals stay terminal below.
      if (reason == null ||
          reason is SSHSocketError ||
          (reason is SSHDisconnectError && reason.reasonCode == _disconnectConnectionLost)) {
        return HostLinkError(
          HostLinkErrorKind.unreachable,
          appL10n.remoteErrSshInterrupted,
          detail: ['$e', if (reason != null) '$reason'].join('\n'),
          retryable: true,
        );
      }
    }
    if (e is SSHAuthError) {
      return HostLinkError(
        HostLinkErrorKind.authFailed,
        params.auth == SshAuthMethod.password ? appL10n.remoteErrUsernamePassword : appL10n.remoteErrPrivateKeyRejected,
        detail: params.auth == SshAuthMethod.privateKey
            ? appL10n.remoteAuthorizedKeysHelp(params.username, e.toString())
            : '$e',
      );
    }
    if (e is SSHHostkeyError) {
      return HostLinkError(HostLinkErrorKind.hostKeyRejected, appL10n.remoteErrFingerprintUntrusted, detail: '$e');
    }
    if (e is SocketException) return describeSocketError(e, params);
    if (e is TimeoutException) {
      return HostLinkError(
        HostLinkErrorKind.unreachable,
        appL10n.remoteErrSshHandshakeTimeout,
        detail: '$e',
        retryable: true,
      );
    }
    final text = '$e';
    if (e is SSHHandshakeError || e is SSHSocketError || e is SSHStateError || e is SSHDisconnectError) {
      return HostLinkError(
        HostLinkErrorKind.unreachable,
        appL10n.remoteErrSshInterrupted,
        detail: text,
        retryable: true,
      );
    }
    return HostLinkError(HostLinkErrorKind.other, appL10n.remoteErrSshConnection, detail: text, retryable: true);
  }

  @override
  Future<RemoteExecResult> runBootstrap(String script, {required Duration timeout}) {
    final random = Random.secure();
    final nonce = List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    final marker = 'DSHAPP_DONE_$nonce';
    final out = _BootstrapOutput(marker, 'stdout');
    final err = _BootstrapOutput(marker, 'stderr');
    // Each stream's frame follows all of that stream's script output,
    // including the log tail after an exited/timeout result.
    final trap =
        r'_dsh_status=$?; trap - 0; '
        'printf ${shQuote('\n$marker stdout %s\n')} "\$_dsh_status"; '
        'printf ${shQuote('\n$marker stderr %s\n')} "\$_dsh_status" >&2; '
        r'exit "$_dsh_status"';
    // Keep any login-profile EXIT handler outside this script's trap.
    final command = loginShell('(\ntrap ${shQuote(trap)} 0\n$script\n)');
    final completed = Completer<RemoteExecResult>();
    SSHSession? session;
    StreamSubscription<Uint8List>? stdoutSubscription;
    StreamSubscription<Uint8List>? stderrSubscription;
    var stdoutDone = false;
    var stderrDone = false;
    var channelDone = false;
    var settled = false;
    late final Timer timer;

    void cleanUp() {
      timer.cancel();
      unawaited(stdoutSubscription?.cancel());
      unawaited(stderrSubscription?.cancel());
      // close() alone may wait for a peer that never closes its output.
      session?.channel.destroy();
    }

    void fail(Object error, StackTrace stack) {
      if (settled) return;
      settled = true;
      out.finish();
      err.finish();
      cleanUp();
      if (error is! TimeoutException && error is! SSHError) {
        completed.completeError(error, stack);
        return;
      }
      final timeoutError = error is TimeoutException;
      final stdout = _bootstrapDiagnostic(out.text());
      final stderr = _bootstrapDiagnostic(err.text());
      completed.completeError(
        HostLinkError(
          HostLinkErrorKind.unreachable,
          timeoutError ? appL10n.remoteErrCommandTimeout : appL10n.remoteErrSshInterrupted,
          retryable: true,
          detail: [
            redactRemoteTokens(timeoutError ? 'after $timeout' : '$error'),
            if (stdout.isNotEmpty) 'stdout:\n$stdout',
            if (stderr.isNotEmpty) 'stderr:\n$stderr',
          ].join('\n'),
        ),
        stack,
      );
    }

    void finishIfReady() {
      if (settled) return;
      final framed = out.status != null && out.status == err.status;
      if (!framed && !(stdoutDone && stderrDone && channelDone)) return;
      settled = true;
      out.finish();
      err.finish();
      final result = RemoteExecResult(
        framed ? out.status : session!.exitCode,
        out.text(beforeFrame: framed),
        err.text(beforeFrame: framed),
      );
      cleanUp();
      completed.complete(result);
    }

    // One deadline includes opening the session. execute has no public
    // handle to cancel until it returns; reclaim a late session below.
    timer = Timer(timeout, () => fail(TimeoutException('bootstrap', timeout), StackTrace.current));
    unawaited(
      _client.execute(command).then<void>((opened) {
        if (settled) {
          opened.channel.destroy();
          return;
        }
        session = opened;
        stdoutSubscription = opened.stdout.listen(
          (data) {
            out.bytes(data);
            finishIfReady();
          },
          onDone: () {
            out.finish();
            stdoutDone = true;
            finishIfReady();
          },
          onError: fail,
        );
        stderrSubscription = opened.stderr.listen(
          (data) {
            err.bytes(data);
            finishIfReady();
          },
          onDone: () {
            err.finish();
            stderrDone = true;
            finishIfReady();
          },
          onError: fail,
        );
        unawaited(
          opened.done.then<void>((_) {
            channelDone = true;
            finishIfReady();
          }, onError: fail),
        );
      }, onError: fail),
    );
    return completed.future;
  }

  @override
  Future<RemoteExecResult> run(String script, {Duration timeout = const Duration(seconds: 30)}) async {
    final SSHRunResult result;
    try {
      result = await _client.runWithResult(loginShell(script)).timeout(timeout);
    } on TimeoutException {
      throw HostLinkError(
        HostLinkErrorKind.unreachable,
        appL10n.remoteErrCommandTimeout,
        retryable: true,
        detail: 'after $timeout',
      );
    } on SSHError catch (e) {
      throw HostLinkError(
        HostLinkErrorKind.unreachable,
        appL10n.remoteErrSshInterrupted,
        detail: '$e',
        retryable: true,
      );
    }
    return RemoteExecResult(
      result.exitCode,
      utf8.decode(result.stdout, allowMalformed: true),
      utf8.decode(result.stderr, allowMalformed: true),
    );
  }

  @override
  Future<TunnelChannel> openTunnel(String host, int port) async {
    try {
      final channel = await _client.forwardLocal(host, port, localHost: '127.0.0.1');
      return _ForwardChannel(channel);
    } on SSHChannelOpenError catch (e) {
      // 2 = SSH_OPEN_CONNECT_FAILED: nothing listens on that port anymore.
      if (e.code == 2) throw TunnelRefused(e);
      rethrow;
    }
  }

  @override
  Future<void> ping({Duration timeout = const Duration(seconds: 10)}) => _client.ping().timeout(timeout);

  @override
  Future<void> get done => _client.done.catchError((_) {});

  @override
  bool get isClosed => _client.isClosed;

  @override
  void close() => unawaited(Future.sync(_client.close).catchError((_) {}));
}

class _ForwardChannel implements TunnelChannel {
  _ForwardChannel(this._channel);

  final SSHForwardChannel _channel;

  @override
  Stream<Uint8List> get stream => _channel.stream;

  @override
  StreamSink<List<int>> get sink => _channel.sink;

  @override
  void destroy() => _channel.destroy();
}

// The frame recognizer keeps only a bounded suffix between chunks; collecting
// diagnostics must not rescan the whole output after every SSH packet.
class _BootstrapOutput implements Sink<String> {
  _BootstrapOutput(String marker, String stream)
    : _frame = RegExp('\n${RegExp.escape(marker)} $stream ([0-9]{1,3})\r?\n'),
      _frames = RegExp('\n${RegExp.escape(marker)} (?:stdout|stderr) [0-9]{1,3}\r?\n'),
      _suffixLength = marker.length + stream.length + 8;

  final RegExp _frame;
  final RegExp _frames;
  final int _suffixLength;
  final _output = StringBuffer();
  late final _decoder = const Utf8Decoder(allowMalformed: true).startChunkedConversion(this);
  var _suffix = '';
  var _frameStart = 0;
  var _finished = false;
  int? status;

  void bytes(Uint8List bytes) => _decoder.add(bytes);

  @override
  void add(String chunk) {
    final previousLength = _output.length;
    _output.write(chunk);
    // A merged stderr can still follow the stdout frame. Keep those bytes
    // until both expected frames arrive or the ordinary EOF path completes.
    if (status != null) return;
    final scan = _suffix + chunk;
    final match = _frame.firstMatch(scan);
    if (match != null && int.parse(match[1]!) <= 255) {
      status = int.parse(match[1]!);
      _frameStart = previousLength - _suffix.length + match.start;
      _suffix = '';
      return;
    }
    _suffix = scan.length <= _suffixLength ? scan : scan.substring(scan.length - _suffixLength);
  }

  void finish() {
    if (_finished) return;
    _finished = true;
    _decoder.close();
  }

  @override
  void close() {}

  String text({bool beforeFrame = false}) {
    final value = _output.toString();
    return (beforeFrame ? value.substring(0, _frameStart) : value).replaceAll(_frames, '');
  }
}

/// SSH_DISCONNECT_CONNECTION_LOST.
const _disconnectConnectionLost = 10;

String _bootstrapDiagnostic(String text) {
  final redacted = redactDiagnostics(redactRemoteTokens(text)).trim();
  const limit = 4096;
  return redacted.length <= limit ? redacted : '…\n${redacted.substring(redacted.length - limit)}';
}
