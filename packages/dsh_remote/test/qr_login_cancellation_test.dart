import 'dart:async';
import 'dart:convert';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';

class _Gate {
  final entered = Completer<void>();
  final release = Completer<void>();

  Future<void> call() {
    entered.complete();
    return release.future;
  }

  void open() {
    if (!release.isCompleted) release.complete();
  }
}

class _ObservedSecrets extends MemorySecretStore {
  final credentialWrites = <String>[];
  Completer<void>? nextCredentialWrite;
  _Gate? credentialWriteGate;
  _Gate? identityWriteGate;

  Future<void> nextWriteOrQuiet() {
    final next = nextCredentialWrite = Completer<void>();
    return next.future.timeout(const Duration(seconds: 2), onTimeout: () {});
  }

  @override
  Future<void> write(String key, String value) async {
    if (key.endsWith('.identity')) {
      final held = identityWriteGate;
      identityWriteGate = null;
      await held?.call();
    }
    if (key.endsWith('.credentials')) {
      final held = credentialWriteGate;
      credentialWriteGate = null;
      await held?.call();
    }
    await super.write(key, value);
    if (key.endsWith('.credentials')) {
      credentialWrites.add(value);
      final next = nextCredentialWrite;
      if (next != null && !next.isCompleted) next.complete();
    }
  }
}

Matcher get _cancelled =>
    throwsA(isA<RemoteConnectException>().having((error) => error.code, 'code', 'LOGIN_CANCELLED'));

