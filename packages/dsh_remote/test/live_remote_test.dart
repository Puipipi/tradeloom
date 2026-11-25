// Live end-to-end test against a real ds-harness-remote Server + Host plugin.
// Never sends model prompts. Skipped unless configured:
//
//   DSH_REMOTE_LIVE_SERVER=http://127.0.0.1:8080 DSH_REMOTE_LIVE_EMAIL=you@example.test \
//   DSH_REMOTE_PASSWORD=... [DSH_REMOTE_LIVE_HOST=<id|name>] [DSH_REMOTE_LIVE_CWD=/host/dir] \
//   dart test -t live test/live_remote_test.dart
//
// Use a throwaway self-hosted Server and an isolated Host DSH_HOME: the test
// creates, renames and archives a session, switches its model/permission and
// sets then clears a dummy provider key on that Host.
@Tags(['live'])
library;

import 'dart:async';
import 'dart:io';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

void main() {
  final env = Platform.environment;
  final server = env['DSH_REMOTE_LIVE_SERVER'];
  final email = env['DSH_REMOTE_LIVE_EMAIL'];
  final password = env['DSH_REMOTE_PASSWORD'];
  final skip = server == null || email == null || password == null
      ? 'set DSH_REMOTE_LIVE_SERVER, DSH_REMOTE_LIVE_EMAIL, DSH_REMOTE_PASSWORD'
      : false;

  late RemoteAccount account;
  late RemoteHost host;
  late DshClient client;
  final states = <RemoteConnectionState>[];

  setUpAll(() async {
    if (skip != false) return;
    account = RemoteAccount(
      secrets: MemorySecretStore(),
      serverUrl: server,
      deviceName: 'dsh_remote live test',
      platform: 'dsh-app-test',
    );
    final user = await account.loginWithPassword(email!, password!);
    expect(user.account, isNotEmpty);
    final hosts = await account.listHosts();
    final selector = env['DSH_REMOTE_LIVE_HOST'];
    host = hosts.firstWhere((h) => selector == null ? h.online : h.id == selector || h.name == selector);
    expect(host.trust, RemoteHostTrust.unpinned, reason: 'fresh device identity');
    client = await account.connectHost(host, onState: states.add);
  });

  tearDownAll(() async {
    if (skip != false) return;
    await client.close();
    await account.logout();
    await account.close();
  });

  test('connects through the Relay with Noise and the Typert carrier', () async {
    expect(states.last.phase, RemoteConnectionPhase.connected);
    expect(states.last.transport, 'relay');
    expect(client.remoteCarrier!.capabilities, contains('harness.remote.v3'));
    expect(client.mux.generation!.clientId, isNotEmpty);
    expect((await account.listHosts()).firstWhere((h) => h.id == host.id).trust, RemoteHostTrust.pinned);
  }, skip: skip);

  test(
    'the app-facing DshClient API works remotely (no prompts)',
    () async {
      final before = await client.listSessions();
      final hostEvents = <HostEvent>[];
      final hostSub = client.hostEvents.listen(hostEvents.add);
      final created = await client.createSession(cwd: env['DSH_REMOTE_LIVE_CWD']);
      expect(created.sessionId, startsWith('session-'));
      final after = await client.listSessions();
      expect(after.length, before.length + 1);
      expect(after.any((s) => s.sessionId == created.sessionId), isTrue);

      final events = <DshEvent>[];
      final watchSub = client.watch(created.sessionId).listen(events.add);
      await _eventually(() => events.whereType<SessionSnapshotEvent>().isNotEmpty);
      final snapshot = events.whereType<SessionSnapshotEvent>().first;

      // A durable event arrives live through the tunnel follow stream.
      final title = await client.renameSession(created.sessionId, 'remote e2e');
      expect(title, 'remote e2e');
      await _eventually(() => events.whereType<SessionLogEvent>().any((e) => e.type == 'session/title'));

      // DSH 0.2.1 lists routable models only once a key is configured; the
      // dummy key is never used (no prompts) and is cleared again below.
      await client.setProviderKey('sk-dsh-remote-e2e-dummy');
      final key = await client.describeCredentials(['DEEPSEEK_API_KEY']);
      expect(key['DEEPSEEK_API_KEY']!.configured, isTrue);
      final catalog = await client.listModels();
      final group = catalog.groups.first;
      final selected = await client.setModel(created.sessionId, provider: group.id, model: group.models.first.id);
      expect(selected.model, group.models.first.id);
      await client.clearProviderKey();
      final permission = await client.setPermissionPreset(created.sessionId, 'read-only');
      expect(permission.success, isTrue, reason: permission.text);

      final history = await client.history(created.sessionId, throughSeq: snapshot.cursor);
      expect(history.events, isNotEmpty);
      await client.cancel(created.sessionId); // idle: accepted no-op

      final workspaces = <WorkspaceUpdate>[];
      final wsSub = client.watchWorkspaces().listen(workspaces.add);
      await _eventually(() => workspaces.isNotEmpty);
      final archived = await client.archiveSession(created.sessionId);
      expect(archived, contains(created.sessionId));
      await _eventually(() => hostEvents.isNotEmpty);

      // > 2 MiB request: travels the chunked harness.remote.transfer.* path and
      // reaches the Host Gateway, whose argument validation then refuses it.
      await expectLater(
        client.searchSessions('z' * (2 * 1024 * 1024 + 1000)),
        throwsA(isA<DshRemoteException>().having((e) => e.code, 'code', 'gateway/bad-request')),
      );

      await wsSub.cancel();
      await watchSub.cancel();
      await hostSub.cancel();
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test('upload is refused locally; uplink is unavailable', () async {
    await expectLater(
      client.uploadFile('session-x', [1]),
      throwsA(isA<DshRemoteException>().having((e) => e.code, 'code', 'METHOD_NOT_ALLOWED')),
    );
  }, skip: skip);

  test(
    'reconnect resyncs watch(); a rotated token keeps working',
    () async {
      final sessions = await client.listSessions();
      final events = <DshEvent>[];
      final sub = client.watch(sessions.first.sessionId).listen(events.add);
      await _eventually(() => events.whereType<SessionSnapshotEvent>().length == 1);
      final generation = client.mux.generation!.number;
      await account.refresh();
      client.mux.reconnect();
      await _eventually(
        () => events.whereType<SessionSnapshotEvent>().length == 2,
        timeout: const Duration(seconds: 30),
      );
      expect(events.whereType<SessionSnapshotEvent>().last.isResync, isTrue);
      expect(client.mux.generation!.number, generation + 1);
      await sub.cancel();
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 1)),
  );
}

Future<void> _eventually(bool Function() condition, {Duration timeout = const Duration(seconds: 10)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) fail('condition not met within $timeout');
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}
