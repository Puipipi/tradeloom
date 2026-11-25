import 'dart:async';

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/remote/relay_login_sheet.dart';
import 'package:dsh_app/ui/remote/remote_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';
import 'support/fake_relay.dart';

const _server = 'https://relay.example.com';
const _host = HostRef.relay('mac', name: 'Mac');
const _expired = HostLinkError(HostLinkErrorKind.notLoggedIn, 'DSH Remote 登录已失效');

class _PasswordBackend extends FakeRelayBackend {
  _PasswordBackend(String? provider)
    : super(
        user: RelayUser(id: 'old-user', displayName: 'old@example.com', provider: provider),
      );

  Completer<void>? passwordGate;
  HostLinkError? passwordError;

  @override
  Future<RelayUser> loginWithPassword(String email, String password) async {
    passwordLogins.add((email, password));
    await passwordGate?.future;
    if (passwordError case final error?) throw error;
    return user = RelayUser(id: 'new-user', displayName: email, provider: 'password');
  }
}

class _RetryConnection extends RemoteConnectionController {
  _RetryConnection(this.retries) : super(_host);

  final List<HostRef> retries;

  @override
  Future<HostConnection?> build() async => null;

  @override
  void retry() => retries.add(host);
}

class _Fixture {
  _Fixture(this.container, this.opened, this.retries);

  final ProviderContainer container;
  final List<Uri> opened;
  final List<HostRef> retries;

  _PasswordBackend get backend => container.read(relayBackendProvider) as _PasswordBackend;
}

Future<void> _frames(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

// Exercise the real screen, sheet, account controller and server selection.
// Remote authentication and link status/retry are controlled seams; this is
// a login UI regression, not a transport or credential-expiry reproduction.
Future<_Fixture> _openFailedHost(WidgetTester tester, {String? provider = 'password', String? server = _server}) async {
  SharedPreferences.setMockInitialValues({RelayServerController.prefsKey: ?server});
  usePhoneSurface(tester);
  final opened = <Uri>[];
  final retries = <HostRef>[];
  await tester.pumpWidget(
    goldenApp(
      home: const RemoteScreen(),
      brightness: Brightness.light,
      overrides: [
        secretStoreProvider.overrideWithValue(MemorySecretStore()),
        hostLinkStatusProvider(_host)
            .overrideWith((ref) => Stream.value(const HostLinkStatus(HostLinkPhase.failed, error: _expired))),
        remoteConnectionProvider(_host).overrideWith(() => _RetryConnection(retries)),
        relayBackendProvider.overrideWith((ref) {
          // The real backend has a new identity after every server change,
          // including A -> B -> A. Preserve that ownership boundary here.
          ref.watch(relayServerProvider);
          return _PasswordBackend(provider);
        }),
        urlOpenerProvider.overrideWithValue((url) async {
          opened.add(url);
          return true;
        }),
        networkKicksProvider.overrideWithValue(const Stream.empty()),
        localRuntimeProvider.overrideWith(
          () => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus)),
        ),
      ],
    ),
  );
  await _frames(tester);
  final container = ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
  expect(container.read(relayServerProvider), server);
  container.read(activeHostProvider.notifier).select(_host);
  await _frames(tester);
  expect(container.read(hostLinkStatusProvider(_host)).value?.error, _expired);
  expect(container.read(relayAccountProvider).value?.signedIn, isTrue);
  return _Fixture(container, opened, retries);
}

Future<void> _openPasswordSheet(WidgetTester tester, {String server = _server}) async {
  await tester.ensureVisible(find.text('重新登录'));
  await tester.tap(find.text('重新登录'));
  await _frames(tester);
  expect(find.byType(SelfHostedLoginSheet), findsOneWidget);
  final fields = find.descendant(of: find.byType(SelfHostedLoginSheet), matching: find.byType(TextField));
  expect(tester.widget<TextField>(fields.at(0)).controller!.text, server);
}

Future<void> _submit(WidgetTester tester) async {
  final fields = find.descendant(of: find.byType(SelfHostedLoginSheet), matching: find.byType(TextField));
  await tester.enterText(fields.at(1), 'new@example.com');
  await tester.enterText(fields.at(2), 'test-password');
  await tester.testTextInput.receiveAction(TextInputAction.done);
  await _frames(tester);
}

