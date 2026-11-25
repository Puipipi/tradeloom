import 'dart:async';

import 'package:dsh_app/pets/pet_mood.dart';
import 'package:dsh_app/pets/pet_signals.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/notify_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../packages/dsh_client/test/support/fake_dsh.dart';
import 'support.dart';

class _Local extends LocalConnectionController {
  @override
  Future<HostConnection?> build() async => null;
}

class _HoldCarrier extends DshCarrier {
  _HoldCarrier(this.http);
  final DshHttpCarrier http;
  final resultArrived = Completer<void>();
  final releaseResult = Completer<void>();
  bool holdResult = false;
  @override
  String get kind => 'pet-live-http';
  @override
  DshTracer? get tracer => null;
  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) async {
    final result = await http.call(endpoint, args, timeout: timeout);
    if (endpoint == r'$events/result' && holdResult) {
      if (!resultArrived.isCompleted) resultArrived.complete();
      await releaseResult.future;
    }
    return result;
  }

  @override
  Future<DshMuxLink> openLink(MuxOptions options) => http.openLink(options);
  @override
  Future<void> close() async {
    if (!releaseResult.isCompleted) releaseResult.complete();
    await http.close();
  }
}

void main() {
  late FakeDsh host;
  late DshClient client;
  late _HoldCarrier wire;
  late FakeAlertSource source;
  late FakeNotifyChannel channel;
  late ProviderContainer container;
  late StreamSubscription<HostEvent> hostEvents;
  late StreamSubscription<PetEvent> petEvents;
  late List<PetEvent> events;
  const remote = HostRef.ssh('lab');
  const approval = ApprovalRequest(eventId: 'e1', sessionId: 's1', toolName: 'bash', callId: 'c1');
  const question = UserQuestionRequest(
    eventId: 'q1',
    sessionId: 's1',
    questions: [
      UserQuestion(
        id: 'color',
        question: 'Pick a color',
        options: [QuestionOption('Blue', null), QuestionOption('Red', null)],
      ),
    ],
  );
  const pending = {
    'type': 'waterfall',
    'eventId': 'e1',
    'event': 'approval/request',
    'agentId': 's1',
    'request': {'toolName': 'bash', 'callId': 'c1'},
  };

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    host = await FakeDsh.start();
    final connection = DshConnection(host.baseUri);
    await connection.login(FakeDsh.token);
    wire = _HoldCarrier(DshHttpCarrier(connection));
    client = await DshClient.connectCarrier(wire);
    host.handlers[r'$events/result'] = (_) => {'ok': true};
    source = FakeAlertSource()
      ..sessions = [session('s1')]
      ..approvalCalls['c1'] = const ToolCallPart(id: 'c1', name: 'bash', arguments: '{"command":"echo ready"}');
    hostEvents = client.hostEvents.listen(source.emit);
    channel = FakeNotifyChannel();
    container = ProviderContainer(
      overrides: [
        notifyChannelProvider.overrideWithValue(channel),
        alertSourceFactoryProvider.overrideWithValue((_) => source),
        alertTimingProvider.overrideWithValue((announce: Duration.zero, reconcile: const Duration(milliseconds: 30))),
        localConnectionProvider.overrideWith(_Local.new),
        activeConnectionProvider.overrideWithValue(
          AsyncData(HostConnection(client: client, label: 'Lab', isLocal: false, kind: HostKind.ssh, hostId: 'lab')),
        ),
      ],
    );
    container.listen(chatAlertsProvider, (_, _) {});
    container.read(appForegroundProvider.notifier).set(false);
    events = [];
    petEvents = container.read(petEventBusProvider).events.listen(events.add);
    await settle();
  });

  tearDown(() async {
    container.dispose();
    await petEvents.cancel();
    await hostEvents.cancel();
    await channel.actionController.close();
    await channel.tapController.close();
    await client.close();
    await host.close();
  });

  List<Map> calls() => [
    for (final call in host.rpcCalls)
      if (call['method'] == r'$events/result') (call['payload'] as Map)['args'] as Map,
  ];

  Future<int> announce({bool questionOnly = false}) async {
    source.emit(questionOnly ? const UserQuestionRequestedEvent(question) : const ApprovalRequestedEvent(approval));
    await settle();
    return events.last.ask!.token!;
  }

  Future<NotifyActionResult> answer(int token, {bool questionOnly = false}) => container
      .read(chatAlertsProvider.notifier)
      .answerFromPet(
        remote,
        questionOnly ? question.eventId : approval.eventId,
        sessionId: 's1',
        token: token,
        decision: questionOnly ? null : ApprovalDecision.allowOnce,
        choice: questionOnly ? 'Blue' : null,
      );

  for (final questionOnly in [false, true]) {
    final kind = questionOnly ? 'question' : 'approval';
    test('pet $kind never retries a stale stream response after reconnect', () async {
      final token = await announce(questionOnly: questionOnly);
      final generation = client.mux.generation!;
      var count = 0;
      host.handlers[r'$events/result'] = (_) {
        if (++count == 1) {
          client.mux.reconnect();
          return {
            'ok': false,
            'error': {'code': 'gateway/arguments-invalid', 'message': 'clientId identifies no active event stream'},
          };
        }
        return {'ok': true};
      };
      expect(await answer(token, questionOnly: questionOnly), NotifyActionResult.failed);
      await client.mux.ready();
      expect(calls().map((args) => args['clientId']), [generation.clientId]);
      expect(client.mux.generation, isNot(same(generation)));
    });
  }

  test('old accepted pet response leaves a redelivered request pending', () async {
    final token = await announce();
    wire.holdResult = true;
    final response = answer(token);
    await wire.resultArrived.future;
    host.pendingWaterfalls.add(pending);
    final redelivered = client.hostEvents.where((event) => event is ApprovalRequestedEvent).first;
    client.mux.reconnect();
    await client.mux.ready();
    await redelivered.timeout(const Duration(seconds: 2));
    await settle();
    expect(client.mux.pendingRequests, hasLength(1));
    wire.releaseResult.complete();
    expect(await response, NotifyActionResult.handled);
    expect(client.mux.pendingRequests, hasLength(1));
    expect(await answer(token), NotifyActionResult.gone);
    expect(calls(), hasLength(1));
  });
}