void main() {
  late FakeRemoteServer server;
  late _ObservedSecrets secrets;
  late RemoteAccount account;
  final gates = <_Gate>[];

  RemoteAccount newAccount() =>
      RemoteAccount(secrets: secrets, serverUrl: server.url, loginPollInterval: const Duration(milliseconds: 10));

  _Gate gate() {
    final held = _Gate();
    gates.add(held);
    return held;
  }

  Future<RemoteLogin> approvedLogin() async {
    final login = await account.startLogin();
    login.result.ignore();
    server.approveQr(login.loginUrl.pathSegments.last);
    return login;
  }

  Future<RemoteUser?> restoredUser() async {
    final restored = newAccount();
    addTearDown(restored.close);
    return restored.currentUser();
  }

  setUp(() async {
    gates.clear();
    server = await FakeRemoteServer.start();
    secrets = _ObservedSecrets();
    account = newAccount();
  });

  tearDown(() async {
    for (final held in gates) {
      held.open();
    }
    await account.close();
    await server.close();
  });

  test('cancel during account lookup never registers or commits credentials', () async {
    final lookup = gate();
    server.beforeAccountLookupResponse = lookup.call;
    final login = await approvedLogin();
    await lookup.entered.future.timeout(const Duration(seconds: 5));
    login.cancel();
    await expectLater(login.result, _cancelled);
    final quiet = secrets.nextWriteOrQuiet();
    lookup.open();
    await quiet;

    final current = await account.currentUser();
    final restored = await restoredUser();
    print(
      'MEASURE stage=accountMe registered_devices=${server.devices.length} '
      'credential_writes=${secrets.credentialWrites.length} '
      'current_signed_in=${current != null} restored_signed_in=${restored != null}',
    );
    expect(server.devices, isEmpty);
    expect(secrets.credentialWrites.length, 0);
    expect(current, isNull);
    expect(restored, isNull);
  });

  test('cancel during registration response never commits local credentials', () async {
    final registration = gate();
    server.beforeRegistrationResponse = registration.call;
    final login = await approvedLogin();
    await registration.entered.future.timeout(const Duration(seconds: 5));
    expect(server.devices, hasLength(1), reason: 'the Server already processed registration');
    login.cancel();
    await expectLater(login.result, _cancelled);
    final quiet = secrets.nextWriteOrQuiet();
    registration.open();
    await quiet;

    final current = await account.currentUser();
    final restored = await restoredUser();
    print(
      'MEASURE stage=register registered_devices=${server.devices.length} '
      'credential_writes=${secrets.credentialWrites.length} '
      'current_signed_in=${current != null} restored_signed_in=${restored != null}',
    );
    expect(secrets.credentialWrites.length, 0);
    expect(current, isNull);
    expect(restored, isNull);
    expect(server.devices.values.single.revoked, isFalse, reason: 'no rollback/revoke of committed Server work');
  });

  test('cancelled lookup arriving after a retry cannot replace the new credentials', () async {
    final lookup = gate();
    server.beforeAccountLookupResponse = lookup.call;
    final old = await approvedLogin();
    await lookup.entered.future.timeout(const Duration(seconds: 5));
    old.cancel();
    await expectLater(old.result, _cancelled);
    final retry = await approvedLogin();
    final user = await retry.result.timeout(const Duration(seconds: 5));
    final committed = Map<String, String>.of(secrets.values);
    final quiet = secrets.nextWriteOrQuiet();
    lookup.open();
    await quiet;

    expect(secrets.credentialWrites.length, 1);
    expect(secrets.values.keys, committed.keys);
    for (final entry in committed.entries) {
      expect(secrets.values[entry.key] == entry.value, isTrue, reason: 'preserve ${entry.key}');
    }
    expect((await account.currentUser())!.deviceId, user.deviceId);
    expect((await restoredUser())!.deviceId, user.deviceId);
    expect(await account.listHosts(), isEmpty, reason: 'the retry tokens remain valid');
  });

  test('cancelled registration arriving after a retry cannot replace the new credentials', () async {
    final registration = gate();
    server.beforeRegistrationResponse = registration.call;
    final old = await approvedLogin();
    await registration.entered.future.timeout(const Duration(seconds: 5));
    old.cancel();
    await expectLater(old.result, _cancelled);
    final retry = await approvedLogin();
    final user = await retry.result.timeout(const Duration(seconds: 5));
    final committed = Map<String, String>.of(secrets.values);
    final quiet = secrets.nextWriteOrQuiet();
    registration.open();
    await quiet;

    expect(secrets.credentialWrites.length, 1);
    expect(secrets.values.keys, committed.keys);
    for (final entry in committed.entries) {
      expect(secrets.values[entry.key] == entry.value, isTrue, reason: 'preserve ${entry.key}');
    }
    expect((await account.currentUser())!.deviceId, user.deviceId);
    expect((await restoredUser())!.deviceId, user.deviceId);
    expect(await account.listHosts(), isEmpty, reason: 'old tokens must not replace the newer token family');
    expect(server.devices.values.single.revoked, isFalse);
  });

  test('cancelled registration failure cannot rotate identity after a successful retry', () async {
    final previous = await account.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    server.devices[previous.deviceId]!.revoked = true;
    final registration = gate();
    server.beforeRegistrationResponse = registration.call;
    final old = await approvedLogin();
    await registration.entered.future.timeout(const Duration(seconds: 5));
    old.cancel();
    await expectLater(old.result, _cancelled);
    final retry = await approvedLogin();
    final user = await retry.result.timeout(const Duration(seconds: 5));
    expect(user.deviceId, isNot(previous.deviceId));
    final committed = Map<String, String>.of(secrets.values);
    final quiet = secrets.nextWriteOrQuiet();
    registration.open();
    await quiet;

    expect(secrets.credentialWrites.length, 2, reason: 'only initial and retry logins may commit');
    expect(secrets.values.keys, committed.keys);
    for (final entry in committed.entries) {
      expect(secrets.values[entry.key] == entry.value, isTrue, reason: 'preserve ${entry.key}');
    }
    expect(server.devices, hasLength(2), reason: 'the cancelled failure must not rotate/register again');
    expect((await restoredUser())!.deviceId, user.deviceId);
    expect(await account.listHosts(), isEmpty);
  });

  test('cancel is too late once the atomic credential write has started', () async {
    final write = secrets.credentialWriteGate = gate();
    final login = await approvedLogin();
    await write.entered.future.timeout(const Duration(seconds: 5));
    login.cancel();
    write.open();
    final user = await login.result.timeout(const Duration(seconds: 5));
    expect(secrets.credentialWrites.length, 1);
    expect((await account.currentUser())!.deviceId, user.deviceId);
    expect((await restoredUser())!.deviceId, user.deviceId);
    expect(jsonDecode(secrets.credentialWrites.single), containsPair('provider', 'github'));
  });

  test('an older atomic write cannot finish after and overwrite a retry commit', () async {
    final write = secrets.credentialWriteGate = gate();
    final old = await approvedLogin();
    await write.entered.future.timeout(const Duration(seconds: 5));
    old.cancel();
    final retry = await approvedLogin();
    var retryCompleted = false;
    final retryResult = retry.result.then((user) {
      retryCompleted = true;
      return user;
    });
    final prematureWrite = secrets.nextWriteOrQuiet();
    await prematureWrite;
    await Future<void>.delayed(Duration.zero);
    final completedWhileOldWritePending = retryCompleted;
    write.open();
    // The baseline reports the old result cancelled; the fixed version has
    // crossed its commit boundary. Cleanup accepts either to measure storage.
    await old.result.then<void>((_) {}, onError: (Object _) {});
    final user = await retryResult.timeout(const Duration(seconds: 5));
    await Future<void>.delayed(Duration.zero);
    print(
      'MEASURE stage=commit-order retry_completed_before_old_write=$completedWhileOldWritePending '
      'credential_writes=${secrets.credentialWrites.length}',
    );

    expect(completedWhileOldWritePending, isFalse, reason: 'credential commits must be ordered');
    expect(secrets.credentialWrites.length, 2);
    expect((await account.currentUser())!.deviceId, user.deviceId);
    expect((await restoredUser())!.deviceId, user.deviceId);
    expect(await account.listHosts(), isEmpty, reason: 'the last stored token family must belong to the retry');
  });

  test('a queued credential commit is still cancellable before its write starts', () async {
    final write = secrets.credentialWriteGate = gate();
    final old = await approvedLogin();
    await write.entered.future.timeout(const Duration(seconds: 5));
    final retry = await approvedLogin();
    await secrets.nextWriteOrQuiet();
    retry.cancel();
    await expectLater(retry.result, _cancelled);
    write.open();
    await old.result.timeout(const Duration(seconds: 5));
    await Future<void>.delayed(Duration.zero);
    expect(secrets.credentialWrites.length, 1, reason: 'cancelled queued work must not enter SecretStore.write');
  });

  test('a failed earlier credential write does not block the next login commit', () async {
    final write = secrets.credentialWriteGate = gate();
    final old = await approvedLogin();
    await write.entered.future.timeout(const Duration(seconds: 5));
    final retry = await approvedLogin();
    write.release.completeError(StateError('store temporarily unavailable'));
    await expectLater(
      old.result,
      throwsA(
        isA<RemoteConnectException>().having(
          (error) => error.failure.message,
          'original failure',
          contains('store temporarily unavailable'),
        ),
      ),
    );
    final user = await retry.result.timeout(const Duration(seconds: 5));
    expect(secrets.credentialWrites.length, 1);
    expect((await restoredUser())!.deviceId, user.deviceId);
    expect(await account.listHosts(), isEmpty);
  });

  test('cancelled identity initialization cannot clear a later retry credential', () async {
    final identityWrite = secrets.identityWriteGate = gate();
    final old = await approvedLogin();
    await identityWrite.entered.future.timeout(const Duration(seconds: 5));
    old.cancel();
    await expectLater(old.result, _cancelled);
    final retry = await approvedLogin();
    await secrets.nextWriteOrQuiet();
    identityWrite.open();
    final user = await retry.result.timeout(const Duration(seconds: 5));
    await secrets.nextWriteOrQuiet();

    print('MEASURE stage=identity-init credential_writes=${secrets.credentialWrites.length}');
    expect(secrets.credentialWrites.length, 1);
    expect((await account.currentUser())!.deviceId, user.deviceId);
    expect((await restoredUser())!.deviceId, user.deviceId);
    expect(await account.listHosts(), isEmpty);
  });

  test('a failed identity write is reported and does not poison a later login', () async {
    final identityWrite = secrets.identityWriteGate = gate();
    final old = await approvedLogin();
    await identityWrite.entered.future.timeout(const Duration(seconds: 5));
    identityWrite.release.completeError(StateError('identity store temporarily unavailable'));
    await expectLater(
      old.result,
      throwsA(
        isA<RemoteConnectException>().having(
          (error) => error.failure.message,
          'original failure',
          contains('identity store temporarily unavailable'),
        ),
      ),
    );
    final retry = await approvedLogin();
    final user = await retry.result.timeout(const Duration(seconds: 5));
    expect(secrets.credentialWrites.length, 1);
    expect((await restoredUser())!.deviceId, user.deviceId);
    expect(await account.listHosts(), isEmpty);
  });
}
