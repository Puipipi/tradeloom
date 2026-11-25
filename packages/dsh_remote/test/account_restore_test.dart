import 'dart:async';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';

class _ReadStore extends MemorySecretStore {
  _ReadStore(super.initial);
  String? holdSuffix;
  final entered = Completer<void>();
  final release = Completer<void>();
  String? failSuffix;
  final failure = StateError('secret read temporarily unavailable');
  int reads = 0;

  @override
  Future<String?> read(String key) async {
    reads++;
    if (key.endsWith(holdSuffix ?? '\u0000')) {
      holdSuffix = null;
      entered.complete();
      await release.future;
    }
    if (key.endsWith(failSuffix ?? '\u0000')) {
      failSuffix = null;
      throw failure;
    }
    return super.read(key);
  }
}

void main() {
  late FakeRemoteServer server;
  late MemorySecretStore saved;
  late RemoteUser original;

  setUp(() async {
    server = await FakeRemoteServer.start();
    saved = MemorySecretStore();
    final writer = RemoteAccount(secrets: saved, serverUrl: server.url);
    original = await writer.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    await writer.close();
  });
  tearDown(() async {
    expect(server.protocolErrors, isEmpty);
    await server.close();
  });
  RemoteAccount restore(_ReadStore store) {
    final account = RemoteAccount(secrets: store, serverUrl: server.url);
    addTearDown(account.close);
    return account;
  }

  for (final suffix in ['.identity', '.credentials']) {
    test('concurrent account and host reads await $suffix restoration', () async {
      final store = _ReadStore(saved.values)..holdSuffix = suffix;
      final account = restore(store);
      final first = account.currentUser();
      await store.entered.future;
      final second = account.currentUser();
      final listing = account.listHosts().then<Object>((hosts) => hosts, onError: (Object error) => error);
      for (var i = 0; i < 8; i++) {
        await Future<void>.value();
      }
      store.release.complete();
      expect((await first)?.deviceId, original.deviceId);
      expect((await second)?.deviceId, original.deviceId);
      expect(await listing, isA<List<RemoteHost>>());
      expect(store.reads, 3, reason: 'one identity, one credentials, and one host pins read');
    });
    test('a failed $suffix read is reported and a later call restores', () async {
      final store = _ReadStore(saved.values)..failSuffix = suffix;
      final account = restore(store);
      await expectLater(account.currentUser(), throwsA(same(store.failure)));
      expect((await account.currentUser())?.deviceId, original.deviceId);
      expect(await account.listHosts(), isEmpty);
    });
  }
  test('restore error reaches both waiters and a sign-in retry reuses stored identity', () async {
    final store = _ReadStore(saved.values)
      ..holdSuffix = '.identity'
      ..failSuffix = '.identity';
    final account = restore(store);
    final first = account.currentUser().then<Object?>((user) => user, onError: (Object error) => error);
    await store.entered.future;
    final second = account.currentUser().then<Object?>((user) => user, onError: (Object error) => error);
    for (var i = 0; i < 8; i++) {
      await Future<void>.value();
    }
    store.release.complete();
    expect(await first, same(store.failure));
    expect(await second, same(store.failure));
    final user = await account.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    expect(user.deviceId, original.deviceId);
    expect((await account.currentUser())?.deviceId, original.deviceId);
    final fresh = restore(_ReadStore(store.values));
    expect((await fresh.currentUser())?.deviceId, original.deviceId);
  });
  test('logout waits for restoration and does not revive stored credentials', () async {
    final store = _ReadStore(saved.values)..holdSuffix = '.credentials';
    final account = restore(store);
    final reading = account.currentUser();
    await store.entered.future;
    final logout = account.logout(revokeDevice: false);
    for (var i = 0; i < 8; i++) {
      await Future<void>.value();
    }
    store.release.complete();
    await reading;
    await logout;
    expect(await account.currentUser(), isNull);
    final fresh = restore(_ReadStore(store.values));
    expect(await fresh.currentUser(), isNull);
  });
}
