// The remote-command layer: probe/start scripts and their parsing.
//
// The scripts run for real against the local /bin/sh with a fake `dsh` that
// prints the launch line, in a temp HOME. The SSH transport itself is covered
// by live_ssh_test.dart (opt-in).

import 'dart:io';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/ssh/remote_bootstrap.dart';
import 'package:dsh_app/remote/ssh/remote_shell.dart';
import 'package:flutter_test/flutter_test.dart';

/// A stand-in `dsh`: records its args and normally delays the launch line.
/// Only setup without an old log opts into immediate URL publication.
/// then idles like a server (as a shell, so `ps` still shows "dsh").
const _fakeDsh = r'''#!/bin/sh
printf '%s\n' "$*" >> "$HOME/dsh-args.txt"
case "$FAKE_DSH_MODE" in
  crash) echo "Error: listen EACCES" >&2; exit 3 ;;
  silent) i=0; while [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done; exit 0 ;;
  fast) ;;
  *) sleep 1 ;;
esac
echo "dsh web: http://127.0.0.1:4${FAKE_DSH_PORT:-1234}/?token=tok-$$"
i=0; while [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
''';

/// Only the tools the scripts use, so a dsh installed on this machine (in
/// /usr/bin) can't leak into the test.
const _tools = ['cat', 'grep', 'tail', 'sed', 'sleep', 'mkdir', 'chmod', 'rm', 'ps', 'pkill', 'nohup'];

