import 'dart:async';

import 'package:dsh_app/phone/phone_approval.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../packages/dsh_client/test/support/fake_dsh.dart';

class _HoldCarrier extends DshCarrier {
  _HoldCarrier(this.http);
  final DshHttpCarrier http;
  final resultArrived = Completer<void>();
  final releaseResult = Completer<void>();
  bool holdResult = false;
  @override
  String get kind => 'phone-live-http';
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
  const request = ApprovalRequest(eventId: 'e1', sessionId: 's1', toolName: 'bash', callId: 'c1');
  const pending = {
    'type': 'waterfall',
    'eventId': 'e1',
    'event': 'approval/request',
    'agentId': 's1',
    'request': {'toolName': 'bash', 'callId': 'c1'},
  };

  setUp(() async {
    host = await FakeDsh.start();
    final connection = DshConnection(host.baseUri);
    await connection.login(FakeDsh.token);
    wire = _HoldCarrier(DshHttpCarrier(connection));
    client = await DshClient.connectCarrier(wire);
    host.handlers[r'$events/result'] = (_) => {'ok': true};
  });
  tearDown(() async {
    await client.close();
    await host.close();
  });

  List<Map> calls() => [
    for (final e in host.rpcCalls)
      if (e['method'] == r'$events/result') (e['payload'] as Map)['args'] as Map,
  ];

  test('a current approval sends one exact response to the observed clientId', () async {
    final generation = client.mux.generation!;
    expect(
      await answerPhoneApproval(
        client: client,
        generation: generation,
        request: request,
        decision: ApprovalDecision.allowOnce,
        current: () => true,
      ),
      isTrue,
    );
    expect(calls(), [
      {
        'clientId': generation.clientId,
        'eventId': 'e1',
        'outcome': {'kind': 'result', 'value': 'allowed-once'},
      },
    ]);
  });

  test('a retired scope never sends an approval response', () async {
    final generation = client.mux.generation!;
    expect(
      await answerPhoneApproval(
        client: client,
        generation: generation,
        request: request,
        decision: ApprovalDecision.allowOnce,
        current: () => false,
      ),
      isFalse,
    );
    expect(calls(), isEmpty);
  });

  test('a stale stream rejection never retries the old answer on a new generation', () async {
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
    Object? failure;
    try {
      await answerPhoneApproval(
        client: client,
        generation: generation,
        request: request,
        decision: ApprovalDecision.allowOnce,
        current: () => identical(client.mux.generation, generation),
      );
    } catch (error) {
      failure = error;
    }
    expect(calls().map((args) => args['clientId']), [generation.clientId]);
    expect(failure, isA<DshRemoteException>());
  });

  test('an old accepted response does not resolve a redelivered current request', () async {
    final generation = client.mux.generation!;
    wire.holdResult = true;
    final answer = answerPhoneApproval(
      client: client,
      generation: generation,
      request: request,
      decision: ApprovalDecision.allowOnce,
      current: () => identical(client.mux.generation, generation),
    );
    await wire.resultArrived.future;
    host.pendingWaterfalls.add(pending);
    final redelivered = client.hostEvents.where((event) => event is ApprovalRequestedEvent).first;
    client.mux.reconnect();
    await client.mux.ready();
    await redelivered.timeout(const Duration(seconds: 2));
    expect(client.mux.pendingRequests, hasLength(1));
    wire.releaseResult.complete();
    expect(await answer, isTrue);
    expect(client.mux.pendingRequests, hasLength(1), reason: 'The old acknowledgement cannot clear a new request.');
  });
}
