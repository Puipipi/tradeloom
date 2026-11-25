import 'dart:async';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';

const _fastMux = MuxOptions(readyTimeout: Duration(seconds: 3), retryCaps: [Duration(milliseconds: 30)]);
const _compactCapability = 'remote.history.compact.v1';
const _configureMethod = 'remote.history.configure';

void main() {
  late FakeRemoteServer server;
  late FakeRemoteHost host;
  late RemoteAccount account;
  late RemoteHost target;

  setUp(() async {
    server = await FakeRemoteServer.start();
    host = await FakeRemoteHost.start(server);
    host.configureHistory = (params) async => {'compact': params['compact']};
    account = RemoteAccount(secrets: MemorySecretStore(), serverUrl: server.url);
    await account.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    target = (await account.listHosts()).single;
  });

  tearDown(() async {
    expect(server.protocolErrors, isEmpty);
    await account.close();
    await host.close();
    await server.close();
  });

  for (final compact in [false, true]) {
    test('old Host receives no history RPC when preference is $compact', () async {
      account.compactHistory = compact;
      final client = await account.connectHost(target, muxOptions: _fastMux);
      final recovered = client.mux.generations.firstWhere((g) => g.number > 1);
      host.dropClients();
      await recovered.timeout(const Duration(seconds: 5));
      expect(host.historyConfigurations, isEmpty);
      expect(host.rpcMethods, isNot(contains(_configureMethod)));
    });

    test('supporting Host explicitly receives compact=$compact before streams', () async {
      expect(account.compactHistory, isFalse, reason: 'compact history is opt-in');
      host.capabilities.add(_compactCapability);
      account.compactHistory = compact;
      await account.connectHost(target, muxOptions: _fastMux);
      expect(host.historyConfigurations.single.$2, {'compact': compact});
      expect(host.rpcMethods.take(3), ['harness.transport.describe', _configureMethod, 'harness.remote.stream.open']);
    });
  }

  test('configuration is awaited and preference is captured before startup finishes', () async {
    host.capabilities.add(_compactCapability);
    account.compactHistory = true;
    final trustGate = Completer<void>();
    final confirming = Completer<void>();
    final gate = Completer<void>();
    final configuring = Completer<void>();
    host.configureHistory = (params) async {
      configuring.complete();
      await gate.future;
      return {'compact': params['compact']};
    };
    var connected = false;
    final ready = account
        .connectHost(
          target,
          muxOptions: _fastMux,
          confirmNewHost: (_) async {
            confirming.complete();
            await trustGate.future;
            return true;
          },
        )
        .then((client) {
          connected = true;
          return client;
        });
    addTearDown(() {
      if (!trustGate.isCompleted) trustGate.complete();
      if (!gate.isCompleted) gate.complete();
    });
    await confirming.future.timeout(const Duration(seconds: 3));
    account.compactHistory = false;
    trustGate.complete();
    await configuring.future.timeout(const Duration(seconds: 3));
    expect(connected, isFalse);
    expect(host.openedStreamParams, isEmpty);
    expect(host.historyConfigurations.single.$2, {'compact': true});
    gate.complete();
    final client = await ready;
    final sub = client.watch('session-1').listen((_) {});
    await _eventually(() => host.openedStreamParams.length == 2);
    expect(
      host.historyConfigurations,
      hasLength(1),
      reason: 'opening a stream must not reconfigure the live connection',
    );
    await sub.cancel();
  });

  test(
    'automatic reconnect keeps client mode; a new client uses changed preference without replaying mutations',
    () async {
      host.capabilities.add(_compactCapability);
      account.compactHistory = true;
      host.handlers['session/create'] = (_) => {
        'ok': true,
        'value': {'sessionId': 'session-new', 'agentPreset': 'standard'},
      };
      host.onOpen = (stream) => stream.push(
        followSnapshot(
          'session-1',
          cursor: 0,
          records: [
            logRecord(0, 'turn/start', {'turn': 1}),
          ],
        ),
      );
      final client = await account.connectHost(target, muxOptions: _fastMux);
      await client.createSession(cwd: '/home/host/ws');
      final snapshots = <SessionSnapshotEvent>[];
      final sub = client.watch('session-1').listen((event) {
        if (event is SessionSnapshotEvent) snapshots.add(event);
      });
      await _eventually(() => snapshots.length == 1);
      account.compactHistory = false;
      expect(host.historyConfigurations, hasLength(1));
      host.dropClients();
      await _eventually(() => snapshots.length == 2);
      expect(snapshots.last.isResync, isTrue);
      expect(host.historyConfigurations.map((request) => request.$2), [
        {'compact': true},
        {'compact': true},
      ]);
      expect(host.historyConfigurations.map((request) => request.$1).toSet(), hasLength(2));
      expect(host.calls.where((call) => call.$1 == 'session/create'), hasLength(1));
      expect(host.rpcMethods.where((method) => method == 'harness.transport.describe' || method == _configureMethod), [
        'harness.transport.describe',
        _configureMethod,
        'harness.transport.describe',
        _configureMethod,
      ]);
      await sub.cancel();
      await _eventually(() => host.rpcMethods.last == 'harness.remote.stream.close');
      final deviceId = (await account.currentUser())!.deviceId;
      await client.close();
      await _eventually(() => !server.peers.containsKey(deviceId));
      final next = await account.connectHost(target, muxOptions: _fastMux);
      expect(identical(next, client), isFalse);
      expect(host.historyConfigurations.last.$2, {'compact': false});
      expect(host.historyConfigurations.map((request) => request.$1).toSet(), hasLength(3));
    },
  );

  test('a full client stays full when an old Host gains compact support on reconnect', () async {
    account.compactHistory = true;
    final client = await account.connectHost(target, muxOptions: _fastMux);
    expect(host.historyConfigurations, isEmpty);
    host.capabilities.add(_compactCapability);
    final recovered = client.mux.generations.firstWhere((g) => g.number > 1);
    host.dropClients();
    await recovered.timeout(const Duration(seconds: 5));
    expect(host.historyConfigurations.single.$2, {'compact': false});
    expect(host.rpcMethods, [
      'harness.transport.describe',
      'harness.remote.stream.open',
      'harness.transport.describe',
      _configureMethod,
      'harness.remote.stream.open',
    ]);
    expect(identical(account.activeClient, client), isTrue);
  });

  test('a full client continues without configuring after the Host loses compact support', () async {
    host.capabilities.add(_compactCapability);
    final client = await account.connectHost(target, muxOptions: _fastMux);
    expect(host.historyConfigurations.single.$2, {'compact': false});
    host.capabilities.remove(_compactCapability);
    final recovered = client.mux.generations.firstWhere((g) => g.number > 1);
    host.dropClients();
    await recovered.timeout(const Duration(seconds: 5));
    expect(host.historyConfigurations, hasLength(1));
    expect(host.openedStreamParams, hasLength(2));
    expect(client.remoteCarrier!.capabilities, isNot(contains(_compactCapability)));
  });

  test('losing compact support fails closed until a new client can load full history', () async {
    host.capabilities.add(_compactCapability);
    account.compactHistory = true;
    final client = await account.connectHost(target, muxOptions: _fastMux);
    expect(host.historyConfigurations.single.$2, {'compact': true});
    host.capabilities.remove(_compactCapability);
    final failed = client.remoteStates!.firstWhere((state) => state.phase == RemoteConnectionPhase.failed);
    host.dropClients();
    final failure = (await failed.timeout(const Duration(seconds: 5))).failure!;
    expect(failure.code, 'HISTORY_MODE_CHANGED');
    expect(failure.retryable, isFalse);
    expect(host.historyConfigurations, hasLength(1));
    expect(host.openedStreamParams, hasLength(1), reason: 'no full-mode stream may reuse compact history');
    expect(host.rpcMethods, [
      'harness.transport.describe',
      _configureMethod,
      'harness.remote.stream.open',
      'harness.transport.describe',
    ]);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(host.handshakes, hasLength(2), reason: 'a terminal mode change must not keep reconnecting');
    final deviceId = (await account.currentUser())!.deviceId;
    await _eventually(() => !server.peers.containsKey(deviceId));
    final next = await account.connectHost(target, muxOptions: _fastMux);
    expect(identical(next, client), isFalse);
    expect(host.historyConfigurations, hasLength(1));
    expect(host.openedStreamParams, hasLength(2), reason: 'a new client has no compact cache to mix');
  });

  for (final entry in <String, Object?>{
    'null': null,
    'primitive': true,
    'array': [true],
    'missing compact': <String, Object?>{},
    'null compact': {'compact': null},
    'string compact': {'compact': 'true'},
    'number compact': {'compact': 1},
    'different compact': {'compact': false},
    'extra field': {'compact': true, 'extra': false},
  }.entries) {
    test('rejects ${entry.key} configuration echo without opening streams', () async {
      host.capabilities.add(_compactCapability);
      account.compactHistory = true;
      host.configureHistory = (_) async => entry.value;
      await expectLater(
        account.connectHost(target, muxOptions: _fastMux),
        throwsA(
          isA<RemoteConnectException>()
              .having((error) => error.code, 'code', 'INVALID_MESSAGE')
              .having((error) => error.failure.retryable, 'retryable', isFalse),
        ),
      );
      expect(host.rpcMethods, ['harness.transport.describe', _configureMethod]);
      expect(host.openedStreamParams, isEmpty);
      expect(account.activeClient, isNull);
    });
  }

  test('advertised configure RPC errors are not silently ignored or mistaken for discovery errors', () async {
    host.capabilities.add(_compactCapability);
    host.configureHistory = null;
    await expectLater(
      account.connectHost(target, muxOptions: _fastMux),
      throwsA(
        isA<RemoteConnectException>()
            .having((error) => error.code, 'code', 'METHOD_NOT_FOUND')
            .having((error) => error.failure.retryable, 'retryable', isFalse),
      ),
    );
    expect(host.rpcMethods, ['harness.transport.describe', _configureMethod]);
    expect(host.openedStreamParams, isEmpty);
  });
}

Future<void> _eventually(bool Function() check) async {
  final deadline = DateTime.now().add(const Duration(seconds: 5));
  while (!check() && DateTime.now().isBefore(deadline)) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  expect(check(), isTrue, reason: 'condition did not become true');
}
