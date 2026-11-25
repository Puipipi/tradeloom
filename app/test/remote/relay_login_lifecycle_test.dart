import 'dart:async';

import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_relay.dart';
import 'support/wait.dart';

// Real startLogin waits for provider discovery and QR session creation.
// Hold that boundary; no artificial timer/race or real account is needed.
class HeldLoginStart extends FakeRelayBackend {
  final entered = Completer<void>();
  final release = Completer<void>();

  @override
  Future<RelayLoginSession> login({String? providerId}) async {
    entered.complete();
    await release.future;
    return super.login(providerId: providerId);
  }
}

// Gates model the ordinary network boundaries, without wall-clock sleeps.
class _Gate<T> {
  final entered = Completer<void>();
  final result = Completer<T>();

  Future<T> call() {
    if (!entered.isCompleted) entered.complete();
    return result.future;
  }
}

class _LoginRequest {
  _LoginRequest(this.backend, int sequence) : url = Uri.parse('https://${backend.serverLabel}/qr/scan/$sequence');

  final _ControlledRelay backend;
  final Uri url;
  final created = Completer<RelayLoginSession>();
  final result = Completer<RelayUser>();
  int cancellations = 0;

  void release() {
    created.complete(
      RelayLoginSession(
        loginUrl: url,
        completed: result.future.then((user) => backend.user = user),
        onCancel: () {
          cancellations++;
          if (!result.isCompleted) result.completeError(StateError('cancelled'));
        },
      ),
    );
  }
}

class _ControlledRelay extends FakeRelayBackend {
  _ControlledRelay({super.user, super.hosts, this.label = 'old.example'});

  final String label;
  final requests = <_LoginRequest>[];
  _Gate<RelayUser?>? userGate;
  _Gate<void>? logoutGate;
  _Gate<List<RelayAuthProvider>>? providersGate;
  _Gate<List<RelayHost>>? hostsGate;
  int hostLists = 0;

  @override
  String get serverLabel => label;

  @override
  Future<RelayUser?> currentUser() => userGate?.call() ?? super.currentUser();

  @override
  Future<List<RelayAuthProvider>> loginProviders() => providersGate?.call() ?? super.loginProviders();

  @override
  Future<RelayLoginSession> login({String? providerId}) {
    loginProviderIds.add(providerId);
    final request = _LoginRequest(this, requests.length);
    requests.add(request);
    return request.created.future;
  }

  @override
  Future<void> logout() async {
    if (logoutGate case final gate?) await gate.call();
    await super.logout();
  }

  @override
  Future<List<RelayHost>> listHosts({bool refresh = false}) {
    hostLists++;
    return hostsGate?.call() ?? super.listHosts(refresh: refresh);
  }
}

class _BackendSelection extends Notifier<RelayBackend> {
  _BackendSelection(this.initial);
  final RelayBackend initial;

  @override
  RelayBackend build() => initial;

  void select(RelayBackend backend) => state = backend;
}

final _backendSelection = NotifierProvider<_BackendSelection, RelayBackend>(
  () => throw StateError('Override the test backend'),
);

