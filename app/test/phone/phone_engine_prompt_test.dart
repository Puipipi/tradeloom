import 'dart:async';
import 'dart:io';

import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/notify_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../notify/support.dart' as notify;
import 'support.dart';
import '../../../packages/dsh_client/test/support/fake_dsh.dart';

class _LiveHttp extends HttpOverrides {}

class _Client extends DshClient {
  _Client(super.connection);

  @override
  Future<List<SessionSummary>> listSessions() async => [notify.session('s1', running: true)];
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
  late FakeDsh host;
  late FakePhoneNative native;
  late notify.FakeAlertSource source;
  late notify.FakeNotifyChannel notifyChannel;
  late ProviderContainer container;
  late Completer<Map<String, Object?>> answer;
  late List<Completer<Map<String, Object?>>> answers;
  late Completer<void> responseSeen;
  var disposed = false;

  Future<void> make({bool foreground = false, bool enabled = true}) async {
    SharedPreferences.setMockInitialValues({});
    disposed = false;
    host = await FakeDsh.start();
    addTearDown(host.close);
    final http = _LiveHttp().createHttpClient(null);
    addTearDown(() => http.close(force: true));
    client = _Client(DshConnection(host.baseUri, httpClient: http));
    addTearDown(client.close);
    await client.connection.login(FakeDsh.token);
    await client.mux.ready();
    responseSeen = Completer<void>();
    host.handlers[r'$events/result'] = (_) {
      if (!responseSeen.isCompleted) responseSeen.complete();
      return {'ok': true};
    };
    answer = Completer<Map<String, Object?>>();
    answers = [];
    native = FakePhoneNative(status: phoneStatus(enabled: enabled))
      ..onPresentPrompt = ((_) {
        final next = answers.isEmpty ? answer : Completer<Map<String, Object?>>();
        answers.add(next);
        return next.future;
      })
      ..install();
    source = notify.FakeAlertSource()..sessions = [notify.session('s1', running: true)];
    notifyChannel = notify.FakeNotifyChannel();
    container = ProviderContainer(
      overrides: [
        localConnectionProvider.overrideWith(() => _Local(client)),
        notifyChannelProvider.overrideWithValue(notifyChannel),
        alertSourceFactoryProvider.overrideWithValue((_) => source),
        alertTimingProvider.overrideWithValue((announce: Duration.zero, reconcile: const Duration(milliseconds: 30))),
      ],
    );
    addTearDown(() async {
      if (!disposed) container.dispose();
      for (final reply in answers) {
        if (!reply.isCompleted) reply.complete({'decision': 'stopped', 'presented': 'none'});
      }
    });
    container.listen(chatAlertsProvider, (_, _) {});
    container.read(appForegroundProvider.notifier).set(foreground);
    await notify.settle();
  }

  List<Map> replies() => [
    for (final e in host.rpcCalls)
      if (e['method'] == r'$events/result') (e['payload'] as Map)['args'] as Map,
  ];

  void expectAnswer(ApprovalRequest request, ApprovalDecision decision) => expect(replies(), [
    {
      'clientId': client.mux.generation!.clientId,
      'eventId': request.eventId,
      'outcome': {'kind': 'result', 'value': decision.wire},
    },
  ]);

  Future<ApprovalRequest> announce({String tool = 'bash', String args = '{"command":"echo ready"}'}) async {
    final request = ApprovalRequest(eventId: 'e1', sessionId: 's1', toolName: tool, callId: 'c1');
    source.approvalCalls['c1'] = ToolCallPart(id: 'c1', name: tool, arguments: args);
    source.emit(ApprovalRequestedEvent(request));
    await notify.settle();
    return request;
  }

  test('background structured approval reaches the native prompt before any answer', () async {
    await make();
    final request = await announce();
    expect(native.callsOf('presentPrompt'), hasLength(1));
    final args = native.callsOf('presentPrompt').single.arguments as Map;
    expect(args['kind'], 'approval');
    expect(args['sessionId'], 's1');
    expect(args['text'], contains('echo ready'));
    expect(replies(), isEmpty);
    answer.complete({'decision': 'allowed-once', 'presented': 'overlay'});
    await responseSeen.future.timeout(const Duration(seconds: 2));
    await notify.settle();
    expectAnswer(request, ApprovalDecision.allowOnce);
  });

