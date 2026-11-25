import 'dart:async';
import 'dart:convert';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';

class _Gate {
  final entered = Completer<void>();
  final released = Completer<void>();

  Future<void> wait() {
    entered.complete();
    return released.future;
  }

  void release() {
    if (!released.isCompleted) released.complete();
  }
}

Future<Object?> _outcome<T>(Future<T> future) =>
    future.then<Object?>((value) => value, onError: (Object error, StackTrace _) => error);

void main() {
  late FakeRemoteServer server;
  late MemorySecretStore secrets;
  late RemoteAccount account;

  RemoteAccount newAccount() => RemoteAccount(secrets: secrets, serverUrl: server.url);

  Future<RemoteUser> signIn() => account.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);

  String? storedCredentials() =>
      secrets.values.entries.where((entry) => entry.key.endsWith('.credentials')).firstOrNull?.value;

  setUp(() async {
    server = await FakeRemoteServer.start();
    secrets = MemorySecretStore();
    account = newAccount();
  });

  tearDown(() async {
    await account.close();
    await server.close();
  });

  test('late accepted refresh cannot restore an account after normal logout', () async {
    await signIn();
    // The server may reject an access token the client still considers fresh.
    // listHosts uses the production AUTH_INVALID -> forced-refresh path.
    server.expireAccessTokens();
    final gate = _Gate();
    addTearDown(gate.release);
    server.beforeRefreshResponse = gate.wait;
    final listing = _outcome(account.listHosts());
    await gate.entered.future;
    expect(server.refreshCount, 1);

    // Normal revokeDevice:true logout does not wait for a forced refresh when
    // its cached token is locally fresh; failed best-effort revoke still exits.
    await account.logout();
    expect(await account.currentUser(), isNull);
    expect(storedCredentials(), isNull);
    gate.release();
    await listing;

    expect(await account.currentUser(), isNull, reason: 'a retired refresh must not sign the user back in');
    expect(storedCredentials(), isNull);
    final restored = newAccount();
    addTearDown(restored.close);
    expect(await restored.currentUser(), isNull);
  });

  test('late successful refresh keeps a subsequent password sign-in', () async {
    await signIn();
    final gate = _Gate();
    addTearDown(gate.release);
    server.beforeRefreshResponse = gate.wait;
    final refreshing = _outcome(account.accessToken(forceRefresh: true));
    await gate.entered.future;

    await signIn();
    final latestToken = await account.accessToken();
    final latestRecord = storedCredentials();
    gate.release();
    await refreshing;

    expect(await account.accessToken(), latestToken, reason: 'the completed sign-in owns the current token');
    expect(storedCredentials(), latestRecord);
    expect(await account.listHosts(), isEmpty);
  });

  test('late refused refresh cannot erase a subsequent password sign-in', () async {
    await signIn();
    final gate = _Gate();
    addTearDown(gate.release);
    server.beforeRefreshRequest = gate.wait;
    final refreshing = _outcome(account.accessToken(forceRefresh: true));
    await gate.entered.future;

    final latestUser = await signIn();
    final latestToken = await account.accessToken();
    final latestRecord = storedCredentials();
    // Registration really replaces that device's old tokens in this existing
    // HTTP fixture. The delayed old refresh naturally receives AUTH_INVALID.
    gate.release();
    final result = await refreshing;
    expect(result, isA<RemoteConnectException>());
    expect(await account.currentUser(), isNotNull, reason: 'an old refusal does not revoke the new sign-in');
    expect((await account.currentUser())!.deviceId, latestUser.deviceId);
    expect(await account.accessToken(), latestToken);
    expect(storedCredentials(), latestRecord);
    expect(await account.listHosts(), isEmpty);
  });

  test('a new sign-in starts its own refresh and old completion keeps its single-flight', () async {
    await signIn();
    final oldGate = _Gate();
    addTearDown(oldGate.release);
    server.beforeRefreshResponse = oldGate.wait;
    final old = _outcome(account.accessToken(forceRefresh: true));
    await oldGate.entered.future;
    await signIn();

    final currentGate = _Gate();
    addTearDown(currentGate.release);
    server.beforeRefreshResponse = currentGate.wait;
    final current = _outcome(account.accessToken(forceRefresh: true));
    // This call's restore continuation is queued before releasing the old
    // response. It must not join a refresh of the preceding credentials.
    oldGate.release();
    final startedOwnRefresh = await Future.any([
      currentGate.entered.future.then((_) => true),
      current.then((_) => false),
    ]);
    expect(startedOwnRefresh, isTrue, reason: 'new credentials need their own token rotation');
    await old;
    final concurrent = _outcome(account.accessToken(forceRefresh: true));
    currentGate.release();
    final results = await Future.wait([current, concurrent]);
    expect(results.first, isA<String>());
    expect(results.last, results.first);
    expect(server.refreshCount, 2, reason: 'old completion must not clear the newer in-flight rotation');
    expect(await account.accessToken(), results.first);
    expect(await account.listHosts(), isEmpty);
  });

  test('current refresh remains single-flight and persists its rotated token', () async {
    final user = await signIn();
    final previous = await account.accessToken();
    final gate = _Gate();
    addTearDown(gate.release);
    server.beforeRefreshResponse = gate.wait;
    final first = account.accessToken(forceRefresh: true);
    await gate.entered.future;
    final second = account.accessToken(forceRefresh: true);
    gate.release();
    final tokens = await Future.wait([first, second]);
    expect(tokens.first, isNot(previous));
    expect(tokens.last, tokens.first);
    expect(server.refreshCount, 1);
    expect(await account.accessToken(), tokens.first);
    final restored = newAccount();
    addTearDown(restored.close);
    expect((await restored.currentUser())!.deviceId, user.deviceId);
    expect(await restored.accessToken(), tokens.first);
  });

  test('a current nonretryable refresh refusal still removes its credentials', () async {
    final user = await signIn();
    final record = jsonDecode(storedCredentials()!) as Map<String, dynamic>;
    // Consume this synthetic token through the real public REST API. Reusing
    // it then follows the fixture's existing token-family rejection contract.
    await account.api.refresh(user.deviceId, record['refreshToken'] as String);
    await expectLater(
      account.refresh(),
      throwsA(isA<RemoteConnectException>().having((error) => error.failure.code, 'code', 'ACCOUNT_AUTH_REQUIRED')),
    );
    expect(await account.currentUser(), isNull);
    expect(storedCredentials(), isNull);
  });
}
