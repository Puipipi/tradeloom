import 'dart:async';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/state/balance_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/state/workspace_state.dart';
import 'package:dsh_app/ui/chat/artifact_preview.dart';
import 'package:dsh_app/ui/common/side_insets.dart';
import 'package:dsh_app/ui/session/workspace_files.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/foundation.dart' show FlutterError, FlutterErrorDetails, debugPrintSynchronously;
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../chat/support/harness.dart' show loadTestFonts, testTheme, usePhoneView;

const _host = HostRef.ssh('preview-owner');
const _config = SshHostConfig(id: 'preview-owner', name: 'Preview host', host: '192.0.2.45', user: 'fixture');
const _session = 'preview-session';
const _path = '/work/notes.txt';
const _changes = 'workspaceFiles/changes';

class _Failures {
  _Failures() {
    addTearDown(() {
      final error = primary;
      if (error != null && !propagated) Error.throwWithStackTrace(error.$1, error.$2);
    });
  }
  (Object, StackTrace)? primary;
  bool propagated = false;
  int secondary = 0;

  void record(Object error, StackTrace stack) => primary ??= (error, stack);

  void resource(String label, Object error, StackTrace stack) {
    secondary++;
    debugPrintSynchronously('[PREVIEW_CLEANUP] failed=$label');
    try {
      addTearDown(() => Error.throwWithStackTrace(error, stack));
    } catch (registrationError, registrationStack) {
      FlutterError.reportError(FlutterErrorDetails(exception: error, stack: stack));
      FlutterError.reportError(FlutterErrorDetails(exception: registrationError, stack: registrationStack));
    }
  }

  void rethrowPrimary() {
    final error = primary;
    if (error == null) return;
    propagated = true;
    Error.throwWithStackTrace(error.$1, error.$2);
  }
}

class _Resources {
  _Resources(this.failures);
  final _Failures failures;
  final originals = <String, Future<void>>{};
  final settled = <Future<void>>[];
  final completed = <String>{};

  void observe(String label, Future<void> future) {
    if (originals.containsKey(label)) throw StateError('duplicate first resource: $label');
    originals[label] = future;
    debugPrintSynchronously('[PREVIEW_CLEANUP] start=$label');
    settled.add(future.then<void>((_) {
      completed.add(label);
      debugPrintSynchronously('[PREVIEW_CLEANUP] done=$label');
    }, onError: (Object error, StackTrace stack) {
      completed.add(label);
      failures.resource(label, error, stack);
    }));
  }

  void release(String label, void Function() action) {
    try {
      action();
    } catch (error, stack) {
      failures.resource(label, error, stack);
    }
  }

  Future<void> join() async {
    await Future.wait(List<Future<void>>.of(settled));
  }
}

class _Client extends DshClient {
  _Client(this.wire, this.resources) : super.withCarrier(wire);
  final _Carrier wire;
  final _Resources resources;
  Future<void>? firstClose;

  @override
  Future<void> close() {
    if (firstClose case final started?) return started;
    final future = super.close();
    firstClose = future;
    resources.observe('client-${wire.name}', future);
    return future;
  }
}

class _Carrier extends DshCarrier {
  _Carrier(this.name);
  final String name;
  String text = 'initial preview content';
  String version = 'v1';
  int closes = 0;
  final calls = <(String, Map<String, Object?>)>[];
  final links = <_Wire>[];

  @override
  String get kind => 'preview-memory';
  @override
  DshTracer? get tracer => null;

  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) async {
    calls.add((endpoint, Map.of(args)));
    if (endpoint != 'workspaceFiles/read') throw StateError('unexpected RPC: $endpoint');
    return RpcOk({
      'absolutePath': _path,
      'version': version,
      'bytes': text.length,
      'offset': 1,
      'text': text,
      'lines': 1,
      'eof': true,
    });
  }

  @override
  Future<DshMuxLink> openLink(MuxOptions options) async {
    final wire = _Wire();
    links.add(wire);
    return wire;
  }

  @override
  Future<void> close() async => closes++;
}

class _Wire implements DshMuxLink {
  late DshMuxFrameHandler frame;
  final opened = <(String, String, Map<String, Object?>)>[];
  final cancelled = <String>[];
  int closes = 0;

  @override
  void start({required DshMuxFrameHandler onFrame, required DshMuxLossHandler onLost}) => frame = onFrame;

  @override
  void open(String id, String endpoint, Map<String, Object?> payload) {
    opened.add((id, endpoint, Map.of(payload)));
    if (endpoint == r'$events') {
      scheduleMicrotask(() => item(id, {
        'type': 'ready',
        'clientId': 'preview-wire',
        'host': {'home': '/work'},
      }));
    } else if (endpoint == _changes) {
      scheduleMicrotask(() => item(id, {'kind': 'ready'}));
    } else {
      throw StateError('unexpected stream: $endpoint');
    }
  }

