// Real RemoteScreen -> email sheet -> server controller -> default backend.
// Only the public preference store's replies are held. No private state,
// backend selection, SDK request, timer, or microtask is replaced.
import 'dart:async';
import 'dart:convert';


import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/remote/relay/dsh_remote_backend.dart';
import 'package:dsh_app/remote/secret_store.dart' as app_secrets;
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/remote/relay_login_sheet.dart';
import 'package:dsh_app/ui/remote/remote_screen.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_remote/dsh_remote.dart' as remote;
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderListenable;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';

import 'real_io_driver.dart';
import '../../../packages/dsh_remote/test/support/fake_remote.dart';
import '../shell/golden_harness.dart'
    show FakeRuntime, runningStatus, usePhoneSurface;

const _guard = Duration(seconds: 8);

class _LoopbackBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

class _NoLocal extends LocalConnectionController {
  @override
  Future<HostConnection?> build() async => null;
}

class _Secrets implements app_secrets.SecretStore, remote.SecretStore {
  final _values = <String, String>{};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async {
    _values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _values.remove(key);
  }
}

class _SaveReply {
  _SaveReply(this.label, this.origin);

  final String label;
  final String origin;
  final requested = Completer<void>();
  final written = Completer<void>();
  final released = Completer<void>();

  void release() {
    if (!released.isCompleted) released.complete();
  }
}

// Values remain in memory. Request/written/reply markers carry only A/B labels.
// All writes retain their call order; B cannot finish its write before A's
// held reply is delivered. Other preference keys keep their normal values.
class _Preferences extends InMemorySharedPreferencesStore {
  _Preferences(super.data) : super.withData();

  final _planned = <_SaveReply>[];
  final _all = <_SaveReply>[];
  final requests = <String>[];
  final writes = <String>[];
  final replies = <String>[];
  Future<void> _tail = Future<void>.value();

  _SaveReply hold(String label, Uri server) {
    final gate = _SaveReply(label, server.origin);
    _planned.add(gate);
    _all.add(gate);
    return gate;
  }

  Future<bool> _enqueue(Future<bool> Function() action, [_SaveReply? gate]) {
    final operation = _tail.then((_) async {
      final result = await action();
      if (gate != null) {
        writes.add(gate.label);
        gate.written.complete();
        await gate.released.future;
        replies.add(gate.label);
      }
      return result;
    });
    _tail = operation.then<void>((_) {}, onError: (Object _) {});
    return operation;
  }

  @override
  Future<bool> setValue(String valueType, String key, Object value) {
    _SaveReply? gate;
    if (key == 'flutter.${RelayServerController.prefsKey}' &&
        _planned.isNotEmpty) {
      gate = _planned.removeAt(0);
      if (valueType != 'String' || value != gate.origin) {
        throw StateError('Unexpected controlled preference request');
      }
      requests.add(gate.label);
      gate.requested.complete();
    }
    return _enqueue(() => super.setValue(valueType, key, value), gate);
  }

  @override
  Future<bool> remove(String key) => _enqueue(() => super.remove(key));

  Future<void> get idle => _tail;

  void releaseAll() {
    for (final gate in _all) {
      gate.release();
    }
  }
}

class _Outcome {
  const _Outcome(
    this.completedNormally,
    this.failureKind, {
    this.isHostLinkError = false,
    this.retryable,
    this.failureType,
  });

  final bool completedNormally;
  final String failureKind;
  final bool isHostLinkError;
  final bool? retryable;
  final String? failureType;
}

class _LoginCall {
  _LoginCall(this.requestedOrigin, this.result) {
    result.then<void>(
      (_) {
        settled = true;
      },
      onError: (Object _) {
        settled = true;
      },
    );
  }

  final String requestedOrigin;
  final Future<void> result;
  bool settled = false;

  Future<_Outcome> outcome() => result.then(
    (_) => const _Outcome(true, 'none'),
    onError: (Object error) => _Outcome(
      false,
      error is HostLinkError ? error.kind.name : 'untyped-error',
      failureType: error.runtimeType.toString(),
      isHostLinkError: error is HostLinkError,
      retryable: error is HostLinkError ? error.retryable : null,
    ),
  );
}

// Observe the original Future without wrapping the production call in an
// additional await. The super method still owns all state and I/O decisions.
class _ObservedServer extends RelayServerController {
  final calls = <_LoginCall>[];

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
    calls.add(_LoginCall(server, result));
    return result;
  }
}

