import 'dart:async';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';

class _TrackedStore extends MemorySecretStore {
  final deleted = <String>[];
  @override
  Future<void> delete(String key) async {
    deleted.add(key);
    await super.delete(key);
  }
}

void main() {
  test('old account logout cannot erase a second instance committed sign-in', () async {
    final server = await FakeRemoteServer.start();
    final store = _TrackedStore();
    final old = RemoteAccount(secrets: store, serverUrl: server.url);
    final next = RemoteAccount(secrets: store, serverUrl: server.url);
    addTearDown(server.close);
    addTearDown(old.close);
    addTearDown(next.close);
    await old.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    // Refuse revoke without revoking the shared identity. This response alone
    // is delayed, so the new registration can legitimately succeed first.
    server.expireAccessTokens();
    final entered = Completer<void>();
    final release = Completer<void>();
    addTearDown(() { if (!release.isCompleted) release.complete(); });
    server.beforeRevokeResponse = () {
      entered.complete();
      return release.future;
    };
    final logout = old.logout();
    await entered.future;
    final signedIn = await next.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    final committed = Map<String, String>.of(store.values);
    expect(committed.keys.where((key) => key.endsWith('.credentials')), hasLength(1));
    expect(await next.listHosts(), isEmpty);
    store.deleted.clear();
    release.complete();
    await logout;
    expect(store.deleted, isEmpty, reason: 'old logout lost authority when another account committed');
    expect(store.values, committed);
    final restored = RemoteAccount(secrets: store, serverUrl: server.url);
    addTearDown(restored.close);
    expect((await restored.currentUser())?.deviceId, signedIn.deviceId);
    expect(await restored.listHosts(), isEmpty);
  });

  test('a different secret store on the same origin does not retire logout', () async {
    final server = await FakeRemoteServer.start();
    final oldStore = _TrackedStore();
    final otherStore = _TrackedStore();
    final old = RemoteAccount(secrets: oldStore, serverUrl: server.url);
    final other = RemoteAccount(secrets: otherStore, serverUrl: server.url);
    addTearDown(server.close);
    addTearDown(old.close);
    addTearDown(other.close);
    await old.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    server.expireAccessTokens();
    final entered = Completer<void>();
    final release = Completer<void>();
    addTearDown(() { if (!release.isCompleted) release.complete(); });
    server.beforeRevokeResponse = () { entered.complete(); return release.future; };
    final logout = old.logout();
    await entered.future;
    await other.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    final committed = Map<String, String>.of(otherStore.values);
    release.complete();
    await logout;
    expect(oldStore.values, isEmpty);
    expect(otherStore.values, committed);
    expect(await other.listHosts(), isEmpty);
  });

  test('a different origin in the same store does not retire logout', () async {
    final server = await FakeRemoteServer.start();
    final anotherServer = await FakeRemoteServer.start();
    final store = _TrackedStore();
    final old = RemoteAccount(secrets: store, serverUrl: server.url);
    final other = RemoteAccount(secrets: store, serverUrl: anotherServer.url);
    addTearDown(server.close);
    addTearDown(anotherServer.close);
    addTearDown(old.close);
    addTearDown(other.close);
    await old.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    final oldKeys = store.values.keys.toSet();
    server.expireAccessTokens();
    final entered = Completer<void>();
    final release = Completer<void>();
    addTearDown(() { if (!release.isCompleted) release.complete(); });
    server.beforeRevokeResponse = () { entered.complete(); return release.future; };
    final logout = old.logout();
    await entered.future;
    await other.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    final committed = Map<String, String>.fromEntries(store.values.entries.where((entry) => !oldKeys.contains(entry.key)));
    release.complete();
    await logout;
    expect(store.values, committed);
    expect(await other.listHosts(), isEmpty);
  });

}
