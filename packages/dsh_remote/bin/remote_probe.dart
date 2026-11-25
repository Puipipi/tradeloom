// Drives a remote Host through ds-harness-remote with the same DshClient API
// the app uses. Never sends model prompts.
//
//   dart run bin/remote_probe.dart --server http://127.0.0.1:8080 \
//       --email you@example.com --state /tmp/probe-state.json \
//       [--host <id|name>] [--create-session --cwd /path] [--watch-seconds 3] \
//       [--reconnect-test] [--trace]
//
// The password is read from DSH_REMOTE_PASSWORD (never from argv). Without
// --email the probe starts a QR / browser sign-in and prints the URL.
// --state keeps the device identity, tokens and Host pins between runs
// (written 0600; delete it to start over).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/dsh_remote.dart';

class _FileSecretStore implements SecretStore {
  _FileSecretStore(this.file) {
    if (file.existsSync()) {
      final decoded = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
      decoded.forEach((k, v) => _values[k] = v! as String);
    }
  }

  final File file;
  final Map<String, String> _values = {};

  Future<void> _flush() async {
    final tmp = File('${file.path}.tmp');
    await tmp.writeAsString(jsonEncode(_values));
    if (!Platform.isWindows) await Process.run('chmod', ['600', tmp.path]);
    await tmp.rename(file.path);
  }

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async {
    _values[key] = value;
    await _flush();
  }

  @override
  Future<void> delete(String key) async {
    _values.remove(key);
    await _flush();
  }
}

String? _option(List<String> args, String name) {
  final index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

void _log(String message) =>
    stdout.writeln('[${DateTime.now().toIso8601String().substring(11, 23)}] $message');

Future<void> main(List<String> args) async {
  if (args.contains('--help') || args.contains('-h')) {
    stdout.writeln(
      File.fromUri(
        Platform.script,
      ).readAsLinesSync().takeWhile((l) => l.startsWith('//')).join('\n'),
    );
    return;
  }
  final server = _option(args, '--server') ?? defaultRemoteServer.toString();
  final statePath = _option(args, '--state');
  final email = _option(args, '--email');
  final hostSelector = _option(args, '--host');
  final watchSeconds = int.tryParse(_option(args, '--watch-seconds') ?? '') ?? 3;
  final trace = args.contains('--trace');

  final account = RemoteAccount(
    secrets: statePath == null ? MemorySecretStore() : _FileSecretStore(File(statePath)),
    serverUrl: server,
    deviceName: 'DSH App probe',
    platform: 'dsh-app-probe',
    controlTracer: trace ? (dir, frame) => _log('control $dir ${jsonEncode(frame)}') : null,
  );
  var exitCode = 0;
  DshClient? client;
  try {
    var user = await account.currentUser();
    if (user == null) {
      if (email != null) {
        final password = Platform.environment['DSH_REMOTE_PASSWORD'];
        if (password == null || password.isEmpty) {
          throw ArgumentError('set DSH_REMOTE_PASSWORD for --email');
        }
        user = await account.loginWithPassword(email, password);
      } else {
        final providers = await account.loginProviders();
        _log('sign-in providers: ${providers.map((p) => p.id).join(', ')}');
        final login = await account.startLogin(providerId: _option(args, '--provider'));
        _log(
          'open to sign in (${login.providerId}, expires ${login.expiresAt}): ${login.loginUrl}',
        );
        user = await login.result;
      }
    }
    _log('signed in: ${user.account} device=${user.deviceId} server=${user.serverUrl}');

    final hosts = await account.listHosts();
    for (final h in hosts) {
      _log(
        'host: ${h.name} id=${h.id} online=${h.online} platform=${h.platform} dsh=${h.harnessVersion} '
        'plugin=${h.pluginVersion} fingerprint=${h.fingerprint} trust=${h.trust.name}',
      );
    }
    final host = hosts
        .where(
          (h) => hostSelector == null ? h.online : (h.id == hostSelector || h.name == hostSelector),
        )
        .firstOrNull;
    if (host == null) throw StateError('no matching online Host');

    final stopwatch = Stopwatch()..start();
    client = await account.connectHost(
      host,
      onState: (s) => _log('state: $s'),
      tracer: trace
          ? (e) => _log('tunnel ${e.direction} ${e.channel} ${jsonEncode(e.data)}')
          : null,
    );
    final carrier = client.remoteCarrier!;
    _log(
      'connected in ${stopwatch.elapsedMilliseconds} ms; generation=${client.mux.generation!.number} '
      'clientId=${client.mux.generation!.clientId} home=${client.mux.generation!.home}',
    );
    _log('capabilities: ${carrier.capabilities.join(', ')}');

    final sessions = await client.listSessions();
    _log(
      'session/list: ${sessions.length} sessions ${sessions.take(5).map((s) => s.sessionId).toList()}',
    );

    String? sessionId = sessions.isEmpty ? null : sessions.first.sessionId;
    if (args.contains('--create-session')) {
      final created = await client.createSession(cwd: _option(args, '--cwd'));
      sessionId = created.sessionId;
      _log('session/create: ${created.sessionId} preset=${created.agentPreset}');
      final again = await client.listSessions();
      _log('session/list now contains it: ${again.any((s) => s.sessionId == sessionId)}');
    }

    final catalog = await client.listModels();
    _log(
      'session/modelCatalog: default=${catalog.defaultSelection?.provider}/${catalog.defaultSelection?.model} '
      'groups=${catalog.groups.map((g) => '${g.id}:${g.models.length}').join(',')}',
    );
    final key = await client.describeCredentials(['DEEPSEEK_API_KEY']);
    _log('credentials/describe: configured=${key['DEEPSEEK_API_KEY']?.configured}');
    _log(
      'fileUploads/upload supported over remote: ${client.supportsEndpoint('fileUploads/upload')}',
    );

    if (sessionId != null) {
      final snapshots = <SessionSnapshotEvent>[];
      final sub = client.watch(sessionId).listen((event) {
        switch (event) {
          case SessionSnapshotEvent():
            snapshots.add(event);
            _log(
              'watch: snapshot cursor=${event.cursor} events=${event.events.length} resync=${event.isResync}',
            );
          case SessionLogEvent():
            _log('watch: event ${event.seq} ${event.type}');
          case ConnectionStateEvent(:final state):
            _log('watch: connection ${state.name}');
          default:
            _log('watch: ${event.runtimeType}');
        }
      }, onError: (Object e) => _log('watch error: $e'));
      await Future<void>.delayed(Duration(seconds: watchSeconds));
      if (args.contains('--reconnect-test')) {
        final before = client.mux.generation!.number;
        _log('reconnect test: dropping the tunnel (generation $before)');
        client.mux.reconnect();
        final deadline = DateTime.now().add(const Duration(seconds: 30));
        while (snapshots.length < 2 && DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        _log(
          'reconnect test: generation ${client.mux.generation?.number}, snapshots=${snapshots.length}, '
          'resync=${snapshots.length > 1 && snapshots.last.isResync}',
        );
        if (snapshots.length < 2) exitCode = 2;
      }
      await sub.cancel();
    }
  } on RemoteConnectException catch (error) {
    _log('FAILED ${error.failure}');
    exitCode = 1;
  } finally {
    await client?.close();
    await account.close();
  }
  exit(exitCode);
}
