import 'dart:async';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_client/dsh_client.dart';

/// Scriptable stand-in for the `dsh_remote` adapter.
class FakeRelayBackend implements RelayBackend {
  FakeRelayBackend({this.user, List<RelayHost>? hosts, this.available = true}) : hosts = hosts ?? sampleRelayHosts;

  RelayUser? user;
  List<RelayHost> hosts;
  @override
  final bool available;

  /// Providers the fake Server offers for browser sign-in.
  List<RelayAuthProvider> providers = List.of(sampleRelayProviders);

  /// `providerId` values [login] was called with (null = default provider).
  final List<String?> loginProviderIds = [];

  /// Completes the pending browser login.
  Completer<RelayUser>? pendingLogin;
  final List<String> connected = [];
  final List<Object> connectErrors = [];
  final Set<DshClient> closedClients = {};
  Object? listError;
  final Set<String> approved = {};
  final List<String> forgotten = [];

  @override
  String get serverLabel => 'dsh.r2049.cn';

  @override
  Future<RelayUser?> currentUser() async => user;

  @override
  Future<List<RelayAuthProvider>> loginProviders() async => providers;

  @override
  Future<RelayLoginSession> login({String? providerId}) async {
    loginProviderIds.add(providerId);
    final completer = pendingLogin = Completer<RelayUser>();
    return RelayLoginSession(
      loginUrl: Uri.parse('https://dsh.r2049.cn/qr/scan/abc'),
      completed: completer.future.then((u) => user = u),
      onCancel: () {
        if (!completer.isCompleted) completer.completeError(StateError('cancelled'));
      },
    );
  }

  @override
  Future<void> logout() async => user = null;

  @override
  Future<List<RelayHost>> listHosts({bool refresh = false}) async {
    if (listError case final error?) throw error;
    return user == null ? const [] : hosts;
  }

  @override
  void approveHost(RelayHost host) => approved.add(host.id);

  @override
  Future<void> forgetHost(RelayHost host) async {
    forgotten.add(host.id);
    approved.add(host.id);
  }

  /// Password logins seen (self-hosted server flow).
  final List<(String, String)> passwordLogins = [];

  @override
  Future<RelayUser> loginWithPassword(String email, String password) async {
    passwordLogins.add((email, password));
    return user = RelayUser(id: 'u-pw', displayName: email, provider: 'password');
  }

  /// Clients restarted through [reconnect].
  final List<DshClient> reconnected = [];
  int probes = 0;

  @override
  Future<bool> probe(DshClient client) async {
    probes++;
    return true;
  }

  /// What [pathOf] reports for every client.
  RelayPath? path;

  @override
  RelayPath? pathOf(DshClient client) => path;

  @override
  bool reconnect(DshClient client) {
    if (closedClients.contains(client)) return false;
    reconnected.add(client);
    return true;
  }

  @override
  Future<DshClient> connectHost(RelayHost host, {RelayStateCallback? onState}) async {
    onState?.call(RelayConnectionState.connecting, null);
    onState?.call(RelayConnectionState.handshaking, null);
    connected.add(host.id);
    if (connectErrors.isNotEmpty) throw connectErrors.removeAt(0);
    return _TrackedClient((client) => closedClients.add(client));
  }
}

const sampleRelayUser = RelayUser(id: 'u1', displayName: 'chimney', provider: 'github');

const sampleRelayProviders = [
  RelayAuthProvider(id: 'zhihu', displayName: '知乎'),
  RelayAuthProvider(id: 'github', displayName: 'GitHub'),
  RelayAuthProvider(id: 'google', displayName: 'Google'),
];

const sampleRelayHosts = [
  RelayHost(
    id: 'mac',
    name: '家里的 Mac',
    online: true,
    platform: 'darwin',
    harnessVersion: '0.2.1-rc.2',
    fingerprint: '3F2A 9C41 07BE',
  ),
  RelayHost(
    id: 'nas',
    name: '书房 NAS',
    online: false,
    platform: 'linux',
    harnessVersion: '0.2.0-rc.2',
    fingerprint: 'A1B2 C3D4 E5F6',
    trust: RelayTrust.unpinned,
  ),
];

class _TrackedClient extends DshClient {
  _TrackedClient(this.onClosed) : super(DshConnection(Uri.parse('http://127.0.0.1:9')));
  final void Function(DshClient) onClosed;

  @override
  Future<void> close() async {
    onClosed(this);
    await super.close();
  }
}
