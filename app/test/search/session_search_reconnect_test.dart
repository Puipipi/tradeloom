import 'dart:async';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/share_code/guest_fs.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/session_search.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../remote/support/ready_mux.dart';

class _Runtime extends LocalRuntimeController {
  @override
  LocalRuntimeState build() => _running('first');

  LocalRuntimeState _running(String token) => LocalRuntimeState(
    loaded: true,
    status: RuntimeStatus.fromMap({'phase': 'running', 'baseUrl': 'http://127.0.0.1:9', 'token': token}),
  );

  void reconnect() => state = _running('second');
}

class _Settings extends SettingsController {
  @override
  AppSettings build() => const AppSettings(loaded: true);
}

class _Host extends ActiveHostController {
  @override
  HostRef build() => HostRef.local;
}

class _Mux extends ReadyMux {
  _Mux(this.gate);
  final Completer<MuxGeneration>? gate;
  @override
  Future<MuxGeneration> ready({Duration? timeout}) => gate?.future ?? super.ready(timeout: timeout);
}

class _Client extends DshClient {
  _Client({Completer<MuxGeneration>? readyGate})
    : _ready = _Mux(readyGate),
      super(DshConnection(Uri.parse('http://127.0.0.1:9')));
  final _Mux _ready;
  @override
  DshMux get mux => _ready;
  final queries = <String>[];
  final response = Completer<({List<ContentHit> items, bool hasMore})>();
  bool closed = false;

  @override
  Future<({List<ContentHit> items, bool hasMore})> searchSessionsPage(String query) {
    queries.add(query);
    if (closed) return Future.error(const DshTransportException('closed client'));
    return response.future;
  }

  @override
  Future<void> close() async {
    closed = true;
    await super.close();
  }
}

const _remoteHost = HostRef.relay('metadata-fixture');

class _RemoteHost extends ActiveHostController {
  @override
  HostRef build() => _remoteHost;
}

class _Link extends HostLink {
  _Link(this.currentClient, {this.openGate});
  final Completer<DshClient>? openGate;
  @override
  final _Client currentClient;
  @override
  HostLinkStatus get status => const HostLinkStatus(HostLinkPhase.connected);
  @override
  Stream<HostLinkStatus> get statuses => const Stream.empty();
  @override
  Stream<DshClient> get clients => const Stream.empty();
  @override
  Future<DshClient> open() async => openGate == null ? currentClient : await openGate!.future;

  @override
  void kick() {}
  @override
  void retry() {}
  @override
  Future<void> close() => currentClient.close();
}

class _RetryLink extends HostLink {
  final firstOpen = Completer<DshClient>();
  final retryOpen = Completer<DshClient>();
  int opens = 0;
  DshClient? _client;

  @override
  DshClient? get currentClient => _client;
  @override
  HostLinkStatus get status => const HostLinkStatus(HostLinkPhase.connecting);
  @override
  Stream<HostLinkStatus> get statuses => const Stream.empty();
  @override
  Stream<DshClient> get clients => const Stream.empty();
  @override
  Future<DshClient> open() async {
    final gate = ++opens == 1 ? firstOpen : retryOpen;
    return _client = await gate.future;
  }