Future<T> _state<T>(
  ProviderContainer container,
  ProviderListenable<T> provider,
  bool Function(T) accept,
) async {
  final arrived = Completer<T>();
  final subscription = container.listen(provider, (_, next) {
    if (!arrived.isCompleted && accept(next)) arrived.complete(next);
  }, fireImmediately: true);
  try {
    return await arrived.future.timeout(_guard);
  } finally {
    subscription.close();
  }
}

class _Fixture {
  _Fixture() : previousStore = SharedPreferencesStorePlatform.instance;

  final SharedPreferencesStorePlatform previousStore;
  final secrets = _Secrets();
  final servers = <FakeRemoteServer>[];
  final backends = <DshRemoteRelayBackend>{};
  final restored = <remote.RemoteAccount>[];
  late final FakeRemoteServer a;
  late final FakeRemoteServer b;
  late final _Preferences preferences;
  bool storeInstalled = false;
  ProviderContainer? _container;
  _ObservedServer? _controller;
  void Function()? stopBackendObservation;
  Future<List<String>>? _cleaning;

  ProviderContainer get container => _container!;
  _ObservedServer get controller => _controller!;

  static Future<_Fixture> create() async {
    final fixture = _Fixture();
    try {
      fixture.a = await FakeRemoteServer.start();
      fixture.servers.add(fixture.a);
      fixture.b = await FakeRemoteServer.start();
      fixture.servers.add(fixture.b);
      fixture.preferences = _Preferences({
        'flutter.${RelayServerController.prefsKey}': fixture.b.url.origin,
        'flutter.${ActiveHostController.prefsKey}': HostRef.local.encode(),
      });
      SharedPreferencesStorePlatform.instance = fixture.preferences;
      SharedPreferences.resetStatic();
      fixture.storeInstalled = true;
      fixture._container = ProviderContainer(
        overrides: [
          secretStoreProvider.overrideWithValue(fixture.secrets),
          relayServerProvider.overrideWith(_ObservedServer.new),
          localConnectionProvider.overrideWith(_NoLocal.new),
          networkKicksProvider.overrideWithValue(const Stream<void>.empty()),
          localRuntimeProvider.overrideWith(
            () => FakeRuntime(
              const LocalRuntimeState(loaded: true, status: runningStatus),
            ),
          ),
        ],
      );
      await _state(
        fixture.container,
        relayServerProvider,
        (value) => value == fixture.b.url.origin,
      );
      fixture._controller = fixture.container.read(
        relayServerProvider.notifier,
      ) as _ObservedServer;
      // Keep the production provider itself: each origin builds its real
      // DshRemoteRelayBackend, and its normal dispose callback closes the old.
      final subscription = fixture.container.listen(relayBackendProvider, (
        _,
        next,
      ) {
        if (next is! DshRemoteRelayBackend) {
          throw StateError('Expected the production relay backend');
        }
        fixture.backends.add(next);
      }, fireImmediately: true);
      fixture.stopBackendObservation = subscription.close;
      await fixture.container.read(activeHostProvider.notifier).ready;
      await fixture.container.read(relayAccountProvider.future).timeout(_guard);
      return fixture;
    } catch (_) {
      final failed = await fixture.cleanup();
      if (failed.isNotEmpty) {
        debugPrint('ORIGIN_PREPARATION_CLEANUP ${failed.join(', ')}');
      }
      rethrow;
    }
  }

  int loginCount(FakeRemoteServer server) => server.requests
      .where((value) => value == 'POST /api/v1/auth/login')
      .length;