const _newUser = RelayUser(id: 'new-user', displayName: 'new account', provider: 'google');
const _newHosts = [RelayHost(id: 'new-host', name: 'new host', online: true)];
const _newProviders = [RelayAuthProvider(id: 'new-provider', displayName: 'New provider')];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  ProviderContainer container(FakeRelayBackend relay, {UrlOpener? opener}) {
    final c = ProviderContainer(
      overrides: [
        secretStoreProvider.overrideWithValue(MemorySecretStore()),
        _backendSelection.overrideWith(() => _BackendSelection(relay)),
        relayBackendProvider.overrideWith((ref) => ref.watch(_backendSelection)),
        urlOpenerProvider.overrideWithValue(opener ?? (_) async => true),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  RelayAccountState account(ProviderContainer c) => c.read(relayAccountProvider).value!;

  Future<void> waiting(ProviderContainer c, Uri url) async {
    await until(c, relayAccountProvider, (s) => s.value?.loginUrl == url, what: 'login session available');
  }

  Future<void> switchTo(ProviderContainer c, RelayBackend backend) async {
    c.read(_backendSelection.notifier).select(backend);
    await c.pump();
    await c.read(relayAccountProvider.future);
  }

  test('cancel while creating login must not later open the browser', () async {
    final relay = HeldLoginStart();
    final opened = <Uri>[];
    final c = container(
      relay,
      opener: (uri) async {
        opened.add(uri);
        return true;
      },
    );
    await c.read(relayAccountProvider.future);
    final controller = c.read(relayAccountProvider.notifier);
    final pending = controller.login(providerId: 'github');
    await relay.entered.future;
    expect(c.read(relayAccountProvider).value!.loggingIn, isTrue);
    controller.cancelLogin();
    expect(c.read(relayAccountProvider).value!.loggingIn, isFalse);
    relay.release.complete();
    for (var i = 0; i < 10; i++) {
      await Future<void>.delayed(Duration.zero);
      await c.pump();
    }
    final openedAfterCancel = List<Uri>.of(opened);
    if (!(relay.pendingLogin?.isCompleted ?? true)) {
      relay.pendingLogin!.complete(sampleRelayUser);
    }
    await pending;
    expect(openedAfterCancel, isEmpty, reason: 'Cancellation was shown before the server session arrived');
    expect(c.read(relayAccountProvider).value!.signedIn, isFalse);
  });

  test('logout of a restored account must restore every sign-in provider', () async {
    final relay = FakeRelayBackend(user: sampleRelayUser);
    final c = container(relay);
    final initial = await c.read(relayAccountProvider.future);
    expect(initial.signedIn, isTrue);
    await c.read(relayAccountProvider.notifier).logout();
    final after = c.read(relayAccountProvider).value!;
    expect(after.signedIn, isFalse);
    expect(after.providers.map((p) => p.id), [
      'zhihu',
      'github',
      'google',
    ], reason: 'RemoteScreen loses all provider-specific buttons without the list');
  });

  test('expired restored account must restore every sign-in provider', () async {
    final relay = FakeRelayBackend(user: sampleRelayUser);
    final c = container(relay);
    await c.read(relayAccountProvider.future);
    relay.user = null;
    await c.read(relayAccountProvider.notifier).recheck();
    final after = c.read(relayAccountProvider).value!;
    expect(after.signedIn, isFalse);
    expect(after.providers.map((p) => p.id), ['zhihu', 'github', 'google']);
  });

  test('normal provider login still opens once and lists its backend hosts', () async {
    final relay = _ControlledRelay();
    final opened = <Uri>[];
    final c = container(
      relay,
      opener: (url) async {
        opened.add(url);
        return true;
      },
    );
    await c.read(relayAccountProvider.future);
    final pending = c.read(relayAccountProvider.notifier).login(providerId: 'github');
    final request = relay.requests.single;
    request.release();
    await waiting(c, request.url);
    request.result.complete(sampleRelayUser);
    await pending;

    expect(relay.loginProviderIds, ['github']);
    expect(opened, [request.url]);
    expect(request.cancellations, 0);
    expect(relay.hostLists, 1);
    expect(account(c).user, sampleRelayUser);
    expect(account(c).hosts, sampleRelayHosts);
    expect(account(c).loggingIn, isFalse);
    expect(account(c).loginUrl, isNull);
    expect(account(c).error, isNull);
  });

  test('cancelling a created session consumes cancellation and clears waiting', () async {
    final relay = _ControlledRelay();
    final c = container(relay);
    await c.read(relayAccountProvider.future);
    final controller = c.read(relayAccountProvider.notifier);
    final pending = controller.login();
    final request = relay.requests.single;
    request.release();
    await waiting(c, request.url);
    controller.cancelLogin();
    await pending;

    expect(request.cancellations, 1);
    expect(account(c).signedIn, isFalse);
    expect(account(c).loggingIn, isFalse);
    expect(account(c).loginUrl, isNull);
    expect(account(c).error, isNull);
  });

  test('cancellation while opener is pending consumes its error before opener returns', () async {
    final relay = _ControlledRelay();
    final opener = _Gate<bool>();
    final c = container(relay, opener: (_) => opener.call());
    await c.read(relayAccountProvider.future);
    final controller = c.read(relayAccountProvider.notifier);
    final pending = controller.login();
    final request = relay.requests.single;
    request.release();
    await opener.entered.future;
    controller.cancelLogin();
    // Let cancellation's error run before the opener completes. An unhandled
    // completed future fails this test even if login() catches it later.
    await Future<void>.delayed(Duration.zero);
    opener.result.complete(false);
    await pending;

    expect(request.cancellations, 1);
    expect(account(c).loggingIn, isFalse);
    expect(account(c).loginUrl, isNull);
    expect(account(c).error, isNull);
  });

  test('late cancelled creation cannot open or detach an immediate retry', () async {
    final relay = _ControlledRelay();
    final opened = <Uri>[];
    final c = container(
      relay,
      opener: (url) async {
        opened.add(url);
        return true;
      },
    );
    await c.read(relayAccountProvider.future);
    final controller = c.read(relayAccountProvider.notifier);
    final oldLogin = controller.login(providerId: 'github');
    final oldRequest = relay.requests.single;
    controller.cancelLogin();
    final retry = controller.login(providerId: 'google');
    final newRequest = relay.requests.last;
    newRequest.release();
    await waiting(c, newRequest.url);

    oldRequest.release();
    await oldLogin;
    expect(oldRequest.cancellations, 1);
    expect(opened, [newRequest.url]);
    expect(account(c).loggingIn, isTrue);
    expect(account(c).loginUrl, newRequest.url);
    expect(account(c).error, isNull);
    controller.cancelLogin();
    await retry;
    expect(newRequest.cancellations, 1, reason: 'old finally must not detach the retry session');
  });

  test('late creation failure cannot clear an immediate retry', () async {
    final relay = _ControlledRelay();
    final c = container(relay);
    await c.read(relayAccountProvider.future);
    final controller = c.read(relayAccountProvider.notifier);
    final oldLogin = controller.login();
    final oldRequest = relay.requests.single;
    controller.cancelLogin();
    final retry = controller.login(providerId: 'google');
    final newRequest = relay.requests.last;
    newRequest.release();
    await waiting(c, newRequest.url);
    oldRequest.created.completeError(StateError('old creation failed'));
    await oldLogin;

    expect(account(c).loggingIn, isTrue);
    expect(account(c).loginUrl, newRequest.url);
    expect(account(c).error, isNull);
    newRequest.result.complete(_newUser);
    await retry;
    expect(account(c).user, _newUser);
  });

  test('server change cancels a late session and keeps the new account', () async {
    final relay = _ControlledRelay();
    final opened = <Uri>[];
    final c = container(
      relay,
      opener: (url) async {
        opened.add(url);
        return true;
      },
    );
    await c.read(relayAccountProvider.future);
    final pending = c.read(relayAccountProvider.notifier).login();
    final request = relay.requests.single;
    final replacement = _ControlledRelay(label: 'new.example', user: _newUser, hosts: _newHosts);
    await switchTo(c, replacement);
    request.release();
    await pending;

    expect(request.cancellations, 1);
    expect(opened, isEmpty);
    expect(account(c).server, 'new.example');
    expect(account(c).user, _newUser);
    expect(account(c).hosts, _newHosts);
    expect(account(c).error, isNull);
    expect(replacement.hostLists, 1);
  });

  test('server change rejects a late old host list', () async {
    final relay = _ControlledRelay();
    final c = container(relay);
    await c.read(relayAccountProvider.future);
    final pending = c.read(relayAccountProvider.notifier).login();
    final request = relay.requests.single;
    request.release();
    await waiting(c, request.url);
    final hosts = relay.hostsGate = _Gate<List<RelayHost>>();
    request.result.complete(sampleRelayUser);
    await hosts.entered.future;
    final replacement = _ControlledRelay(label: 'new.example', user: _newUser, hosts: _newHosts);
    await switchTo(c, replacement);
    hosts.result.complete(sampleRelayHosts);
    await pending;

    expect(account(c).server, 'new.example');
    expect(account(c).user, _newUser);
    expect(account(c).hosts, _newHosts);
    expect(account(c).error, isNull);
    expect(replacement.hostLists, 1);
  });

  test('disposal cancels a session created after the controller went away', () async {
    final relay = _ControlledRelay();
    final opened = <Uri>[];
    final c = ProviderContainer(
      overrides: [
        relayBackendProvider.overrideWithValue(relay),
        urlOpenerProvider.overrideWithValue((url) async {
          opened.add(url);
          return true;
        }),
      ],
    );
    await c.read(relayAccountProvider.future);
    final pending = c.read(relayAccountProvider.notifier).login();
    final request = relay.requests.single;
    c.dispose();
    request.release();
    await pending;
    expect(request.cancellations, 1);
    expect(opened, isEmpty);
  });

  test('providers after logout cannot overwrite a subsequent login', () async {
    final relay = _ControlledRelay(user: sampleRelayUser);
    final c = container(relay);
    await c.read(relayAccountProvider.future);
    final controller = c.read(relayAccountProvider.notifier);
    final providers = relay.providersGate = _Gate<List<RelayAuthProvider>>();
    final logout = controller.logout();
    await providers.entered.future;
    expect(account(c).signedIn, isFalse);
    final pending = controller.login(providerId: 'google');
    final request = relay.requests.single;
    request.release();
    await waiting(c, request.url);
    request.result.complete(_newUser);
    await pending;
    providers.result.complete(_newProviders);
    await logout;

    expect(account(c).user, _newUser);
    expect(account(c).providers, isEmpty, reason: 'discard the old signed-out read');
    expect(account(c).loggingIn, isFalse);
    expect(account(c).error, isNull);
  });

  test('late expiry check cannot sign out a subsequent successful login', () async {
    final relay = _ControlledRelay(user: sampleRelayUser);
    final c = container(relay);
    await c.read(relayAccountProvider.future);
    final controller = c.read(relayAccountProvider.notifier);
    final user = relay.userGate = _Gate<RelayUser?>();
    final checking = controller.recheck();
    await user.entered.future;
    final pending = controller.login(providerId: 'google');
    final request = relay.requests.single;
    request.release();
    await waiting(c, request.url);
    request.result.complete(_newUser);
    await pending;
    user.result.complete(null);
    await checking;

    expect(account(c).user, _newUser);
    expect(account(c).hosts, sampleRelayHosts);
    expect(account(c).error, isNull);
  });

  test('late expiry provider read and refresh tail cannot overwrite the new server', () async {
    final relay = _ControlledRelay(user: sampleRelayUser);
    final c = container(relay);
    await c.read(relayAccountProvider.future);
    relay.user = null;
    relay.listError = StateError('credentials expired');
    final providers = relay.providersGate = _Gate<List<RelayAuthProvider>>();
    final refresh = c.read(relayAccountProvider.notifier).refresh();
    await providers.entered.future;
    final replacement = _ControlledRelay(label: 'new.example')..providers = _newProviders;
    await switchTo(c, replacement);
    providers.result.complete(sampleRelayProviders);
    await refresh;

    expect(account(c).server, 'new.example');
    expect(account(c).providers, _newProviders);
    expect(account(c).signedIn, isFalse);
    expect(account(c).refreshing, isFalse);
    expect(account(c).hostsFailed, isFalse);
    expect(account(c).error, isNull);
  });

  test('late logout cannot clear a newly selected server or its active host', () async {
    final relay = _ControlledRelay(user: sampleRelayUser);
    final c = container(relay);
    await c.read(relayAccountProvider.future);
    final gate = relay.logoutGate = _Gate<void>();
    final pending = c.read(relayAccountProvider.notifier).logout();
    await gate.entered.future;
    final replacement = _ControlledRelay(label: 'new.example', user: _newUser, hosts: _newHosts);
    await switchTo(c, replacement);
    const selected = HostRef.relay('new-host');
    c.read(activeHostProvider.notifier).select(selected);
    gate.result.complete();
    await pending;

    expect(account(c).server, 'new.example');
    expect(account(c).user, _newUser);
    expect(account(c).hosts, _newHosts);
    expect(c.read(activeHostProvider), selected);
  });

  for (final expire in [false, true]) {
    test('${expire ? 'expiry' : 'logout'} provider failure keeps generic signed-out fallback', () async {
      final relay = _ControlledRelay(user: sampleRelayUser);
      final c = container(relay);
      await c.read(relayAccountProvider.future);
      final providers = relay.providersGate = _Gate<List<RelayAuthProvider>>();
      final controller = c.read(relayAccountProvider.notifier);
      if (expire) relay.user = null;
      final pending = expire ? controller.recheck() : controller.logout();
      await providers.entered.future;
      providers.result.completeError(StateError('server unreachable'));
      await pending;

      expect(account(c).signedIn, isFalse);
      expect(account(c).providers, isEmpty);
      expect(account(c).loggingIn, isFalse);
      expect(account(c).error, isNull);
    });
  }
}
