import 'package:dsh_client/dsh_client.dart';

import '../../l10n/l10n.dart';
import '../link_status.dart';
import 'remote_shell.dart';
import 'ssh_host_config.dart';

/// dsh-app's state directory on the remote (pid, log, launch command).
const remoteStateDir = r'$HOME/.dsh-app-remote';

/// Marker that prefixes every structured line our scripts print, so login
/// banners and `~/.profile` chatter can't be mistaken for results.
const _tag = 'DSHAPP';

/// A `dsh web` on the remote that dsh-app can reach through a tunnel.
class RemoteDshEndpoint {
  const RemoteDshEndpoint({
    required this.port,
    required this.token,
    this.pid,
    this.reused = false,
    this.home,
    this.dshPath,
  });

  /// Port on the remote's loopback (`--host 127.0.0.1`).
  final int port;

  /// Launch token from the `dsh web: http://…/?token=` line; good for this
  /// process's lifetime only.
  final String token;
  final int? pid;

  /// An instance dsh-app had started earlier was still running.
  final bool reused;

  /// Remote `$HOME`, to expand `~` in the configured working directory.
  final String? home;

  /// Resolved `dsh` binary (default command only).
  final String? dshPath;

  /// `127.0.0.1:<port>`: the Host header DSH's fence accepts.
  String get authority => '127.0.0.1:$port';
}

/// What the probe found on the remote.
class RemoteProbe {
  const RemoteProbe({this.home, this.pid, this.sameCommand = false, this.launchLine});

  final String? home;

  /// Pid of the instance dsh-app started earlier, if it's still alive.
  final int? pid;

  /// That instance was started with the command configured now.
  final bool sameCommand;

  /// Latest `dsh web: http://…?token=` line from its log.
  final String? launchLine;

  bool get reusable => pid != null && sameCommand && DshLaunchUrl.tryParse(launchLine ?? '') != null;
}

/// Finds or starts dsh-app's managed `dsh web` on the remote.
///
/// Files under `~/.dsh-app-remote/` (mode 700):
/// * `web.pid` — pid of the `dsh web` process dsh-app started;
/// * `web.log` — its stdout/stderr, truncated on every start, so the last
///   `token=` line always belongs to the running process;
/// * `web.cmd` — the launch command it was started with; a live instance with
///   another command requires an explicit restart.
///
/// The server is started as `<command> --host 127.0.0.1 --port 0 --no-open`
/// under `nohup`, so it outlives the SSH session and is reused by the next
/// connection. Port 0 lets the OS pick a free port; the real one is read from
/// the launch line.
class RemoteDshBootstrap {
  RemoteDshBootstrap(
    this.shell, {
    String launchCommand = defaultDshLaunchCommand,
    this.workingDirectory,
    this.environment = const {},
    this.startTimeout = const Duration(seconds: 60),
  }) : launchCommand = launchCommand.trim().isEmpty ? defaultDshLaunchCommand : launchCommand.trim();

  final RemoteShell shell;
  final String launchCommand;
  final String? workingDirectory;

  /// Extra variables exported before anything runs (tests isolate `HOME` and
  /// `DSH_HOME` this way; advanced users could add PATH tweaks).
  final Map<String, String> environment;
  final Duration startTimeout;

  bool get _defaultCommand => launchCommand == defaultDshLaunchCommand;

  /// Reuses the running instance when it's healthy, otherwise starts one.
  /// [onDetail] receives short progress notes for the UI.
  Future<RemoteDshEndpoint> ensureRunning({bool forceRestart = false, void Function(String)? onDetail}) async {
    if (!forceRestart) {
      final probe = await this.probe();
      if (probe.reusable) {
        final url = DshLaunchUrl.tryParse(probe.launchLine!)!;
        onDetail?.call(appL10n.remoteBootstrapReusePort(url.baseUri.port));
        return RemoteDshEndpoint(
          port: url.baseUri.port,
          token: url.token,
          pid: probe.pid,
          reused: true,
          home: probe.home,
        );
      }
      if (probe.pid != null) throw _sharedInstanceError();
    }
    onDetail?.call(appL10n.remoteBootstrapStarting);
    return start(forceRestart: forceRestart);
  }

  Future<RemoteProbe> probe() async {
    final result = await shell.run(probeScript(), timeout: const Duration(seconds: 20));
    if (_missingShell(result)) throw _noShell(result);
    return parseProbe(result.stdout);
  }