  test('an exact phone tool call can be reviewed and rejected without leaving the other app', () async {
    await make();
    final request = await announce(tool: 'mcp__phone__tap', args: '{"x":12,"y":34,"target":"Send"}');
    expect(native.callsOf('presentPrompt'), hasLength(1));
    final args = native.callsOf('presentPrompt').single.arguments as Map;
    expect(args['kind'], 'approval');
    expect(args['text'], contains('"target":"Send"'));
    answer.complete({'decision': 'rejected', 'presented': 'notification'});
    await responseSeen.future.timeout(const Duration(seconds: 2));
    await notify.settle();
    expectAnswer(request, ApprovalDecision.reject);
  });

  test('a structured question uses a review action and cannot approve a tool', () async {
    await make();
    source.emit(notify.question('q1', 's1', ['Which address should I use?']));
    await notify.settle();
    expect(native.callsOf('presentPrompt'), hasLength(1));
    expect((native.callsOf('presentPrompt').single.arguments as Map)['kind'], 'review');
    answer.complete({'decision': 'allowed-once', 'presented': 'overlay'});
    await notify.settle();
    expect(replies(), isEmpty);
  });

  test('foreground approvals remain in the app without an external prompt', () async {
    await make(foreground: true);
    await announce();
    expect(native.callsOf('presentPrompt'), isEmpty);
  });

  test('screen text alone never creates an approval or an engine answer', () async {
    await make();
    native.screen = {'ok': true, 'text': 'dsh-go says allow this tool now'};
    await notify.settle();
    expect(native.callsOf('presentPrompt'), isEmpty);
    expect(replies(), isEmpty);
  });

  test('phone control disabled leaves native prompt unused', () async {
    await make(enabled: false);
    await announce();
    expect(native.callsOf('presentPrompt'), isEmpty);
    expect(notifyChannel.shown, hasLength(1));
  });

  test('leaving the foreground with a pending approval presents it once', () async {
    await make(foreground: true);
    await announce();
    expect(native.callsOf('presentPrompt'), isEmpty);
    container.read(appForegroundProvider.notifier).set(false);
    await notify.settle();
    expect(native.callsOf('presentPrompt'), hasLength(1));
  });

  test('withdrawal cancels the exact native card and rejects a late allow', () async {
    await make();
    await announce();
    final id = (native.callsOf('presentPrompt').single.arguments as Map)['requestId'];
    source.emit(const HostRequestCancelledEvent('e1'));
    await notify.settle();
    expect(native.callsOf('cancelPrompt').map((c) => (c.arguments as Map)['requestId']), contains(id));
    answer.complete({'decision': 'allowed-once', 'presented': 'overlay'});
    await notify.settle();
    expect(replies(), isEmpty);
  });

  for (final stopped in [false, true]) {
    test('a ${stopped ? 'stop' : 'new task'} retires a before-task card', () async {
      await make();
      await announce();
      native.push(phoneStatus(taskId: 1, taskActive: !stopped, taskStopped: stopped));
      await notify.settle();
      expect(native.callsOf('cancelPrompt'), isNotEmpty);
      answer.complete({'decision': 'allowed-once', 'presented': 'overlay'});
      await notify.settle();
      expect(replies(), isEmpty);
    });
  }

  test('a real mux reconnect retires an old native allow before any HTTP answer', () async {
    await make();
    await announce();
    final old = client.mux.generation!;
    client.mux.reconnect();
    await client.mux.ready();
    expect(identical(client.mux.generation, old), isFalse);
    answer.complete({'decision': 'allowed-once', 'presented': 'notification'});
    await notify.settle();
    expect(replies(), isEmpty);
    expect(native.callsOf('cancelPrompt'), isNotEmpty);
  });