  List<(String, String, Map<String, Object?>)> get watches => opened.where((entry) => entry.$2 == _changes).toList();
  void item(String id, Object? value) => frame({'type': 'item', 'streamId': id, 'value': value});
  void changed(String version) => item(watches.single.$1, {
    'kind': 'change',
    'change': {'absolutePath': _path, 'version': version},
  });

  @override
  void cancel(String streamId) => cancelled.add(streamId);
  @override
  Future<void> close(int code, String reason) async => closes++;
  @override
  void sendItem(String streamId, Object? value) => throw StateError('unexpected uplink');
  @override
  void endUplink(String streamId) {}
}

// Public HostLink boundary only: the real connection/source/page consumers run.
class _PublishingLink extends HostLink {
  _PublishingLink(this.currentClient, this.resources) : owned = [currentClient];
  final _Resources resources;
  final List<_Client> owned;
  final replacements = StreamController<DshClient>.broadcast();
  final phases = StreamController<HostLinkStatus>.broadcast();
  Future<void>? firstClose;

  @override
  _Client currentClient;
  @override
  HostLinkStatus get status => const HostLinkStatus(HostLinkPhase.connected);
  @override
  Stream<DshClient> get clients => replacements.stream;
  @override
  Stream<HostLinkStatus> get statuses => phases.stream;
  @override
  Future<DshClient> open() async {
    await currentClient.mux.ready();
    return currentClient;
  }

  void replace(_Client next) {
    final old = currentClient;
    owned.add(next);
    currentClient = next;
    replacements.add(next);
    unawaited(old.close());
  }

  @override
  void kick() {}
  @override
  void retry() {}
  @override
  Future<void> close() {
    if (firstClose case final started?) return started;
    final future = _close();
    firstClose = future;
    resources.observe('host-link', future);
    return future;
  }

  Future<void> _close() async {
    // A already started at replacement; never call its close a second time.
    for (final client in owned) {
      if (client.firstClose == null) unawaited(client.close());
    }
    final clientsClosed = Future.wait([for (final client in owned) client.firstClose!]);
    final clientsStream = replacements.close();
    resources.observe('replacements', clientsStream);
    final statusesStream = phases.close();
    resources.observe('statuses', statusesStream);
    await Future.wait([clientsClosed, clientsStream, statusesStream]);
  }
}

Future<void> _pumps(WidgetTester tester) async {
  for (var i = 0; i < 20; i++) {
    await tester.pump(Duration.zero);
  }
}

Future<T> _ready<T>(WidgetTester tester, Future<T> future, String stage) async {
  var done = false;
  T? value;
  (Object, StackTrace)? failure;
  future.then<void>((result) { value = result; done = true; }, onError: (Object error, StackTrace stack) {
    failure = (error, stack);
    done = true;
  });
  for (var i = 0; i < 20 && !done; i++) {
    await tester.pump(Duration.zero);
  }
  if (!done) fail('PREPARE: $stage did not settle');
  if (failure case final error?) Error.throwWithStackTrace(error.$1, error.$2);
  return value as T;
}

void _watchScope(_Wire wire) {
  expect(wire.watches, hasLength(1));
  expect(wire.watches.single.$3, {'args': {'workspaceFileScopeId': _session, 'path': _path}});
}