void main() {
  group('parsing', () {
    test('probe output: alive instance with the same command is reusable', () {
      final probe = RemoteDshBootstrap.parseProbe('''
Welcome to Ubuntu!
DSHAPP home /home/me
DSHAPP alive 4242
DSHAPP samecmd
DSHAPP url dsh web: http://127.0.0.1:38211/?token=AbC.d_e~f-9
''');
      expect(probe.home, '/home/me');
      expect(probe.pid, 4242);
      expect(probe.sameCommand, isTrue);
      expect(probe.reusable, isTrue);
    });

    test('probe output: nothing running, or a different command, is not reusable', () {
      expect(RemoteDshBootstrap.parseProbe('DSHAPP home /root\n').reusable, isFalse);
      expect(
        RemoteDshBootstrap.parseProbe('DSHAPP alive 1\nDSHAPP url dsh web: http://127.0.0.1:1/?token=x\n').reusable,
        isFalse,
      );
      // Alive but its log has no launch line yet.
      expect(RemoteDshBootstrap.parseProbe('DSHAPP alive 1\nDSHAPP samecmd\nDSHAPP url \n').reusable, isFalse);
    });

    test('start output: launch line gives port, token and pid', () {
      final endpoint = RemoteDshBootstrap.parseStart(
        const RemoteExecResult(0, '''
DSHAPP home /Users/me
DSHAPP dsh /opt/homebrew/bin/dsh
DSHAPP started 777
DSHAPP url dsh web: http://127.0.0.1:51234/?token=launch-tok
''', ''),
      );
      expect(endpoint.port, 51234);
      expect(endpoint.token, 'launch-tok');
      expect(endpoint.pid, 777);
      expect(endpoint.authority, '127.0.0.1:51234');
      expect(endpoint.home, '/Users/me');
      expect(endpoint.dshPath, '/opt/homebrew/bin/dsh');
    });

    test('start output: missing dsh is a helpful, non-retryable error', () {
      expect(
        () => RemoteDshBootstrap.parseStart(const RemoteExecResult(127, 'DSHAPP home /h\nDSHAPP nodsh\n', '')),
        throwsA(
          isA<HostLinkError>()
              .having((e) => e.kind, 'kind', HostLinkErrorKind.dshNotFound)
              .having((e) => e.retryable, 'retryable', isFalse)
              .having((e) => e.detail, 'detail', contains('npm install -g @deepseek-ai/dsh')),
        ),
      );
    });

    test('start output: a custom command that is not found names the command', () {
      expect(
        () => RemoteDshBootstrap.parseStart(
          const RemoteExecResult(1, 'DSHAPP started 5\nDSHAPP exited\nDSHAPP log sh: 1: mydsh: not found\n', ''),
          customCommand: true,
          command: 'mydsh web',
        ),
        throwsA(
          isA<HostLinkError>()
              .having((e) => e.kind, 'kind', HostLinkErrorKind.dshNotFound)
              .having((e) => e.message, 'message', contains('mydsh web')),
        ),
      );
    });

    test('start output: crash and timeout carry the (redacted) log tail', () {
      expect(
        () => RemoteDshBootstrap.parseStart(
          const RemoteExecResult(
            1,
            'DSHAPP started 5\nDSHAPP exited\nDSHAPP log Error: listen EADDRINUSE\nDSHAPP log url ?token=secret123\n',
            '',
          ),
        ),
        throwsA(
          isA<HostLinkError>()
              .having((e) => e.kind, 'kind', HostLinkErrorKind.dshStartFailed)
              .having((e) => e.detail, 'detail', allOf(contains('EADDRINUSE'), isNot(contains('secret123')))),
        ),
      );
      expect(
        () => RemoteDshBootstrap.parseStart(const RemoteExecResult(1, 'DSHAPP started 5\nDSHAPP timeout\n', '')),
        throwsA(
          isA<HostLinkError>()
              .having((e) => e.kind, 'kind', HostLinkErrorKind.dshTimeout)
              .having((e) => e.retryable, 'retryable', isTrue),
        ),
      );
    });

    test('paths: ~ is expanded remotely and for session cwd', () {
      expect(RemoteDshBootstrap.remotePathExpr('~/code/my app'), '"\$HOME"/\'code/my app\'');
      expect(RemoteDshBootstrap.remotePathExpr("/srv/it's"), "'/srv/it'\\''s'");
      expect(RemoteDshBootstrap.absolutePath('~/code', '/home/me'), '/home/me/code');
      expect(RemoteDshBootstrap.absolutePath('~', '/home/me/'), '/home/me/');
      expect(RemoteDshBootstrap.absolutePath('/srv/x', '/home/me'), '/srv/x');
      expect(RemoteDshBootstrap.absolutePath('  ', '/home/me'), isNull);
    });

    test('shQuote survives quotes', () {
      expect(shQuote("a'b"), "'a'\\''b'");
      expect(loginShell('echo hi'), "sh -lc 'echo hi'");
    });

    test('start script always binds loopback with an OS-picked port', () {
      final script = RemoteDshBootstrap(LocalProcessShell()).startScript();
      expect(script, contains('dsh web --host 127.0.0.1 --port 0 --no-open'));
      expect(script, contains('nohup'));
      expect(script, contains(r'$HOME/.dsh-app-remote'));
    });
  });

  group('scripts against /bin/sh', () {
    late Directory home;
    late Directory bin;
    late Map<String, String> env;

    setUp(() {
      home = Directory.systemTemp.createTempSync('dsh-app-remote-test-');
      bin = Directory('${home.path}/bin')..createSync();
      final tools = Directory('${home.path}/tools')..createSync();
      for (final tool in _tools) {
        final path = Process.runSync('sh', ['-c', 'command -v $tool']).stdout.toString().trim();
        if (path.isNotEmpty) Link('${tools.path}/$tool').createSync(path);
      }
      final dsh = File('${bin.path}/dsh')..writeAsStringSync(_fakeDsh);
      Process.runSync('chmod', ['+x', dsh.path]);
      env = {'HOME': home.path, 'PATH': '${bin.path}:${tools.path}'};
    });

    tearDown(() async {
      // Stop whatever the scripts started, then remove the temp HOME.
      final pidFile = File('${home.path}/.dsh-app-remote/web.pid');
      if (pidFile.existsSync()) {
        final pid = int.tryParse(pidFile.readAsStringSync().trim());
        if (pid != null) Process.killPid(pid);
      }
      home.deleteSync(recursive: true);
    });

    RemoteDshBootstrap bootstrap({Map<String, String> extra = const {}, String command = 'dsh web', String? cwd}) =>
        RemoteDshBootstrap(
          LocalProcessShell(environment: {...env, ...extra}),
          launchCommand: command,
          workingDirectory: cwd,
          startTimeout: const Duration(seconds: 8),
        );

    test('starts dsh with the right flags, then reuses it', () async {
      final delayedLaunch = Stopwatch()..start();
      final first = await bootstrap(cwd: '~').ensureRunning();
      delayedLaunch.stop();
      expect(delayedLaunch.elapsed, greaterThanOrEqualTo(const Duration(seconds: 1)));
      expect(first.reused, isFalse);
      expect(first.port, 41234);
      expect(first.token, startsWith('tok-'));
      expect(first.home, home.path);
      expect(File('${home.path}/dsh-args.txt').readAsStringSync().trim(), 'web --host 127.0.0.1 --port 0 --no-open');

      final mode = (await FileStat.stat('${home.path}/.dsh-app-remote')).modeString();
      expect(mode, 'rwx------');

      final second = await bootstrap().ensureRunning();
      expect(second.reused, isTrue);
      expect(second.token, first.token);
      expect(second.pid, first.pid);
      // Still exactly one launch.
      expect(File('${home.path}/dsh-args.txt').readAsLinesSync(), hasLength(1));
    });

    test('a changed launch command needs explicit consent before restarting', () async {
      // Only initial empty-state setup is fast. The replacement still delays
      // its URL, so returning a stale old log entry remains observable.
      final first = await bootstrap(extra: {'FAKE_DSH_MODE': 'fast'}).ensureRunning();
      final changed = bootstrap(command: '${bin.path}/dsh web');
      await expectLater(
        changed.ensureRunning(),
        throwsA(isA<HostLinkError>().having((e) => e.retryable, 'retryable', isFalse)),
      );
      expect(Process.runSync('kill', ['-0', '${first.pid}']).exitCode, 0);
      expect(File('${home.path}/dsh-args.txt').readAsLinesSync(), hasLength(1));
      final second = await changed.ensureRunning(forceRestart: true);
      expect(second.reused, isFalse);
      expect(second.token, isNot(first.token));
      // The old process was stopped.
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(Process.runSync('kill', ['-0', '${first.pid}']).exitCode, isNot(0));
    });

    test('a missing launch log leaves the live instance alone', () async {
      final b = bootstrap(extra: {'FAKE_DSH_MODE': 'fast'});
      final first = await b.ensureRunning();
      File('${home.path}/.dsh-app-remote/web.log').deleteSync();
      await expectLater(b.ensureRunning(), throwsA(isA<HostLinkError>()));
      expect(Process.runSync('kill', ['-0', '${first.pid}']).exitCode, 0);
      expect(File('${home.path}/dsh-args.txt').readAsLinesSync(), hasLength(1));
    });

    test('a process appearing after probe is protected by the start script', () async {
      final b = bootstrap(extra: {'FAKE_DSH_MODE': 'fast'});
      final first = await b.ensureRunning();
      await expectLater(b.start(), throwsA(isA<HostLinkError>()));
      expect(Process.runSync('kill', ['-0', '${first.pid}']).exitCode, 0);
      expect(File('${home.path}/dsh-args.txt').readAsLinesSync(), hasLength(1));
    });

    test('finds dsh outside PATH (nvm layout)', () async {
      final nvm = Directory('${home.path}/.nvm/versions/node/v22.1.0/bin')..createSync(recursive: true);
      File('${bin.path}/dsh').renameSync('${nvm.path}/dsh');
      final endpoint = await bootstrap(extra: {'FAKE_DSH_MODE': 'fast'}).ensureRunning();
      expect(endpoint.dshPath, '${nvm.path}/dsh');
    });

    test('no dsh anywhere: dshNotFound', () async {
      File('${bin.path}/dsh').deleteSync();
      await expectLater(
        bootstrap().ensureRunning(),
        throwsA(isA<HostLinkError>().having((e) => e.kind, 'kind', HostLinkErrorKind.dshNotFound)),
      );
    });

    test('a crashing dsh reports its log', () async {
      await expectLater(
        bootstrap(extra: {'FAKE_DSH_MODE': 'crash'}).ensureRunning(),
        throwsA(
          isA<HostLinkError>()
              .having((e) => e.kind, 'kind', HostLinkErrorKind.dshStartFailed)
              .having((e) => e.detail, 'detail', contains('EACCES')),
        ),
      );
    });

    test('a dsh that never prints its URL times out', () async {
      final b = RemoteDshBootstrap(
        LocalProcessShell(environment: {...env, 'FAKE_DSH_MODE': 'silent'}),
        startTimeout: const Duration(seconds: 5),
      );
      try {
        final e = await b.ensureRunning();
        fail(
          'DEBUG endpoint port=${e.port} token=${e.token} pid=${e.pid} reused=${e.reused} log=${File('${home.path}/.dsh-app-remote/web.log').readAsStringSync()} args=${File('${home.path}/dsh-args.txt').readAsStringSync()}',
        );
      } on HostLinkError catch (e) {
        expect(e.kind, HostLinkErrorKind.dshTimeout);
      }
    }, timeout: const Timeout(Duration(seconds: 30)));

    test('a stale pid that is not ours is neither reused nor killed', () async {
      // Some unrelated long-running process of the same user.
      final other = await Process.start('sleep', ['30']);
      addTearDown(other.kill);
      final dir = Directory('${home.path}/.dsh-app-remote')..createSync();
      File('${dir.path}/web.pid').writeAsStringSync('${other.pid}\n');
      File('${dir.path}/web.cmd').writeAsStringSync('dsh web');
      File('${dir.path}/web.log').writeAsStringSync('dsh web: http://127.0.0.1:1/?token=old\n');

      final probe = await bootstrap().probe();
      expect(probe.pid, isNull);
      final started = await bootstrap().ensureRunning();
      expect(started.token, isNot('old'));
      expect(Process.runSync('kill', ['-0', '${other.pid}']).exitCode, 0, reason: 'unrelated process survived');
    });

    for (final failingPs in [false, true]) {
      test('legacy node-like unrelated process survives (ps fails: $failingPs)', () async {
        final sleep = Process.runSync('sh', ['-c', 'command -v sleep']).stdout.toString().trim();
        final alias = Link('${bin.path}/node-unrelated')..createSync(sleep);
        final other = await Process.start(alias.path, ['30']);
        addTearDown(other.kill);
        if (failingPs) {
          final ps = File('${bin.path}/ps')..writeAsStringSync('#!/bin/sh\nexit 1\n');
          Process.runSync('chmod', ['+x', ps.path]);
        }
        final dir = Directory('${home.path}/.dsh-app-remote')..createSync();
        File('${dir.path}/web.pid').writeAsStringSync('${other.pid}\n');
        File('${dir.path}/web.cmd').writeAsStringSync('dsh web');
        File('${dir.path}/web.log').writeAsStringSync('dsh web: http://127.0.0.1:1/?token=old\n');
        expect(File('${dir.path}/web.st').existsSync(), isFalse);
        final started = await bootstrap().ensureRunning();
        expect(started.reused, isFalse);
        expect(started.token, isNot('old'));
        expect(
          Process.runSync('kill', ['-0', '${other.pid}']).exitCode,
          0,
          reason: 'unrelated node-like process survived',
        );
      });
    }

    test('environment overrides reach the scripts (live-test isolation)', () async {
      final alt = Directory('${home.path}/alt')..createSync();
      final b = RemoteDshBootstrap(
        LocalProcessShell(environment: {...env, 'FAKE_DSH_MODE': 'fast'}),
        environment: {'HOME': alt.path, 'bad name': 'x'},
        startTimeout: const Duration(seconds: 8),
      );
      final endpoint = await b.ensureRunning();
      expect(endpoint.home, alt.path);
      expect(File('${alt.path}/.dsh-app-remote/web.pid').existsSync(), isTrue);
      await b.stop();
      expect(File('${alt.path}/.dsh-app-remote/web.pid').existsSync(), isFalse);
    });
  });
}
