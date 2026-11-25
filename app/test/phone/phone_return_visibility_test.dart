import 'dart:async';

import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/chat_reveal.dart';
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
  final ownerSnapshot = Completer<List<SessionSummary>>();
  final requests = <Completer<List<SessionSummary>>>[];
  final events = StreamController<HostEvent>.broadcast(sync: true);

  @override
  Stream<HostEvent> get hostEvents => events.stream;

  @override
  Future<List<SessionSummary>> listSessions() {
    final request = requests.isEmpty ? ownerSnapshot : Completer<List<SessionSummary>>();
    requests.add(request);
    return request.future;
  }
}

class _Local extends LocalConnectionController {
  _Local(this.client);
  final DshClient client;

  @override
  Future<HostConnection?> build() async => HostConnection(client: client, label: 'local', isLocal: true);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Client client;
  late FakePhoneNative native;
  late notify.FakeNotifyChannel channel;
  late notify.FakeAlertSource source;
  late ProviderContainer container;

  Future<void> make({bool delayOwner = false, bool doneAllowed = false}) async {
    SharedPreferences.setMockInitialValues({'notify_done': doneAllowed});
    client = _Client();
    if (!delayOwner) client.ownerSnapshot.complete([notify.session('s1', running: true)]);
    native = FakePhoneNative(status: phoneStatus(taskActive: true, taskId: 1))..install();
    channel = notify.FakeNotifyChannel();
    source = notify.FakeAlertSource()..sessions = [notify.session('s1', running: true), notify.session('s2')];
    final connection = HostConnection(client: client, label: 'local', isLocal: true);
    container = ProviderContainer(
      overrides: [
        notifyChannelProvider.overrideWithValue(channel),
        alertSourceFactoryProvider.overrideWithValue((_) => source),
        alertTimingProvider.overrideWithValue((announce: Duration.zero, reconcile: const Duration(milliseconds: 30))),
        localConnectionProvider.overrideWith(() => _Local(client)),
        activeConnectionProvider.overrideWithValue(AsyncData(connection)),
      ],
    );
    addTearDown(() async {
      container.dispose();
      await client.events.close();
      await client.close();
    });
    container.listen(phoneTurnEndProvider, (_, _) {});
    container.listen(chatAlertsProvider, (_, _) {});
    await notify.settle();
    container.read(appForegroundProvider.notifier).set(false);
    await notify.settle();
  }

  Future<void> end(String sessionId) async {
    source.outcomes[sessionId] = notify.outcome(10, 'completed', reply: 'fixture');
    source.emit(SessionStatusEvent(sessionId, false));
    await notify.settle();
  }

  test('a rejected activity launch still leaves a result notification for the owning turn', () async {
    await make();
    native.finish = {'closed': true, 'opened': false, 'launched': false};
    await end('s1');
    expect(native.callsOf('finishTask'), hasLength(1));
    expect(
      channel.shown,
      hasLength(1),
      reason: 'No launch exception or silent BAL rejection may erase the return path.',
    );
    expect(channel.shown.single.sessionId, 's1');
  });

  test('an end arriving before the same task owner snapshot is handled once evidence arrives', () async {
    await make(delayOwner: true);
    await end('s1');
    expect(native.callsOf('finishTask'), isEmpty);
    // This is the initial request's delayed response, not a new post-end scan.
    client.ownerSnapshot.complete([notify.session('s1', running: true)]);
    await notify.settle();
    expect(native.callsOf('finishTask'), hasLength(1));
    expect((native.callsOf('finishTask').single.arguments as Map)['taskId'], 1);
  });

  test('a delayed owner snapshot never uses an unrelated ended conversation', () async {
    await make(delayOwner: true);
    await end('s2');
    client.ownerSnapshot.complete([notify.session('s1', running: true)]);
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
  });

  test('a delayed ambiguous owner snapshot still refuses automatic finish', () async {
    await make(delayOwner: true);
    await end('s1');
    client.ownerSnapshot.complete([notify.session('s1', running: true), notify.session('s2', running: true)]);
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
  });

