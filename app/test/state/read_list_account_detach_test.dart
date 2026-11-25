import 'dart:async';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/models_state.dart';
import 'package:dsh_app/state/provider_keys.dart';
import 'package:dsh_app/state/read_list_cache.dart';
import 'package:dsh_app/state/read_list_identity.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../plugins/support/fake_plugin_host.dart';
import '../shell/golden_harness.dart' show FakeSettings;
import 'read_list_refresh_test.dart' show FixedHost, ListHost;

// Regression of the independently found runtime teardown race. Only the
// carrier, decoded platform events and platform metadata are fixtures; runtime,
// connection, account API/controller, mux, catalog and cache stay production.
class _Carrier extends FakePluginCarrier {
  _Carrier() {
    handlers['session/modelCatalog'] = (_) => holdModels ? _hold(models) : ListHost.models(label);
    handlers['account/getProfile'] = (_) => holdProfile ? _hold(profiles) : profile(account);
    handlers['account/getState'] = (_) => _hold(states);
    handlers['account/signOut'] = (_) => _hold(signOuts);
    handlers['account/startSignIn'] = (_) => _hold(starts);
    handlers['account/cancelSignIn'] = (_) => {'status': 'signed-out'};
  }

  String label = 'A';
  String account = 'account-a';
  bool holdModels = false;
  bool holdProfile = false;
  final models = <Completer<Object?>>[];
  final profiles = <Completer<Object?>>[];
  final states = <Completer<Object?>>[];
  final signOuts = <Completer<Object?>>[];
  final starts = <Completer<Object?>>[];
  final links = <_Link>[];
  Completer<_Link> nextLink = Completer<_Link>();

  static Object profile(String id) => {
    'status': 'ready',
    'value': {'id': id},
  };

  Future<Object?> _hold(List<Completer<Object?>> queue) {
    final reply = Completer<Object?>();
    queue.add(reply);
    return reply.future;
  }

  @override
  Future<DshMuxLink> openLink(MuxOptions options) async {
    final next = _Link(links.length + 1, initialSignedIn: true);
    links.add(next);
    link = next;
    nextLink.complete(next);
    nextLink = Completer<_Link>();
    return next;
  }
}

class _Link extends FakeMuxLink {
  _Link(this.number, {required this.initialSignedIn});
  final int number;
  final bool initialSignedIn;
  DshMuxFrameHandler? frame;
  String? events;
  String? account;
  final cancelled = <String>[];

  @override
  void start({required DshMuxFrameHandler onFrame, required DshMuxLossHandler onLost}) => frame = onFrame;

  @override
  void open(String streamId, String endpoint, Map<String, Object?> payload) {
    if (endpoint == r'$events') {
      events = streamId;
      if (number == 1) scheduleMicrotask(ready);
    } else if (endpoint == 'account/watch') {
      account = streamId;
      if (number == 1) scheduleMicrotask(() => confirm(signedIn: initialSignedIn));
    }
  }

  void ready() => push({
    'type': 'ready',
    'clientId': 'generation-$number',
    'host': {'home': '/root'},
  });

  void confirm({bool signedIn = true}) => frame!({
    'type': 'item',
    'streamId': account!,
    'value': {'status': signedIn ? 'credential-stored' : 'signed-out'},
  });

  void failAccount() => frame!({
    'type': 'error',
    'streamId': account!,
    'error': {'code': 'account/test-stream-error', 'message': 'controlled watch failure'},
  });

  @override
  void cancel(String streamId) => cancelled.add(streamId);

  @override
  void push(Map<String, Object?> value) => frame!({'type': 'item', 'streamId': events!, 'value': value});
}

class _PlatformBridge extends RuntimeBridge {
  final stream = StreamController<RuntimeEvent>.broadcast(sync: true);
  RuntimeStatus current = const RuntimeStatus(
    phase: RuntimePhase.running,
    installedVersion: 'v1',
    baseUrl: 'http://127.0.0.1:3080',
    token: 'local-test-token',
  );

  @override
  Stream<RuntimeEvent> get events => stream.stream;
  @override
  Future<RuntimeStatus> status() async => current;
  @override
  Future<List<String>> logs({int lines = 500}) async => const [];

  void reportStopped() {
    current = const RuntimeStatus(phase: RuntimePhase.installed, installedVersion: 'v1');
    stream.add(RuntimeStatusEvent(current));
  }
}

