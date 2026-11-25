import 'dart:async';

import 'package:dsh_app/remote/relay/relay_backend.dart';
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
const _chooseServer = '使用此服务器';

class _Backend extends FakeRelayBackend {
  _Backend(this.origin, this.passwordGate);

  final String origin;
  final Completer<void>? passwordGate;

  @override
  String get serverLabel => Uri.parse(origin).host;

  @override
  Future<RelayUser> loginWithPassword(String email, String password) async {
    passwordLogins.add((email, password));
    await passwordGate?.future;
    return user = RelayUser(id: 'password-user', displayName: email, provider: 'password');
  }
}

class _Fixture {
  _Fixture(this.container, this.backends);

  final ProviderContainer container;
  final Map<String, _Backend> backends;
}

Future<void> _frames(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

// The screen, sheet, origin validation, stored selection and account controller
// are real. Only the network backend and local runtime are controlled seams.
Future<_Fixture> _open(WidgetTester tester, {bool noProviders = false, Completer<void>? passwordGate}) async {
  SharedPreferences.setMockInitialValues({});
  usePhoneSurface(tester);
  final backends = <String, _Backend>{};
  await tester.pumpWidget(
    goldenApp(
      home: const RemoteScreen(),
      brightness: Brightness.light,
      overrides: [
        secretStoreProvider.overrideWithValue(MemorySecretStore()),
        relayBackendProvider.overrideWith((ref) {
          final origin = ref.watch(relayServerProvider) ?? defaultRelayServer;
          final backend = _Backend(origin, passwordGate);
          if (origin == _server) {
            backend.providers = noProviders ? [] : const [RelayAuthProvider(id: 'sso', displayName: 'Company SSO')];
          }
          return backends[origin] = backend;
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
  await tester.tap(find.text('自建服务器 · 邮箱登录'));
  await _frames(tester);
  return _Fixture(container, backends);
}

Finder get _fields => find.descendant(of: find.byType(SelfHostedLoginSheet), matching: find.byType(TextField));

Future<void> _choose(WidgetTester tester, String server) async {
  await tester.enterText(_fields.at(0), server);
  await tester.ensureVisible(find.widgetWithText(TextButton, _chooseServer));
  await tester.tap(find.widgetWithText(TextButton, _chooseServer));
  await _frames(tester);
}

void main() {
  testWidgets('server selection needs no credentials and exposes that server providers', (tester) async {
    final f = await _open(tester);
    await _choose(tester, ' relay.example.com/ ');
    expect(find.byType(SelfHostedLoginSheet), findsNothing);
    expect(f.container.read(relayServerProvider), _server);
    expect((await SharedPreferences.getInstance()).getString(RelayServerController.prefsKey), _server);
    expect(f.container.read(relayAccountProvider).value?.signedIn, isFalse);
    expect(find.text('使用 Company SSO 登录'), findsOneWidget);
    expect(find.text('使用 GitHub 登录'), findsNothing);
    expect(f.backends.values.expand((backend) => backend.passwordLogins), isEmpty);
    expect(f.backends.values.expand((backend) => backend.loginProviderIds), isEmpty);
  });

  testWidgets('a server without provider metadata keeps the existing browser fallback', (tester) async {
    final f = await _open(tester, noProviders: true);
    await _choose(tester, _server);
    expect(find.byType(SelfHostedLoginSheet), findsNothing);
    expect(f.container.read(relayServerProvider), _server);
    expect(find.text('在浏览器中登录'), findsOneWidget);
    expect(f.container.read(relayAccountProvider).value?.signedIn, isFalse);
    expect(f.backends.values.expand((backend) => backend.passwordLogins), isEmpty);
  });

  for (final server in ['', 'http://public.example.com', 'https://relay.example.com/path']) {
    testWidgets('server selection rejects invalid origin "$server" without changing selection', (tester) async {
      final f = await _open(tester);
      await _choose(tester, server);
      expect(find.byType(SelfHostedLoginSheet), findsOneWidget);
      expect(find.text('服务器地址无效'), findsOneWidget);
      expect(f.container.read(relayServerProvider), isNull);
      expect((await SharedPreferences.getInstance()).containsKey(RelayServerController.prefsKey), isFalse);
      expect(f.backends.keys, [defaultRelayServer]);
      expect(f.backends.values.single.passwordLogins, isEmpty);
    });
  }

  testWidgets('password submit still requires email and password', (tester) async {
    final f = await _open(tester);
    await tester.enterText(_fields.at(0), _server);
    await tester.tap(find.widgetWithText(FilledButton, '登录'));
    await _frames(tester);
    expect(find.text('填写服务器地址、邮箱和密码'), findsOneWidget);
    expect(f.container.read(relayServerProvider), isNull);
    expect(f.backends.values.single.passwordLogins, isEmpty);
  });

  testWidgets('pending password sign-in disables server selection', (tester) async {
    final gate = Completer<void>();
    addTearDown(() {
      if (!gate.isCompleted) gate.complete();
    });
    final f = await _open(tester, passwordGate: gate);
    await tester.enterText(_fields.at(0), _server);
    await tester.enterText(_fields.at(1), 'synthetic@example.com');
    await tester.enterText(_fields.at(2), 'synthetic-password');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await _frames(tester);
    expect(f.backends[_server]!.passwordLogins, [('synthetic@example.com', 'synthetic-password')]);
    expect(tester.widget<TextButton>(find.widgetWithText(TextButton, _chooseServer)).onPressed, isNull);
    gate.complete();
    await _frames(tester);
    expect(find.byType(SelfHostedLoginSheet), findsNothing);
    expect(f.container.read(relayAccountProvider).value?.signedIn, isTrue);
  });
}
