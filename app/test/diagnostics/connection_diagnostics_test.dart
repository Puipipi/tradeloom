import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/diagnostics/diagnostics_bundle.dart';
import 'package:dsh_app/diagnostics/app_error_log.dart';
import 'package:dsh_app/diagnostics/diagnostics_channel.dart';
import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../remote/support/wait.dart';

const _privateError = HostLinkError(
  HostLinkErrorKind.dshTimeout,
  'secret-host.example',
  detail: 'token=private-token SHA256:private-fingerprint',
);

class _Runtime extends LocalRuntimeController {
  @override
  LocalRuntimeState build() => const LocalRuntimeState(loaded: true);
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

class _Active extends ActiveHostController {
  _Active(this.host);
  final HostRef host;
  @override
  HostRef build() => host;
  void change(HostRef next) => state = next;
}

class _Hosts extends HostsController {
  @override
  HostsState build() => const HostsState(
    loaded: true,
    ssh: [
      SshHostConfig(
        id: 'private-host-id',
        name: 'private-host-name',
        host: 'secret-host.example',
        user: 'private-user',
      ),
    ],
  );
}

class _Local extends LocalConnectionController {
  @override
  Future<HostConnection?> build() async => throw _privateError;
}

class _Link implements HostLink {
  _Link({this.step = HostLinkStep.startDsh, this.errorKind = HostLinkErrorKind.dshTimeout});
  final HostLinkStep step;
  final HostLinkErrorKind errorKind;
  final changes = StreamController<HostLinkStatus>.broadcast(sync: true);
  HostLinkStatus? next;
  int opens = 0;

  @override
  HostLinkStatus get status =>
      next ??
      HostLinkStatus(
        HostLinkPhase.reconnecting,
        step: step,
        attempt: 2,
        error: HostLinkError(errorKind, 'secret-host.example', detail: 'SHA256:private-fingerprint', retryable: true),
        detail: 'secret-host.example token=private-token',
      );
  void emit(HostLinkStatus status) {
    next = status;
    changes.add(status);
  }

  @override
  DshClient? get currentClient => null;
  @override
  Stream<DshClient> get clients => const Stream.empty();
  @override
  Stream<HostLinkStatus> get statuses => changes.stream;
  @override
  Future<DshClient> open() async {
    opens++;
    throw _privateError;
  }