void main() {
  setUpAll(loadTestFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final replace in [false, true]) {
    testWidgets(
      replace
          ? 'preview rebinds its workspace watch when the same Host publishes a replacement client'
          : 'preview keeps following changes across a new generation of the same client',
      (tester) async {
        final failures = _Failures();
        final resources = _Resources(failures);
        final a = _Client(_Carrier('A'), resources);
        final link = _PublishingLink(a, resources);
        _Client? b;
        ProviderContainer? container;
        ProviderSubscription<AsyncValue<HostConnection?>>? active;
        var mounted = false;
        try {
          usePhoneView(tester);
          final c = ProviderContainer(overrides: [
            secretStoreProvider.overrideWithValue(MemorySecretStore()),
            accountWalletBalanceProvider.overrideWithValue(null),
            hostLinkProvider(_host).overrideWithValue(link),
          ]);
          container = c;
          await _ready(tester, c.read(hostsProvider.notifier).ready, 'hosts');
          expect(await _ready(tester, c.read(hostsProvider.notifier).saveSsh(_config), 'save host'), isTrue);
          await _ready(tester, c.read(activeHostProvider.notifier).ready, 'active host');
          c.read(activeHostProvider.notifier).select(_host);
          c.read(currentSessionProvider.notifier).select(_session);
          active = c.listen(activeConnectionProvider, (_, _) {});
          await _ready(tester, a.mux.ready(), 'A mux ready');
          await _pumps(tester);
          expect(c.read(hostsProvider).loaded, isTrue);
          expect(c.read(hostsProvider).sshById(_config.id), _config);
          expect(c.read(activeHostProvider), _host);
          expect(c.read(currentSessionProvider), _session);
          expect(c.read(activeConnectionProvider).requireValue!.client, same(a));
          expect(c.read(remoteConnectionProvider(_host)).requireValue!.client, same(a));
          expect(a.mux.generation, isNotNull);
          mounted = true;
          await tester.pumpWidget(UncontrolledProviderScope(
            container: c,
            child: MaterialApp(
              theme: testTheme(Brightness.light),
              locale: const Locale('zh', 'CN'),
              supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
              localizationsDelegates: GlobalMaterialLocalizations.delegates,
              builder: (context, child) => MirroredSideInsets(child: child!),
              home: const FilePreviewPage(sessionId: _session, path: _path),
            ),
          ));
          await _pumps(tester);
          final page = tester.element(find.byType(ArtifactPreviewPage));
          _watchScope(a.wire.links.single);
          expect(a.wire.calls.single.$1, 'workspaceFiles/read');
          expect(a.wire.calls.single.$2['workspaceFileScopeId'], _session);
          expect(a.wire.calls.single.$2['path'], _path);
          expect(find.textContaining('initial preview content', findRichText: true), findsWidgets);
          final generation = a.mux.generation;
          _Client current;
          if (replace) {
            final next = _Client(_Carrier('B'), resources);
            b = next;
            await _ready(tester, next.mux.ready(), 'B mux ready');
            final dispatched = await tester.runAsync(() async {
              link.replace(next);
              return true;
            });
            if (dispatched != true) fail('PREPARE: replacement dispatch did not return');
            await _pumps(tester);
            expect(a.firstClose, isNotNull);
            expect(link.currentClient, same(next));
            expect(c.read(remoteConnectionProvider(_host)).requireValue!.client, same(next));
            expect(c.read(activeConnectionProvider).requireValue!.client, same(next));
            final source = c.read(workspaceSourceProvider(_session));
            expect(source, isA<ClientWorkspaceSource>());
            final clientSource = source as ClientWorkspaceSource;
            expect(clientSource.client, same(next));
            expect(clientSource.sessionId, _session);
            current = next;
          } else {
            a.mux.reconnect();
            await tester.pump(const Duration(milliseconds: 500));
            await _pumps(tester);
            expect(a.mux.generation, isNotNull);
            expect(a.mux.generation, isNot(same(generation)));
            expect(a.wire.links, hasLength(2));
            expect(c.read(activeConnectionProvider).requireValue!.client, same(a));
            current = a;
          }
          expect(c.read(activeHostProvider), _host);
          expect(c.read(currentSessionProvider), _session);
          expect(tester.element(find.byType(ArtifactPreviewPage)), same(page));
          expect(page.mounted, isTrue);
          expect(current.mux.state, DshConnectionState.connected);
          // First target semantic gate: do not await a nonexistent B watch.
          _watchScope(current.wire.links.last);
          current.wire.text = 'updated preview content';
          current.wire.version = 'v2';
          current.wire.links.last.changed('v2');
          await tester.pump(Duration.zero);
          await tester.pump(const Duration(milliseconds: 400));
          await _pumps(tester);
          expect(current.wire.calls.last.$1, 'workspaceFiles/read');
          expect(find.textContaining('updated preview content', findRichText: true), findsWidgets);
          expect(tester.element(find.byType(ArtifactPreviewPage)), same(page));
        } catch (error, stack) {
          failures.record(error, stack);
        } finally {
          try {
            if (mounted) await tester.pumpWidget(const SizedBox.shrink());
            await tester.pump(Duration.zero);
          } catch (error, stack) {
            failures.resource('unmount', error, stack);
          }
          try {
            final cleaned = await tester.runAsync(() async {
              resources.release('active subscription', () => active?.close());
              resources.release('container', () => container?.dispose());
              resources.release('link close', () => unawaited(link.close()));
              // A B-created prepare failure can precede publication to the Link.
              final other = b;
              if (other != null && other.firstClose == null) {
                resources.release('unpublished B', () => unawaited(other.close()));
              }
              await resources.join();
              return true;
            });
            if (cleaned != true) throw StateError('cleanup callback did not return');
            await tester.pump(Duration.zero);
            expect(resources.originals.length, (b == null ? 1 : 2) + 3);
            expect(resources.completed.length, resources.originals.length);
            expect(failures.secondary, 0);
            expect(a.wire.closes, 1);
            if (b case final next?) expect(next.wire.closes, 1);
            debugPrintSynchronously('[PREVIEW_CLEANUP] complete originals=${resources.originals.length}');
          } catch (error, stack) {
            failures.resource('cleanup completion', error, stack);
          }
        }
        failures.rethrowPrimary();
      },
      timeout: const Timeout(Duration(seconds: 30)),
    );
  }
}
