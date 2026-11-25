import 'dart:async';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/share_code/guest_fs.dart';
import 'package:dsh_app/state/balance_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/drawer_view_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/onboarding_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/state/workspaces_state.dart';
import 'package:dsh_app/ui/shell/session_search_page.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../drawer/support.dart';
import '../shell/golden_harness.dart';
import '../workspace/support.dart';

class _Runtime extends FakeRuntime {
  _Runtime() : super(_running('first'));

  static LocalRuntimeState _running(String token) => LocalRuntimeState(
    loaded: true,
    status: RuntimeStatus.fromMap({'phase': 'running', 'baseUrl': 'http://127.0.0.1:9', 'token': token}),
  );

  void reconnect() => state = _running('second');
}

class _LocalHost extends ActiveHostController {
  @override
  HostRef build() => HostRef.local;
}

class _Carrier extends DrawerHost {
  bool closed = false;
  final unarchiveAttempts = <Map<String, Object?>>[];

  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) {
    if (endpoint == 'workspace/unarchiveSession') unarchiveAttempts.add(args);
    // DrawerHost.close is intentionally a no-op in the existing fixture.
    // Reject after close here so a stale call cannot fake a successful write.
    if (closed) return Future.error(const DshClosedException('test carrier closed'));
    return super.call(endpoint, args, timeout: timeout);
  }

  @override
  Future<void> close() async {
    closed = true;
    await super.close();
  }
}

class _Client extends DshClient {
  _Client(super.carrier) : super.withCarrier();

  Future<void>? _closing;

  // Keep ownership of the whole mux + carrier close, including when the
  // controller and test cleanup both request it.
  @override
  Future<void> close() => _closing ??= super.close();
}

// The same public route and archivedOnly argument used by drawer_actions.
// This small host observes the popped id and applies the existing selection;
// it does not mount HomeShell's unrelated pet/overlay integrations.
class _ArchiveLauncher extends ConsumerWidget {
  const _ArchiveLauncher({required this.onPicked});
  final ValueChanged<String> onPicked;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
    body: Center(
      child: FilledButton(
        onPressed: () async {
          final id = await showSessionSearch(context, archivedOnly: true);
          if (id == null || !context.mounted) return;
          onPicked(id);
          ref.read(currentSessionProvider.notifier).select(id);
        },
        child: const Text('打开归档'),
      ),
    ),
  );
}

Future<void> _frames(WidgetTester tester) async {
  await tester.pump(Duration.zero);
  await tester.pump(const Duration(milliseconds: 450));
  await tester.pump(const Duration(milliseconds: 450));
}

