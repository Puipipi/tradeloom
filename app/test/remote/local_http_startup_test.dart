import 'dart:async';
import 'dart:io';

import 'package:dsh_app/runtime/background_net.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/share_code/guest_fs.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/state/provider_keys.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../packages/dsh_client/test/support/fake_dsh.dart';

class _Runtime extends LocalRuntimeController {
  _Runtime(this.url);
  String url;
  @override
  LocalRuntimeState build() => _value(FakeDsh.token);
  LocalRuntimeState _value(String token) => LocalRuntimeState(
    loaded: true,
    status: RuntimeStatus.fromMap({'phase': 'running', 'baseUrl': url, 'token': token}),
  );
  void replace() => state = _value('second');
}

class _Settings extends SettingsController {
  _Settings(this.key);
  final String key;
  @override
  AppSettings build() => AppSettings(loaded: true, apiKey: key);
}

class _Mux extends DshMux {
  _Mux() : super(DshHttpCarrier(DshConnection(Uri.parse('http://127.0.0.1:9'))));
  final result = Completer<MuxGeneration>();
  Duration? requestedTimeout;
  bool shortTimeout = false;
  @override
  Future<MuxGeneration> ready({Duration? timeout}) {
    requestedTimeout = timeout;
    return shortTimeout
        ? result.future.timeout(
            const Duration(milliseconds: 20),
            onTimeout: () => throw const DshTransportException('controlled ready deadline'),
          )
        : result.future;
  }

  @override
  Future<void> close() async {}
}

class _Client extends DshClient {
  _Client() : super(DshConnection(Uri.parse('http://127.0.0.1:9')));
  final _readyMux = _Mux();
  @override
  _Mux get mux => _readyMux;
  final keyEntered = Completer<void>();
  final keyRelease = Completer<void>();
  bool closed = false;
  @override
  Future<void> setProviderKey(String key, {String ref = 'DEEPSEEK_API_KEY'}) async {
    keyEntered.complete();
    await keyRelease.future;
  }

  @override
  Future<void> close() async {
    closed = true;
    await super.close();
  }
}

class _Vault implements ProviderKeyVault {
  int reads = 0;
  final entered = Completer<void>();
  @override
  Future<Map<String, String>> readAll() async {
    reads++;
    if (!entered.isCompleted) entered.complete();
    return {};
  }

  @override
  Future<void> write(String id, String key) async {}
  @override
  Future<void> delete(String id) async {}
}

Duration? neverRetry(int count, Object error) => null;

ProviderContainer container({
  String key = '',
  String url = 'http://127.0.0.1:9',
  LocalClientConnector? connector,
  Duration? Function(int, Object)? retry = neverRetry,
  ProviderKeyVault? vault,
  void Function()? onGuestRead,
}) => ProviderContainer(
  retry: retry,
  overrides: [
    settingsProvider.overrideWith(() => _Settings(key)),
    localRuntimeProvider.overrideWith(() => _Runtime(url)),
    networkKicksProvider.overrideWithValue(const Stream.empty()),
    guestFsProvider.overrideWith((ref) async {
      onGuestRead?.call();
      return null;
    }),
    if (vault != null) providerKeyVaultProvider.overrideWithValue(vault),
    if (connector != null) localClientConnectorProvider.overrideWithValue(connector),
  ],
);
Future<T> nextState<T>(
  ProviderContainer c,
  T Function(AsyncValue<HostConnection?>) project,
  bool Function(AsyncValue<HostConnection?>) matches,
) {
  final done = Completer<T>();
  final sub = c.listen(localConnectionProvider, (_, next) {
    if (matches(next) && !done.isCompleted) done.complete(project(next));
  }, fireImmediately: true);
  return done.future.timeout(const Duration(seconds: 3)).whenComplete(sub.close);
}

Future<HostConnection> connected(ProviderContainer c) =>
    nextState(c, (s) => s.requireValue!, (s) => s is AsyncData<HostConnection?> && s.value != null);
