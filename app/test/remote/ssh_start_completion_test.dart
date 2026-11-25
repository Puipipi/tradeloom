import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
// These two pinned dependency internals drive its real session and channel
// without a network server; the application only uses the public API.
// ignore: implementation_imports
import 'package:dartssh2/src/message/msg_channel.dart';
// ignore: implementation_imports
import 'package:dartssh2/src/ssh_channel.dart';
import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/ssh/remote_bootstrap.dart';
import 'package:dsh_app/remote/ssh/remote_shell.dart';
import 'package:dsh_app/remote/ssh/ssh_transport.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _MemorySocket extends SSHSocket {
  _MemorySocket() {
    outgoing.stream.listen((_) {});
  }

  final incoming = StreamController<Uint8List>();
  final outgoing = StreamController<List<int>>();
  final _closed = Completer<void>();

  @override
  Stream<Uint8List> get stream => incoming.stream;
  @override
  StreamSink<List<int>> get sink => outgoing.sink;
  @override
  Future<void> get done => _closed.future;

  @override
  Future<void> close() {
    if (_closed.isCompleted) return done;
    _closed.complete();
    if (!incoming.isClosed) unawaited(incoming.close());
    if (!outgoing.isClosed) unawaited(outgoing.close());
    return done;
  }

  @override
  void destroy() => unawaited(close());
}

class _Session {
  _Session() {
    controller = SSHChannelController(
      localId: 0,
      remoteId: 0,
      localMaximumPacketSize: 32768,
      remoteMaximumPacketSize: 32768,
      localInitialWindowSize: 1 << 20,
      remoteInitialWindowSize: 1 << 20,
      sendMessage: sent.add,
    );
    session = SSHSession(controller.channel);
  }

  final sent = <Object>[];
  late final SSHChannelController controller;
  late final SSHSession session;

  int get closeRequests => sent.whereType<SSH_Message_Channel_Close>().length;

  void bytes(List<int> data, {bool stderr = false}) {
    final bytes = Uint8List.fromList(data);
    controller.handleMessage(
      stderr
          ? SSH_Message_Channel_Extended_Data(recipientChannel: 0, dataTypeCode: 1, data: bytes)
          : SSH_Message_Channel_Data(recipientChannel: 0, data: bytes),
    );
  }

  void text(String data, {bool stderr = false}) => bytes(utf8.encode(data), stderr: stderr);

  void exitStatus(int status) =>
      controller.handleMessage(SSH_Message_Channel_Request.exitStatus(recipientChannel: 0, exitStatus: status));

  void finish(int status) {
    exitStatus(status);
    controller.handleMessage(SSH_Message_Channel_EOF(recipientChannel: 0));
    controller.handleMessage(SSH_Message_Channel_Close(recipientChannel: 0));
  }

  void destroy() => session.channel.destroy();
}

class _Execution {
  _Execution(this.command);

  final String command;
  final channel = _Session();
  final pending = Completer<SSHSession>();

  // The original implementation has no frame. Keeping a synthetic marker in
  // that case lets the same test reach its old runWithResult wait, not a
  // missing-method or parsing failure.
  String get marker => RegExp(r'DSHAPP_DONE_[0-9a-f]{32}').firstMatch(command)?.group(0) ?? 'DSHAPP_DONE_BASELINE';

  String frame({bool stderr = false, int status = 0}) => '\n$marker ${stderr ? 'stderr' : 'stdout'} $status\n';

  void frames({int status = 0}) {
    channel.text(frame(status: status));
    channel.text(frame(stderr: true, status: status), stderr: true);
  }
}

// runWithResult is inherited unchanged, so the baseline exercises the actual
// dependency's original drain-and-done wait. Only opening the session is faked.
class _Client extends SSHClient {
  _Client({this.holdExecute = false})
    : super(
        _MemorySocket(),
        username: 'synthetic-test',
        onVerifyHostKey: (_, _) => false,
        keepAliveInterval: null,
        handshakeTimeout: null,
        authTimeout: null,
      ) {
    unawaited(authenticated.then<void>((_) {}, onError: (Object _) {}));
    unawaited(done.then<void>((_) {}, onError: (Object _) {}));
  }

  final bool holdExecute;
  final executions = <_Execution>[];

  @override
  Future<SSHSession> execute(String command, {SSHPtyConfig? pty, SSHX11Config? x11, Map<String, String>? environment}) {
    expect(pty, isNull);
    final execution = _Execution(command);
    executions.add(execution);
    if (!holdExecute) execution.pending.complete(execution.channel.session);
    return execution.pending.future;
  }
}

class _Outcome<T> {
  _Outcome(Future<T> future) {
    unawaited(
      future.then<void>(
        (result) {
          value = result;
          settled = true;
        },
        onError: (Object cause) {
          error = cause;
          settled = true;
        },
      ),
    );
  }

