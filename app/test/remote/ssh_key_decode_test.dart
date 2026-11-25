import 'dart:async';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/ssh/ssh_host_config.dart';
import 'package:dsh_app/remote/ssh/ssh_transport.dart';
import 'package:flutter_test/flutter_test.dart';

// Synthetic ED25519 key generated only for this regression. It has never
// authorized a host. OpenSSH bcrypt rounds: 16; this is not a user credential.
const encryptedKey = '''
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABCUQoklIL
CrPlYqOda2u7U3AAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIKxHFDA7dEytlxrW
2fsiAawyQ9q3BDI6L4cVtqPkRwSUAAAAsG2XtMQPuZahTV3xjcNgVWYlP8uDfoDCJKuUS0
Wbe3cNXwD1JadlKXKLZi6jbAtnrnINJHot78cagnUZLmLTx8Jm/3OWH/7wqo3N683xteZA
aaLOVzjQqEi2OEI9h9p5s29Da3PwcJKKKL5K5G+iDN3iN7IsXbu/xm1vRBlqwqHcnM7cMm
VVwpX3EgreaQ3xbjFvjn5QEUKUewk3HVOru67mB0OaU/1h8rAUGwNF20ED
-----END OPENSSH PRIVATE KEY-----
''';
const passphrase = 'wave5-test-only-passphrase';

void main() {
  tearDown(() => AppLocale.use(AppLocale.zhCN));

  test('decrypting a real encrypted key leaves the caller event loop responsive', () async {
    var ticks = 0;
    final heartbeat = Timer.periodic(const Duration(milliseconds: 1), (_) => ticks++);
    addTearDown(heartbeat.cancel);
    final pairs = await Future.sync(() => DartSshTransport.decodePrivateKey(encryptedKey, passphrase));
    heartbeat.cancel();
    expect(pairs, hasLength(1));
    expect(pairs.single.name, 'ssh-ed25519');
    final signature = pairs.single.sign(Uint8List.fromList([1, 2, 3]));
    expect(SSHSignature.getType(signature.encode()), 'ssh-ed25519');
    expect(SSHHostKey.getType(pairs.single.toPublicKey().encode()), 'ssh-ed25519');
    expect(ticks, greaterThan(0), reason: 'key decryption must not occupy the caller isolate');
  });

  test('the real connect path preserves localized wrong-password errors without blocking', () async {
    AppLocale.use(AppLocale.en);
    var ticks = 0;
    final heartbeat = Timer.periodic(const Duration(milliseconds: 1), (_) => ticks++);
    addTearDown(heartbeat.cancel);
    await expectLater(
      DartSshTransport.connect(
        const SshConnectParams(
          host: '127.0.0.1',
          port: 9,
          username: 'test',
          auth: SshAuthMethod.privateKey,
          secrets: SshSecrets(privateKey: encryptedKey, passphrase: 'wrong'),
        ),
        (_) => fail('key validation must fail before a connection is opened'),
      ),
      throwsA(
        isA<HostLinkError>()
            .having((error) => error.kind, 'kind', HostLinkErrorKind.badPrivateKey)
            .having((error) => error.message, 'localized message', appL10n.remoteErrKeyPassword),
      ),
    );
    heartbeat.cancel();
    expect(ticks, greaterThan(0));
  });

  for (final locale in [AppLocale.zhCN, AppLocale.en]) {
    test('key errors keep the caller locale ($locale)', () async {
      AppLocale.use(locale);
      for (final (pem, password, message) in [
        ('', null, appL10n.remoteErrPrivateKeyMissing),
        (encryptedKey, null, appL10n.remoteErrKeyNeedsPassword),
        ('not a PEM key', null, appL10n.remoteErrKeyUnreadable),
      ]) {
        await expectLater(
          Future.sync(() => DartSshTransport.decodePrivateKey(pem, password)),
          throwsA(
            isA<HostLinkError>()
                .having((error) => error.kind, 'kind', HostLinkErrorKind.badPrivateKey)
                .having((error) => error.message, 'message', message),
          ),
        );
      }
    });
  }
}