Future<Object> failed(ProviderContainer c) => nextState(c, (s) => s.error!, (s) => s.hasError && !s.isLoading);
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    HttpOverrides.global = null;
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });
  test('default local connector publishes HTTP after key while mux is gated, then really ready', () async {
    final host = await FakeDsh.start();
    final entered = Completer<void>(), release = Completer<void>();
    host.beforeEventsReady = () async {
      entered.complete();
      await release.future;
    };
    host.handlers['credentials/set'] = (_) => {'ok': true};
    host.handlers['session/list'] = (_) => {
      'ok': true,
      'value': {'items': []},
    };
    // The production connector receives the launch token from the native status.
    final c = container(key: 'fake-key', url: host.baseUri.toString());
    try {
      final result = connected(c);
      await entered.future;
      final client = (await result).client;
      expect(release.isCompleted, isFalse);
      expect(client.mux.generation, isNull);
      expect(await client.listSessions(), isEmpty);
      expect(host.rpcCalls.where((r) => r['method'] == 'credentials/set'), hasLength(1));
      release.complete();
      await client.mux.ready();
      expect(client.mux.generation, isNotNull);
      expect(host.requests.where((r) => r['path'] == '/'), hasLength(1));
      expect(host.sockets, hasLength(1));
    } finally {
      if (!release.isCompleted) release.complete();
      c.dispose();
      await host.close();
    }
  });
  for (final status in [401, 403]) {
    test('actual mux $status fails while credentials are pending, without successful publication', () async {
      final host = await FakeDsh.start();
      host.rejectWebSocket = true;
      host.rejectedWebSocketStatus = status;
      final entered = Completer<void>(), release = Completer<void>();
      host.handlers['credentials/set'] = (_) => {'ok': true};
      host.beforeRpc = (name, args) async {
        if (name == 'credentials/set') {
          entered.complete();
          await release.future;
        }
      };
      late DshClient client;
      final refused = Completer<void>();
      final c = container(
        key: 'fake-key',
        connector: ({required baseUri, required token}) async {
          client = await DshClient.connect(baseUri: host.baseUri, token: FakeDsh.token, startMux: false);
          unawaited(
            client.mux.states
                .firstWhere((s) => s == DshConnectionState.unauthorized)
                .then((_) => refused.complete(), onError: refused.completeError),
          );
          return client;
        },
      );
      final seen = <AsyncValue<HostConnection?>>[];
      final sub = c.listen(localConnectionProvider, (_, v) => seen.add(v));
      try {
        // A refusal that lands first closes the client, and the key's RPC never leaves.
        await Future.any([entered.future, refused.future]);
        await refused.future;
        expect(client.mux.lastError, isA<DshHttpException>().having((e) => e.statusCode, 'status', status));
        release.complete();
        expect(await failed(c), isA<DshHttpException>().having((e) => e.statusCode, 'status', status));
        expect(seen.whereType<AsyncData<HostConnection?>>(), isEmpty);
        await expectLater(client.mux.ready(), throwsA(isA<DshClosedException>()));
        expect(host.rpcCalls.where((r) => r['method'] != 'credentials/set'), isEmpty);
      } finally {
        if (!release.isCompleted) release.complete();
        sub.close();
        c.dispose();
        await host.close();
      }
    });
  }
  test('failure triggered by actual early Data publication reaches build error', () async {
    final client = _Client();
    final c = container(connector: ({required baseUri, required token}) async => client);
    var publications = 0;
    final sub = c.listen(localConnectionProvider, (_, next) {
      if (next is AsyncData<HostConnection?> && next.value != null) {
        publications++;
        client.mux.result.completeError(const DshTransportException('publication'));
      }
    });
    try {
      expect(await failed(c), isA<DshTransportException>());
      expect(publications, 1);
      expect(client.closed, isTrue);
    } finally {
      sub.close();
      c.dispose();
    }
  });
  test('published ready failure closes the same client and exposes error', () async {
    final client = _Client();
    final c = container(connector: ({required baseUri, required token}) async => client);
    try {
      expect((await connected(c)).client, same(client));
      final error = failed(c);
      client.mux.result.completeError(const DshTransportException('after publication'));
      expect(await error, isA<DshTransportException>());
      expect(client.closed, isTrue);
    } finally {
      c.dispose();
    }
  });
  test('ready failure before key completion keeps the original provider future pending', () async {
    final client = _Client();
    final c = container(key: 'fake-key', connector: ({required baseUri, required token}) async => client);
    final sub = c.listen(localConnectionProvider, (_, _) {});
    var completed = false;
    final failure = const DshTransportException('ready failed before key');
    final result = c.read(localConnectionProvider.future);
    final observed = result.then<Object?>(
      (value) {
        completed = true;
        return value;
      },
      onError: (Object error, StackTrace stack) {
        completed = true;
        return error;
      },
    );
    try {
      await client.keyEntered.future;
      client.mux.result.completeError(failure);
      await c.pump();
      expect(client.closed, isTrue);
      expect(completed, isFalse);
      expect(c.read(localConnectionProvider).isLoading, isTrue);
      client.keyRelease.complete();
      expect(await observed, same(failure));
      expect(c.read(localConnectionProvider).value, isNull);
    } finally {
      if (!client.keyRelease.isCompleted) client.keyRelease.complete();
      sub.close();
      c.dispose();
    }
  });

  test('ready failure takes the closed client away from its consumers', () async {
    final client = _Client();
    final c = container(connector: ({required baseUri, required token}) async => client);
    final events = c.listen(localHostEventsProvider, (_, _) {});
    final account = c.listen(accountApiProvider, (_, _) {});
    try {
      await connected(c);
      expect(events.read(), isNotNull);
      expect(account.read(), isA<DshAccountApi>());
      client.mux.result.completeError(const DshTransportException('ready failed'));
      await failed(c);
      await c.pump();
      expect(client.closed, isTrue);
      expect(c.read(localConnectionProvider).value, isNull);
      expect(account.read(), isNull);
      expect(events.read(), isNull);
    } finally {
      events.close();
      account.close();
      c.dispose();
    }
  });

  test('default retry hides failed value throughout reconnect and publishes only the new client', () async {
    final first = _Client(), second = _Client();
    final entered = Completer<void>(), release = Completer<_Client>();
    var calls = 0;
    final c = container(
      retry: null,
      connector: ({required baseUri, required token}) async {
        if (++calls == 1) return first;
        entered.complete();
        return release.future;
      },
    );
    final account = c.listen(accountApiProvider, (_, _) {});
    final events = c.listen(localHostEventsProvider, (_, _) {});
    try {
      await connected(c);
      final retrying = nextState(c, (s) => s, (s) => s.hasError && s.isLoading);
      first.mux.result.completeError(const DshTransportException('temporary ready failure'));
      final afterFailure = await retrying;
      final failedAccount = account.read();
      await entered.future.timeout(const Duration(seconds: 3));
      final duringReconnect = c.read(localConnectionProvider);
      final pendingAccount = account.read();
      final pendingEvents = events.read();
      release.complete(second);
      final fresh = await nextState(c, (s) => s.requireValue!, (s) => identical(s.asData?.value?.client, second));
      second.mux.result.complete(const MuxGeneration(1, 'fixture', '/tmp'));
      await c.pump();
      expect(fresh.client, same(second));
      expect(calls, 2);
      expect(first.closed, isTrue);
      expect(second.closed, isFalse);
      expect((account.read() as DshAccountApi).client, same(second));
      expect(afterFailure.value, isNull);
      expect(duringReconnect.value, isNull);
      expect(failedAccount, isNull);
      expect(pendingAccount, isNull);
      expect(pendingEvents, isNull);
    } finally {
      if (!release.isCompleted) release.complete(second);
      account.close();
      events.close();
      c.dispose();
    }
  });

  test('old ready failure after rebuild never replaces or closes the new client', () async {
    final old = _Client(), current = _Client();
    var calls = 0;
    final c = container(connector: ({required baseUri, required token}) async => ++calls == 1 ? old : current);
    try {
      await connected(c);
      (c.read(localRuntimeProvider.notifier) as _Runtime).replace();
      final fresh = await nextState(c, (s) => s.requireValue!, (s) => identical(s.asData?.value?.client, current));
      old.mux.result.completeError(const DshTransportException('old'));
      await c.pump();
      expect(c.read(localConnectionProvider).requireValue, same(fresh));
      expect(old.closed, isTrue);
      expect(current.closed, isFalse);
      current.mux.result.complete(const MuxGeneration(1, 'fixture', '/tmp'));
      await c.pump();
    } finally {
      c.dispose();
    }
  });
  test('same 20 second budget is passed; controlled short timeout closes the published client', () async {
    final client = _Client();
    client.mux.shortTimeout = true;
    final c = container(connector: ({required baseUri, required token}) async => client);
    try {
      await connected(c);
      expect(client.mux.requestedTimeout, const Duration(seconds: 20));
      expect(await failed(c), isA<DshTransportException>());
      expect(client.closed, isTrue);
    } finally {
      c.dispose();
    }
  });
  test('dispose while ready is pending closes owned client and late error is consumed', () async {
    final client = _Client();
    final c = container(connector: ({required baseUri, required token}) async => client);
    await connected(c);
    c.dispose();
    expect(client.closed, isTrue);
    client.mux.result.completeError(const DshClosedException('disposed'));
    await Future<void>.value();
  });
  test('vault and profile repairs start only after actual ready succeeds', () async {
    final client = _Client(), vault = _Vault();
    var guestReads = 0;
    final c = container(
      vault: vault,
      onGuestRead: () => guestReads++,
      connector: ({required baseUri, required token}) async => client,
    );
    try {
      await connected(c);
      expect(vault.reads, 0);
      expect(guestReads, 0);
      client.mux.result.complete(const MuxGeneration(1, 'fixture', '/tmp'));
      await vault.entered.future;
      await c.pump();
      expect(vault.reads, 1);
      expect(guestReads, 1);
    } finally {
      c.dispose();
    }
  });
  test('disposed build late ready success never starts vault or profile repairs', () async {
    final client = _Client(), vault = _Vault();
    var guestReads = 0;
    final c = container(
      vault: vault,
      onGuestRead: () => guestReads++,
      connector: ({required baseUri, required token}) async => client,
    );
    await connected(c);
    c.dispose();
    client.mux.result.complete(const MuxGeneration(1, 'fixture', '/tmp'));
    await client.mux.result.future;
    expect(vault.reads, 0);
    expect(guestReads, 0);
  });
  test('default Riverpod retry still reconnects after early HTTP data then ready failure', () async {
    final first = _Client(), second = _Client();
    var calls = 0;
    final c = container(
      retry: null,
      connector: ({required baseUri, required token}) async => ++calls == 1 ? first : second,
    );
    try {
      await connected(c);
      first.mux.result.completeError(const DshTransportException('retryable ready failure'));
      final next = await nextState(c, (s) => s.requireValue!, (s) => identical(s.asData?.value?.client, second));
      expect(next.client, same(second));
      expect(calls, 2);
      expect(first.closed, isTrue);
      second.mux.result.complete(const MuxGeneration(1, 'fixture', '/tmp'));
      await c.pump();
    } finally {
      c.dispose();
    }
  });

  test('early publication resolves provider future once and preserves ready completion identity', () async {
    final client = _Client();
    final c = container(connector: ({required baseUri, required token}) async => client);
    var publications = 0;
    final sub = c.listen(localConnectionProvider, (_, s) {
      if (s is AsyncData<HostConnection?>) publications++;
    });
    try {
      final first = await c.read(localConnectionProvider.future);
      expect(first!.client, same(client));
      expect(client.mux.result.isCompleted, isFalse);
      client.mux.result.complete(const MuxGeneration(1, 'fixture', '/tmp'));
      await c.pump();
      expect(c.read(localConnectionProvider).requireValue, same(first));
      expect(publications, 1);
    } finally {
      sub.close();
      c.dispose();
    }
  });
  test('early Data does not reset the original retry counter', () async {
    final clients = [_Client(), _Client()];
    var connects = 0;
    final counts = <int>[];
    final c = container(
      retry: (count, error) {
        counts.add(count);
        return counts.length == 1 ? Duration.zero : null;
      },
      connector: ({required baseUri, required token}) async => clients[connects++],
    );
    try {
      await connected(c);
      clients.first.mux.result.completeError(const DshTransportException('first'));
      await nextState(c, (s) => s.requireValue!, (s) => identical(s.asData?.value?.client, clients.last));
      clients.last.mux.result.completeError(const DshTransportException('second'));
      await failed(c);
      expect(counts, [0, 1]);
      expect(connects, 2);
    } finally {
      c.dispose();
    }
  });
}