void main() {
  for (final restoreAfterReady in [false, true]) {
    testWidgets('archive confirmation starts during loading (wait for ready: $restoreAfterReady)', (tester) async {
      SharedPreferences.setMockInitialValues({});
      FlutterSecureStorage.setMockInitialValues({});
      final oldHost = _Carrier();
      final nextHost = _Carrier();
      for (final host in [oldHost, nextHost]) {
        host.seedSession('a1', '归档的旧对话', DateTime(2026, 10, 1));
        host.archived = ['a1'];
      }
      final old = _Client(oldHost);
      final next = _Client(nextHost);
      final opening = Completer<DshClient>();
      var opens = 0;
      LocalClientConnector selectedConnector = ({required baseUri, required token}) async {
        opens++;
        return old;
      };
      final picks = <String>[];
      usePhoneSurface(tester);
      // Reuse only the themed MaterialApp. goldenApp's own ProviderScope
      // substitutes FakeConnection and must not be mounted in this test.
      final themed = goldenApp(
        brightness: Brightness.light,
        home: _ArchiveLauncher(onPicked: picks.add),
      ) as ProviderScope;
      try {
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              onboardingPrefsProvider.overrideWith(FakeOnboardingPrefs.new),
              accountWalletBalanceProvider.overrideWithValue(null),
              drawerClockProvider.overrideWithValue(() => sampleNow),
              activeHostProvider.overrideWith(_LocalHost.new),
              localRuntimeProvider.overrideWith(_Runtime.new),
              settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
              workspacePrefsProvider.overrideWith(() => FixedWorkspacePrefs(const WorkspacePrefs(loaded: true))),
              currentSessionProvider.overrideWith(() => FakeCurrentSession(null)),
              networkKicksProvider.overrideWithValue(const Stream.empty()),
              guestFsProvider.overrideWith((ref) async => null),
              localClientConnectorProvider.overrideWith((ref) {
                final connector = selectedConnector;
                return connector;
              }),
            ],
            child: themed.child,
          ),
        );

        await _frames(tester);
        final c = ProviderScope.containerOf(tester.element(find.byType(_ArchiveLauncher)));
        await tester.tap(find.text('打开归档'));
        await _frames(tester);
        expect(opens, 1);
        expect(c.read(localConnectionProvider).value?.client, same(old));
        expect(old.mux.generation, isNotNull);
        expect(c.read(sessionsProvider).value, isEmpty);
        expect(find.byType(SearchResultTile), findsOneWidget);

        selectedConnector = ({required baseUri, required token}) async {
          opens++;
          return opening.future;
        };
        c.invalidate(localClientConnectorProvider);
        (c.read(localRuntimeProvider.notifier) as _Runtime).reconnect();
        await _frames(tester);
        expect(c.read(localClientConnectorProvider), same(selectedConnector));
        expect(opens, 2);
        expect(oldHost.closed, isTrue);
        expect(old.mux.state, DshConnectionState.closed);
        expect(old.mux.generation, isNull);
        final raw = c.read(localConnectionProvider);
        expect(raw.isLoading, isTrue);
        expect(raw.value?.client, same(old));
        expect(c.read(activeConnectionProvider), same(raw));
        expect(find.byType(SearchResultTile), findsOneWidget);
        expect(oldHost.unarchiveAttempts, isEmpty);

        if (restoreAfterReady) {
          opening.complete(next);
          await _frames(tester);
          expect(c.read(activeConnectionProvider).isLoading, isFalse);
          expect(c.read(activeConnectionProvider).value?.client, same(next));
          expect(next.mux.generation, isNotNull);
          expect(nextHost.unarchiveAttempts, isEmpty);
        }
        // The user opens the sheet only after the initial connection transition.
        await tester.tap(find.byType(SearchResultTile));
        await _frames(tester);
        expect(find.text('恢复并打开'), findsOneWidget);
        if (!restoreAfterReady) {
          expect(c.read(activeConnectionProvider).isLoading, isTrue);
          expect(c.read(activeConnectionProvider).value?.client, same(old));
          expect(opening.isCompleted, isFalse);
        }
        await tester.tap(find.text('恢复并打开'));
        await _frames(tester);
        // Actual fake-service processing is separate from reaching the old API.
        expect(oldHost.argsOf('workspace/unarchiveSession'), isEmpty);
        expect(oldHost.archived, ['a1']);
        expect(oldHost.unarchiveAttempts, isEmpty);
        if (restoreAfterReady) {
          expect(nextHost.unarchiveAttempts, hasLength(1));
          expect(nextHost.argsOf('workspace/unarchiveSession'), hasLength(1));
          expect(nextHost.archived, isEmpty);
          expect(picks, ['a1']);
          expect(c.read(currentSessionProvider), 'a1');
          expect(find.byType(SessionSearchPage), findsNothing);
        } else {
          expect(nextHost.unarchiveAttempts, isEmpty);
          expect(picks, isEmpty);
          expect(c.read(currentSessionProvider), isNull);
          expect(find.byType(SessionSearchPage), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
      } finally {
        // Run inside testWidgets, while pump can still drain this test's
        // FakeAsync queue. Do not wait for a predicted controller signal.
        await tester.pumpWidget(const SizedBox.shrink());
        if (!opening.isCompleted) opening.complete(next);
        var closed = false;
        final closing = Future.wait([old.close(), next.close()]).then((_) {
          closed = true;
        });
        await tester.pump(Duration.zero);
        expect(closed, isTrue, reason: 'owned mux and carrier close futures must settle during cleanup');
        await closing;
        await tester.pump(Duration.zero);
      }
    });
  }
}
