import 'dart:async';
import 'dart:convert';


import 'package:dsh_remote/dsh_remote.dart' as remote;
import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/remote/relay_login_sheet.dart';
import 'package:dsh_app/ui/remote/remote_screen.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'real_io_driver.dart';
import '../../../packages/dsh_remote/test/support/fake_remote.dart';
import '../shell/golden_harness.dart'
    show FakeRuntime, runningStatus, usePhoneSurface;

const _guard = Duration(seconds: 8);

// Only fixed categories are logged: never an error message, response or token.
String _observationFailure(Object error) {
  if (error is remote.RemoteConnectException && error.code == 'ACCOUNT_AUTH_REQUIRED') {
    return 'account-auth-required';
  }
  if (error is HostLinkError) return 'host-link-error';
  return 'other-error';
}

class _LoopbackBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

class _NoLocal extends LocalConnectionController {
  @override
  Future<HostConnection?> build() async => null;
}

class _HeldCredentials extends MemorySecretStore implements remote.SecretStore {
  final written = Completer<void>();
  final release = Completer<void>();
  bool held = false;

  @override
  Future<void> write(String key, String value) async {
    await super.write(key, value);
    if (!held && key.endsWith('.credentials')) {
      held = true;
      written.complete();
      await release.future;
    }
  }
}

class _ObservedServer extends RelayServerController {
  final calls = <Future<void>>[];

  @override
  Future<void> loginWithPassword({
    required String server,
    required String email,
    required String password,
  }) {
    final result = super.loginWithPassword(
      server: server,
      email: email,
      password: password,
    );
    result.ignore();
    calls.add(result);
    return result;
  }
}

class _ObservedAccount extends RelayAccountController {
  Future<void>? loginResult;
  bool loginFinished = false;

  @override
  Future<void> login({String? providerId}) {
    final result = super.login(providerId: providerId);
    loginResult = result;
    result.then<void>(
      (_) => loginFinished = true,
      onError: (Object _) => loginFinished = true,
    );
    return result;
  }
}

