@TestOn('vm')
@Tags(['integration'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:test/test.dart';

// Explicit opt-in: CI installs openssh-server and creates /run/sshd. Nothing
// connects to an existing daemon or uses personal keys/passwords.
void main() {
  for (final serverCompression in [true, false]) {
    test('OpenSSH compression=$serverCompression: cipher matrix and rekey', () async {
      await _withSshd(serverCompression, (port, key, username) async {
        for (final enabled in [true, false]) {
          for (final mode in [
            (SSHCipherType.aes128gcm, SSHMacType.hmacSha256),
            (SSHCipherType.aes256gcm, SSHMacType.hmacSha256),
            (SSHCipherType.chacha20poly1305, SSHMacType.hmacSha256),
            (SSHCipherType.aes128ctr, SSHMacType.hmacSha256Etm),
            (SSHCipherType.aes256ctr, SSHMacType.hmacSha256),
          ]) {
            var exchanges = 0;
            final negotiated = <String>[];
            final client = SSHClient(
              await SSHSocket.connect('127.0.0.1', port),
              username: username,
              identities: [key],
              compression: enabled,
              algorithms: SSHAlgorithms(cipher: [mode.$1], mac: [mode.$2]),
              // These host keys exist only for this isolated loopback daemon.
              onVerifyHostKey: (_, __) => true,
              keepAliveInterval: null,
              handshakeTimeout: const Duration(seconds: 10),
              authTimeout: const Duration(seconds: 10),
              printDebug: (line) {
                if (line == 'SSHTransport._handleMessageKexInit') exchanges++;
                if (line != null && (line.startsWith('SSHTransport._clientCompression:') ||
                    line.startsWith('SSHTransport._serverCompression:'))) {
                  negotiated.add(line.split(': ').last);
                }
              },
            );
            try {
              await client.authenticated;
              final expected = enabled && serverCompression ? 'zlib@openssh.com' : 'none';
              expect(negotiated, [expected, expected], reason: mode.$1.name);
              final random = Random(42);
              // Incompressible bytes cross RekeyLimit; repeated text exercises
              // compression history in both directions. cat echoes exact bytes.
              final payload = Uint8List.fromList([
                ...List.generate(256 * 1024, (_) => random.nextInt(256)),
                ...List.filled(256 * 1024, 65),
              ]);
              await _echo(client, payload);
              expect(exchanges, greaterThan(1), reason: 'server-initiated rekey');
              final before = exchanges;
              await client.rekey();
              expect(exchanges, greaterThan(before), reason: 'client-initiated rekey');
              await _echo(client, Uint8List.fromList(utf8.encode('after-rekey\n' * 4000)));
              expect(negotiated, everyElement(expected));
            } finally {
              await client.close();
            }
          }
        }
      });
    }, skip: Platform.environment['SSH_COMPRESSION_TEST'] != '1',
        timeout: const Timeout(Duration(minutes: 3)));
  }
}

Future<void> _echo(SSHClient client, Uint8List payload) async {
  final session = await client.execute('cat');
  final output = session.stdout.expand((data) => data).toList();
  final errors = session.stderr.expand((data) => data).toList();
  // Many SSH packets, preserving the same compression dictionary throughout.
  for (var offset = 0; offset < payload.length; offset += 8192) {
    final flushed = client.flush();
    session.stdin.add(Uint8List.sublistView(
        payload, offset, min(offset + 8192, payload.length)));
    await flushed;
    await session.flush();
  }
  await session.stdin.close();
  expect(await output, payload);
  expect(await errors, isEmpty);
  await session.done;
  expect(session.exitCode, 0);
}

Future<void> _command(String executable, List<String> args) async {
  final result = await Process.run(executable, args);
  if (result.exitCode != 0) {
    throw StateError('$executable failed (${result.exitCode}): ${result.stderr}');
  }
}

Future<void> _withSshd(bool compression,
    Future<void> Function(int port, SSHKeyPair key, String username) body) async {
  final directory = await Directory.systemTemp.createTemp('dartssh2-compression-');
  Process? daemon;
  StreamSubscription<String>? logs;
  StreamSubscription<List<int>>? stdout;
  final log = <String>[];
  try {
    final hostKey = '${directory.path}/host';
    final clientKey = '${directory.path}/client';
    await _command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
    await _command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
    final userResult = await Process.run('id', ['-un']);
    if (userResult.exitCode != 0) throw StateError('Cannot identify test user');
    final username = (userResult.stdout as String).trim();
    final listener = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = listener.port;
    await listener.close();
    final config = File('${directory.path}/sshd_config');
    await config.writeAsString('''
Port $port
ListenAddress 127.0.0.1
HostKey $hostKey
PidFile ${directory.path}/sshd.pid
AuthorizedKeysFile $clientKey.pub
AllowUsers $username
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitRootLogin yes
Compression ${compression ? 'yes' : 'no'}
RekeyLimit 32K
LogLevel VERBOSE
''');
    daemon = await Process.start('/usr/sbin/sshd', ['-D', '-e', '-f', config.path]);
    final ready = Completer<void>();
    logs = daemon.stderr.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      log.add(line);
      if (log.length > 200) log.removeAt(0);
      if (line.contains('Server listening on') && !ready.isCompleted) ready.complete();
    });
    stdout = daemon.stdout.listen((_) {});
    await Future.any<void>([
      ready.future,
      daemon.exitCode.then<void>((code) => throw StateError('sshd exited: $code\n${log.join('\n')}')),
    ]).timeout(const Duration(seconds: 10));
    final key = SSHKeyPair.fromPem(await File(clientKey).readAsString()).single;
    await body(port, key, username);
  } catch (error) {
    // Test-only ephemeral daemon logs contain no authentication secrets.
    throw StateError('$error\nsshd:\n${log.join('\n')}');
  } finally {
    if (daemon != null) {
      daemon.kill();
      await daemon.exitCode;
    }
    await logs?.cancel();
    await stdout?.cancel();
    await directory.delete(recursive: true);
  }
}