  @override
  void kick() {}
  @override
  void retry() {}
  @override
  Future<void> close() async => await _client?.close();
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });

  for (final transition in ['token', 'refresh', 'error']) {
    for (final inFlight in [false, true]) {
      testWidgets('$transition retires ${inFlight ? 'in-flight' : 'debounced'} search', (tester) async {
        final old = _Client();
        final next = _Client();
        final connector = Completer<DshClient>();
        var attempts = 0;
        final c = ProviderContainer(
          retry: (_, _) => null,
          overrides: [
            activeHostProvider.overrideWith(_Host.new),
            settingsProvider.overrideWith(_Settings.new),
            localRuntimeProvider.overrideWith(_Runtime.new),
            networkKicksProvider.overrideWithValue(const Stream.empty()),
            guestFsProvider.overrideWith((ref) async => null),
            localClientConnectorProvider.overrideWithValue(
              ({required baseUri, required token}) async => ++attempts == 1 ? old : await connector.future,
            ),
          ],
        );
        addTearDown(() async {
          if (!connector.isCompleted) connector.complete(next);
          for (final client in [old, next]) {
            if (!client.response.isCompleted) client.response.complete((items: <ContentHit>[], hasMore: false));
          }
          c.dispose();
          await old.close();
          await next.close();
        });
        c.listen(sessionSearchProvider, (_, _) {});
        await tester.pump(Duration.zero);
        expect(c.read(activeConnectionProvider).value?.client, same(old));
        c.read(sessionSearchProvider.notifier).setInput(const TextEditingValue(text: 'first query'));
        if (inFlight) await tester.pump(SessionSearchController.debounce);
        expect(old.queries, inFlight ? ['first query'] : isEmpty);

        if (transition == 'refresh') {
          c.invalidate(localConnectionProvider);
        } else {
          (c.read(localRuntimeProvider.notifier) as _Runtime).reconnect();
        }
        await tester.pump(Duration.zero);
        expect(attempts, 2);
        expect(old.closed, isTrue);
        expect(c.read(localConnectionProvider).isLoading, isTrue);
        // Riverpod retains this value; consumers must not treat it as a current client.
        expect(c.read(localConnectionProvider).value?.client, same(old));
        expect(c.read(sessionContentSearchProvider), isNull);
        expect(c.read(activeConnectionProvider), same(c.read(localConnectionProvider)));
        expect(c.read(sessionSearchProvider).content, ContentSearchStatus.idle);

        old.response.complete((items: [(sessionId: 'old', snippet: 'late')], hasMore: true));
        await tester.pump(Duration.zero);
        expect(c.read(sessionSearchProvider).hits, isEmpty);
        c.read(sessionSearchProvider.notifier).setInput(const TextEditingValue(text: 'current query'));
        await tester.pump(SessionSearchController.debounce);
        expect(old.queries, inFlight ? ['first query'] : isEmpty);
        expect(next.queries, isEmpty);

        if (transition == 'error') {
          connector.completeError(const DshTransportException('reconnect failed'));
          await tester.pump(Duration.zero);
          expect(c.read(localConnectionProvider).hasError, isTrue);
          expect(c.read(localConnectionProvider).value?.client, same(old));
          expect(c.read(activeConnectionProvider).hasError, isTrue);
          expect(c.read(activeConnectionProvider), same(c.read(localConnectionProvider)));
          expect(c.read(sessionContentSearchProvider), isNull);
          expect(c.read(sessionSearchProvider).hits, isEmpty);
          return;
        }
        connector.complete(next);
        await tester.pump(Duration.zero);
        await tester.pump(SessionSearchController.debounce);
        expect(next.queries, ['current query']);
        next.response.complete((items: [(sessionId: 'current', snippet: 'current query')], hasMore: false));
        await tester.pump(Duration.zero);
        expect(c.read(sessionSearchProvider).hits.single.sessionId, 'current');
        expect(c.read(sessionSearchProvider).content, ContentSearchStatus.ready);
      });
    }
  }

  testWidgets('HTTP search remains available before this client mux is ready', (tester) async {
    final ready = Completer<MuxGeneration>();
    final client = _Client(readyGate: ready);
    final c = ProviderContainer(
      overrides: [
        activeHostProvider.overrideWith(_Host.new),
        settingsProvider.overrideWith(_Settings.new),
        localRuntimeProvider.overrideWith(_Runtime.new),
        networkKicksProvider.overrideWithValue(const Stream.empty()),
        guestFsProvider.overrideWith((ref) async => null),
        localClientConnectorProvider.overrideWithValue(({required baseUri, required token}) async => client),
      ],
    );
    addTearDown(() async {
      if (!ready.isCompleted) ready.complete(const MuxGeneration(1, 'fixture', '/tmp'));
      if (!client.response.isCompleted) client.response.complete((items: <ContentHit>[], hasMore: false));
      c.dispose();
      await client.close();
    });
    c.listen(sessionSearchProvider, (_, _) {});
    await tester.pump(Duration.zero);
    expect(ready.isCompleted, isFalse);
    expect(c.read(activeConnectionProvider).value?.client, same(client));
    c.read(sessionSearchProvider.notifier).setInput(const TextEditingValue(text: 'http ready'));
    await tester.pump(SessionSearchController.debounce);
    expect(client.queries, ['http ready']);
    client.response.complete((items: [(sessionId: 'http', snippet: 'http ready')], hasMore: false));
    await tester.pump(Duration.zero);
    expect(c.read(sessionSearchProvider).hits.single.sessionId, 'http');
    ready.complete(const MuxGeneration(1, 'fixture', '/tmp'));
    await tester.pump(Duration.zero);
    expect(client.queries, ['http ready']);
  });

  testWidgets('remote name update preserves the pending same-client search', (tester) async {
    final client = _Client();
    final link = _Link(client);
    overrides(String name) => [
      activeHostProvider.overrideWith(_RemoteHost.new),
      hostLinkProvider(_remoteHost).overrideWithValue(link),
      hostNameProvider(_remoteHost).overrideWithValue(name),
    ];
    final c = ProviderContainer(overrides: overrides('first'));
    addTearDown(() async {
      if (!client.response.isCompleted) client.response.complete((items: <ContentHit>[], hasMore: false));
      c.dispose();
      await client.close();
    });
    c.listen(sessionSearchProvider, (_, _) {});
    await tester.pump(Duration.zero);
    final backend = c.read(sessionContentSearchProvider);
    c.read(sessionSearchProvider.notifier).setInput(const TextEditingValue(text: 'same client'));
    await tester.pump(SessionSearchController.debounce);
    c.updateOverrides(overrides('renamed'));
    // Read immediately, including any async rebuild caused solely by the name.
    expect(c.read(sessionContentSearchProvider), same(backend));
    await tester.pump(SessionSearchController.debounce);
    expect(c.read(activeConnectionProvider).value?.name, 'renamed');
    expect(c.read(sessionContentSearchProvider), same(backend));
    expect(client.queries, ['same client']);
    client.response.complete((items: [(sessionId: 'same', snippet: 'same client')], hasMore: false));
    await tester.pump(Duration.zero);
    expect(c.read(sessionSearchProvider).hits.single.sessionId, 'same');
  });
  testWidgets('remote name update while opening appears on the eventual connection', (tester) async {
    final client = _Client();
    final opening = Completer<DshClient>();
    final link = _Link(client, openGate: opening);
    overrides(String name) => [
      activeHostProvider.overrideWith(_RemoteHost.new),
      hostLinkProvider(_remoteHost).overrideWithValue(link),
      hostNameProvider(_remoteHost).overrideWithValue(name),
    ];
    final c = ProviderContainer(overrides: overrides('first'));
    addTearDown(() async {
      if (!opening.isCompleted) opening.complete(client);
      c.dispose();
      await client.close();
    });
    c.listen(activeConnectionProvider, (_, _) {});
    await tester.pump(Duration.zero);
    expect(c.read(activeConnectionProvider).isLoading, isTrue);
    expect(c.read(activeConnectionProvider).value, isNull);
    c.updateOverrides(overrides('renamed while opening'));
    await tester.pump(Duration.zero);
    expect(c.read(activeConnectionProvider).isLoading, isTrue);
    expect(c.read(activeConnectionProvider).value, isNull);
    opening.complete(client);
    await tester.pump(Duration.zero);
    expect(c.read(activeConnectionProvider).value?.client, same(client));
    expect(c.read(activeConnectionProvider).value?.name, 'renamed while opening');
  });
  for (final withPrevious in [false, true]) {
    testWidgets('remote retry preserves raw error ${withPrevious ? 'with previous client' : 'on first open'}', (
      tester,
    ) async {
      final old = _Client();
      final next = _Client();
      final retryLink = _RetryLink();
      final initialLink = _Link(old);
      const error = HostLinkError(HostLinkErrorKind.authFailed, 'retry fixture');
      final errorStack = StackTrace.current;
      HostLink selectedLink = withPrevious ? initialLink : retryLink;
      final overrides = [
        activeHostProvider.overrideWith(_RemoteHost.new),
        hostNameProvider(_remoteHost).overrideWithValue('retry fixture'),
        hostLinkProvider(_remoteHost).overrideWith((ref) {
          final link = selectedLink;
          ref.onDispose(() => unawaited(link.close()));
          return link;
        }),
      ];
      // Keep Riverpod's normal automatic retry enabled.
      final c = ProviderContainer(overrides: overrides);
      addTearDown(() async {
        c.dispose();
        if (!retryLink.firstOpen.isCompleted) retryLink.firstOpen.complete(next);
        if (!retryLink.retryOpen.isCompleted) retryLink.retryOpen.complete(next);
        for (final client in [old, next]) {
          if (!client.response.isCompleted) client.response.complete((items: <ContentHit>[], hasMore: false));
          await client.close();
        }
      });
      c.listen(sessionSearchProvider, (_, _) {});
      await tester.pump(Duration.zero);
      if (withPrevious) {
        expect(c.read(remoteConnectionProvider(_remoteHost)).value?.client, same(old));
        selectedLink = retryLink;
        c.invalidate(hostLinkProvider(_remoteHost));
        await tester.pump(Duration.zero);
        expect(old.closed, isTrue);
        expect(c.read(remoteConnectionProvider(_remoteHost)).isLoading, isTrue);
        expect(c.read(remoteConnectionProvider(_remoteHost)).value?.client, same(old));
      }
      expect(c.read(hostLinkProvider(_remoteHost)), same(retryLink));
      expect(retryLink.opens, 1);
      retryLink.firstOpen.completeError(error, errorStack);
      await tester.pump(Duration.zero);
      final raw = c.read(remoteConnectionProvider(_remoteHost));
      expect(raw.isLoading, isTrue);
      expect(raw.hasError, isTrue);
      expect(raw.retrying, isTrue);
      expect(raw.error, same(error));
      expect(raw.stackTrace, same(errorStack));
      expect(raw.value?.client, withPrevious ? same(old) : isNull);
      final active = c.read(activeConnectionProvider);
      expect(active, same(raw));
      expect(active.isLoading, isTrue);
      expect(active.hasError, isTrue);
      expect(active.retrying, isTrue);
      expect(active.stackTrace, same(errorStack));
      expect(active.progress, raw.progress);
      expect(c.read(sessionContentSearchProvider), isNull);
      c.read(sessionSearchProvider.notifier).setInput(const TextEditingValue(text: 'retry query'));
      await tester.pump(ProviderContainer.defaultRetry(0, error)!);
      expect(retryLink.opens, 2);
      await tester.pump(SessionSearchController.debounce);
      expect(c.read(sessionContentSearchProvider), isNull);
      expect(old.queries, isEmpty);
      expect(next.queries, isEmpty);
      retryLink.retryOpen.complete(next);
      await tester.pump(Duration.zero);
      await tester.pump(SessionSearchController.debounce);
      expect(c.read(activeConnectionProvider), same(c.read(remoteConnectionProvider(_remoteHost))));
      expect(c.read(activeConnectionProvider).value?.client, same(next));
      expect(next.queries, ['retry query']);
      next.response.complete((items: [(sessionId: 'retry', snippet: 'retry query')], hasMore: false));
      await tester.pump(Duration.zero);
      expect(c.read(sessionSearchProvider).hits.single.sessionId, 'retry');
      expect(old.queries, isEmpty);
    });
  }
}
