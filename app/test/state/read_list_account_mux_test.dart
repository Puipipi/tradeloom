import 'dart:async';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/models_state.dart';
import 'package:dsh_app/state/read_list_cache.dart';
import 'package:dsh_app/state/read_list_identity.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../plugins/support/fake_plugin_host.dart';
import '../shell/golden_harness.dart' show FakeRuntime, FakeSettings;
import 'read_list_refresh_test.dart' show FixedHost, ListHost;

// All identity, account, catalog, cache and mux classes are production classes.
// Only the carrier controls when complete HTTP replies and mux frames arrive.
class _Carrier extends FakePluginCarrier {
  _Carrier({this.initialSignedIn = true}) {
    handlers['session/modelCatalog'] = (_) => holdModels ? _hold(models) : ListHost.models(label);
    handlers['account/getProfile'] = (_) => holdProfile ? _hold(profiles) : profile(account);
    handlers['account/getState'] = (_) => _hold(states);
    handlers['account/signOut'] = (_) => _hold(signOuts);
    handlers['account/startSignIn'] = (_) => _hold(starts);
    handlers['account/cancelSignIn'] = (_) => {'status': 'signed-out'};
  }

  final bool initialSignedIn;
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
    final next = _Link(links.length + 1, initialSignedIn: initialSignedIn);
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

class _Harness {
  _Harness({bool initialSignedIn = true, bool watchModels = true})
    : carrier = _Carrier(initialSignedIn: initialSignedIn) {
    client = DshClient.withCarrier(carrier, muxOptions: const MuxOptions(retryCaps: [Duration.zero]));
    api = DshAccountApi(client, callbackOrigin: 'http://127.0.0.1:3080');
    c = ProviderContainer(
      overrides: [
        activeHostProvider.overrideWith(FixedHost.new),
        activeConnectionProvider.overrideWithValue(AsyncData(HostConnection(client: client, isLocal: true))),
        accountApiProvider.overrideWithValue(api),
        localRuntimeProvider.overrideWith(
          () => FakeRuntime(
            const LocalRuntimeState(
              loaded: true,
              status: RuntimeStatus(phase: RuntimePhase.running, installedVersion: 'v1'),
            ),
          ),
        ),
        localReadListRootProvider.overrideWithValue(const AsyncData('/canonical-root')),
        settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
        accountEngineStarterProvider.overrideWithValue(() async {}),
      ],
    );
    c.listen(readListIdentityProvider, (_, next) => identities.add(next));
    if (watchModels) c.listen(modelListViewProvider, (_, _) {});
    addTearDown(() async {
      c.dispose();
      await client.close();
    });
  }

  final _Carrier carrier;
  late final DshClient client;
  late final DshAccountApi api;
  late final ProviderContainer c;
  final identities = <ReadListIdentity?>[];

  ReadListIdentity? get identity => c.read(readListIdentityProvider);
  AccountState get account => c.read(accountProvider);
  AccountController get controller => c.read(accountProvider.notifier);
  ReadListCache get cache => c.read(readListCacheProvider);

  String? cached(ReadListIdentity? identity) =>
      cache.get<CachedModels>(readListKey(identity, ReadListKind.models))?.value.models.single.name;

  Future<_Link> disconnect() async {
    final next = carrier.nextLink.future;
    client.mux.reconnect();
    final link = await next.timeout(const Duration(seconds: 2));
    await flush();
    expect(client.mux.generation, isNull);
    return link;
  }

  Future<_Link> reconnect({required String account, required String label, bool requireWatch = true}) async {
    carrier
      ..account = account
      ..label = label;
    final link = await disconnect();
    link.ready();
    await flush();
    if (requireWatch) expect(link.account, isNotNull);
    return link;
  }