void main() {
  for (final server in [_server, null]) {
    testWidgets('password relogin at $server opens email and retries after success', (tester) async {
      final f = await _openFailedHost(tester, server: server);
      final backend = f.backend;
      await _openPasswordSheet(tester, server: server ?? defaultRelayServer);
      expect(backend.loginProviderIds, isEmpty);
      expect(f.opened, isEmpty);
      await _submit(tester);
      expect(backend.passwordLogins, [('new@example.com', 'test-password')]);
      expect(find.byType(SelfHostedLoginSheet), findsNothing);
      expect(f.retries, [_host]);
      expect(f.container.read(relayAccountProvider).value?.user?.id, 'new-user');
    });
  }

  testWidgets('closing the password sheet does not retry the signed-in account', (tester) async {
    final f = await _openFailedHost(tester);
    final backend = f.backend;
    await _openPasswordSheet(tester);
    final close = find.descendant(of: find.byType(SelfHostedLoginSheet), matching: find.byTooltip('关闭'));
    await tester.tap(close);
    await _frames(tester);
    expect(find.byType(SelfHostedLoginSheet), findsNothing);
    expect(backend.passwordLogins, isEmpty);
    expect(f.retries, isEmpty);
    expect(f.container.read(relayAccountProvider).value?.signedIn, isTrue);
  });

  testWidgets('choosing the server alone is not a successful password relogin', (tester) async {
    final f = await _openFailedHost(tester);
    final backend = f.backend;
    await _openPasswordSheet(tester);
    await tester.tap(find.widgetWithText(TextButton, '使用此服务器'));
    await _frames(tester);
    expect(find.byType(SelfHostedLoginSheet), findsNothing);
    expect(f.container.read(relayServerProvider), _server);
    expect(backend.passwordLogins, isEmpty);
    expect(f.retries, isEmpty);
  });

  testWidgets('password rejection stays visible without retrying', (tester) async {
    final f = await _openFailedHost(tester);
    final backend = f.backend..passwordError = const HostLinkError(HostLinkErrorKind.notLoggedIn, '测试密码错误');
    await _openPasswordSheet(tester);
    await _submit(tester);
    expect(find.text('测试密码错误'), findsOneWidget);
    expect(find.byType(SelfHostedLoginSheet), findsOneWidget);
    expect(f.retries, isEmpty);
    expect(backend.loginProviderIds, isEmpty);
  });

  testWidgets('password completion after switching host does not reconnect it', (tester) async {
    final f = await _openFailedHost(tester);
    final gate = Completer<void>();
    addTearDown(() {
      if (!gate.isCompleted) gate.complete();
    });
    final backend = f.backend..passwordGate = gate;
    await _openPasswordSheet(tester);
    await _submit(tester);
    expect(backend.passwordLogins, hasLength(1));
    f.container.read(activeHostProvider.notifier).select(HostRef.local);
    await _frames(tester);
    gate.complete();
    await _frames(tester);
    expect(find.byType(SelfHostedLoginSheet), findsNothing);
    expect(f.container.read(activeHostProvider), HostRef.local);
    expect(f.retries, isEmpty);
  });

  testWidgets('late password completion cannot retry a replacement server owner', (tester) async {
    final f = await _openFailedHost(tester);
    final gate = Completer<void>();
    addTearDown(() {
      if (!gate.isCompleted) gate.complete();
    });
    final old = f.backend..passwordGate = gate;
    await _openPasswordSheet(tester);
    await _submit(tester);
    await f.container.read(relayServerProvider.notifier).useServer('https://other.example.com');
    await _frames(tester);
    await f.container.read(relayServerProvider.notifier).useServer(_server);
    await _frames(tester);
    f.container.read(activeHostProvider.notifier).select(_host);
    await _frames(tester);
    final current = f.backend;
    expect(current, isNot(same(old)));
    expect(f.retries, isEmpty);
    gate.complete();
    await _frames(tester);
    expect(find.byType(SelfHostedLoginSheet), findsNothing);
    expect(f.container.read(activeHostProvider), _host);
    expect(f.backend, same(current));
    expect(f.retries, isEmpty);
    expect(current.passwordLogins, isEmpty);
  });

  for (final (provider, server) in [('github', _server), (null, _server), ('github', null)]) {
    testWidgets('browser relogin stays available for $provider at $server', (tester) async {
      final f = await _openFailedHost(tester, provider: provider, server: server);
      final backend = f.backend;
      await tester.ensureVisible(find.text('重新登录'));
      await tester.tap(find.text('重新登录'));
      await _frames(tester);
      expect(find.byType(SelfHostedLoginSheet), findsNothing);
      expect(backend.loginProviderIds, [null]);
      expect(f.opened, hasLength(1));
      expect(backend.passwordLogins, isEmpty);
      backend.pendingLogin!.complete(sampleRelayUser);
      await _frames(tester);
      expect(f.retries, [_host]);
    });
  }
}
