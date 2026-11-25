import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/diagnostics/app_error_log.dart';
import 'package:dsh_app/diagnostics/diagnostics_bundle.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/state/chat_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../diagnostics/support/zip_reader.dart';
import '../remote/support/ready_mux.dart';

class _Client extends DshClient {
  _Client() : super(DshConnection(Uri.parse('http://127.0.0.1:9')));
  final _ready = ReadyMux();
  final watches = <StreamController<DshEvent>>[];

  @override
  DshMux get mux => _ready;

  @override
  Stream<DshEvent> watch(String sessionId, {WatchOptions options = const WatchOptions()}) {
    final stream = StreamController<DshEvent>.broadcast();
    watches.add(stream);
    return stream.stream;
  }
}

ProviderContainer _start(_Client client) {
  final container = ProviderContainer(
    overrides: [
      activeConnectionProvider.overrideWithValue(
        AsyncData(HostConnection(client: client, label: 'synthetic host', isLocal: false)),
      ),
    ],
  );
  container.listen(chatProvider('S'), (_, _) {});
  addTearDown(() async {
    container.dispose();
    for (final stream in client.watches) {
      await stream.close();
    }
    await client.close();
  });
  return container;
}

List<AppErrorRecord> _sessionErrors() =>
    appErrorLog.snapshot().where((record) => record.source.name == 'session').toList();

void main() {
  testWidgets('host session failure survives the diagnostics ZIP with credentials redacted', (tester) async {
    final client = _Client();
    final container = _start(client);
    client.watches.single.add(
      const SessionErrorEvent(
        'S',
        'synthetic unreadable log: unknown event permissionRules/decision, seq 2873; token=fixture-session-secret',
      ),
    );
    await tester.pump();

    final records = _sessionErrors();
    expect(records, isNotEmpty);
    final record = records.last;
    expect(record.message, contains('unknown event permissionRules/decision, seq 2873'));
    expect(record.message, isNot(contains('fixture-session-secret')));
    expect(record.stack, isEmpty);
    expect(container.read(chatProvider('S')).error, isNull, reason: 'host diagnostics do not invent UI recovery');

    final bytes = DiagnosticsBundle.build(
      DiagnosticsSnapshot(
        at: DateTime.utc(2026, 11, 4),
        status: const RuntimeStatus.unknown(),
        settings: const AppSettings(),
        appErrors: appErrorLog.snapshot(),
      ),
    );
    final files = {for (final entry in readZip(bytes)) entry.name: utf8.decode(entry.data)};
    expect(files, contains('app-errors.json'));
    final exported = (jsonDecode(files['app-errors.json']!) as List).cast<Map<String, dynamic>>();
    final saved = exported.lastWhere((entry) => entry['source'] == 'session');
    expect(saved['message'], contains('permissionRules/decision'));
    expect(files.values.join('\n'), isNot(contains('fixture-session-secret')));
  });

  testWidgets('terminal follow failure records the actual remote code and stack', (tester) async {
    final client = _Client();
    final container = _start(client);
    client.watches.single.addError(
      const DshRemoteException('gateway/internal', 'synthetic follow failure token=fixture-follow-secret'),
      StackTrace.fromString('synthetic-follow.dart:41'),
    );
    await tester.pump();

    final records = _sessionErrors();
    expect(records, isNotEmpty);
    expect(records.last.message, contains('DshRemoteException(gateway/internal)'));
    expect(records.last.message, isNot(contains('fixture-follow-secret')));
    expect(records.last.stack, contains('synthetic-follow.dart:41'));
    final state = container.read(chatProvider('S'));
    expect(state.streamLost, isTrue);
    expect(state.loading, isFalse);
    expect(state.error, isNot(contains('synthetic follow failure')));
  });

  testWidgets('a deleted session is ordinary navigation, not a captured failure', (tester) async {
    final client = _Client();
    _start(client);
    final before = _sessionErrors();
    client.watches.single.addError(const DshRemoteException('session/not-found', 'synthetic deleted session'));
    await tester.pump();
    expect(_sessionErrors(), before);
  });

  testWidgets('unsupported history is readable in the UI and retains its diagnostic', (tester) async {
    final client = _Client();
    final container = _start(client);
    client.watches.single.addError(
      const DshRemoteException(
        'session/format-unsupported',
        'synthetic unknown event permissionRules/decision; token=fixture-format-secret',
      ),
      StackTrace.fromString('synthetic-format.dart:12'),
    );
    await tester.pump();
    final state = container.read(chatProvider('S'));
    expect(state.error, '对话同步中断：当前引擎无法读取此对话的日志格式，请导出诊断包排查');
    expect(state.streamLost, isTrue);
    expect(state.loading, isFalse);
    expect(_sessionErrors().last.message, contains('session/format-unsupported'));
    expect(_sessionErrors().last.message, contains('permissionRules/decision'));
    expect(_sessionErrors().last.message, isNot(contains('fixture-format-secret')));
  });

  testWidgets('a retired follow cannot add errors after the controller was invalidated', (tester) async {
    final client = _Client();
    final container = _start(client);
    final old = client.watches.single;
    final before = _sessionErrors();
    old.add(const SessionErrorEvent('S', 'synthetic stale host failure'));
    old.addError(const DshRemoteException('gateway/internal', 'synthetic stale follow failure'));
    container.invalidate(chatProvider('S'));
    container.read(chatProvider('S'));
    await tester.pump(Duration.zero);
    expect(client.watches, hasLength(2));
    expect(_sessionErrors(), before);
  });
}