  test('a new run while the initial owner read is pending retires the old end', () async {
    await make(delayOwner: true, doneAllowed: true);
    await end('s1');
    expect(channel.shown, isEmpty);
    client.events.add(const SessionStatusEvent('s1', true));
    source.emit(const SessionStatusEvent('s1', true));
    client.ownerSnapshot.complete([notify.session('s1', running: true)]);
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
    expect(container.read(phoneTurnEndProvider.notifier).link.armed, isFalse);
    expect(channel.shown, isEmpty, reason: 'A retired end cannot fall back to an ordinary notification.');
  });

  test('a new native task cannot inherit the old deferred end', () async {
    await make(delayOwner: true, doneAllowed: true);
    await end('s1');
    expect(channel.shown, isEmpty);
    native.push(phoneStatus(taskActive: true, taskId: 2));
    await notify.settle();
    expect(client.requests, hasLength(2));
    client.requests.last.complete([notify.session('s2', running: true)]);
    client.ownerSnapshot.complete([notify.session('s1', running: true)]);
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
    expect(container.read(phoneTurnEndProvider.notifier).link.candidates, {'s2'});
    expect(channel.shown, isEmpty, reason: 'Replacing the native task retires its pending ordinary notice too.');
    source.emit(const SessionStatusEvent('s2', true));
    await notify.settle();
    await end('s2');
    expect(native.callsOf('finishTask'), hasLength(1));
    expect((native.callsOf('finishTask').single.arguments as Map)['taskId'], 2);
  });

  test('a closed native task with a retired result cannot reveal or notify', () async {
    await make(doneAllowed: true);
    native.finish = {'closed': true, 'opened': true, 'launched': true, 'current': false};
    await end('s1');
    expect(native.callsOf('finishTask'), hasLength(1));
    expect(container.read(chatRevealProvider), isNull);
    expect(channel.shown, isEmpty);
  });

  test('the native result notification is not duplicated by Dart', () async {
    await make();
    native.finish = {'closed': true, 'opened': false, 'launched': false, 'notified': true};
    await end('s1');
    expect(native.callsOf('finishTask'), hasLength(1));
    expect(channel.shown, isEmpty);
  });

  test('a pending owner read times out without later finishing the task', () async {
    await make(delayOwner: true);
    await end('s1');
    await Future<void>.delayed(PhoneTurnEndController.ownerWait + const Duration(milliseconds: 50));
    client.ownerSnapshot.complete([notify.session('s1', running: true)]);
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
    expect(channel.shown, isEmpty);
  });

  test('an ambiguous initial owner still releases the ordinary notice exactly once', () async {
    await make(delayOwner: true, doneAllowed: true);
    await end('s1');
    expect(channel.shown, isEmpty);
    client.ownerSnapshot.complete([notify.session('s1', running: true), notify.session('s2', running: true)]);
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
    expect(channel.shown.map((post) => (post.kind, post.sessionId)), [('done', 's1')]);
    await notify.settle();
    expect(channel.shown, hasLength(1));
  });

  test('a failed initial owner read still releases the ordinary notice', () async {
    await make(delayOwner: true, doneAllowed: true);
    await end('s1');
    expect(channel.shown, isEmpty);
    client.ownerSnapshot.completeError(StateError('fixture owner read failed'));
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
    expect(channel.shown.map((post) => (post.kind, post.sessionId)), [('done', 's1')]);
  });

  test('an initial owner timeout releases one ordinary notice and ignores its late reply', () async {
    await make(delayOwner: true, doneAllowed: true);
    await end('s1');
    expect(channel.shown, isEmpty);
    await Future<void>.delayed(PhoneTurnEndController.ownerWait + const Duration(milliseconds: 50));
    expect(native.callsOf('finishTask'), isEmpty);
    expect(channel.shown.map((post) => (post.kind, post.sessionId)), [('done', 's1')]);
    client.ownerSnapshot.complete([notify.session('s1', running: true)]);
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
    expect(channel.shown, hasLength(1));
  });

  test('an expired native task discards its deferred ordinary notice', () async {
    await make(delayOwner: true, doneAllowed: true);
    await end('s1');
    expect(channel.shown, isEmpty);
    native.push(phoneStatus(taskActive: false, taskId: 1));
    await notify.settle();
    client.ownerSnapshot.complete([notify.session('s1', running: true)]);
    await notify.settle();
    expect(native.callsOf('finishTask'), isEmpty);
    expect(channel.shown, isEmpty);
    expect(container.read(phoneTurnEndProvider.notifier).link.armed, isFalse);
  });
}
