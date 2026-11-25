import 'dart:async';

import 'package:dsh_app/remote/relay/dsh_remote_backend.dart';
import 'package:dsh_app/remote/secret_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../packages/dsh_remote/test/support/fake_remote.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('replacement App backends share the inner secret store ownership', () async {
    final server = await FakeRemoteServer.start();
    final secrets = MemorySecretStore();
    final old = DshRemoteRelayBackend(secrets: secrets, serverUrl: server.url, direct: false);
    final next = DshRemoteRelayBackend(secrets: secrets, serverUrl: server.url, direct: false);
    addTearDown(server.close);
    addTearDown(old.account.close);
    addTearDown(next.account.close);
    await old.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    server.expireAccessTokens();
    final entered = Completer<void>();
    final release = Completer<void>();
    addTearDown(() { if (!release.isCompleted) release.complete(); });
    server.beforeRevokeResponse = () { entered.complete(); return release.future; };
    final logout = old.logout();
    await entered.future;
    await next.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    final committed = Map<String, String>.of(secrets.values);
    release.complete();
    await logout;
    expect(secrets.values, committed);
    final restored = DshRemoteRelayBackend(secrets: secrets, serverUrl: server.url, direct: false);
    addTearDown(restored.account.close);
    expect(await restored.currentUser(), isNotNull);
    expect(await restored.listHosts(), isEmpty);
  });
}