  Future<void> flush() async {
    for (var i = 0; i < 20; i++) {
      await Future<void>.delayed(Duration.zero);
      await c.pump();
    }
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('same-object ready reactively withdraws identity before account first frame without a catalog reader', () async {
    final h = _Harness(watchModels: false);
    await h.flush();
    final a = h.identity;
    expect(a, isNotNull);
    final link = await h.reconnect(account: 'account-b', label: 'B');
    expect(identical(h.c.read(accountApiProvider), h.api), isTrue);
    expect(h.account.profile?.id, 'account-a', reason: 'retained profile is display-only');
    expect(h.identities.last, isNull, reason: 'provider must notify, not merely fix a getter');
    expect(h.identity, isNull);
    await h.controller.refreshProfile();
    expect(h.carrier.argsOf('account/getProfile'), hasLength(1), reason: 'no profile proof before this view');
    link.confirm();
    await h.flush();
    expect(h.identity, isNotNull);
    expect(h.identity, isNot(a));
    expect(h.account.profile?.id, 'account-b');
  });

  test(
    'same-account mux reconnect reuses the same cache key only after proof and never grants cached write authority',
    () async {
      final h = _Harness();
      await h.flush();
      final a = h.identity;
      expect(h.cached(a), 'A Model 0');
      h.carrier
        ..holdModels = true
        ..label = 'Fresh';
      final link = await h.disconnect();
      expect(h.identity, a);
      expect(h.c.read(modelListViewProvider).value!.models.single.name, 'A Model 0');
      expect(h.c.read(modelListViewProvider).readOnly, isTrue);
      link.ready();
      await h.flush();
      expect(h.identity, isNull);
      expect(h.c.read(modelListViewProvider).value, isNull, reason: 'unknown new account cannot replay A');
      link.confirm();
      await h.flush();
      expect(h.identity, a, reason: 'mux number is proof scope, not part of the stable cache key');
      expect(h.c.read(modelListViewProvider).value!.models.single.name, 'A Model 0');
      expect(h.c.read(modelListViewProvider).readOnly, isTrue);
      expect(h.carrier.models, isNotEmpty);
      for (final reply in h.carrier.models) {
        reply.complete(ListHost.models('Fresh'));
      }
      await h.flush();
      expect(h.c.read(modelListViewProvider).value!.models.single.name, 'Fresh Model 0');
      expect(h.c.read(modelListViewProvider).readOnly, isFalse);
    },
  );

  test('one client and API keep A and B cache keys separate across A to B to A', () async {
    final h = _Harness();
    await h.flush();
    final a = h.identity;
    final second = await h.reconnect(account: 'account-b', label: 'B');
    expect(h.identity, isNull);
    expect(h.cached(a), 'A Model 0');
    second.confirm();
    await h.flush();
    final b = h.identity;
    expect(b, isNotNull);
    expect(b, isNot(a));
    expect(h.cached(b), 'B Model 0');
    final third = await h.reconnect(account: 'account-a', label: 'A3');
    expect(h.identity, isNull);
    expect(h.cached(a), 'A Model 0');
    third.confirm();
    await h.flush();
    expect(h.client.mux.generation!.number, 3);
    expect(h.identity, a);
    expect(h.cached(a), 'A3 Model 0');
    expect(h.cached(b), 'B Model 0');
  });

  test('old profile cannot confirm a new ready while its account first frame is held', () async {
    final h = _Harness();
    await h.flush();
    h.carrier.holdProfile = true;
    final old = h.controller.refreshProfile();
    await h.flush();
    final reply = h.carrier.profiles.single;
    h.carrier.holdProfile = false;
    final second = await h.reconnect(account: 'account-b', label: 'B');
    reply.complete(_Carrier.profile('late-old-profile'));
    await old;
    await h.flush();
    expect(h.account.profile?.id, 'account-a');
    expect(h.identity, isNull);
    second.confirm();
    await h.flush();
    expect(h.account.profile?.id, 'account-b');
    expect(h.identity, isNotNull);
  });

  test('old signOut cannot relabel A after the same client and API have visited B and A again', () async {
    final h = _Harness();
    await h.flush();
    final old = h.controller.signOut();
    await h.flush();
    final second = await h.reconnect(account: 'account-b', label: 'B');
    second.confirm();
    await h.flush();
    final third = await h.reconnect(account: 'account-a', label: 'A3');
    third.confirm();
    await h.flush();
    final current = h.identity;
    expect(current, isNotNull);
    h.carrier.signOuts.single.complete({'status': 'signed-out'});
    await old;
    await h.flush();
    expect(h.account.phase, AccountPhase.signedIn);
    expect(h.account.profile?.id, 'account-a');
    expect(h.identity, current);
    expect(h.cached(current), 'A3 Model 0');
  });

  for (final unsupported in [false, true]) {
    test('late watch recovery ${unsupported ? '404' : 'signed-out'} cannot certify a new mux generation', () async {
      final h = _Harness();
      await h.flush();
      h.carrier.links.single.failAccount();
      await h.flush();
      final reply = h.carrier.states.single;
      // R1 waits for the old recovery before reopening watch. Do not require
      // the repaired eager subscription as a precondition of this old-reply probe.
      final second = await h.reconnect(account: 'account-b', label: 'B', requireWatch: false);
      if (unsupported) {
        reply.completeError(const DshHttpException(404, 'old service missing'));
      } else {
        reply.complete({'status': 'signed-out'});
      }
      await h.flush();
      expect(h.account.phase, AccountPhase.signedIn);
      expect(h.account.profile?.id, 'account-a');
      expect(h.identity, isNull);
      second.confirm();
      await h.flush();
      expect(h.account.profile?.id, 'account-b');
      expect(h.identity, isNotNull);
    });
  }

  for (final failed in [false, true]) {
    test('new-generation pending then ${failed ? 'failed' : 'null'} profile keeps cache admission closed', () async {
      final h = _Harness();
      await h.flush();
      final a = h.identity;
      h.carrier.holdProfile = true;
      final second = await h.reconnect(account: 'account-b', label: 'B');
      second.confirm();
      await h.flush();
      expect(h.identity, isNull);
      expect(h.cached(a), 'A Model 0');
      h.carrier.profiles.single.complete(failed ? {'status': 'failed'} : null);
      await h.flush();
      expect(h.account.profileFailed, isTrue);
      expect(h.identity, isNull);
      expect(h.cached(a), 'A Model 0');
      h.carrier.holdProfile = false;
      await h.controller.refreshProfile();
      await h.flush();
      expect(h.account.profile?.id, 'account-b');
      expect(h.identity, isNotNull);
      expect(h.identity, isNot(a));
      expect(h.cached(a), 'A Model 0');
    });
  }

  test('an account frame queued immediately before loss cannot replace the retained confirmed display', () async {
    final h = _Harness();
    await h.flush();
    final a = h.identity;
    h.carrier.links.single.confirm(signedIn: false);
    final link = await h.disconnect();
    expect(h.account.phase, AccountPhase.signedIn);
    expect(h.account.profile?.id, 'account-a');
    expect(h.identity, a);
    link.ready();
    await h.flush();
    expect(h.identity, isNull);
  });

  test('a previously confirmed signed-out account also requires a new-generation first frame', () async {
    final h = _Harness(initialSignedIn: false);
    await h.flush();
    final out = h.identity;
    expect(out, isNotNull);
    final second = await h.reconnect(account: 'account-b', label: 'B');
    expect(h.identity, isNull);
    expect(h.cached(out), 'A Model 0');
    second.confirm();
    await h.flush();
    expect(h.identity, isNotNull);
    expect(h.identity, isNot(out));
    expect(h.cached(out), 'A Model 0');
  });

  test('late cancelled sign-in start cannot send cleanup through a successor mux', () async {
    final h = _Harness(initialSignedIn: false);
    await h.flush();
    final signingIn = h.controller.signIn();
    await h.flush();
    expect(h.carrier.starts, hasLength(1));
    await h.controller.cancel();
    expect(await signingIn, SignInResult.cancelled);
    await h.reconnect(account: 'account-b', label: 'B');
    h.carrier.starts.single.complete({
      'status': 'signed-out',
      'attempt': {'id': 'retired-attempt', 'phase': 'waiting-browser'},
    });
    await h.flush();
    expect(h.carrier.argsOf('account/cancelSignIn'), isEmpty);
    expect(h.identity, isNull);
  });

  test('late cancel response cannot settle the attempt observed on the successor mux', () async {
    final h = _Harness(initialSignedIn: false);
    await h.flush();
    Map<String, Object?> view(String id, String phase) => {
      'status': 'signed-out',
      'attempt': {'id': id, 'phase': phase},
    };
    final signingIn = h.controller.signIn();
    await h.flush();
    h.carrier.starts.single.complete(view('old', 'waiting-browser'));
    await h.flush();
    h.carrier.states.single.complete(view('old', 'waiting-browser'));
    await h.flush();
    final cancelled = Completer<Object?>();
    h.carrier.handlers['account/cancelSignIn'] = (_) => cancelled.future;
    final oldCancel = h.controller.cancel();
    await h.flush();
    expect(h.carrier.argsOf('account/cancelSignIn'), hasLength(1));
    final second = await h.reconnect(account: 'account-b', label: 'B');
    second.frame!({'type': 'item', 'streamId': second.account!, 'value': view('new', 'waiting-browser')});
    await h.flush();
    expect(h.account.attemptId, 'new');
    cancelled.complete(view('old', 'cancelled'));
    await oldCancel;
    await h.flush();
    expect(h.account.phase, AccountPhase.signingIn);
    expect(h.account.attemptId, 'new');
    expect(h.identity, isNull);
    h.carrier.handlers['account/cancelSignIn'] = (_) => view('new', 'cancelled');
    await h.controller.cancel();
    expect(await signingIn, SignInResult.cancelled);
  });

  test('a transient ready lost before state callbacks still withdraws the unconfirmed offline identity', () async {
    final h = _Harness();
    await h.flush();
    final a = h.identity;
    expect(h.cached(a), 'A Model 0');
    final second = await h.disconnect();
    expect(h.identity, a, reason: 'no successor has become ready yet');
    final third = h.carrier.nextLink.future;
    second.ready();
    expect(h.client.mux.generation!.number, 2);
    h.client.mux.reconnect();
    expect(h.client.mux.generation, isNull);
    await third.timeout(const Duration(seconds: 2));
    await h.flush();
    expect(h.identity, isNull, reason: 'the unconfirmed generation retired A even though it was short-lived');
    expect(h.c.read(modelListViewProvider).value, isNull);
    expect(h.cached(a), 'A Model 0', reason: 'withdraw replay permission, do not mutate the stored old entry');
    expect(h.account.profile?.id, 'account-a', reason: 'retained account display is not cache proof');
  });
}