  Future<RemoteDshEndpoint> start({bool forceRestart = false}) async {
    final runner = shell;
    final timeout = startTimeout + const Duration(seconds: 20);
    final result = runner is RemoteBootstrapShell
        ? await runner.runBootstrap(startScript(forceRestart: forceRestart), timeout: timeout)
        : await runner.run(startScript(forceRestart: forceRestart), timeout: timeout);
    if (_missingShell(result)) throw _noShell(result);
    return parseStart(result, customCommand: !_defaultCommand, command: launchCommand);
  }

  /// Stops dsh-app's managed instance (if any). Not used on disconnect: the
  /// server is meant to outlive the phone's connection.
  Future<void> stop() async {
    await shell.run(stopScript(), timeout: const Duration(seconds: 15));
  }

  // ---------------------------------------------------------------------------
  // Scripts (POSIX sh; also tested against the local /bin/sh).

  String _prelude() {
    final b = StringBuffer()..writeln('umask 077');
    for (final entry in environment.entries) {
      if (!RegExp(r'^[A-Za-z_][A-Za-z0-9_]*$').hasMatch(entry.key)) continue;
      b.writeln('${entry.key}=${shQuote(entry.value)}; export ${entry.key}');
    }
    b
      ..writeln('D="$remoteStateDir"')
      // A PID can be recycled after reboot; bind ownership to its start time.
      ..writeln(r"""
_st() {
  if [ -r "/proc/$1/stat" ]; then
    S=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
    S=${S##*) }
    set -- $S
    [ "$#" -ge 20 ] || return 1
    shift 19
    printf '%s\n' "$1"
  else
    ps -p "$1" -o lstart= 2>/dev/null
  fi
}
ours() {
  kill -0 "$1" 2>/dev/null || return 1
  if [ -f "$D/web.st" ]; then
    A=$(_st "$1") || return 1
    B=$(cat "$D/web.st" 2>/dev/null) || return 1
    [ -n "$A" ] && [ -n "$B" ] && [ "$A" = "$B" ]
    return $?
  fi
  A=$(ps -p "$1" -o args= 2>/dev/null) || return 1
  case "$A" in
    *'--host 127.0.0.1 --port 0 --no-open'*) return 0;;
    *) return 1;;
  esac
}
""");
    return b.toString();
  }

  String probeScript() {
    return '${_prelude()}'
        'printf \'$_tag home %s\\n\' "\$HOME"\n'
        'if [ -f "\$D/web.pid" ]; then\n'
        '  P=\$(cat "\$D/web.pid" 2>/dev/null)\n'
        '  if [ -n "\$P" ] && ours "\$P"; then\n'
        '    printf \'$_tag alive %s\\n\' "\$P"\n'
        '    if [ "\$(cat "\$D/web.cmd" 2>/dev/null)" = ${shQuote(launchCommand)} ]; then printf \'$_tag samecmd\\n\'; fi\n'
        '    L=\$(grep -E \'https?://[^ ]*[?&]token=\' "\$D/web.log" 2>/dev/null | tail -n 1)\n'
        '    printf \'$_tag url %s\\n\' "\$L"\n'
        '  else\n'
        '    rm -f "\$D/web.pid"\n'
        '  fi\n'
        'fi\n'
        'true\n';
  }

  String _stopOld() =>
      'if [ -f "\$D/web.pid" ]; then\n'
      '  P=\$(cat "\$D/web.pid" 2>/dev/null)\n'
      '  if [ -n "\$P" ] && ours "\$P"; then\n'
      '    if command -v pkill >/dev/null 2>&1; then pkill -TERM -P "\$P" 2>/dev/null; fi\n'
      '    kill "\$P" 2>/dev/null\n'
      '    i=0; while kill -0 "\$P" 2>/dev/null && [ \$i -lt 10 ]; do sleep 1; i=\$((i+1)); done\n'
      '    ours "\$P" && kill -9 "\$P" 2>/dev/null\n'
      '  fi\n'
      '  rm -f "\$D/web.pid"\n'
      'fi\n';

  String stopScript() => '${_prelude()}${_stopOld()}true\n';

