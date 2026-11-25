import 'dart:async';

import 'package:dsh_app/l10n/l10n.dart';
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
import 'package:dsh_app/ui/shell/page_frame.dart' show GlassIconButton;
import 'package:dsh_app/ui/theme/motion.dart' show AppMotion;
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/foundation.dart' show FlutterError, FlutterErrorDetails, debugPrintSynchronously;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
    debugPrintSynchronously('[WATCH_CONTROL_CLEANUP] failed=$label');
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
    debugPrintSynchronously('[WATCH_CONTROL_CLEANUP] start=$label');
    settled.add(future.then<void>((_) {
      completed.add(label);
      debugPrintSynchronously('[WATCH_CONTROL_CLEANUP] done=$label');
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

// Keep route completions in the fake-async test body. They are not real-I/O
// Futures to await from runAsync or from a later package:test tearDown.
class _RouteCompletion {
  _RouteCompletion(this.label, this.original, _Failures failures) {
    observed = original.then<void>((_) {
      settled = true;
      succeeded = true;
    }, onError: (Object error, StackTrace stack) {
      settled = true;
      failures.resource(label, error, stack);
    });
  }

  final String label;
  final Future<Object?> original;
  late final Future<void> observed;
  bool settled = false;
  bool succeeded = false;
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

void _readScope((String, Map<String, Object?>) call) {
  expect(call.$1, 'workspaceFiles/read');
  expect(call.$2, {
    'workspaceFileScopeId': _session,
    'path': _path,
    'range': {'offset': 1, 'limit': 500},
  });
}

// Keep the public HostLink, providers and page intact. Only the carrier and
// platform clipboard are controllable boundaries in these four controls.
class _Scenario {
  _Scenario(this.tester) {
    resources = _Resources(failures);
    a = _Client(_Carrier('A'), resources);
    link = _PublishingLink(a, resources);
    // Synchronous fallback only. An unresolved fake-zone Future must fail a
    // gate, not keep the package:test teardown waiting without another pump.
    addTearDown(() {
      for (final transition in copyTransitions) {
        expect(transition.settled, isTrue, reason: transition.label);
      }
    });
  }

  final WidgetTester tester;
  final failures = _Failures();
  final copyTransitions = <_RouteCompletion>[];
  late final _Resources resources;
  late final _Client a;
  late final _PublishingLink link;
  _Client? b;
  ProviderContainer? container;
  ProviderSubscription<AsyncValue<HostConnection?>>? active;
  Element? page;
  bool mounted = false;

  ProviderContainer get c => container!;

  Future<void> prepare() async {
    usePhoneView(tester);
    container = ProviderContainer(overrides: [
      secretStoreProvider.overrideWithValue(MemorySecretStore()),
      accountWalletBalanceProvider.overrideWithValue(null),
      hostLinkProvider(_host).overrideWithValue(link),
    ]);
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
    expectCurrent(a);
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
    page = tester.element(find.byType(ArtifactPreviewPage));
    _watchScope(a.wire.links.single);
    expect(a.wire.calls, hasLength(1));
    _readScope(a.wire.calls.single);
    expect(find.textContaining('initial preview content', findRichText: true), findsWidgets);
  }

  Future<_Client> prepareB() async {
    final next = _Client(_Carrier('B'), resources);
    b = next;
    await _ready(tester, next.mux.ready(), 'B mux ready');
    expect(next.mux.state, DshConnectionState.connected);
    expect(next.wire.calls, isEmpty);
    return next;
  }

  Future<void> publishB() async {
    final next = b!;
    // Preserve the accepted v3 dispatch boundary. This advances no fake time.
    final dispatched = await tester.runAsync(() async {
      link.replace(next);
      return true;
    });
    if (dispatched != true) fail('PREPARE: replacement dispatch did not return');
    await _pumps(tester);
    expect(a.firstClose, isNotNull);
    expectCurrent(next);
    expectSamePage();
  }

  void expectCurrent(_Client current) {
    expect(link.currentClient, same(current));
    expect(c.read(remoteConnectionProvider(_host)).requireValue!.client, same(current));
    expect(c.read(activeConnectionProvider).requireValue!.client, same(current));
    final source = c.read(workspaceSourceProvider(_session));
    expect(source, isA<ClientWorkspaceSource>());
    final clientSource = source as ClientWorkspaceSource;
    expect(clientSource.client, same(current));
    expect(clientSource.sessionId, _session);
    expect(c.read(activeHostProvider), _host);
    expect(c.read(currentSessionProvider), _session);
    expect(current.mux.state, DshConnectionState.connected);
  }

  void expectSamePage() {
    expect(tester.element(find.byType(ArtifactPreviewPage)), same(page));
    expect(page!.mounted, isTrue);
  }

  Finder action(String tooltip) => find.byWidgetPredicate(
    (widget) => widget is GlassIconButton && widget.tooltip == tooltip,
  );

  Finder get more => action(page!.l10n.viewArtifactMore);

  void expectActionsEnabled(bool enabled) {
    for (final tooltip in [page!.l10n.commonShare, page!.l10n.viewArtifactMore]) {
      final finder = action(tooltip);
      expect(finder, findsOneWidget);
      final button = tester.widget<GlassIconButton>(finder);
      expect(button.onPressed, enabled ? isNotNull : isNull, reason: tooltip);
    }
  }

  Future<void> copyThroughMenu(_ClipboardGate clipboard) async {
    expectActionsEnabled(true);
    final before = clipboard.requests.length;
    await tester.tap(more);
    await tester.pump(Duration.zero);
    // These are the real sheet's published animation tokens, all fake time.
    await tester.pump(AppMotion.sheetIn);
    await tester.pump(AppMotion.glassIn);
    final copy = find.text(page!.l10n.chatCopyPath);
    expect(copy, findsOneWidget);
    final route = ModalRoute.of(tester.element(copy));
    expect(route, isA<ModalBottomSheetRoute<Object?>>());
    final sheet = route!;
    final animation = sheet.animation!;
    debugPrintSynchronously('[WATCH_COPY_FRONT] before-scroll current=${sheet.isCurrent} '
        'status=${animation.status.name} value=${animation.value} requests=$before');
    expect(sheet.isCurrent, isTrue);
    expect(animation.status, AnimationStatus.completed);
    final exitDuration = sheet.reverseTransitionDuration;
    expect(exitDuration, AppMotion.sheetOut);
    // Capture the original public Future while the route is alive. Read only
    // our observation after tapping; Navigator may already have disposed it.
    final originalCompletion = sheet.completed;
    expect(copyTransitions.any((item) => identical(item.original, originalCompletion)), isFalse);
    final completion = _RouteCompletion(
      'copy transition ${copyTransitions.length + 1}', originalCompletion, failures,
    );
    copyTransitions.add(completion);
    await tester.ensureVisible(copy);
    // ensureVisible changes scroll position; render that new layout before
    // locating the next pointer target. Do not advance a timer to guess a hit.
    await tester.pump(Duration.zero);
    final hit = copy.hitTestable();
    expect(hit, findsOneWidget, reason: 'COPY FRONT: actual menu label must be hit-testable');
    await tester.tap(hit);
    await _pumps(tester);
    debugPrintSynchronously('[WATCH_COPY_FRONT] after-tap completed=${completion.succeeded} '
        'requests=${clipboard.requests.length} returned=${clipboard.returned}');
    expect(clipboard.requests, hasLength(before + 1),
        reason: 'COPY FRONT: the real menu action must reach the platform clipboard');
    // Flutter 3.47.7 _InterpolationSimulation.isDone uses t > duration.
    // At equality the value can be zero while status remains reverse. Keep
    // the product token, then cross that strict endpoint by the smallest
    // representable Duration, without polling or changing Clipboard's gate.
    await tester.pump(exitDuration);
    await _pumps(tester);
    debugPrintSynchronously('[WATCH_COPY_FRONT] at-exit-duration completed=${completion.succeeded} '
        'menu=${copy.evaluate().length}');
    await tester.pump(const Duration(microseconds: 1));
    await _pumps(tester);
    debugPrintSynchronously('[WATCH_COPY_FRONT] after-exit-endpoint completed=${completion.succeeded} '
        'menu=${copy.evaluate().length}');
    expect(completion.succeeded, isTrue,
        reason: 'COPY FRONT: the public transition completion must settle');
    expect(copy, findsNothing);
  }

  Future<void> dispose() async {
    try {
      if (mounted) await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(Duration.zero);
    } catch (error, stack) {
      failures.resource('unmount', error, stack);
    }
    // Navigator disposal completes its original route Futures. Observe and
    // join in this same fake-zone body after the unmount pump has flushed
    // their microtasks. A missing settlement is a reported cleanup failure;
    // never await a still-pending route Future outside the pumping body.
    for (final transition in copyTransitions) {
      try {
        debugPrintSynchronously('[WATCH_ROUTE_CLEANUP] ${transition.label} '
            'settled=${transition.settled} succeeded=${transition.succeeded}');
        expect(transition.settled, isTrue, reason: transition.label);
        await transition.observed;
      } catch (error, stack) {
        failures.resource(transition.label, error, stack);
      }
    }
    try {
      final cleaned = await tester.runAsync(() async {
        resources.release('active subscription', () => active?.close());
        resources.release('container', () => container?.dispose());
        resources.release('link close', () => unawaited(link.close()));
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
      debugPrintSynchronously('[WATCH_CONTROL_CLEANUP] complete originals=${resources.originals.length}');
    } catch (error, stack) {
      failures.resource('cleanup completion', error, stack);
    }
  }
}

class _ClipboardGate {
  final first = Completer<void>();
  final requests = <Object?>[];
  int returned = 0;

  Future<Object?> call(MethodCall call) async {
    if (call.method == 'Clipboard.setData') {
      requests.add(call.arguments);
      if (requests.length == 1) await first.future;
      returned++;
    }
    // Haptic feedback is not the operation under test.
    return null;
  }

  void release() {
    if (!first.isCompleted) first.complete();
  }
}

Future<void> _run(
  WidgetTester tester,
  Future<void> Function(_Scenario) body, {
  _ClipboardGate? clipboard,
}) async {
  final scenario = _Scenario(tester);
  if (clipboard != null) {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, clipboard.call);
  }
  try {
    await scenario.prepare();
    await body(scenario);
  } catch (error, stack) {
    scenario.failures.record(error, stack);
  } finally {
    // copyPath captures the real messenger before awaiting the clipboard.
    // Release it before unmount even on a failed assertion. This cleanup
    // release cannot replace a business gate or erase the primary failure.
    if (clipboard != null) {
      try {
        if (!clipboard.first.isCompleted) {
          debugPrintSynchronously('[WATCH_CONTROL_CLEANUP] clipboard release for cleanup');
          clipboard.release();
        }
        await _pumps(tester);
        expect(clipboard.returned, clipboard.requests.length);
      } catch (error, stack) {
        scenario.failures.resource('clipboard release', error, stack);
      }
    }
    await scenario.dispose();
    if (clipboard != null) {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null);
    }
  }
  scenario.failures.rethrowPrimary();
}

void main() {
  setUpAll(loadTestFonts);
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final replace in [false, true]) {
    testWidgets(
      replace
          ? 'preview preserves a pending refresh across a same Host client replacement at 399ms'
          : 'preview refreshes the same client exactly after its accepted 400ms debounce',
      (tester) => _run(tester, (scenario) async {
        final current = replace ? await scenario.prepareB() : scenario.a;
        scenario.a.wire.text = 'pending refresh from A';
        scenario.a.wire.version = 'v2';
        current.wire.text = replace ? 'pending refresh from B' : 'pending refresh from A';
        current.wire.version = 'v2';
        scenario.a.wire.links.single.changed('v2');
        await _pumps(tester);
        expect(scenario.a.wire.calls, hasLength(1));
        await tester.pump(const Duration(milliseconds: 399));
        await _pumps(tester);
        expect(scenario.a.wire.calls, hasLength(1));
        if (replace) {
          expect(current.wire.calls, isEmpty);
          await scenario.publishB();
          expect(current.wire.calls, isEmpty);
        }
        scenario.expectCurrent(current);
        scenario.expectSamePage();
        expect(find.textContaining('initial preview content', findRichText: true), findsWidgets);
        expect(find.textContaining('pending refresh from', findRichText: true), findsNothing);
        // Do not require B's watch here: unmodified DDD lacks it. No B change
        // or extra ready is sent; the already accepted A event must suffice.
        await tester.pump(const Duration(milliseconds: 1));
        await _pumps(tester);
        expect(current.wire.calls, hasLength(replace ? 1 : 2));
        if (replace) expect(scenario.a.wire.calls, hasLength(1));
        _readScope(current.wire.calls.last);
        expect(find.textContaining(current.wire.text, findRichText: true), findsWidgets);
        expect(find.textContaining('initial preview content', findRichText: true), findsNothing);
        scenario.expectSamePage();
      }),
      timeout: const Timeout(Duration(seconds: 30)),
    );

    testWidgets(
      replace
          ? 'preview completes its pending copy action after a same Host client replacement'
          : 'preview completes its pending copy action with the same client',
      (tester) async {
        final clipboard = _ClipboardGate();
        await _run(tester, (scenario) async {
          final current = replace ? await scenario.prepareB() : scenario.a;
          await scenario.copyThroughMenu(clipboard);
          expect(clipboard.requests, [{'text': _path}]);
          expect(clipboard.returned, 0);
          expect(clipboard.first.isCompleted, isFalse);
          scenario.expectActionsEnabled(false);
          if (replace) await scenario.publishB();
          scenario.expectCurrent(current);
          scenario.expectSamePage();
          scenario.expectActionsEnabled(false);
          expect(clipboard.returned, 0);
          expect(scenario.a.wire.calls, hasLength(1));
          if (replace) expect(current.wire.calls, isEmpty);

          clipboard.release();
          await _pumps(tester);
          expect(clipboard.returned, 1);
          scenario.expectActionsEnabled(true);
          scenario.expectSamePage();
          // A second real menu action proves the enabled callback is usable.
          await scenario.copyThroughMenu(clipboard);
          expect(clipboard.requests, [{'text': _path}, {'text': _path}]);
          expect(clipboard.returned, 2);
          scenario.expectActionsEnabled(true);
          scenario.expectSamePage();
          expect(scenario.a.wire.calls, hasLength(1));
          if (replace) expect(current.wire.calls, isEmpty);
        }, clipboard: clipboard);
      },
      timeout: const Timeout(Duration(seconds: 30)),
    );
  }
}