  @override
  void kick() {}
  @override
  void retry() {}
  @override
  Future<void> close() async => changes.close();
}

Future<DiagnosticsSnapshot> collect(ProviderContainer c) =>
    c.read(FutureProvider((ref) => collectDiagnostics(ref, DateTime.utc(2026))).future);

ProviderContainer _observed(HostRef host, _Link link) {
  final c = ProviderContainer(
    retry: (_, _) => null,
    overrides: [
      activeHostProvider.overrideWith(() => _Active(host)),
      hostsProvider.overrideWith(_Hosts.new),
      hostNameProvider.overrideWith((ref, host) => 'private-host-name'),
      hostLinkProvider.overrideWith((ref, host) => link),
      localConnectionProvider.overrideWith(_Local.new),
      localRuntimeProvider.overrideWith(_Runtime.new),
      settingsProvider.overrideWith(_Settings.new),
      runtimeBridgeProvider.overrideWithValue(_Bridge()),
      diagnosticsChannelProvider.overrideWithValue(_Channel()),
    ],
  );
  addTearDown(c.dispose);
  addTearDown(link.close);
  final sub = c.listen(activeConnectionProvider, (_, _) {});
  addTearDown(sub.close);
  return c;
}

void main() {
  for (final host in [HostRef.local, const HostRef.ssh('private-host-id'), const HostRef.relay('private-host-id')]) {
    test('diagnostics capture existing ${host.kind.name} status without private connection text', () async {
      final link = _Link(
        step: host.kind == HostKind.relay ? HostLinkStep.connect : HostLinkStep.startDsh,
        errorKind: host.kind == HostKind.relay ? HostLinkErrorKind.hostOffline : HostLinkErrorKind.dshTimeout,
      );
      final c = _observed(host, link);
      await until(c, activeConnectionProvider, (value) => value.hasError, what: 'observed failure');
      final diagnostic = (await collect(c)).connection;
      expect(diagnostic['host'], host.kind.name);
      expect(diagnostic['state'], 'failed');
      expect(diagnostic['observedAtEpochMs'], isA<int>());
      if (host.isLocal) {
        expect(diagnostic, isNot(contains('link')));
      } else {
        expect(diagnostic['link'], {
          'phase': 'reconnecting',
          'step': link.step.name,
          'attempt': 2,
          'errorKind': link.errorKind.name,
          'retryable': true,
        });
        link.emit(HostLinkStatus(HostLinkPhase.reconnecting, step: HostLinkStep.login, attempt: 3));
        expect(((await collect(c)).connection['link'] as Map)['attempt'], 3);
      }
      final encoded = jsonEncode(diagnostic);
      for (final privateText in [
        'secret-host.example',
        'private-host-id',
        'private-host-name',
        'private-token',
        'private-fingerprint',
      ]) {
        expect(encoded, isNot(contains(privateText)));
      }
      expect(link.opens, host.isLocal ? 0 : 1, reason: 'export must not open or retry a connection');
    });
  }

  for (final host in [HostRef.local, const HostRef.ssh('private-host-id'), const HostRef.relay('private-host-id')]) {
    test('exporting diagnostics does not initialize an unobserved ${host.kind.name} connection or link', () async {
      var connectionReads = 0;
      var linkBuilds = 0;
      final c = ProviderContainer(
        overrides: [
          activeHostProvider.overrideWith(() => _Active(host)),
          activeConnectionProvider.overrideWith((ref) {
            connectionReads++;
            return const AsyncData<HostConnection?>(null);
          }),
          hostLinkProvider.overrideWith((ref, host) {
            linkBuilds++;
            return _Link();
          }),
          localRuntimeProvider.overrideWith(_Runtime.new),
          settingsProvider.overrideWith(_Settings.new),
          runtimeBridgeProvider.overrideWithValue(_Bridge()),
          diagnosticsChannelProvider.overrideWithValue(_Channel()),
        ],
      );
      addTearDown(c.dispose);
      c.read(activeHostProvider);
      final snapshot = await collect(c);
      expect(connectionReads, 0);
      expect(linkBuilds, 0);
      expect(snapshot.connection, {'host': 'not_observed', 'state': 'not_observed'});
    });
  }

  test('diagnostics must not rebuild an invalidated unobserved connection', () async {
    var builds = 0;
    final c = ProviderContainer(
      overrides: [
        activeHostProvider.overrideWith(() => _Active(const HostRef.ssh('private-host-id'))),
        activeConnectionProvider.overrideWith((ref) {
          builds++;
          return const AsyncData<HostConnection?>(null);
        }),
        localRuntimeProvider.overrideWith(_Runtime.new),
        settingsProvider.overrideWith(_Settings.new),
        runtimeBridgeProvider.overrideWithValue(_Bridge()),
        diagnosticsChannelProvider.overrideWithValue(_Channel()),
      ],
    );
    addTearDown(c.dispose);
    c.read(activeHostProvider);
    c.read(activeConnectionProvider);
    c.invalidate(activeConnectionProvider);
    await collect(c);
    expect(builds, 1, reason: 'a diagnostic read must not re-run connection creation');
  });

  test('closing a link clears its retained observation', () async {
    final link = _Link();
    final c = _observed(const HostRef.ssh('private-host-id'), link);
    await until(c, activeConnectionProvider, (value) => value.hasError, what: 'observed failure');
    await link.close();
    expect((await collect(c)).connection, {'host': 'not_observed', 'state': 'not_observed'});
    expect(link.opens, 1);
  });

  test('collect includes app errors without opening a connection', () async {
    var connectionReads = 0;
    final c = ProviderContainer(
      overrides: [
        activeConnectionProvider.overrideWith((ref) {
          connectionReads++;
          return const AsyncData<HostConnection?>(null);
        }),
        localRuntimeProvider.overrideWith(_Runtime.new),
        settingsProvider.overrideWith(_Settings.new),
        runtimeBridgeProvider.overrideWithValue(_Bridge()),
        diagnosticsChannelProvider.overrideWithValue(_Channel()),
      ],
    );
    addTearDown(c.dispose);
    appErrorLog.record(AppErrorSource.platform, 'SYNTHETIC collect marker password=fixture-password', StackTrace.empty);
    final snapshot = await collect(c);
    expect(snapshot.appErrors.any((error) => error.message.contains('SYNTHETIC collect marker')), isTrue);
    expect(snapshot.appErrors.any((error) => error.message.contains('fixture-password')), isFalse);
    expect(connectionReads, 0);
  });

  test('switching hosts discards old link observations', () async {
    final link = _Link();
    final c = _observed(const HostRef.ssh('private-host-id'), link);
    await until(c, activeConnectionProvider, (value) => value.hasError, what: 'observed failure');
    (c.read(activeHostProvider.notifier) as _Active).change(HostRef.local);
    await until(c, activeConnectionProvider, (value) => value.hasError, what: 'local failure');
    link.emit(const HostLinkStatus(HostLinkPhase.reconnecting, step: HostLinkStep.tunnel, attempt: 7));
    final diagnostic = (await collect(c)).connection;
    expect(diagnostic['host'], 'local');
    expect(diagnostic, isNot(contains('link')));
  });
}
