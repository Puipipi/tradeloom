// What DSH Go sends and pulls over DSH Remote, flow by flow: the real home
// shell and chat screen on a relay Host, with a metered fake tunnel under
// the client (fake_host.dart) and fake time. Each test prints its traffic
// (`TRAFFIC <flow>`) and pins what must not come back:
//
// * `session/list` has no paging and carries every conversation with its
//   projections, so `$events` edges the list already explains are applied
//   in place (sessions_state.dart): a turn reads it once, at its end; a
//   subagent's edges and a re-announced conversation not at all;
// * every streamed token is a Relay frame of its own, so a running
//   conversation out of sight for a while follows without them
//   (chat_state.dart) and takes them up again on return.
import 'dart:async';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/chat_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/ui/shell/home_shell.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../shell/golden_harness.dart';
import 'fake_host.dart';
import 'traffic_meter.dart';

class _App {
  _App(this.tester, this.host, this.backend, this.kicks);

  final WidgetTester tester;
  final FakeHost host;
  final TrafficRelayBackend backend;
  final StreamController<void> kicks;

  TrafficMeter get meter => host.meter;

  /// Lets [duration] of fake time pass in [step]s.
  Future<void> wait(Duration duration, {Duration step = const Duration(milliseconds: 500)}) async {
    var left = duration;
    while (left > Duration.zero) {
      final next = left < step ? left : step;
      await tester.pump(next);
      left -= next;
    }
  }

  void report(String flow) => debugPrint('TRAFFIC $flow\n${meter.table(top: 14)}');

  void lifecycle(List<AppLifecycleState> states) {
    for (final s in states) {
      tester.binding.handleAppLifecycleStateChanged(s);
    }
  }

  Future<void> close() async {
    await tester.pumpWidget(const SizedBox());
    for (final c in backend.clients) {
      await c.close();
    }
    await kicks.close();
    await tester.pump(const Duration(minutes: 2));
  }
}

/// The app opened on the relay Host, its session list in the drawer and the
/// long conversation `S0` on screen (restored as the last one).
Future<_App> _open(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({
    'active_host': const HostRef.relay('mac', name: '家里的 Mac').encode(),
    'last_session_id': 'S0',
  });
  usePhoneSurface(tester);
  final host = FakeHost();
  final backend = TrafficRelayBackend(host);
  final kicks = StreamController<void>.broadcast();
  await tester.pumpWidget(
    goldenApp(
      brightness: Brightness.light,
      home: const HomeShell(),
      overrides: [
        localRuntimeProvider.overrideWith(
          () => FakeRuntime(const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.notInstalled))),
        ),
        relayBackendProvider.overrideWithValue(backend),
        networkKicksProvider.overrideWithValue(kicks.stream),
      ],
    ),
  );
  final app = _App(tester, host, backend, kicks);
  await app.wait(const Duration(seconds: 3), step: const Duration(milliseconds: 100));
  return app;
}

ChatState _chat(WidgetTester tester, String id) =>
    ProviderScope.containerOf(tester.element(find.byType(HomeShell))).read(chatProvider(id));