  /// Looks for `dsh` where npm, nvm, volta, bun, pnpm and Homebrew put it,
  /// since a non-interactive SSH shell often lacks the PATH from `~/.bashrc`.
  static const _dshSearch = r'''
if ! command -v dsh >/dev/null 2>&1; then
  F=""
  for c in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.npm/bin" "$HOME/.volta/bin" "$HOME/.bun/bin" \
           "$HOME/.local/share/pnpm" "$HOME/Library/pnpm" /usr/local/bin /opt/homebrew/bin \
           "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do
    if [ -x "$c/dsh" ]; then F="$c"; fi
  done
  if [ -n "$F" ]; then PATH="$F:$PATH"; export PATH; fi
fi
if ! command -v dsh >/dev/null 2>&1; then printf 'DSHAPP nodsh\n'; exit 127; fi
printf 'DSHAPP dsh %s\n' "$(command -v dsh)"
''';

  String startScript({bool forceRestart = false}) {
    final seconds = startTimeout.inSeconds.clamp(5, 600);
    final cwd = workingDirectory?.trim();
    final b = StringBuffer(_prelude())
      ..writeln('printf \'$_tag home %s\\n\' "\$HOME"')
      ..writeln('mkdir -p "\$D" || { printf \'$_tag nodir\\n\'; exit 70; }')
      ..writeln('chmod 700 "\$D" 2>/dev/null');
    if (forceRestart) {
      b.write(_stopOld());
    } else {
      b.writeln(r'''if [ -f "$D/web.pid" ]; then
  P=$(cat "$D/web.pid" 2>/dev/null)
  if [ -n "$P" ] && ours "$P"; then printf 'DSHAPP shared\n'; exit 73; fi
fi''');
    }
    if (_defaultCommand) b.write(_dshSearch);
    if (cwd != null && cwd.isNotEmpty) {
      b.writeln('cd ${remotePathExpr(cwd)} 2>/dev/null || printf \'$_tag nocwd\\n\'');
    }
    b
      ..writeln('printf \'%s\' ${shQuote(launchCommand)} > "\$D/web.cmd"')
      ..writeln(': > "\$D/web.log"')
      ..writeln('NO_COLOR=1; export NO_COLOR')
      ..writeln('N=""; if command -v nohup >/dev/null 2>&1; then N=nohup; fi')
      ..writeln('\$N $launchCommand --host 127.0.0.1 --port 0 --no-open </dev/null >>"\$D/web.log" 2>&1 &')
      ..writeln('P=\$!')
      ..writeln('_st "\$P" > "\$D/web.st"')
      ..writeln('printf \'%s\\n\' "\$P" > "\$D/web.pid"')
      ..writeln('printf \'$_tag started %s\\n\' "\$P"')
      ..writeln('i=0')
      ..writeln('while [ \$i -lt $seconds ]; do')
      ..writeln('  L=\$(grep -E \'https?://[^ ]*[?&]token=\' "\$D/web.log" 2>/dev/null | tail -n 1)')
      ..writeln('  if [ -n "\$L" ]; then printf \'$_tag url %s\\n\' "\$L"; exit 0; fi')
      ..writeln('  if ! kill -0 "\$P" 2>/dev/null; then')
      ..writeln(
        '    printf \'$_tag exited\\n\'; tail -n 20 "\$D/web.log" 2>/dev/null | sed \'s/^/$_tag log /\'; exit 1',
      )
      ..writeln('  fi')
      ..writeln('  sleep 1; i=\$((i+1))')
      ..writeln('done')
      ..writeln('printf \'$_tag timeout\\n\'; tail -n 20 "\$D/web.log" 2>/dev/null | sed \'s/^/$_tag log /\'; exit 1');
    return b.toString();
  }

  // ---------------------------------------------------------------------------
  // Parsing (static: unit-tested without a shell).

  static Iterable<(String, String)> _tagged(String stdout) sync* {
    for (final raw in stdout.split('\n')) {
      final line = raw.trimRight();
      if (!line.startsWith('$_tag ')) continue;
      final rest = line.substring(_tag.length + 1);
      final space = rest.indexOf(' ');
      yield space < 0 ? (rest, '') : (rest.substring(0, space), rest.substring(space + 1));
    }
  }

  static RemoteProbe parseProbe(String stdout) {
    String? home;
    int? pid;
    var same = false;
    String? url;
    for (final (key, value) in _tagged(stdout)) {
      switch (key) {
        case 'home':
          home = value.isEmpty ? null : value;
        case 'alive':
          pid = int.tryParse(value.trim());
        case 'samecmd':
          same = true;
        case 'url':
          url = value.trim().isEmpty ? null : value.trim();
      }
    }
    return RemoteProbe(home: home, pid: pid, sameCommand: same, launchLine: url);
  }

