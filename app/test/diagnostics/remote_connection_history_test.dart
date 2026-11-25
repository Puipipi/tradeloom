import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/diagnostics/diagnostics_bundle.dart';
import 'package:dsh_app/diagnostics/diagnostics_channel.dart';
import 'package:dsh_app/diagnostics/diagnostics_markdown.dart';
import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/relay/dsh_remote_backend.dart';
import 'package:dsh_app/remote/ssh/ssh_link.dart';
import 'package:dsh_app/remote/ssh/ssh_transport.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/state/voice_settings.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:dsh_remote/dsh_remote.dart' as remote;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../remote/support/fake_ssh.dart';
import '../remote/support/wait.dart';
import 'support/zip_reader.dart';

const _ssh = HostRef.ssh('private-ssh-id');
const _relay = HostRef.relay('private-relay-id');
const _sshConfig = SshHostConfig(
  id: 'private-ssh-id',
  name: 'private-host-name',
  host: 'private-host.example',
  user: 'private-user',
  hostKeyType: 'ssh-ed25519',
  hostKeyFingerprint: 'SHA256:private-fingerprint',
);
const _unobserved = {'host': 'not_observed', 'state': 'not_observed'};
const _privateError = HostLinkError(
  HostLinkErrorKind.tunnelFailed,
  'private-host.example',
  detail: 'token=private-token SHA256:private-fingerprint private-user private-path',
  retryable: true,
);

class _Active extends ActiveHostController {
  _Active(this.initial);
  final HostRef initial;
  @override
  HostRef build() => initial;
  @override
  void select(HostRef host) => state = host;
}

class _Hosts extends HostsController {
  @override
  HostsState build() => HostsState(loaded: true, ssh: [_sshConfig]);
}

class _Runtime extends LocalRuntimeController {
  @override
  LocalRuntimeState build() => const LocalRuntimeState(loaded: true);
}

class _Local extends LocalConnectionController {
  @override
  Future<HostConnection?> build() async => null;
}

class _Settings extends SettingsController {
  @override
  AppSettings build() => const AppSettings(loaded: true);
}

class _Bridge extends RuntimeBridge {
  @override
  Stream<RuntimeEvent> get events => const Stream.empty();
  @override
  Future<List<String>> logs({int lines = 500}) async => const [];
}

class _Channel extends DiagnosticsChannel {
  @override
  Future<NativeDiagnostics> info() async => const NativeDiagnostics();
  @override
  Future<List<String>> engineLog({int maxBytes = 512 * 1024}) async => const [];
}

class _Phone extends PhoneChannel {
  @override
  Future<PhoneStatus> status() async => const PhoneStatus.notReady();
}

class _Voice extends VoiceSettingsController {
  @override
  VoiceMode build() => VoiceMode.auto;
  @override
  Future<VoiceMode> ready() async => VoiceMode.auto;
}

class _ManualLink implements HostLink {
  HostLinkStatus value = const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.connect);
  final opening = Completer<DshClient>();
  final changes = StreamController<HostLinkStatus>.broadcast(sync: true);
  var opens = 0;
  var kicks = 0;
  var retries = 0;
  var closed = false;

  @override
  HostLinkStatus get status => value;
  void emit(HostLinkStatus next) {
    value = next;
    changes.add(next);
  }

  void failOpening(HostLinkError error) => opening.completeError(error);
  @override
  Stream<HostLinkStatus> get statuses => changes.stream;
  @override
  DshClient? get currentClient => null;
  @override
  Stream<DshClient> get clients => const Stream.empty();
  @override
  Future<DshClient> open() {
    opens++;
    if (closed) return Future.error(StateError('closed synthetic link'));
    return opening.future;
  }

  @override
  void kick() => kicks++;
  @override
  void retry() => retries++;
  @override
  Future<void> close() async {
    if (closed) return;
    closed = true;
    await changes.close();
  }
}