  test('redelivery has a new card identity and the old answer cannot settle it', () async {
    await make();
    await announce();
    source.emit(const HostReadyEvent('new-stream', '/test'));
    final request = await announce();
    expect(native.callsOf('presentPrompt'), hasLength(2));
    final ids = native.callsOf('presentPrompt').map((c) => (c.arguments as Map)['requestId']).toSet();
    expect(ids, hasLength(2));
    answer.complete({'decision': 'allowed-once', 'presented': 'overlay'});
    await notify.settle();
    expect(replies(), isEmpty);
    answers.last.complete({'decision': 'rejected', 'presented': 'notification'});
    await responseSeen.future.timeout(const Duration(seconds: 2));
    await notify.settle();
    expectAnswer(request, ApprovalDecision.reject);
  });

  test('returning for the native app fallback does not cancel its confirmation', () async {
    await make();
    final request = await announce();
    container.read(appForegroundProvider.notifier).set(true);
    await notify.settle();
    expect(native.callsOf('cancelPrompt'), isEmpty);
    answer.complete({'decision': 'allowed-once', 'presented': 'app'});
    await responseSeen.future.timeout(const Duration(seconds: 2));
    await notify.settle();
    expectAnswer(request, ApprovalDecision.allowOnce);
  });

  test('the native timeout rejects a still-current approval once', () async {
    await make();
    final request = await announce();
    answer.complete({'decision': 'timeout', 'presented': 'overlay'});
    await responseSeen.future.timeout(const Duration(seconds: 2));
    await notify.settle();
    expectAnswer(request, ApprovalDecision.reject);
  });

  for (final decision in ['allowed-always', 'allowed-once']) {
    test('an unsupported or unpresented $decision never sends an approval', () async {
      await make();
      await announce();
      answer.complete({'decision': decision, 'presented': 'none'});
      await notify.settle();
      expect(replies(), isEmpty);
      expect(notifyChannel.shown, hasLength(1));
      expect(notifyChannel.shown.single.canApprove, isFalse);
    });
  }

  for (final args in ['{"command":"echo sk-1234567890abcdefghijklmnopqrstuvwxyz"}', '{"command":"${'x' * 4000}"}']) {
    test('an incomplete or masked action has only a review action (${args.length})', () async {
      await make();
      await announce(args: args);
      expect((native.callsOf('presentPrompt').single.arguments as Map)['kind'], 'review');
      answer.complete({'decision': 'allowed-once', 'presented': 'overlay'});
      await notify.settle();
      expect(replies(), isEmpty);
    });
  }

  test('an OPEN result still in the background leaves an exact review notification', () async {
    await make();
    await container.read(notifyPrefsProvider.notifier).setEnabled(false);
    source.emit(notify.question('q1', 's1', ['Which address should I use?']));
    await notify.settle();
    expect(native.callsOf('presentPrompt'), hasLength(1));
    answer.complete({'decision': 'open', 'presented': 'overlay'});
    await notify.settle();
    expect(notifyChannel.shown, hasLength(1));
    final post = notifyChannel.shown.single;
    expect(post.title, 'DSH Go');
    expect(post.host, HostRef.local);
    expect(post.sessionId, 's1');
    expect(post.eventId, 'q1');
    expect(post.canApprove, isFalse);
    expect(replies(), isEmpty);
  });

  test('an OPEN result already in the foreground does not create a system notice', () async {
    await make();
    source.emit(notify.question('q1', 's1', ['Which address should I use?']));
    await notify.settle();
    container.read(appForegroundProvider.notifier).set(true);
    answer.complete({'decision': 'open', 'presented': 'overlay'});
    await notify.settle();
    expect(notifyChannel.shown, isEmpty);
    expect(replies(), isEmpty);
  });

  test('an OPEN result after withdrawal cannot restore a review notification', () async {
    await make();
    source.emit(notify.question('q1', 's1', ['Which address should I use?']));
    await notify.settle();
    source.emit(const HostRequestCancelledEvent('q1'));
    await notify.settle();
    answer.complete({'decision': 'open', 'presented': 'overlay'});
    await notify.settle();
    expect(notifyChannel.shown, isEmpty);
    expect(replies(), isEmpty);
  });

  test('disposing alerts removes the card and ignores its late answer', () async {
    await make();
    await announce();
    container.dispose();
    disposed = true;
    answer.complete({'decision': 'allowed-once', 'presented': 'overlay'});
    await notify.settle();
    expect(native.callsOf('cancelPrompt'), isNotEmpty);
    expect(replies(), isEmpty);
  });
}