class _EmptyVault extends ProviderKeyVault {
  @override
  Future<Map<String, String>> readAll() async => const {};
  @override
  Future<void> delete(String id) async => throw StateError('unexpected credential write');
  @override
  Future<void> write(String id, String key) async => throw StateError('unexpected credential write');
}

class _RuntimeHarness {
  _RuntimeHarness() {
    client = DshClient.withCarrier(carrier, muxOptions: const MuxOptions(retryCaps: [Duration.zero]));
    c = ProviderContainer(
      overrides: [
        activeHostProvider.overrideWith(FixedHost.new),
        runtimeBridgeProvider.overrideWithValue(bridge),
        networkKicksProvider.overrideWithValue(const Stream.empty()),
        localClientConnectorProvider.overrideWithValue(({required baseUri, required token}) async {
          await client.mux.ready();
          return client;
        }),
        localReadListRootProvider.overrideWithValue(const AsyncData('/canonical-root')),
        providerKeyVaultProvider.overrideWithValue(_EmptyVault()),
        settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
      ],
    );
    // The runtime, local connection, account API, account state, identity and
    // model providers are all the actual product implementations.
    c.listen(modelListViewProvider, (_, _) {});
    addTearDown(() async {
      c.dispose();
      await client.close();
      await bridge.stream.close();
    });
  }

  final carrier = _Carrier();
  final bridge = _PlatformBridge();
  late final DshClient client;
  late final ProviderContainer c;

  Future<void> flush() async {
    for (var i = 0; i < 30; i++) {
      await Future<void>.delayed(Duration.zero);
      await c.pump();
    }
  }

  Future<_Link> disconnect() async {
    final next = carrier.nextLink.future;
    client.mux.reconnect();
    final link = await next.timeout(const Duration(seconds: 2));
    await flush();
    expect(client.mux.generation, isNull);
    return link;
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final successorReady in [false, true]) {
    for (final immediateRead in [false, true]) {
      for (final closeBeforeStop in [false, true]) {
        test('runtime stop ready=$successorReady immediate-read=$immediateRead close-first=$closeBeforeStop', () async {
          final h = _RuntimeHarness();
          await h.flush();
          expect(h.c.read(localConnectionProvider).value!.client, same(h.client));
          expect((h.c.read(accountApiProvider)! as DshAccountApi).client, same(h.client));
          final a = h.c.read(readListIdentityProvider);
          expect(a, isNotNull);
          final cache = h.c.read(readListCacheProvider);
          final key = readListKey(a, ReadListKind.models);
          expect(cache.get<CachedModels>(key)!.value.models.single.name, 'A Model 0');
          final second = await h.disconnect();
          expect(h.c.read(readListIdentityProvider), a);
          if (successorReady) {
            second.ready();
            expect(h.client.mux.generation!.number, 2);
          }
          // A close can clear current generation before provider disposal.
          // Do not await: queued states callbacks must not run before stop/read.
          final closing = closeBeforeStop ? h.client.close() : null;
          if (closeBeforeStop) expect(h.client.mux.generation, isNull);
          h.bridge.reportStopped();
          if (immediateRead) h.c.read(modelListViewProvider);
          await h.flush();
          if (closing != null) await closing;
          expect(h.c.read(localRuntimeProvider).status.phase, RuntimePhase.installed);
          expect(h.c.read(localConnectionProvider).value, isNull);
          expect(h.c.read(accountApiProvider), isNull);
          expect(h.client.mux.state, DshConnectionState.closed);
          final identity = h.c.read(readListIdentityProvider);
          final view = h.c.read(modelListViewProvider);
          expect(view.readOnly, isTrue);
          if (successorReady) {
            expect(
              identity,
              isNull,
              reason: 'unknown successor proof survives neither listener cancellation nor close',
            );
            expect(h.c.read(accountProvider.notifier).readListIdentityKnown, isFalse);
            expect(view.value, isNull);
          } else {
            expect(identity, a, reason: 'ordinary offline stop keeps the confirmed display source');
            expect(h.c.read(accountProvider.notifier).readListIdentityKnown, isTrue);
            expect(view.value!.models.single.name, 'A Model 0');
          }
          expect(h.c.read(accountProvider).profile?.id, 'account-a', reason: 'display profile is not cache proof');
          expect(
            cache.get<CachedModels>(key)!.value.models.single.name,
            'A Model 0',
            reason: 'retire replay permission, not the bounded entry',
          );
        });
      }
    }
  }
}