class _Fixture {
  _Fixture(HostLink first, {HostRef host = _ssh, bool observe = true}) {
    links[host] = first;
    container = ProviderContainer(
      retry: (_, _) => null,
      overrides: [
        activeHostProvider.overrideWith(() => _Active(host)),
        hostsProvider.overrideWith(_Hosts.new),
        hostNameProvider.overrideWith((ref, host) => 'private-host-name'),
        hostLinkProvider.overrideWith((ref, host) {
          linkReads++;
          return links[host];
        }),
        localConnectionProvider.overrideWith(_Local.new),
        localRuntimeProvider.overrideWith(_Runtime.new),
        settingsProvider.overrideWith(_Settings.new),
        runtimeBridgeProvider.overrideWithValue(_Bridge()),
        diagnosticsChannelProvider.overrideWithValue(_Channel()),
        phoneChannelProvider.overrideWithValue(_Phone()),
        voiceSettingsProvider.overrideWith(_Voice.new),
      ],
    );
    if (observe) startObserving();
    addTearDown(() async {
      dispose();
      for (final link in links.values.toSet()) {
        await link.close();
      }
    });
  }

  final links = <HostRef, HostLink>{};
  late final ProviderContainer container;
  ProviderSubscription<AsyncValue<HostConnection?>>? subscription;
  var linkReads = 0;
  var disposed = false;

  void startObserving() => subscription = container.listen(activeConnectionProvider, (_, _) {});
  void stopObserving() {
    subscription?.close();
    subscription = null;
    container.invalidate(activeConnectionProvider);
  }

  void select(HostRef host) => (container.read(activeHostProvider.notifier) as _Active).select(host);
  void replace(HostRef host, HostLink link) {
    links[host] = link;
    container.invalidate(hostLinkProvider(host));
  }

  void dispose() {
    if (disposed) return;
    disposed = true;
    subscription?.close();
    container.dispose();
  }

  Map<String, Object?> get snapshot => container.read(connectionDiagnosticsProvider).snapshot;
  Future<DiagnosticsSnapshot> collect() =>
      container.read(Provider((ref) => collectDiagnostics(ref, DateTime.utc(2026, 11, 5))));
}

Map<String, Object?> _history(Map<String, Object?> snapshot) {
  expect(snapshot['history'], isA<Map>(), reason: 'observed remote stages must survive into diagnostics');
  return (snapshot['history']! as Map).cast<String, Object?>();
}

List<Map<String, Object?>> _events(Map<String, Object?> snapshot) =>
    (_history(snapshot)['events']! as List).cast<Map>().map((e) => e.cast<String, Object?>()).toList();

DiagnosticsSnapshot _report(Map<String, Object?> connection) => DiagnosticsSnapshot(
  at: DateTime.utc(2026, 11, 5),
  status: const RuntimeStatus(phase: RuntimePhase.notInstalled),
  settings: const AppSettings(),
  connection: connection,
);

Map<String, Object?> _zipConnection(DiagnosticsSnapshot report) {
  final entry = readZip(DiagnosticsBundle.build(report)).singleWhere((e) => e.name == 'summary.json');
  return (jsonDecode(utf8.decode(entry.data))['connection'] as Map).cast<String, Object?>();
}

class _OfflineCarrier extends DshCarrier {
  @override
  String get kind => 'diagnostics-test';
  @override
  DshTracer? get tracer => null;
  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) =>
      throw StateError('unexpected DSH RPC in passive diagnostic test');
  @override
  Future<DshMuxLink> openLink(MuxOptions options) async =>
      throw const DshTransportException('no network carrier in diagnostic test');
  @override
  Future<void> close() async {}
}

class _HeldProbe extends FakeTransport {
  _HeldProbe(super.remote);
  final entered = Completer<void>();
  final release = Completer<TunnelChannel>();
  @override
  Future<TunnelChannel> openTunnel(String host, int port) {
    if (!entered.isCompleted) entered.complete();
    return release.future;
  }
}

// Keep the real link and asynchronous startup; only its selected periodic
// timer is driven by events. No wall-clock wait or product test seam is used.
class _PeriodicTimer implements Timer {
  _PeriodicTimer(this.callback);
  final void Function(Timer) callback;
  var _active = true;
  var _tick = 0;

  void fire() {
    if (!_active) return;
    _tick++;
    callback(this);
  }

  @override
  void cancel() => _active = false;
  @override
  bool get isActive => _active;
  @override
  int get tick => _tick;
}

