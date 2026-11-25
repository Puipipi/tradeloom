import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/notify_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _remote = HostRef.relay('mac', name: 'Mac');

Future<SharedPreferences> _seed({HostRef host = HostRef.local, bool autoConnect = true, String? legacyId}) async {
  SharedPreferences.setMockInitialValues({
    ActiveHostController.prefsKey: host.encode(),
    RemoteAutoConnectController.prefsKey: autoConnect,
    'last_session_id': ?legacyId,
  });
  // main() also warms this cache before building the UI. The tests do not
  // manufacture a cold or delayed preferences backend.
  return SharedPreferences.getInstance();
}

Future<void> _settle(ProviderContainer container) async {
  for (var i = 0; i < 16; i++) {
    await Future<void>.value();
    await container.pump();
  }
}

ProviderContainer _open({List<ChatTarget?>? viewed}) {
  final container = ProviderContainer();
  addTearDown(container.dispose);
  final sub = container.listen(viewedChatProvider, (_, next) => viewed?.add(next), fireImmediately: true);
  addTearDown(sub.close);
  container.read(activeHostProvider);
  return container;
}

Future<void> _rememberRemoteSelection() async {
  final initial = _open();
  await _settle(initial);
  initial.read(activeHostProvider.notifier).select(_remote);
  initial.read(currentSessionProvider.notifier).select('remote-session');
  await initial.read(remoteAutoConnectProvider.notifier).set(false);
  await _settle(initial);
}

void main() {
  test('a saved remote selection never becomes a local viewed conversation when startup connect is off', () async {
    await _seed();
    await _rememberRemoteSelection();
    final viewed = <ChatTarget?>[];
    final next = _open(viewed: viewed);
    await _settle(next);

    expect(next.read(activeHostProvider), HostRef.local);
    expect(next.read(currentSessionProvider), isNull);
    expect(viewed.whereType<ChatTarget>(), isEmpty);
  });

  test('off, local selection, then another off launch restores the local conversation', () async {
    final prefs = await _seed();
    await _rememberRemoteSelection();
    final local = _open();
    await _settle(local);
    expect(local.read(activeHostProvider), HostRef.local);
    local.read(currentSessionProvider.notifier).select('local-session');
    await _settle(local);
    // Keeping the remembered remote is existing, intentional startup behavior.
    expect(HostRef.decode(prefs.getString(ActiveHostController.prefsKey)), _remote);

    final next = _open();
    await _settle(next);
    expect(next.read(viewedChatProvider), (host: HostRef.local, sessionId: 'local-session'));
  });

  test('off, local selection, then enabling startup connect does not open that ID on the remote', () async {
    await _seed();
    await _rememberRemoteSelection();
    final local = _open();
    await _settle(local);
    local.read(currentSessionProvider.notifier).select('local-session');
    await local.read(remoteAutoConnectProvider.notifier).set(true);
    await _settle(local);

    final viewed = <ChatTarget?>[];
    final next = _open(viewed: viewed);
    await _settle(next);
    expect(next.read(activeHostProvider), _remote);
    expect(next.read(currentSessionProvider), isNull);
    expect(viewed.whereType<ChatTarget>(), isEmpty);
  });

  test('legacy remote ID is not assumed local when the saved host is skipped', () async {
    await _seed(host: _remote, autoConnect: false, legacyId: 'unbound-old-id');
    final next = _open();
    await _settle(next);
    expect(next.read(activeHostProvider), HostRef.local);
    expect(next.read(currentSessionProvider), isNull);
  });

  for (final host in [HostRef.local, _remote]) {
    test('legacy compatibility with an unchanged ${host.kind.name} host', () async {
      await _seed(host: host, legacyId: 'old-id');
      final next = _open();
      await _settle(next);
      expect(next.read(viewedChatProvider), (host: host, sessionId: 'old-id'));
    });
  }

  test('legacy remote restoration waits for the actual host before publishing a viewed target', () async {
    await _seed(host: _remote, legacyId: 'old-id');
    final viewed = <ChatTarget?>[];
    final next = _open(viewed: viewed);
    await _settle(next);
    expect(next.read(viewedChatProvider), (host: _remote, sessionId: 'old-id'));
    expect(viewed.whereType<ChatTarget>(), everyElement((host: _remote, sessionId: 'old-id')));
  });

  test('an early explicit local choice stops a remembered remote conversation too', () async {
    await _seed(host: _remote, legacyId: 'old-id');
    final next = _open();
    next.read(activeHostProvider.notifier).select(HostRef.local);
    await _settle(next);
    expect(next.read(activeHostProvider), HostRef.local);
    expect(next.read(currentSessionProvider), isNull);
  });

  test('an explicit host and session before startup restoration always win', () async {
    await _seed(host: _remote, legacyId: 'old-id');
    final next = _open();
    const chosen = HostRef.ssh('work');
    next.read(activeHostProvider.notifier).select(chosen);
    next.read(currentSessionProvider.notifier).select('chosen-session');
    await _settle(next);
    expect(next.read(viewedChatProvider), (host: chosen, sessionId: 'chosen-session'));
  });

  test('new chat remains cleared across the next launch', () async {
    await _seed(legacyId: 'old-id');
    final current = _open();
    current.read(currentSessionProvider.notifier).select('new-id');
    current.read(currentSessionProvider.notifier).select(null);
    await _settle(current);
    final next = _open();
    await _settle(next);
    expect(next.read(currentSessionProvider), isNull);
  });

  test('enabling startup again without another selection restores the paired remote conversation', () async {
    await _seed();
    await _rememberRemoteSelection();
    final local = _open();
    await _settle(local);
    await local.read(remoteAutoConnectProvider.notifier).set(true);

    final next = _open();
    await _settle(next);
    expect(next.read(viewedChatProvider), (host: _remote, sessionId: 'remote-session'));
  });

  test('an explicit new chat while startup stays local also clears the remembered remote selection', () async {
    await _seed();
    await _rememberRemoteSelection();
    final local = _open();
    await _settle(local);
    local.read(currentSessionProvider.notifier).select(null);
    await local.read(remoteAutoConnectProvider.notifier).set(true);
    await _settle(local);

    final next = _open();
    await _settle(next);
    expect(next.read(activeHostProvider), _remote);
    expect(next.read(currentSessionProvider), isNull);
  });

  test('a relay display-name change does not change the saved conversation owner', () async {
    await _seed();
    final current = _open();
    await _settle(current);
    current.read(activeHostProvider.notifier).select(_remote);
    current.read(currentSessionProvider.notifier).select('remote-session');
    const renamed = HostRef.relay('mac', name: 'Renamed Mac');
    current.read(activeHostProvider.notifier).select(renamed);
    await _settle(current);

    final next = _open();
    await _settle(next);
    expect(next.read(activeHostProvider).name, 'Renamed Mac');
    expect(next.read(viewedChatProvider), (host: renamed, sessionId: 'remote-session'));
  });

  test('disposing a startup before preferences continuations does not publish a target', () async {
    await _seed(host: _remote, legacyId: 'old-id');
    final viewed = <ChatTarget?>[];
    final container = ProviderContainer();
    container.listen(viewedChatProvider, (_, next) => viewed.add(next), fireImmediately: true);
    container.read(activeHostProvider);
    container.dispose();
    for (var i = 0; i < 16; i++) {
      await Future<void>.value();
    }
    expect(viewed, [null]);
  });
}
