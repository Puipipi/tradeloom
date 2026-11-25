import 'dart:async';

import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/notify_state.dart';
import 'package:dsh_app/state/phone_turn_end.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../notify/support.dart' as notify;
import 'support.dart';

class _Client extends DshClient {
  _Client() : super(DshConnection(Uri.parse('http://127.0.0.1:9')));

  @override
  Future<List<SessionSummary>> listSessions() async => [notify.session('s1', running: true)];
}

class _Local extends LocalConnectionController {
  _Local(this.client);
  final DshClient client;

  @override
  Future<HostConnection?> build() async => HostConnection(client: client, label: 'local', isLocal: true);
}

class _AlertSource extends notify.FakeAlertSource {
  final pendingOutcome = Completer<TurnOutcome?>();

  @override
  Future<TurnOutcome?> lastTurn(String sessionId) => pendingOutcome.future;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the real alert tracker cannot send an old idle result to native finish', () async {
    SharedPreferences.setMockInitialValues({});
    final client = _Client();
    final native = FakePhoneNative()..install();
    final container = ProviderContainer(overrides: [localConnectionProvider.overrideWith(() => _Local(client))]);
    addTearDown(container.dispose);
    await container.read(localConnectionProvider.future);
    container.read(appForegroundProvider.notifier).set(false);
    container.listen(phoneTurnEndProvider, (_, _) {});
    await notify.settle();
    native.push(phoneStatus(taskActive: true, taskId: 1));
    await notify.settle();
    final phone = container.read(phoneTurnEndProvider.notifier);
    final source = _AlertSource()..sessions = [notify.session('s1', running: true)];
    final tracker = HostAlertTracker(
      host: HostRef.local,
      source: source,
      onAlert: (alert) => phone.onTurnEnd(alert),
      onWithdraw: (_, _, _) {},
      onSessionGone: (_, _) {},
    )..start();
    addTearDown(tracker.dispose);
    await notify.settle();
    source.emit(const SessionStatusEvent('s1', false));
    await notify.settle();
    source.emit(const SessionStatusEvent('s1', true));
    source.pendingOutcome.complete(notify.outcome(8, 'completed'));
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
    expect(phone.link.armed, isTrue);
  });
}