  T? value;
  Object? error;
  bool settled = false;
}

class _Harness {
  _Harness({bool holdExecute = false}) : client = _Client(holdExecute: holdExecute) {
    transport = DartSshTransport.fromClient(client);
    bootstrap = RemoteDshBootstrap(transport, startTimeout: const Duration(seconds: 5));
  }

  final _Client client;
  late final DartSshTransport transport;
  late final RemoteDshBootstrap bootstrap;

  _Execution get execution => client.executions.single;

  Future<void> dispose() async {
    for (final execution in client.executions) {
      if (!execution.pending.isCompleted) execution.pending.complete(execution.channel.session);
      execution.channel.destroy();
    }
    await client.close();
  }
}

Future<void> _using(WidgetTester tester, Future<void> Function(_Harness) body, {bool holdExecute = false}) async {
  final harness = _Harness(holdExecute: holdExecute);
  try {
    await body(harness);
  } finally {
    await harness.dispose();
    await tester.pump();
  }
}

const _url = 'DSHAPP url http://127.0.0.1:43123/?token=synthetic-full-token\n';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('startup completes after its two output frames without remote EOF', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump();
      h.execution.channel.text('DSHAPP home /synthetic\nDSHAPP started 42\n$_url');
      h.execution.frames();
      await tester.pump();
      expect(result.value?.port, 43123);
      expect(result.value?.token, 'synthetic-full-token');
      expect(result.value?.pid, 42);
      expect(result.value?.home, '/synthetic');
      expect(result.error, isNull);
      expect(h.execution.channel.closeRequests, 1);
      expect(h.client.isClosed, isFalse);
    });
  });

  testWidgets('split UTF-8, URL and frames wait for the last stderr frame', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump();
      for (final byte in utf8.encode('DSHAPP home /家/测试\nDSHAPP url http://127.0.0.1:43123/?token=synthetic-')) {
        h.execution.channel.bytes([byte]);
      }
      await tester.pump();
      expect(result.settled, isFalse);
      h.execution.channel.text('full-token\n');
      for (final byte in utf8.encode(h.execution.frame())) {
        h.execution.channel.bytes([byte]);
      }
      h.execution.channel.text('late stderr 完整\n', stderr: true);
      await tester.pump();
      expect(result.settled, isFalse);
      final frame = h.execution.frame(stderr: true);
      h.execution.channel.text(frame.substring(0, frame.length - 1), stderr: true);
      await tester.pump();
      expect(result.settled, isFalse);
      h.execution.channel.text('\n', stderr: true);
      await tester.pump();
      expect(result.value?.token, 'synthetic-full-token');
      expect(result.value?.home, '/家/测试');
      expect(result.error, isNull);
    });
  });

  for (final terminal in ['exited', 'timeout']) {
    testWidgets('$terminal is not terminal until its complete log tail arrives', (tester) async {
      await _using(tester, (h) async {
        final result = _Outcome(h.bootstrap.start());
        await tester.pump();
        h.execution.channel.text('DSHAPP $terminal\nDSHAPP log first failure\n');
        await tester.pump();
        expect(result.settled, isFalse);
        h.execution.channel.text('DSHAPP log final failure token=synthetic-secret\n');
        h.execution.frames(status: 1);
        await tester.pump();
        expect(result.error, isA<HostLinkError>());
        final error = result.error! as HostLinkError;
        expect(error.kind, terminal == 'timeout' ? HostLinkErrorKind.dshTimeout : HostLinkErrorKind.dshStartFailed);
        expect(error.detail, contains('first failure'));
        expect(error.detail, contains('final failure'));
        expect(error.detail, isNot(contains('synthetic-secret')));
        expect(h.execution.channel.closeRequests, 1);
      });
    });
  }

  testWidgets('a stderr marker on stdout does not count as stderr completion', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump();
      h.execution.channel.text(_url);
      h.execution.channel.text(h.execution.frame());
      h.execution.channel.text(h.execution.frame(stderr: true));
      await tester.pump();
      expect(result.settled, isFalse);
      expect(h.execution.channel.closeRequests, 0);
      h.execution.channel.finish(0);
      await tester.pump();
      expect(result.value?.token, 'synthetic-full-token');
    });
  });

  testWidgets('merged stderr diagnostics after a stdout frame survive the EOF fallback', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump();
      h.execution.channel.text('DSHAPP exited\nDSHAPP log first failure\n');
      h.execution.channel.text(h.execution.frame(status: 1));
      await tester.pump();
      expect(result.settled, isFalse);
      h.execution.channel.text('DSHAPP log final merged failure\n');
      h.execution.channel.text(h.execution.frame(stderr: true, status: 1));
      h.execution.channel.finish(1);
      await tester.pump();
      expect(result.error, isA<HostLinkError>());
      final error = result.error! as HostLinkError;
      expect(error.kind, HostLinkErrorKind.dshStartFailed);
      expect(error.detail, contains('first failure'));
      expect(error.detail, contains('final merged failure'));
    });
  });

  testWidgets('timeout retains both diagnostic streams and redacts a whole query token', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump();
      h.execution.channel.text('DSHAPP home /synthetic\nDSHAPP started 42\n');
      h.execution.channel.text('partial http://127.0.0.1:43123/?token=ab+SECRET/');
      h.execution.channel.text('TAIL%2B&next=safe\n');
      h.execution.channel.text('stderr failure token=cd/SECRET+TAIL\n', stderr: true);
      h.execution.channel.text('DEEPSEEK_API_KEY=sk-synthetic-key-value\n', stderr: true);
      await tester.pump();
      await tester.pump(const Duration(seconds: 25));
      expect(result.error, isA<HostLinkError>());
      final error = result.error! as HostLinkError;
      expect(error.kind, HostLinkErrorKind.unreachable);
      expect(error.retryable, isTrue);
      expect(error.detail, contains('DSHAPP started 42'));
      expect(error.detail, contains('stderr failure'));
      expect(error.detail, contains('next=safe'));
      expect(error.detail, isNot(contains('SECRET')));
      expect(error.detail, isNot(contains('TAIL')));
      expect(error.detail, isNot(contains('sk-synthetic-key-value')));
      expect(h.execution.channel.closeRequests, 1);
      expect(h.client.isClosed, isFalse);
    });
  });

  testWidgets('diagnostics redact before retaining only their bounded tail', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump();
      h.execution.channel.text('old header\n${List.filled(20, 'ordinary-' * 70).join('\n')}\n');
      h.execution.channel.text('token=${'SYNTHETIC_SECRET_' * 700}\nlast useful failure\n');
      await tester.pump();
      await tester.pump(const Duration(seconds: 25));
      expect(result.error, isA<HostLinkError>());
      final detail = (result.error! as HostLinkError).detail!;
      expect(detail, contains('last useful failure'));
      expect(detail, contains('…'));
      expect(detail, isNot(contains('old header')));
      expect(detail, isNot(contains('SYNTHETIC_SECRET')));
      expect(detail.length, lessThan(4200));
    });
  });

  testWidgets('the same deadline covers execute and destroys a late returned session', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump(const Duration(seconds: 25));
      expect(result.error, isA<HostLinkError>());
      expect(h.execution.channel.closeRequests, 0);
      h.execution.pending.complete(h.execution.channel.session);
      await tester.pump();
      expect(h.execution.channel.closeRequests, 1);
      expect(h.client.isClosed, isFalse);
    }, holdExecute: true);
  });

  testWidgets('an execute error arriving after the deadline is consumed', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump(const Duration(seconds: 25));
      expect(result.error, isA<HostLinkError>());
      h.execution.pending.completeError(SSHChannelRequestError('late synthetic refusal'));
      await tester.pump();
      expect(tester.takeException(), isNull);
    }, holdExecute: true);
  });

  testWidgets('exit status alone cannot discard output that follows it', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump();
      h.execution.channel.exitStatus(1);
      await tester.pump();
      expect(result.settled, isFalse);
      h.execution.channel.text('DSHAPP exited\nDSHAPP log buffered final failure\n');
      h.execution.channel.finish(1);
      await tester.pump();
      expect(result.error, isA<HostLinkError>());
      expect((result.error! as HostLinkError).detail, contains('buffered final failure'));
    });
  });

  testWidgets('a shell missing before the trap still uses its normal error classification', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome(h.bootstrap.start());
      await tester.pump();
      h.execution.channel.text('sh: command not found\n', stderr: true);
      h.execution.channel.finish(127);
      await tester.pump();
      expect(result.error, isA<HostLinkError>());
      expect((result.error! as HostLinkError).kind, HostLinkErrorKind.noShell);
    });
  });

  for (final exitCode in [0, 70]) {
    test(
      'the real POSIX trap preserves exit $exitCode and follows both outputs',
      skip: Platform.isWindows ? 'needs /bin/sh' : false,
      () async {
        final home = Directory.systemTemp.createTempSync('dsh-start-completion-');
        final h = _Harness();
        try {
          final badHome = File('${home.path}/not-a-directory')..writeAsStringSync('synthetic');
          // The synthetic launch writes its URL synchronously before the
          // background no-op. Neither path needs the script's sleep loop.
          final bootstrap = RemoteDshBootstrap(
            h.transport,
            launchCommand:
                "printf '%s\\n' ${shQuote('dsh web: http://127.0.0.1:43123/?token=synthetic-shell-token')} "
                r'> "$D/web.log"; :',
            environment: {'HOME': exitCode == 0 ? home.path : badHome.path},
            startTimeout: const Duration(seconds: 5),
          );
          final result = _Outcome(bootstrap.start());
          // Let POSIX sh itself remove the outer login-shell quoting. Running
          // the resulting script directly avoids reading this machine's profile.
          final unquoted = await Process.run('/bin/sh', ['-c', 'set -- ${h.execution.command}; printf %s "\$3"']);
          expect(unquoted.exitCode, 0);
          final outerTrap = shQuote(r'_outer_status=$?; printf "OUTER_EXIT %s\n" "$_outer_status"');
          final ran = await Process.run('/bin/sh', ['-c', 'trap $outerTrap 0\n${unquoted.stdout}']);
          expect(ran.exitCode, exitCode);
          expect(ran.stdout, contains(h.execution.frame(status: exitCode)));
          expect(ran.stdout, endsWith('OUTER_EXIT $exitCode\n'));
          expect(ran.stderr, endsWith(h.execution.frame(stderr: true, status: exitCode)));
          if (exitCode == 0) {
            expect(ran.stdout, contains('DSHAPP url dsh web: http://127.0.0.1:43123/?token=synthetic-shell-token\n'));
          } else {
            expect(ran.stdout, contains('DSHAPP nodir\n'));
            expect(ran.stderr, contains('mkdir'));
          }
          expect(result.settled, isFalse);
        } finally {
          await h.dispose();
          home.deleteSync(recursive: true);
        }
      },
    );
  }

  final accountShells = {
    'sh': '/bin/sh',
    'bash': '/bin/bash',
    'zsh': '/bin/zsh',
    'fish': Platform.environment['DSH_TEST_FISH'] ?? '/usr/bin/fish',
  };
  for (final shell in accountShells.entries) {
    for (final exitCode in [0, 70]) {
      test(
        'the complete bootstrap command preserves exit $exitCode through ${shell.key}',
        skip: !File(shell.value).existsSync()
            ? 'needs ${shell.value} (set DSH_TEST_FISH for another fish path)'
            : false,
        () async {
          final home = Directory.systemTemp.createTempSync('dsh-login-shell-');
          final h = _Harness();
          try {
            final badHome = File('${home.path}/not-a-directory')..writeAsStringSync('synthetic');
            final bootstrap = RemoteDshBootstrap(
              h.transport,
              launchCommand:
                  "printf '%s\\n' ${shQuote('dsh web: http://127.0.0.1:43123/?token=synthetic-shell-token')} "
                  r'> "$D/web.log"; :',
              environment: {'HOME': exitCode == 0 ? home.path : badHome.path},
              startTimeout: const Duration(seconds: 5),
            );
            final result = _Outcome(bootstrap.start());
            // SSH passes the complete command to the account's shell first.
            // Do not remove its outer quoting before executing it here.
            final ran = await Process.run(shell.value, [
              if (shell.key == 'fish') '--no-config',
              '-c',
              h.execution.command,
            ]);
            expect(ran.exitCode, exitCode, reason: '${ran.stderr}');
            expect(ran.stdout, endsWith(h.execution.frame(status: exitCode)));
            expect(ran.stderr, endsWith(h.execution.frame(stderr: true, status: exitCode)));
            expect(
              ran.stdout,
              contains(
                exitCode == 0
                    ? 'DSHAPP url dsh web: http://127.0.0.1:43123/?token=synthetic-shell-token\n'
                    : 'DSHAPP nodir\n',
              ),
            );
            expect(result.settled, isFalse);
          } finally {
            await h.dispose();
            home.deleteSync(recursive: true);
          }
        },
      );
    }
  }

  testWidgets('ordinary run keeps waiting for EOF and retains exact output', (tester) async {
    await _using(tester, (h) async {
      final result = _Outcome<RemoteExecResult>(h.transport.run('printf ordinary'));
      await tester.pump();
      final out = 'ordinary\n${h.execution.frame()}';
      final err = 'diagnostic\n${h.execution.frame(stderr: true)}';
      h.execution.channel.text(out);
      h.execution.channel.text(err, stderr: true);
      h.execution.channel.exitStatus(7);
      await tester.pump();
      expect(result.settled, isFalse);
      expect(h.execution.channel.closeRequests, 0);
      h.execution.channel.finish(7);
      await tester.pump();
      expect(result.value?.stdout, out);
      expect(result.value?.stderr, err);
      expect(result.value?.exitCode, 7);
    });
  });
}