  static RemoteDshEndpoint parseStart(
    RemoteExecResult result, {
    bool customCommand = false,
    String command = defaultDshLaunchCommand,
  }) {
    String? home;
    String? dsh;
    int? pid;
    String? url;
    var noDsh = false;
    var exited = false;
    var timedOut = false;
    final log = <String>[];
    for (final (key, value) in _tagged(result.stdout)) {
      switch (key) {
        case 'home':
          home = value.isEmpty ? null : value;
        case 'dsh':
          dsh = value.trim();
        case 'started':
          pid = int.tryParse(value.trim());
        case 'url':
          url = value.trim();
        case 'shared':
          throw _sharedInstanceError();
        case 'nodsh':
          noDsh = true;
        case 'exited':
          exited = true;
        case 'timeout':
          timedOut = true;
        case 'log':
          log.add(value);
      }
    }
    final parsed = url == null ? null : DshLaunchUrl.tryParse(url);
    if (parsed != null) {
      return RemoteDshEndpoint(port: parsed.baseUri.port, token: parsed.token, pid: pid, home: home, dshPath: dsh);
    }
    final tail = redactTokens(log.where((l) => l.trim().isNotEmpty).join('\n')).trim();
    if (noDsh || (exited && _looksNotFound(tail))) {
      throw HostLinkError(
        HostLinkErrorKind.dshNotFound,
        customCommand ? appL10n.remoteErrCommandNotFound(command) : appL10n.remoteErrDshMissing,
        detail: [
          if (!customCommand) 'npm install -g @deepseek-ai/dsh',
          if (!customCommand) appL10n.remoteStartCommandExample,
          if (tail.isNotEmpty) tail,
        ].join('\n'),
      );
    }
    if (timedOut) {
      throw HostLinkError(
        HostLinkErrorKind.dshTimeout,
        appL10n.remoteErrDshStartTimeout,
        detail: tail.isEmpty ? null : tail,
        retryable: true,
      );
    }
    if (exited) {
      throw HostLinkError(
        HostLinkErrorKind.dshStartFailed,
        appL10n.remoteErrDshExited,
        detail: tail.isEmpty ? null : tail,
      );
    }
    final stderr = result.stderr.trim();
    throw HostLinkError(
      HostLinkErrorKind.dshStartFailed,
      appL10n.remoteErrDshStart,
      detail: [
        if (result.exitCode != null) appL10n.remoteExitCode(result.exitCode!),
        if (stderr.isNotEmpty) stderr.split('\n').take(6).join('\n'),
      ].join('\n'),
    );
  }

  static HostLinkError _sharedInstanceError() => HostLinkError(
    HostLinkErrorKind.dshStartFailed,
    appL10n.remoteErrSharedInstance,
  );

  static bool _looksNotFound(String log) => RegExp(
    r'command not found|not found|No such file or directory|can.t open|ENOENT',
    caseSensitive: false,
  ).hasMatch(log);

  static bool _missingShell(RemoteExecResult result) =>
      !result.stdout.contains(_tag) &&
      RegExp(r"'sh' is not recognized|sh: (command )?not found|command not found: sh|No such file or directory.*\bsh\b")
          .hasMatch(result.stderr);

  static HostLinkError _noShell(RemoteExecResult result) =>
      HostLinkError(HostLinkErrorKind.noShell, appL10n.remoteErrNoShell, detail: result.stderr.trim());

  /// `token=…` values replaced, so a log tail can be shown or copied safely.
  static String redactTokens(String text) => redactRemoteTokens(text);

  /// Shell expression for a remote path with `~` expanded by the remote shell.
  static String remotePathExpr(String path) {
    final p = path.trim();
    if (p == '~') return '"\$HOME"';
    if (p.startsWith('~/')) return '"\$HOME"/${shQuote(p.substring(2))}';
    return shQuote(p);
  }

  /// [path] with `~` resolved against the remote [home] (for `session/create`).
  static String? absolutePath(String? path, String? home) {
    final p = path?.trim();
    if (p == null || p.isEmpty) return null;
    if (home == null || home.isEmpty) return p;
    if (p == '~') return home;
    if (p.startsWith('~/')) {
      return '${home.endsWith('/') ? home.substring(0, home.length - 1) : home}/${p.substring(2)}';
    }
    return p;
  }
}