  Future<Map<String, bool>> currentLogin(Uri expected) async {
    final backend = container.read(relayBackendProvider);
    final real = backend is DshRemoteRelayBackend ? backend : null;
    debugPrint('DSH_ORIGIN_STAGE current-user');
    final user = await backend.currentUser();
    final account = remote.RemoteAccount(secrets: secrets, serverUrl: expected);
    restored.add(account);
    debugPrint('DSH_ORIGIN_STAGE cold-restore');
    final saved = await account.currentUser();
    debugPrint('DSH_ORIGIN_STAGE authenticated-api');
    var apiSucceeded = false;
    try {
      await backend.listHosts();
      apiSucceeded = true;
    } on Object {
      // No error body or credential is printed.
    }
    debugPrint('DSH_ORIGIN_STAGE account-provider');
    final ui = await container
        .read(relayAccountProvider.future)
        .timeout(_guard);
    debugPrint('DSH_ORIGIN_STAGE account-provider-ready');
    return {
      'defaultRealBackend': real != null,
      'backendOriginMatches': real?.account.serverUrl.origin == expected.origin,
      'selectedOriginMatches':
          container.read(relayServerProvider) == expected.origin,
      'currentUserPresent': user != null,
      'restoredUserPresent': saved != null,
      'sameRestoredUser': user?.id == saved?.deviceId,
      'apiSucceeded': apiSucceeded,
      'uiSignedIn': ui.signedIn,
    };
  }

  Future<List<String>> cleanup() => _cleaning ??= _cleanup();

  Future<List<String>> _cleanup() async {
    final failed = <String>[];
    Future<void> attempt(String label, FutureOr<void> Function() action) async {
      try {
        await Future<void>.sync(action).timeout(_guard);
      } catch (_) {
        failed.add(label);
      }
    }

    if (storeInstalled) preferences.releaseAll();
    await attempt('provider-observation', () => stopBackendObservation?.call());
    await attempt('container', () => _container?.dispose());
    for (final (index, call)
        in (_controller?.calls ?? <_LoginCall>[]).indexed) {
      await attempt('login-${index + 1}', () async {
        await call.outcome();
      });
    }
    for (final (index, backend) in backends.indexed) {
      await attempt('backend-${index + 1}', backend.close);
    }
    for (final (index, account) in restored.indexed) {
      await attempt('restored-${index + 1}', account.close);
    }
    if (storeInstalled) {
      await attempt('preference-writes', () => preferences.idle);
    }
    for (final (index, server) in servers.indexed) {
      await attempt('server-${index + 1}', server.close);
    }
    await attempt('restore-global-store', () {
      SharedPreferencesStorePlatform.instance = previousStore;
      SharedPreferences.resetStatic();
    });
    return failed;
  }
}

Future<void> _frames(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> _withScreen(
  WidgetTester tester,
  Future<void> Function(_Fixture fixture) body,
) async {
  final fixture = (await tester.runAsync(_Fixture.create))!;
  addTearDown(() async {
    final failed = await fixture.cleanup();
    if (failed.isNotEmpty) fail('Owned cleanup failed: ${failed.join(', ')}');
  });
  usePhoneSurface(tester);
  try {
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: fixture.container,
        child: MaterialApp(
          theme: buildLightTheme(),
          locale: const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: const RemoteScreen(),
        ),
      ),
    );
    await _frames(tester);
    try {
      await body(fixture);
    } catch (_) {
      debugPrint('DSH_ORIGIN_FAILURE ${jsonEncode({
        'aPasswordPosts': fixture.loginCount(fixture.a),
        'bPasswordPosts': fixture.loginCount(fixture.b),
        'aDevices': fixture.a.devices.length,
        'bDevices': fixture.b.devices.length,
        'prefsRequested': fixture.preferences.requests,
        'prefsReplied': fixture.preferences.replies,
        'callsSettled': fixture.controller.calls.map((call) => call.settled).toList(),
        'providerLoading': fixture.container.read(relayAccountProvider).isLoading,
        'providerSignedIn': fixture.container.read(relayAccountProvider).value?.signedIn,
        'sheetCount': find.byType(SelfHostedLoginSheet).evaluate().length,
      })}');
      rethrow;
    }
  } finally {
    try {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    } finally {
      await tester.runAsync(fixture.cleanup);
    }
  }
}

Future<void> _openSheet(WidgetTester tester, Uri origin) async {
  final entry = find.descendant(
    of: find.byType(RemoteScreen),
    matching: find.text(appL10n.remoteSelfHostedEmailSignIn),
  );
  expect(entry, findsOneWidget);
  await tester.runAsync(() => tester.tap(entry));
  await _frames(tester);
  expect(find.byType(SelfHostedLoginSheet), findsOneWidget);
  final fields = find.descendant(
    of: find.byType(SelfHostedLoginSheet),
    matching: find.byType(TextField),
  );
  expect(fields, findsNWidgets(3));
  await tester.enterText(fields.at(0), origin.origin);
  await tester.enterText(fields.at(1), FakeRemoteServer.account);
  await tester.enterText(fields.at(2), FakeRemoteServer.password);
}

