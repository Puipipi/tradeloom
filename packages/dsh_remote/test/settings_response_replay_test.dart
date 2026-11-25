import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

import 'support/fake_remote.dart';

const fastMux = MuxOptions(readyTimeout: Duration(seconds: 3), retryCaps: [Duration(milliseconds: 30)]);

void main() {
  late FakeRemoteServer server;
  late FakeRemoteHost host;
  late RemoteAccount account;

  setUp(() async {
    server = await FakeRemoteServer.start();
    host = await FakeRemoteHost.start(server);
    host.directResponseLimit = 4 * 1024 * 1024;
    account = RemoteAccount(secrets: MemorySecretStore(), serverUrl: server.url);
  });

  tearDown(() async {
    expect(server.protocolErrors, isEmpty);
    await account.close();
    await host.close();
    await server.close();
  });

  Future<DshClient> connect() async {
    await account.loginWithPassword(FakeRemoteServer.account, FakeRemoteServer.password);
    final target = (await account.listHosts()).single;
    return account.connectHost(target, muxOptions: fastMux);
  }

  Map<String, Object?> result(String payload, List<String> items, int revision) => {
    'ok': true,
    'value': {
      'ns': 'fixture',
      'revision': revision,
      'value': {'payload': payload, 'items': List.of(items)},
      'base': {'payload': payload},
      'user': {'payload': payload, 'items': List.of(items)},
    },
  };

  test('an oversized settings mutation result does not remove another array item', () async {
    final client = await connect();
    final items = ['alpha', 'beta', 'gamma'];
    final payload = 'x' * (3 * 1024 * 1024);
    var calls = 0;
    host.handlers['settings/mutate'] = (args) {
      expect(args['ops'], [
        {
          'op': 'unset',
          'path': ['items', '0'],
        },
      ]);
      calls++;
      items.removeAt(0);
      return result(payload, items, calls);
    };
    Object? outcome;
    try {
      outcome = await client.mutateSettings('fixture', const [
        SettingsOp.unset(['items', '0']),
      ]);
    } catch (error) {
      outcome = error;
    }
    expect(calls, 1);
    expect(items, ['beta', 'gamma']);
    expect(outcome, isA<DshRemoteException>().having((e) => e.code, 'code', 'RESPONSE_TOO_LARGE'));
    expect(host.rpcMethods.where((m) => m.startsWith('harness.remote.transfer.')), isEmpty);
  });

  test('a committed revisioned settings mutation keeps its original response error', () async {
    final client = await connect();
    final payload = 'x' * (3 * 1024 * 1024);
    var calls = 0;
    var revision = 0;
    host.handlers['settings/mutate'] = (args) {
      calls++;
      if (args['expectedRevision'] != revision) {
        return {
          'ok': false,
          'error': {'code': 'settings/conflict', 'message': 'The revision changed.', 'details': <String, Object?>{}},
        };
      }
      revision++;
      return result(payload, ['accepted'], revision);
    };
    Object? outcome;
    try {
      outcome = await client.mutateSettings('fixture', const [
        SettingsOp.set(['enabled'], true),
      ], expectedRevision: 0);
    } catch (error) {
      outcome = error;
    }
    expect(calls, 1);
    expect(revision, 1);
    expect(outcome, isA<DshRemoteException>().having((e) => e.code, 'code', 'RESPONSE_TOO_LARGE'));
    expect(host.rpcMethods.where((m) => m.startsWith('harness.remote.transfer.')), isEmpty);
  });

  test('a normal settings mutation still succeeds through one direct call', () async {
    final client = await connect();
    var calls = 0;
    host.handlers['settings/mutate'] = (_) => result('small', ['beta', 'gamma'], ++calls);
    final section = await client.mutateSettings('fixture', const [
      SettingsOp.unset(['items', '0']),
    ]);
    expect(section.value['items'], ['beta', 'gamma']);
    expect(calls, 1);
    expect(host.rpcMethods.where((m) => m.startsWith('harness.remote.transfer.')), isEmpty);
  });

  test('an initially large settings mutation transfers and commits once', () async {
    final client = await connect();
    final payload = 'x' * (3 * 1024 * 1024);
    var calls = 0;
    host.handlers['settings/mutate'] = (args) {
      expect(args['ops'], [
        {
          'op': 'set',
          'path': ['payload'],
          'value': payload,
        },
      ]);
      return result(payload, ['alpha'], ++calls);
    };
    final section = await client.mutateSettings('fixture', [
      SettingsOp.set(['payload'], payload),
    ]);
    expect(section.value['payload'], payload);
    expect(calls, 1);
    expect(host.rpcMethods.where((m) => m == 'harness.remote.transfer.commit'), hasLength(1));
    expect(host.rpcMethods.where((m) => m == 'harness.remote.call'), isEmpty);
  });
  for (final endpoint in ['settings/update', 'settings/replace']) {
    test('an oversized $endpoint response is not dispatched twice', () async {
      final client = await connect();
      final payload = 'x' * (2 * 1024 * 1024);
      var calls = 0;
      host.handlers[endpoint] = (_) => result(payload, ['accepted'], ++calls);
      Object? outcome;
      try {
        outcome = await client.rpc.call(endpoint, {
          'ns': 'fixture',
          if (endpoint == 'settings/update') 'patch': {'mode': 'A'} else 'section': {'mode': 'A'},
          'expectedRevision': 0,
        });
      } catch (error) {
        outcome = error;
      }
      expect(calls, 1);
      expect(outcome, isA<DshRemoteException>().having((e) => e.code, 'code', 'RESPONSE_TOO_LARGE'));
      expect(host.rpcMethods.where((m) => m.startsWith('harness.remote.transfer.')), isEmpty);
    });
  }

}