Future<void> _frames(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> _emailLogin(
  WidgetTester tester,
  Uri origin,
  String password,
) async {
  await tester.runAsync(
    () => tester.tap(find.text(appL10n.remoteSelfHostedEmailSignIn)),
  );
  await _frames(tester);
  final fields = find.descendant(
    of: find.byType(SelfHostedLoginSheet),
    matching: find.byType(TextField),
  );
  await tester.enterText(fields.at(0), origin.origin);
  await tester.enterText(fields.at(1), FakeRemoteServer.account);
  await tester.enterText(fields.at(2), password);
  await tester.runAsync(
    () => tester.tap(find.widgetWithText(FilledButton, appL10n.commonSignIn)),
  );
  await _frames(tester);
}

Future<void> _closeSheet(WidgetTester tester) async {
  final close = find.descendant(
    of: find.byType(SelfHostedLoginSheet),
    matching: find.byTooltip(appL10n.commonClose),
  );
  await tester.runAsync(() => tester.tap(close));
  await _frames(tester);
  expect(find.byType(SelfHostedLoginSheet), findsNothing);
}

void main() {
  _LoopbackBinding();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets(
    'late successful password login cannot cancel another server browser login',
    (tester) async {
      final a = (await tester.runAsync(FakeRemoteServer.start))!;
      final b = (await tester.runAsync(FakeRemoteServer.start))!;
      final secrets = _HeldCredentials();
      final pollEntered = Completer<void>();
      final pollRelease = Completer<void>();
      final opened = Completer<Uri>();
      ProviderContainer? container;
      try {
        await driveRealIo(tester, () async {
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString(RelayServerController.prefsKey, a.url.origin);
        });
        final c = container = ProviderContainer(
          overrides: [
            secretStoreProvider.overrideWithValue(secrets),
            relayServerProvider.overrideWith(_ObservedServer.new),
            relayAccountProvider.overrideWith(_ObservedAccount.new),
            localConnectionProvider.overrideWith(_NoLocal.new),
            networkKicksProvider.overrideWithValue(const Stream<void>.empty()),
            localRuntimeProvider.overrideWith(
              () => FakeRuntime(
                const LocalRuntimeState(loaded: true, status: runningStatus),
              ),
            ),
            urlOpenerProvider.overrideWithValue((url) async {
              opened.complete(url);
              return true;
            }),
          ],
        );
        // Complete normal preferences restoration before reading the backend.
        final selected = Completer<void>();
        final subscription = c.listen(relayServerProvider, (_, value) {
          if (value == a.url.origin && !selected.isCompleted) {
            selected.complete();
          }
        }, fireImmediately: true);
        await driveRealIo(tester, () => selected.future.timeout(_guard));
        subscription.close();
        await driveRealIo(tester,
          () => c.read(relayAccountProvider.future).timeout(_guard),
        );
        usePhoneSurface(tester);
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: c,
            child: MaterialApp(
              theme: buildLightTheme(),
              locale: const Locale('zh', 'CN'),
              supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
              localizationsDelegates: GlobalMaterialLocalizations.delegates,
              home: const RemoteScreen(),
            ),
          ),
        );
        await _frames(tester);
        final server = c.read(relayServerProvider.notifier) as _ObservedServer;
        await _emailLogin(tester, a.url, FakeRemoteServer.password);
        await driveRealIo(tester, () => secrets.written.future.timeout(_guard));
        expect(
          a.requests.where((r) => r == 'POST /api/v1/auth/login').length,
          1,
        );
        expect(
          a.devices.length,
          1,
          reason: 'A really registered before its credential write returned',
        );
        await _closeSheet(tester);

        // A real failed B submission selects B without authenticating it.
        await _emailLogin(tester, b.url, 'invalid-test-password');
        Object? bError;
        await driveRealIo(tester, () async {
          try {
            await server.calls.last.timeout(_guard);
          } catch (error) {
            bError = error;
          }
        });
        expect(bError, isA<HostLinkError>());
        expect((bError as HostLinkError).kind, HostLinkErrorKind.authFailed);
        await _frames(tester);
        await _closeSheet(tester);
        await driveRealIo(tester,
          () => c.read(relayAccountProvider.future).timeout(_guard),
        );
        await _frames(tester);
        b.beforeQrPollResponse = () async {
          pollEntered.complete();
          await pollRelease.future;
        };
        final browserButton = find.widgetWithText(
          FilledButton,
          appL10n.remoteSignInWithProvider('GitHub'),
        );
        await tester.runAsync(() => tester.tap(browserButton));
        late Uri loginUrl;
        await driveRealIo(tester, () async {
          loginUrl = await opened.future.timeout(_guard);
          await pollEntered.future.timeout(_guard);
        });
        await _frames(tester);
        final account =
            c.read(relayAccountProvider.notifier) as _ObservedAccount;
        expect(c.read(relayAccountProvider).value!.loggingIn, isTrue);
        expect(c.read(relayAccountProvider).value!.loginUrl, loginUrl);
        expect(account.loginFinished, isFalse);
        expect(b.devices, isEmpty);

        // No HTTP request or browser opener is held for A: only the successful
        // platform secret-write return remains. Its original Future must succeed.
        var aSucceeded = false;
        await driveRealIo(tester, () async {
          secrets.release.complete();
          await server.calls.first.timeout(_guard);
          aSucceeded = true;
        });
        await _frames(tester);
        final stayedPending = !account.loginFinished;
        final stateAfterA = c.read(relayAccountProvider).value;
        final keptUrl = stateAfterA?.loginUrl == loginUrl;
        final keptWaiting = stateAfterA?.loggingIn == true;
        await driveRealIo(tester, () async {
          b.approveQr(loginUrl.pathSegments.last);
          pollRelease.complete();
          await account.loginResult!.timeout(_guard);
        });
        await _frames(tester);
        var currentUserError = 'none';
        final user = await driveRealIo(tester, () async {
          try {
            return await c.read(relayBackendProvider).currentUser();
          } on Object catch (error) {
            currentUserError = _observationFailure(error);
            return null;
          }
        });
        var apiSucceeded = false;
        var apiError = 'none';
        await driveRealIo(tester, () async {
          try {
            await c.read(relayBackendProvider).listHosts();
            apiSucceeded = true;
          } on Object catch (error) {
            apiError = _observationFailure(error);
          }
        });
        var coldRestored = false;
        var coldApiSucceeded = false;
        var coldRestoreError = 'none';
        var coldApiError = 'none';
        var coldCloseError = 'none';
        await driveRealIo(tester, () async {
          final cold = remote.RemoteAccount(secrets: secrets, serverUrl: b.url);
          try {
            try {
              final saved = await cold.currentUser();
              coldRestored = saved != null && saved.deviceId == user?.id;
            } on Object catch (error) {
              coldRestoreError = _observationFailure(error);
            }
            try {
              await cold.listHosts();
              coldApiSucceeded = true;
            } on Object catch (error) {
              coldApiError = _observationFailure(error);
            }
          } finally {
            try {
              await cold.close();
            } on Object catch (error) {
              coldCloseError = _observationFailure(error);
            }
          }
        });
        await _frames(tester);
        debugPrint('DSH_LOGIN_PUBLISH ${jsonEncode({
          'aPasswordPosts': a.requests.where((r) => r == 'POST /api/v1/auth/login').length,
          'aRegisteredDevices': a.devices.length,
          'aOriginalFutureSucceeded': aSucceeded,
          'bOriginalFutureStillPendingAfterA': stayedPending,
          'bLoginUrlPreservedAfterA': keptUrl,
          'bWaitingPreservedAfterA': keptWaiting,
          'bRegisteredDevicesAfterApproval': b.devices.length,
          'bCurrentUserPresent': user != null,
          'bApiSucceeded': apiSucceeded,
          'bCurrentUserError': currentUserError,
          'bApiError': apiError,
          'bColdRestoredIdentityMatches': coldRestored,
          'bColdApiSucceeded': coldApiSucceeded,
          'bColdRestoreError': coldRestoreError,
          'bColdApiError': coldApiError,
          'bColdCloseError': coldCloseError,
          'bUiSignedIn': c.read(relayAccountProvider).value?.signedIn == true,
        })}');
        expect(aSucceeded, isTrue);
        expect(
          stayedPending,
          isTrue,
          reason: 'A completion must not settle B browser login',
        );
        expect(keptUrl, isTrue);
        expect(keptWaiting, isTrue);
        expect(user, isNotNull);
        expect(apiSucceeded, isTrue);
        expect(coldRestored, isTrue);
        expect(coldApiSucceeded, isTrue);
        expect(currentUserError, 'none');
        expect(apiError, 'none');
        expect(coldRestoreError, 'none');
        expect(coldApiError, 'none');
        expect(coldCloseError, 'none');
        expect(find.text(FakeRemoteServer.account), findsOneWidget);
        expect(b.devices.length, 1);
        expect(c.read(relayAccountProvider).value!.signedIn, isTrue);
      } finally {
        if (!secrets.release.isCompleted) secrets.release.complete();
        if (!pollRelease.isCompleted) pollRelease.complete();
        await tester.pumpWidget(const SizedBox.shrink());
        container?.dispose();
        await tester.runAsync(() async {
          await a.close();
          await b.close();
        });
      }
    },
  );
}