class _PeriodicEvents {
  final timers = <_PeriodicTimer>[];
  Future<void> run(Future<void> Function() body) => runZoned(
    body,
    zoneSpecification: ZoneSpecification(
      createPeriodicTimer: (self, parent, zone, period, callback) {
        if (period != const Duration(seconds: 15)) return parent.createPeriodicTimer(zone, period, callback);
        final timer = _PeriodicTimer((timer) => zone.runUnaryGuarded(callback, timer));
        timers.add(timer);
        return timer;
      },
    ),
  );
}

class _CountedPings extends FakeTransport {
  _CountedPings(super.remote);
  var pings = 0;
  @override
  Future<void> ping({Duration timeout = const Duration(seconds: 10)}) {
    pings++;
    if (!pingOk || isClosed) throw TimeoutException('synthetic ping failure');
    return Future.value();
  }
}

SshHostLink _sshLink(FakeTransport transport, {Duration keepAliveInterval = const Duration(days: 1)}) => SshHostLink(
  config: _sshConfig,
  loadSecrets: () async => const SshSecrets(password: 'synthetic-password'),
  transportFactory: (_, _) async => transport,
  connectClient: ({required baseUri, required token, required hostHeader}) async =>
      DshClient.withCarrier(_OfflineCarrier()),
  keepAliveInterval: keepAliveInterval,
  backoff: Backoff(maxAttempts: 0),
  retryFirstOpen: false,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('same-link loading to error preserves observed prior stages', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    link.emit(const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.verifyHostKey));
    link.emit(const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.startDsh));
    link.emit(const HostLinkStatus(HostLinkPhase.failed, step: HostLinkStep.startDsh, error: _privateError));
    link.failOpening(_privateError);
    await until(f.container, activeConnectionProvider, (v) => v.hasError, what: 'opening failed');
    final events = _events(f.snapshot);
    expect(events.map((e) => e['step']), ['connect', 'verifyHostKey', 'startDsh', 'startDsh']);
    expect(events.last['phase'], 'failed');
    expect(events.last['errorKind'], 'tunnelFailed');
    expect(events.last['retryable'], true);
    expect(events.map((e) => e['sequence']), [1, 2, 3, 4]);
    for (var i = 0; i < events.length; i++) {
      expect(events[i]['observedAtEpochMs'], isA<int>());
      expect(events[i]['elapsedMs'], isA<int>());
      expect(events[i]['elapsedMs'] as int, greaterThanOrEqualTo(i == 0 ? 0 : events[i - 1]['elapsedMs'] as int));
    }
    expect(link.opens, 1);
  });

  test('reconnecting keeps the failed step before a new connect attempt', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    link.emit(const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.tunnel));
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 1, error: _privateError));
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, step: HostLinkStep.connect, attempt: 1));
    final events = _events(f.snapshot);
    expect(events.map((e) => e['phase']), ['connecting', 'connecting', 'reconnecting', 'reconnecting']);
    expect(events[1]['step'], 'tunnel');
    expect(events[2]['errorKind'], 'tunnelFailed');
    expect(events.last['step'], 'connect');
  });

  test('identical notifications and RTT-only updates do not evict stages', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    for (var i = 0; i < 70; i++) {
      link.emit(
        HostLinkStatus(
          HostLinkPhase.connected,
          path: RelayPath.relay,
          network: RemoteNetworkStatus(
            path: RelayPath.relay,
            roundTripTime: Duration(milliseconds: i),
          ),
        ),
      );
    }
    expect(_events(f.snapshot), hasLength(2));
    expect(_history(f.snapshot)['dropped'], 0);
    expect((f.snapshot['link']! as Map)['roundTripTimeMs'], 69);
  });

  test('history evicts oldest events at 40 and records the actual dropped count', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    for (var attempt = 1; attempt <= 50; attempt++) {
      link.emit(HostLinkStatus(HostLinkPhase.reconnecting, attempt: attempt, error: _privateError));
    }
    final events = _events(f.snapshot);
    expect(events, hasLength(40));
    expect(events.first['attempt'], 11);
    expect(events.last['attempt'], 50);
    expect(events.first['sequence'], 12);
    expect(events.last['sequence'], 51);
    expect(_history(f.snapshot)['dropped'], 11);
    final report = _report(f.snapshot);
    expect(_events(_zipConnection(report)).last['sequence'], 51);
    final markdown = diagnosticsMarkdown(report);
    expect(markdown, contains('#12'));
    expect(markdown, contains('#51'));
  });

  test('old snapshots and nested history stay immutable after append eviction and clear', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    link.emit(const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.startDsh));
    final old = f.snapshot;
    final encoded = jsonEncode(old);
    final history = _history(old);
    final events = history['events'] as List;
    expect(() => history['dropped'] = 99, throwsUnsupportedError);
    expect(() => events.clear(), throwsUnsupportedError);
    expect(() => (events.first as Map)['phase'] = 'changed', throwsUnsupportedError);
    for (var attempt = 1; attempt <= 45; attempt++) {
      link.emit(HostLinkStatus(HostLinkPhase.reconnecting, attempt: attempt));
    }
    await link.close();
    expect(f.snapshot, _unobserved);
    expect(jsonEncode(old), encoded);
  });

  test('same host with a different actual link starts a new history', () async {
    final first = _ManualLink();
    final f = _Fixture(first);
    addTearDown(first.close);
    await f.container.pump();
    first.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 77));
    final next = _ManualLink();
    f.replace(_ssh, next);
    await f.container.pump();
    first.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 88));
    await first.close();
    expect(_events(f.snapshot).map((e) => e['attempt']), [0]);
    expect(_events(f.snapshot).single['sequence'], 1);
    expect(_history(f.snapshot)['dropped'], 0);
  });

  test('host switch and switch back do not resurrect the previous history', () async {
    final first = _ManualLink();
    final second = _ManualLink();
    final f = _Fixture(first);
    f.links[_relay] = second;
    await f.container.pump();
    first.emit(const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.verifyHostKey));
    first.emit(const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.startDsh));
    f.select(_relay);
    await f.container.pump();
    expect(_events(f.snapshot), hasLength(1));
    expect(f.snapshot['host'], 'relay');
    f.select(_ssh);
    await f.container.pump();
    final events = _events(f.snapshot);
    expect(events, hasLength(1), reason: 'the latest state is newly observed, the old sequence is retired');
    expect(events.single['sequence'], 1);
    expect(events.single['step'], 'startDsh');
  });

  test('host changes without an intermediate rebuild retire the old history', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    f.links[_relay] = _ManualLink();
    await f.container.pump();
    link.emit(const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.verifyHostKey));
    link.emit(const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.startDsh));
    f.select(_relay);
    f.select(_ssh);
    await f.container.pump();
    final events = _events(f.snapshot);
    expect(events, hasLength(1));
    expect(events.single['sequence'], 1);
    expect(events.single['step'], 'startDsh');
  });

  test('host changes in an observation gap cannot revive a still-owned link history', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    f.links[_relay] = _ManualLink();
    // A normal status consumer may keep the actual link alive while the
    // active-connection consumer is absent.
    final statusRow = f.container.listen(hostLinkStatusProvider(_ssh), (_, _) {});
    addTearDown(statusRow.close);
    await f.container.pump();
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 61));
    f.stopObserving();
    await f.container.pump();
    expect(f.snapshot, _unobserved);
    f.select(_relay);
    f.select(_ssh);
    expect(f.snapshot, _unobserved);
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 62));
    f.startObserving();
    await f.container.pump();
    final events = _events(f.snapshot);
    expect(events, hasLength(1));
    expect(events.single['sequence'], 1);
    expect(events.single['attempt'], 62);
    expect(link.closed, false);
    expect(link.kicks + link.retries, 0);
  });

  test('unobserved export neither reads a link nor opens or retries it', () async {
    final link = _ManualLink();
    final f = _Fixture(link, observe: false);
    final report = await f.collect();
    expect(report.connection, _unobserved);
    expect(_zipConnection(report), _unobserved);
    expect(f.linkReads, 0);
    expect(link.opens, 0);
    expect(link.kicks, 0);
    expect(link.retries, 0);
  });

  test('losing observation keeps the exported current contract and closing in the gap retires history', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 77));
    expect(_events(f.snapshot), hasLength(2));
    f.stopObserving();
    await f.container.pump();
    expect((await f.collect()).connection, _unobserved);
    final reads = f.linkReads;
    await link.close();
    expect((await f.collect()).connection, _unobserved);
    expect(f.linkReads, reads);
    final replacement = _ManualLink();
    f.replace(_ssh, replacement);
    f.startObserving();
    await f.container.pump();
    expect(_events(f.snapshot).map((e) => e['attempt']), [0]);
    expect(_history(f.snapshot)['dropped'], 0);
  });

  test('diagnostic scope disposal clears current and ignores subsequent source events', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    final diagnostics = f.container.read(connectionDiagnosticsProvider);
    expect(_events(diagnostics.snapshot), hasLength(1));
    f.dispose();
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 91));
    expect(diagnostics.snapshot, _unobserved);
  });

  test('same-link observation resumes without recording events that arrived in the gap', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 41));
    expect(_events(f.snapshot).map((e) => e['attempt']), [0, 41]);
    f.stopObserving();
    await f.container.pump();
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 42));
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 43));
    expect(f.snapshot, _unobserved);
    f.startObserving();
    await f.container.pump();
    final events = _events(f.snapshot);
    expect(events.map((e) => e['attempt']), [0, 41, 43]);
    expect(events.map((e) => e['sequence']), [1, 2, 3]);
  });

  test('closing in an observation gap cannot revive the old sequence on that same link', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 51));
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 52));
    expect(_events(f.snapshot), hasLength(3));
    f.stopObserving();
    await f.container.pump();
    await link.close();
    f.startObserving();
    final immediate = f.snapshot;
    if (immediate.containsKey('history')) {
      final events = _events(immediate);
      expect(events, hasLength(1), reason: 'a fresh observation must not resurrect the closed link history');
      expect(events.single['sequence'], 1);
    }
    await f.container.pump();
    expect(f.snapshot, _unobserved);
  });

  test('private progress error and network text never enter history ZIP or Markdown', () async {
    final link = _ManualLink();
    final f = _Fixture(link);
    await f.container.pump();
    link.emit(
      const HostLinkStatus(
        HostLinkPhase.reconnecting,
        step: HostLinkStep.tunnel,
        error: _privateError,
        detail: 'private-host.example private-user private-path',
        network: RemoteNetworkStatus(fallbackReason: 'private-candidate token=private-token'),
      ),
    );
    expect(_events(f.snapshot).last['fallbackReason'], 'unknown');
    final report = await f.collect();
    expect(_zipConnection(report), report.connection);
    final text = '${jsonEncode(report.connection)}\n${diagnosticsMarkdown(report)}';
    for (final private in [
      'private-host',
      'private-ssh',
      'private-relay',
      'private-user',
      'private-path',
      'private-fingerprint',
      'private-token',
      'private-candidate',
    ]) {
      expect(text, isNot(contains(private)));
    }
    expect(diagnosticsMarkdown(report), contains('tunnelFailed'));
    expect(link.opens, 1);
    expect(link.kicks + link.retries, 0);
  });

  for (final (code, expected, kind, retryable) in [
    ('HARNESS_VERSION_INCOMPATIBLE', 'remoteHarnessVersionIncompatible', HostLinkErrorKind.other, false),
    ('PROTOCOL_MISMATCH', 'remoteProtocolMismatch', HostLinkErrorKind.other, false),
    ('PEER_IDENTITY_MISMATCH', 'remotePeerIdentityMismatch', HostLinkErrorKind.hostKeyMismatch, false),
    ('RPC_TIMEOUT', 'remoteRpcTimeout', HostLinkErrorKind.unreachable, true),
    ('TOKEN_EXPIRED', 'remoteTokenExpired', HostLinkErrorKind.notLoggedIn, false),
    ('private-protocol-code token=private-token', 'unknown', HostLinkErrorKind.other, false),
  ]) {
    test('relay safe reason $expected preserves the original failure semantics', () async {
      final error = DshRemoteRelayBackend.describe(
        remote.RemoteFailure(code, 'private-server-detail', retryable: retryable),
        'private-host-name',
      );
      expect(error.kind, kind);
      expect(error.retryable, retryable);
      final link = _ManualLink();
      final f = _Fixture(link, host: _relay);
      await f.container.pump();
      link.emit(HostLinkStatus(HostLinkPhase.failed, step: HostLinkStep.connect, error: error));
      expect(_events(f.snapshot).last['reasonCode'], expected);
      expect((f.snapshot['link'] as Map)['reasonCode'], expected);
      final report = _report(f.snapshot);
      expect(_events(_zipConnection(report)).last['reasonCode'], expected);
      final text = '${jsonEncode(_zipConnection(report))}\n${diagnosticsMarkdown(report)}';
      expect(text, isNot(contains('private-')));
      expect(link.opens, 1);
      expect(link.kicks + link.retries, 0);
    });
  }

  for (final (label, error, reason) in [
    ('refused', const TunnelRefused(), 'sshTunnelRefused'),
    ('failed', StateError('private-probe-detail'), 'sshTunnelFailed'),
  ]) {
    test('real SSH initial probe $label has a safe reason without changing failure policy', () async {
      final remoteHost = FakeRemote()..pid = 500;
      remoteHost.tunnelErrors.add(error);
      final transport = FakeTransport(remoteHost);
      final link = _sshLink(transport);
      final f = _Fixture(link);
      await until(f.container, activeConnectionProvider, (v) => v.hasError, what: 'probe failed');
      expect(link.status.error?.kind, HostLinkErrorKind.tunnelFailed);
      expect(link.status.error?.retryable, true);
      expect(transport.isClosed, true);
      expect(_events(f.snapshot).last['reasonCode'], reason);
      expect(_events(f.snapshot).map((e) => e['step']), contains('startDsh'));
      expect(remoteHost.launches, 0);
    });
  }

  testWidgets('real SSH tunnel timeout keeps its stage and destroys a late channel', (tester) async {
    final transport = _HeldProbe(FakeRemote()..pid = 500);
    final link = _sshLink(transport);
    final f = _Fixture(link);
    await tester.pump();
    expect(transport.entered.isCompleted, true);
    await tester.pump(const Duration(seconds: 10));
    expect(link.status.phase, HostLinkPhase.failed);
    expect(link.status.error?.kind, HostLinkErrorKind.tunnelFailed);
    expect(_events(f.snapshot).last['reasonCode'], 'sshTunnelTimedOut');
    final late = FakeChannel();
    transport.release.complete(late);
    await tester.pump();
    expect(late.destroyed, true);
    expect(transport.isClosed, true);
  });

  for (final reason in ['sshTransportEnded', 'sshKeepaliveMissed', 'sshKickProbeFailed']) {
    test('real SSH $reason source survives retry-budget failure wrapping', () async {
      final events = _PeriodicEvents();
      await events.run(() async {
        final transport = _CountedPings(FakeRemote()..pid = 500);
        final link = _sshLink(transport, keepAliveInterval: const Duration(seconds: 15));
        final f = _Fixture(link);
        await until(f.container, activeConnectionProvider, (v) => v.value != null, what: 'connected synthetic SSH');
        final timer = events.timers.single;
        expect(timer.isActive, true);
        expect(timer.tick, 0);
        final failed = link.statuses.firstWhere((s) => s.phase == HostLinkPhase.failed);
        if (reason == 'sshTransportEnded') {
          transport.drop();
        } else {
          transport.pingOk = false;
          if (reason == 'sshKickProbeFailed') {
            link.kick();
          } else {
            timer.fire();
            expect(transport.pings, 1);
            expect(link.status.phase, HostLinkPhase.connected);
            timer.fire();
            expect(transport.pings, 2);
            expect(timer.tick, 2);
          }
        }
        await failed.timeout(const Duration(seconds: 5));
        expect(link.status.error?.kind, HostLinkErrorKind.unreachable);
        expect(link.status.error?.retryable, true);
        expect(_events(f.snapshot).last['reasonCode'], reason);
        expect(_events(f.snapshot).map((e) => e['phase']), contains('connected'));
        expect(transport.isClosed, true);
        expect(timer.isActive, false);
        final pings = transport.pings;
        timer.fire();
        expect(transport.pings, pings, reason: 'cancelled periodic callbacks cannot run');
      });
    });
  }
}