Future<_LoginCall> _submit(WidgetTester tester, _Fixture fixture) async {
  final before = fixture.controller.calls.length;
  final submit = find.descendant(
    of: find.byType(SelfHostedLoginSheet),
    matching: find.widgetWithText(FilledButton, appL10n.commonSignIn),
  );
  expect(submit, findsOneWidget);
  await tester.runAsync(() => tester.tap(submit));
  expect(fixture.controller.calls.length, before + 1);
  await _frames(tester);
  return fixture.controller.calls.last;
}

Future<void> _closeBusySheet(WidgetTester tester) async {
  final submit = find.descendant(
    of: find.byType(SelfHostedLoginSheet),
    matching: find.byType(FilledButton),
  );
  expect(tester.widget<FilledButton>(submit).onPressed, isNull);
  final close = find.descendant(
    of: find.byType(SelfHostedLoginSheet),
    matching: find.byTooltip(appL10n.commonClose),
  );
  expect(close, findsOneWidget);
  await tester.runAsync(() => tester.tap(close));
  await _frames(tester);
  expect(find.byType(SelfHostedLoginSheet), findsNothing);
}

void main() {
  _LoopbackBinding();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets(
    'normal changed-origin email login uses the requested real server',
    (tester) async {
      await _withScreen(tester, (fixture) async {
        await _openSheet(tester, fixture.a.url);
        final call = await _submit(tester, fixture);
        final outcome = (await driveRealIo(tester,
          () => call.outcome().timeout(_guard),
        ))!;
        await _frames(tester);
        final observation = (await driveRealIo(tester,
          () => fixture.currentLogin(fixture.a.url),
        ))!;
        await _frames(tester);
        expect(outcome.completedNormally, isTrue, reason: outcome.failureType);
        expect(fixture.loginCount(fixture.a), 1);
        expect(fixture.loginCount(fixture.b), 0);
        expect(observation.values, everyElement(isTrue));
        await _frames(tester);
        expect(find.text(FakeRemoteServer.account), findsOneWidget);
        expect(find.byType(SelfHostedLoginSheet), findsNothing);
      });
    },
  );

  testWidgets('same-origin email login retains the normal fast path', (
    tester,
  ) async {
    await _withScreen(tester, (fixture) async {
      final unused = fixture.preferences.hold('unused', fixture.b.url);
      await _openSheet(tester, fixture.b.url);
      final call = await _submit(tester, fixture);
      final outcome = (await driveRealIo(tester,
        () => call.outcome().timeout(_guard),
      ))!;
      await _frames(tester);
      final observation = (await driveRealIo(tester,
        () => fixture.currentLogin(fixture.b.url),
      ))!;
      expect(outcome.completedNormally, isTrue, reason: outcome.failureType);
      expect(unused.requested.isCompleted, isFalse);
      expect(fixture.loginCount(fixture.a), 0);
      expect(fixture.loginCount(fixture.b), 1);
      expect(observation.values, everyElement(isTrue));
        await _frames(tester);
        expect(find.text(FakeRemoteServer.account), findsOneWidget);
    });
  });

  testWidgets('closing a busy sheet alone preserves its unchanged target', (
    tester,
  ) async {
    await _withScreen(tester, (fixture) async {
      final gate = fixture.preferences.hold('A', fixture.a.url);
      await _openSheet(tester, fixture.a.url);
      final call = await _submit(tester, fixture);
      await driveRealIo(tester, () => gate.written.future.timeout(_guard));
      await _closeBusySheet(tester);
      expect(
        fixture.container.read(relayServerProvider) == fixture.a.url.origin,
        isTrue,
      );
      late _Outcome outcome;
      await driveRealIo(tester, () async {
        gate.release();
        outcome = await call.outcome().timeout(_guard);
      });
      await _frames(tester);
      final observation = (await driveRealIo(tester,
        () => fixture.currentLogin(fixture.a.url),
      ))!;
      expect(outcome.completedNormally, isTrue, reason: outcome.failureType);
      expect(fixture.loginCount(fixture.a), 1);
      expect(fixture.loginCount(fixture.b), 0);
      expect(observation.values, everyElement(isTrue));
        await _frames(tester);
        expect(find.text(FakeRemoteServer.account), findsOneWidget);
    });
  });

  testWidgets(
    'an older sheet login cannot switch to the later selected server',
    (tester) async {
      await _withScreen(tester, (fixture) async {
        final firstSave = fixture.preferences.hold('A', fixture.a.url);
        final secondSave = fixture.preferences.hold('B', fixture.b.url);
        await _openSheet(tester, fixture.a.url);
        final first = await _submit(tester, fixture);
        await driveRealIo(tester, () => firstSave.written.future.timeout(_guard));
        expect(fixture.loginCount(fixture.a), 0);
        expect(fixture.loginCount(fixture.b), 0);
        await _closeBusySheet(tester);
        await _openSheet(tester, fixture.b.url);
        final second = await _submit(tester, fixture);
        await driveRealIo(tester,
          () => secondSave.requested.future.timeout(_guard),
        );
        expect(
          fixture.container.read(relayServerProvider) == fixture.b.url.origin,
          isTrue,
        );
        expect(
          secondSave.written.isCompleted,
          isFalse,
          reason: 'platform writes keep A then B order',
        );
        expect(fixture.preferences.requests, ['A', 'B']);
        expect(fixture.preferences.replies, isEmpty);

        late _Outcome firstOutcome;
        await driveRealIo(tester, () async {
          firstSave.release();
          firstOutcome = await first.outcome().timeout(_guard);
        });
        await _frames(tester);
        final beforeCurrentReply = {
          'aLogins': fixture.loginCount(fixture.a),
          'bLogins': fixture.loginCount(fixture.b),
          'firstSettled': first.settled,
          'firstCompletedNormally': firstOutcome.completedNormally,
          'firstFailureKind': firstOutcome.failureKind,
          'firstFailureType': firstOutcome.failureType,
          'firstIsHostLinkError': firstOutcome.isHostLinkError,
          'firstRetryable': firstOutcome.retryable,
          'secondStillWaiting':
              !second.settled && !secondSave.released.isCompleted,
          'secondSheetPresent':
              find.byType(SelfHostedLoginSheet).evaluate().length == 1,
          'selectedB':
              fixture.container.read(relayServerProvider) ==
              fixture.b.url.origin,
          'requestedOriginsMatch':
              first.requestedOrigin == fixture.a.url.origin &&
              second.requestedOrigin == fixture.b.url.origin,
          'replyOrder': List<String>.of(fixture.preferences.replies),
        };
        late _Outcome secondOutcome;
        await driveRealIo(tester, () async {
          secondSave.release();
          secondOutcome = await second.outcome().timeout(_guard);
        });
        await _frames(tester);
        final current = (await driveRealIo(tester,
          () => fixture.currentLogin(fixture.b.url),
        ))!;
        await _frames(tester);
        final observation = {
          'beforeCurrentReply': beforeCurrentReply,
          'secondCompletedNormally': secondOutcome.completedNormally,
          'finalBLogins': fixture.loginCount(fixture.b),
          'finalReplyOrder': List<String>.of(fixture.preferences.replies),
          'currentLogin': current,
        };
        debugPrint('DSH_LOGIN_ORIGIN ${jsonEncode(observation)}');
        expect(beforeCurrentReply['firstSettled'], isTrue);
        expect(beforeCurrentReply['secondStillWaiting'], isTrue);
        expect(beforeCurrentReply['requestedOriginsMatch'], isTrue);
        expect(beforeCurrentReply['replyOrder'], ['A']);
        expect(beforeCurrentReply['secondSheetPresent'], isTrue);
        expect(beforeCurrentReply['aLogins'], 0);
        expect(firstOutcome.completedNormally, isFalse);
        expect(firstOutcome.isHostLinkError, isTrue);
        expect(firstOutcome.retryable, isFalse);
        expect(
          beforeCurrentReply['bLogins'],
          0,
          reason: 'the old A invocation must not send its login to B',
        );
        expect(secondOutcome.completedNormally, isTrue);
        expect(fixture.loginCount(fixture.b), 1);
        expect(fixture.preferences.replies, ['A', 'B']);
        expect(current.values, everyElement(isTrue));
        expect(find.text(FakeRemoteServer.account), findsOneWidget);
        expect(find.byType(SelfHostedLoginSheet), findsNothing);
      });
    },
  );
}
