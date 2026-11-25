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
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../account/support.dart' show FakeAccountApi, ApiSwitch, apiSwitchProvider, signedInView, signedOutView;
import '../shell/golden_harness.dart' show FakeRuntime, FakeSettings;
import 'read_list_refresh_test.dart' show ListHost, FixedHost, SwitchConnection, switchConnectionProvider;

class _BoundApi extends DshAccountApi {
  _BoundApi(super.client, String id, {this.holdView = false})
    : delegate = FakeAccountApi(initial: signedInView())..profile = AccountProfile(id: id),
      super(callbackOrigin: 'http://127.0.0.1:3080');
  final FakeAccountApi delegate;
  final bool holdView;
  final views = StreamController<AccountView>.broadcast();
  Completer<AccountView>? signOutReply;
  Completer<AccountProfile?>? profileReply;
  @override
  Stream<AccountView> watch() => holdView ? views.stream : delegate.watch();
  @override
  Future<AccountProfile?> getProfile() => profileReply?.future ?? delegate.getProfile();
  @override
  Future<AccountView> getState() => delegate.getState();
  @override
  Future<AccountView> signOut() => signOutReply?.future ?? delegate.signOut();
}

Future<void> _flush(ProviderContainer c) async {
  for (var i = 0; i < 12; i++) {
    await Future<void>.delayed(Duration.zero);
    await c.pump();
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  ProviderContainer container(ListHost a, _BoundApi api) {
    final c = ProviderContainer(
      overrides: [
        activeHostProvider.overrideWith(FixedHost.new),
        switchConnectionProvider.overrideWith(() => SwitchConnection(a.connection)),
        activeConnectionProvider.overrideWith((ref) => ref.watch(switchConnectionProvider)),
        apiSwitchProvider.overrideWith(() => ApiSwitch(api)),
        accountApiProvider.overrideWith((ref) => ref.watch(apiSwitchProvider)),
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
      ],
    );
    addTearDown(c.dispose);
    c.listen(modelListViewProvider, (_, _) {});
    return c;
  }

  test('a newly connected local client cannot overwrite account A cache before confirming account B', () async {
    final a = ListHost('A');
    final b = ListHost('B');
    final apiA = _BoundApi(a.client, 'account-a');
    final apiB = _BoundApi(b.client, 'account-b', holdView: true);
    addTearDown(() async {
      await a.client.close();
      await b.client.close();
      await apiB.views.close();
    });
    final c = container(a, apiA);
    await _flush(c);
    final identityA = c.read(readListIdentityProvider);
    expect(identityA, isNotNull);
    final cache = c.read(readListCacheProvider);
    expect(cache.get<CachedModels>(readListKey(identityA, ReadListKind.models))!.value.models.single.name, 'A Model 0');
    c.read(switchConnectionProvider.notifier).set(null);
    c.read(apiSwitchProvider.notifier).set(null);
    await _flush(c);
    expect(c.read(readListIdentityProvider), identityA, reason: 'offline last-confirmed display source remains known');
    c.read(switchConnectionProvider.notifier).set(b.connection);
    c.read(apiSwitchProvider.notifier).set(apiB);
    await _flush(c);
    expect(
      cache.get<CachedModels>(readListKey(identityA, ReadListKind.models))!.value.models.single.name,
      'A Model 0',
      reason: 'new B data cannot be labelled with the retained A profile',
    );
    expect(c.read(readListIdentityProvider), isNull, reason: 'the new connection has not confirmed its account');
    apiB.views.add(signedInView());
    await _flush(c);
    expect(c.read(accountProvider).profile?.id, 'account-b');
    final identityB = c.read(readListIdentityProvider);
    expect(identityB, isNotNull);
    expect(identityB, isNot(identityA));
    expect(cache.get<CachedModels>(readListKey(identityB, ReadListKind.models))!.value.models.single.name, 'B Model 0');
  });

  test('late old profile and sign-out replies cannot reauthorize or relabel a new API', () async {
    final a = ListHost('A');
    final b = ListHost('B');
    addTearDown(() async {
      await a.client.close();
      await b.client.close();
    });
    final apiA = _BoundApi(a.client, 'account-a');
    final apiB = _BoundApi(b.client, 'account-b');
    final c = container(a, apiA);
    await _flush(c);
    apiA.profileReply = Completer<AccountProfile?>();
    apiA.signOutReply = Completer<AccountView>();
    final oldProfile = c.read(accountProvider.notifier).refreshProfile();
    final oldSignOut = c.read(accountProvider.notifier).signOut();
    c.read(switchConnectionProvider.notifier).set(b.connection);
    c.read(apiSwitchProvider.notifier).set(apiB);
    await _flush(c);
    expect(c.read(accountProvider).profile?.id, 'account-b');
    final current = c.read(readListIdentityProvider);
    expect(current, isNotNull);
    apiA.profileReply!.complete(const AccountProfile(id: 'old-late-account'));
    apiA.signOutReply!.complete(signedOutView());
    await Future.wait([oldProfile, oldSignOut]);
    await _flush(c);
    expect(c.read(accountProvider).phase, AccountPhase.signedIn);
    expect(c.read(accountProvider).profile?.id, 'account-b');
    expect(c.read(readListIdentityProvider), current);
  });

  test('API A to B to the same A object still rejects an old sign-out completion', () async {
    final a = ListHost('A');
    final b = ListHost('B');
    addTearDown(() async {
      await a.client.close();
      await b.client.close();
    });
    final apiA = _BoundApi(a.client, 'account-a');
    final apiB = _BoundApi(b.client, 'account-b');
    final c = container(a, apiA);
    await _flush(c);
    apiA.signOutReply = Completer<AccountView>();
    final old = c.read(accountProvider.notifier).signOut();
    c.read(switchConnectionProvider.notifier).set(b.connection);
    c.read(apiSwitchProvider.notifier).set(apiB);
    await _flush(c);
    c.read(switchConnectionProvider.notifier).set(a.connection);
    c.read(apiSwitchProvider.notifier).set(apiA);
    await _flush(c);
    final current = c.read(readListIdentityProvider);
    expect(current, isNotNull);
    apiA.signOutReply!.complete(signedOutView());
    await old;
    await _flush(c);
    expect(c.read(accountProvider).phase, AccountPhase.signedIn);
    expect(c.read(accountProvider).profile?.id, 'account-a');
    expect(c.read(readListIdentityProvider), current);
  });

  test('an unconfirmed replacement profile cannot use the retained signed-in display identity', () async {
    final a = ListHost('A');
    final b = ListHost('B');
    addTearDown(() async {
      await a.client.close();
      await b.client.close();
    });
    final apiA = _BoundApi(a.client, 'account-a');
    final apiB = _BoundApi(b.client, 'account-b')..delegate.profileError = const AccountQueryFailed('profile');
    final c = container(a, apiA);
    await _flush(c);
    final known = c.read(readListIdentityProvider);
    expect(known, isNotNull);
    c.read(switchConnectionProvider.notifier).set(b.connection);
    c.read(apiSwitchProvider.notifier).set(apiB);
    await _flush(c);
    expect(c.read(accountProvider).profileFailed, isTrue);
    expect(c.read(readListIdentityProvider), isNull);
    expect(
      c
          .read(readListCacheProvider)
          .get<CachedModels>(readListKey(known, ReadListKind.models))!
          .value
          .models
          .single
          .name,
      'A Model 0',
    );
  });

  test('the real account chain reuses a confirmed same-account snapshot while the new model read waits', () async {
    final a = ListHost('A');
    final b = ListHost('B')..paused.add('models');
    addTearDown(() async {
      await a.client.close();
      await b.client.close();
    });
    final apiA = _BoundApi(a.client, 'same-account');
    final apiB = _BoundApi(b.client, 'same-account');
    final c = container(a, apiA);
    await _flush(c);
    final known = c.read(readListIdentityProvider);
    expect(known, isNotNull);
    c.read(switchConnectionProvider.notifier).set(null);
    c.read(apiSwitchProvider.notifier).set(null);
    await _flush(c);
    expect(c.read(modelListViewProvider).value!.models.single.name, 'A Model 0');
    c.read(switchConnectionProvider.notifier).set(b.connection);
    c.read(apiSwitchProvider.notifier).set(apiB);
    await _flush(c);
    expect(apiB.delegate.calls, contains('getProfile'));
    expect(c.read(readListIdentityProvider), known);
    expect(c.read(modelListViewProvider).value!.models.single.name, 'A Model 0');
    expect(c.read(modelListViewProvider).readOnly, isTrue);
    expect(b.requests['models']!.every((request) => !request.isCompleted), isTrue);
    for (final request in b.requests['models']!) {
      request.complete(ListHost.models('B'));
    }
    await _flush(c);
    expect(c.read(modelListViewProvider).value!.models.single.name, 'B Model 0');
    expect(c.read(modelListViewProvider).readOnly, isFalse);
  });
}