void main() {
  testWidgets('open: the host, the session list and a long conversation', (tester) async {
    final app = await _open(tester);
    app.report('open host + session list + long chat');
    expect(app.meter.count('item session/follow:snapshot'), 1);
    expect(app.meter.count(r'open $events'), 1);
    expect(_chat(tester, 'S0').items, isNotEmpty);
    await app.close();
  });

  testWidgets('idle ten minutes: the tunnel health probe and nothing else', (tester) async {
    final app = await _open(tester);
    app.meter.reset();
    await app.wait(const Duration(minutes: 10), step: const Duration(seconds: 5));
    app.report('idle 10 min');
    expect(app.meter.messages, lessThanOrEqualTo(48));
    expect(app.meter.rows.keys, everyElement('probe harness.transport.describe'));
    await app.close();
  });

  testWidgets('a streamed reply with tool calls reads the session list once, at its end', (tester) async {
    final app = await _open(tester);
    app.meter.reset();
    await app.host.runTurn('S0', () => app.wait(const Duration(seconds: 1)));
    await app.wait(const Duration(seconds: 3));
    app.report('send + streamed reply with tool calls');
    expect(app.meter.count('call session/list'), 1);
    expect(app.meter.count('item session/follow:assistant-stream'), greaterThan(3 * 800));
    final chat = _chat(tester, 'S0');
    expect(chat.running, isFalse);
    expect(chat.turns, isNotEmpty);
    await app.close();
  });

  testWidgets('subagent turns and re-announced conversations read no session list', (tester) async {
    final app = await _open(tester);
    app.meter.reset();
    for (var i = 0; i < 5; i++) {
      app.host.emit('api-session/status', ['A$i', true]);
      await app.wait(const Duration(seconds: 2));
      app.host.emit('api-session/status', ['A$i', false]);
      await app.wait(const Duration(seconds: 2));
    }
    for (var i = 1; i < 4; i++) {
      // DSH re-announces a conversation whenever its agent comes or goes.
      app.host.emit('api-session/added', [app.host.sessions['S$i']!.summary()]);
      await app.wait(const Duration(seconds: 2));
    }
    // A listed conversation starting a turn: the row says running at once.
    app.host.sessions['S2']!.running = true;
    app.host.emit('api-session/status', ['S2', true]);
    await app.wait(const Duration(seconds: 2));
    app.report('5 subagent turns + 3 re-announced + 1 turn start');
    expect(app.meter.count('call session/list'), 0);
    final container = ProviderScope.containerOf(tester.element(find.byType(HomeShell)));
    final rows = await container.read(sessionsProvider.future);
    expect(rows.firstWhere((s) => s.sessionId == 'S2').running, isTrue);
    await app.close();
  });

  testWidgets('an edge landing while the list is read reads it once more instead', (tester) async {
    final app = await _open(tester);
    final container = ProviderScope.containerOf(tester.element(find.byType(HomeShell)));
    app.meter.reset();
    app.host.listsHeld = Completer<void>();
    app.host.emit('api-session/status', ['S1', false]);
    await app.wait(const Duration(seconds: 1));
    expect(app.host.calls.where((c) => c == 'session/list'), isNotEmpty);
    // Answered before S2 started; it arrives after.
    app.host.sessions['S2']!.running = true;
    app.host.emit('api-session/status', ['S2', true]);
    await app.wait(const Duration(seconds: 1));
    app.host.listsHeld!.complete();
    await app.wait(const Duration(seconds: 1));
    final rows = await container.read(sessionsProvider.future);
    expect(rows.firstWhere((s) => s.sessionId == 'S2').running, isTrue);
    expect(app.meter.count('call session/list'), 2);
    await app.close();
  });

  testWidgets('out of sight, a running conversation streams no tokens; back, it follows again once', (tester) async {
    final app = await _open(tester);
    app.meter.reset();
    app.lifecycle([AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]);
    await app.wait(const Duration(minutes: 1), step: const Duration(seconds: 5));
    final turn = app.host.runTurn('S0', () => app.wait(const Duration(seconds: 1)), steps: 6);
    await turn;
    await app.wait(const Duration(minutes: 1), step: const Duration(seconds: 5));
    app.report('background 2 min with a turn running');
    final background = app.meter.count('item session/follow:assistant-stream');
    final reopened = app.meter.count('open session/follow');
    app.meter.reset();
    app.lifecycle([AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]);
    await app.wait(const Duration(seconds: 3));
    app.report('back on screen');
    expect(background, 0);
    expect(reopened, 1);
    expect(app.meter.count('open session/follow'), 1);
    expect(app.meter.count('item session/follow:snapshot'), 1);
    final chat = _chat(tester, 'S0');
    expect(chat.syncing, isFalse);
    expect(chat.running, isFalse);
    await app.close();
  });

  testWidgets('a short trip away keeps the stream as it is', (tester) async {
    final app = await _open(tester);
    app.meter.reset();
    app.lifecycle([AppLifecycleState.inactive, AppLifecycleState.hidden]);
    await app.host.runTurn('S0', () => app.wait(const Duration(seconds: 1)));
    app.lifecycle([AppLifecycleState.inactive, AppLifecycleState.resumed]);
    await app.wait(const Duration(minutes: 1), step: const Duration(seconds: 5));
    app.report('background 10 s during a turn');
    expect(app.meter.count('open session/follow'), 0);
    await app.close();
  });

  testWidgets('a dropped connection reconnects and re-subscribes each stream once', (tester) async {
    final app = await _open(tester);
    app.meter.reset();
    app.host.drop();
    await app.wait(const Duration(seconds: 15));
    app.report('drop + reconnect');
    expect(app.host.connects, 2);
    expect(app.meter.count(r'open $events'), 1);
    expect(app.meter.count('open session/follow'), 1);
    expect(app.meter.count('open session/control'), lessThanOrEqualTo(1));
    expect(_chat(tester, 'S0').syncing, isFalse);
    await app.close();
  });

  testWidgets('the Host offline ten minutes: backoff, not a storm; back, one reconnect', (tester) async {
    final app = await _open(tester);
    app.meter.reset();
    app.host.online = false;
    app.host.drop();
    await app.wait(const Duration(minutes: 10), step: const Duration(seconds: 2));
    app.report('host offline 10 min');
    final attempts = app.meter.count('rest api.device');
    expect(attempts, lessThanOrEqualTo(30));
    expect(app.meter.messages, 0);
    app.meter.reset();
    app.host.online = true;
    app.kicks.add(null); // the person comes back to the app
    await app.wait(const Duration(seconds: 15));
    app.report('host back online');
    expect(app.meter.count(r'open $events'), 1);
    await app.close();
  });
}
