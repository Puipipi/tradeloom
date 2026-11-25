import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Result of one non-interactive remote command.
class RemoteExecResult {
  const RemoteExecResult(this.exitCode, this.stdout, this.stderr);

  final int? exitCode;
  final String stdout;
  final String stderr;

  bool get ok => exitCode == 0;
}

/// Something that can run a POSIX `sh` script on the remote: the SSH
/// session in production, a local `sh` in tests.
abstract class RemoteShell {
  /// Runs [script] with `sh -lc` (login shell, so `~/.profile` PATH tweaks
  /// apply whatever the account's own shell is).
  Future<RemoteExecResult> run(String script, {Duration timeout = const Duration(seconds: 30)});
}

/// SSH can finish a startup script before a background child releases the
/// session. Ordinary commands keep the full drain-and-exit contract of run.
abstract interface class RemoteBootstrapShell implements RemoteShell {
  Future<RemoteExecResult> runBootstrap(String script, {required Duration timeout});
}

/// A URL query value ends at a query separator, fragment or whitespace.
String redactRemoteTokens(String text) => text.replaceAll(RegExp(r'token=[^\s&#]+', caseSensitive: false), 'token=•••');

/// Single-quotes [value] for POSIX sh.
String shQuote(String value) => "'${value.replaceAll("'", r"'\''")}'";

/// `sh -lc '<script>'`: works under bash, zsh, fish and busybox accounts alike.
String loginShell(String script) {
  // Unlike POSIX sh, fish interprets \\ and \' inside single quotes. Keep
  // both backslashes and quotes outside quoted spans so the account shell
  // passes the same script to sh, including its nested trap quoting.
  final escaped = script.replaceAllMapped(RegExp(r"['\\]"), (match) => "'\\${match[0]}'");
  return "sh -lc '$escaped'";
}

/// Runs scripts with the local `/bin/sh` (tests, and a "remote" that is this
/// machine).
class LocalProcessShell implements RemoteShell {
  LocalProcessShell({this.environment, this.workingDirectory});

  final Map<String, String>? environment;
  final String? workingDirectory;

  @override
  Future<RemoteExecResult> run(String script, {Duration timeout = const Duration(seconds: 30)}) async {
    final process = await Process.start(
      '/bin/sh',
      ['-c', script],
      environment: environment,
      workingDirectory: workingDirectory,
    );
    final out = process.stdout.transform(utf8.decoder).join();
    final err = process.stderr.transform(utf8.decoder).join();
    final code = await process.exitCode.timeout(
      timeout,
      onTimeout: () {
        process.kill();
        return -1;
      },
    );
    return RemoteExecResult(code, await out, await err);
  }
}
