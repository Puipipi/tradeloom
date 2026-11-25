import 'dart:async';

import 'package:dsh_client/dsh_client.dart';

import '../../l10n/l10n.dart';
import '../link_status.dart';

/// A sign-in provider the Server offers for browser sign-in
/// (`github`, `zhihu`, `google`, ...). IDs are Server-owned and opaque.
class RelayAuthProvider {
  const RelayAuthProvider({required this.id, required this.displayName});

  final String id;

  /// Server-supplied label (untrusted: truncate it in the UI).
  final String displayName;

  @override
  String toString() => 'RelayAuthProvider($id)';
}

/// Signed-in DSH Remote (ds-harness-remote) account.
class RelayUser {
  const RelayUser({required this.id, required this.displayName, this.provider});

  final String id;
  final String displayName;

  /// `github` / `zhihu` / `google` / `password`, when known.
  final String? provider;
}

/// Whether this phone already trusts a Host's identity key.
enum RelayTrust {
  /// Pinned and unchanged.
  pinned,

  /// Never connected: ask the person before the first connect.
  unpinned,

  /// The Server reports a different key than the pinned one: fail closed.
  keyChanged,

  /// Descriptor unavailable.
  unknown,
}

/// A Host device registered on the account (a computer running DSH with the
/// ds-harness-remote plugin).
class RelayHost {
  const RelayHost({
    required this.id,
    required this.name,
    required this.online,
    this.platform,
    this.harnessVersion,
    this.fingerprint,
    this.trust = RelayTrust.pinned,
  });

  final String id;

  /// Untrusted display name from the Server.
  final String name;
  final bool online;

  /// e.g. `darwin`, `linux`, `windows`.
  final String? platform;
  final String? harnessVersion;

  /// `ABCD EF01 2345` of the Host's identity key, to compare with the Host.
  final String? fingerprint;
  final RelayTrust trust;

  /// "macOS · Harness 0.2.1-rc.2".
  String get subtitle {
    final parts = <String>[
      if (platform case final p? when p.isNotEmpty) platformLabel(p),
      if (harnessVersion case final v? when v.isNotEmpty) 'Harness $v',
    ];
    return parts.isEmpty ? (online ? appL10n.remoteOnline : appL10n.remoteOffline) : parts.join(' · ');
  }

  static String platformLabel(String raw) => switch (raw.toLowerCase()) {
    'darwin' || 'macos' || 'mac' => 'macOS',
    'linux' => 'Linux',
    'win32' || 'windows' => 'Windows',
    _ => raw,
  };
}

/// A browser login in flight: open [loginUrl], then wait for [completed].
class RelayLoginSession {
  RelayLoginSession({required this.loginUrl, required this.completed, this._onCancel});

  final Uri loginUrl;

  /// Resolves once the account has authorized this device (polling).
  final Future<RelayUser> completed;
  final void Function()? _onCancel;

  void cancel() => _onCancel?.call();
}

/// Connection progress reported by the relay transport. The client
/// reconnects by itself after drops; [failed] means it stopped and needs the
/// person (the error says why).
enum RelayConnectionState { connecting, handshaking, connected, reconnecting, failed, disconnected }

typedef RelayStateCallback = void Function(RelayConnectionState state, HostLinkError? error);

/// What dsh-app needs from `packages/dsh_remote` (李国宝's ds-harness-remote
/// protocol), implemented by `DshRemoteRelayBackend`. [UnavailableRelayBackend]
/// turns the relay off; tests use a fake.
abstract class RelayBackend {
  /// False when the relay is turned off ([UnavailableRelayBackend]).
  bool get available;

  /// Server shown in the UI (`dsh.r2049.cn`).
  String get serverLabel;

  Future<RelayUser?> currentUser();

  /// Providers this Server offers for browser sign-in. Empty when it offers
  /// none (self-hosted Servers sign in with email + password).
  Future<List<RelayAuthProvider>> loginProviders();

  /// Starts a QR/browser login with [providerId] (default: the Server's
  /// first provider); the app opens [RelayLoginSession.loginUrl] in a Custom
  /// Tab and awaits [RelayLoginSession.completed].
  Future<RelayLoginSession> login({String? providerId});

  /// Email + password: self-hosted servers (and invited accounts).
  Future<RelayUser> loginWithPassword(String email, String password);

  Future<void> logout();

  /// Hosts on the account with live presence. [refresh] bypasses caches.
  Future<List<RelayHost>> listHosts({bool refresh = false});

  /// The person confirmed [host]'s fingerprint: pin it on the next connect,
  /// but only if the Host still presents exactly that key.
  void approveHost(RelayHost host);

  /// Forgets a changed key and approves the one in [host] (after the person
  /// confirmed the Host was reinstalled).
  Future<void> forgetHost(RelayHost host);

  /// Restarts [client]'s connection after a terminal failure the person has
  /// dealt with (a stopped relay client never retries by itself). False when
  /// [client] isn't a relay client.
  bool reconnect(DshClient client);

  /// Checks [client]'s tunnel now (after a network change); a dead one
  /// reconnects. True when it answered or [client] isn't a relay client.
  Future<bool> probe(DshClient client);

  /// How [client]'s current tunnel travels; null when it has none.
  RelayPath? pathOf(DshClient client);

  /// Opens an end-to-end encrypted tunnel to [host] and returns a ready
  /// client. [onState] reports progress and later drops/reconnects.
  Future<DshClient> connectHost(RelayHost host, {RelayStateCallback? onState});
}

/// Optional real network observations, without expanding the account/backend contract.
abstract interface class RelayNetworkBackend {
  RemoteNetworkStatus? networkOf(DshClient client);
  Future<RemoteNetworkStatus?> inspectNetwork(DshClient client);
}

/// The relay turned off: nothing to sign in to or connect to.
class UnavailableRelayBackend implements RelayBackend {
  const UnavailableRelayBackend();

  static HostLinkError get _error => HostLinkError(HostLinkErrorKind.unavailable, appL10n.remoteUnavailable);

  @override
  bool get available => false;

  @override
  String get serverLabel => 'dsh.r2049.cn';

  @override
  Future<RelayUser?> currentUser() async => null;

  @override
  Future<List<RelayAuthProvider>> loginProviders() async => const [];

  @override
  Future<RelayLoginSession> login({String? providerId}) => Future.error(_error);

  @override
  Future<RelayUser> loginWithPassword(String email, String password) => Future.error(_error);

  @override
  Future<void> logout() async {}

  @override
  Future<List<RelayHost>> listHosts({bool refresh = false}) async => const [];

  @override
  void approveHost(RelayHost host) {}

  @override
  Future<void> forgetHost(RelayHost host) async {}

  @override
  bool reconnect(DshClient client) => false;

  @override
  Future<bool> probe(DshClient client) async => true;

  @override
  RelayPath? pathOf(DshClient client) => null;

  @override
  Future<DshClient> connectHost(RelayHost host, {RelayStateCallback? onState}) => Future.error(_error);
}

/// [HostLink] over a [RelayBackend] connection.
class RelayHostLink implements HostLink, NetworkInspectableHostLink {
  RelayHostLink({
    required this.backend,
    required this.hostId,
    required this.resolveHost,
    Stream<void>? kicks,
    Backoff? backoff,
  }) : _backoff = backoff ?? Backoff() {
    _kickSub = kicks?.listen((_) => kick());
  }

  final RelayBackend backend;
  final String hostId;

  /// Looks the host up in the account's (refreshed) list.
  final Future<RelayHost?> Function() resolveHost;
  final Backoff _backoff;

  final _statuses = StreamController<HostLinkStatus>.broadcast(sync: true);
  final _clients = StreamController<DshClient>.broadcast();
  final _delay = InterruptibleDelay();
  StreamSubscription<void>? _kickSub;
  HostLinkStatus _status = HostLinkStatus.idle;
  DshClient? _client;
  Future<DshClient>? _opening;
  bool _closed = false;
  Future<RemoteNetworkStatus?>? _networkInspection;
  int _networkEpoch = 0;

  /// The first client goes out through [open]; later ones through [clients].
  bool _published = false;
  int _attempt = 0;

  @override
  HostLinkStatus get status => _status;

  @override
  Stream<HostLinkStatus> get statuses => _statuses.stream;

  @override
  Stream<DshClient> get clients => _clients.stream;

  @override
  DshClient? get currentClient => _status.isConnected ? _client : null;

  void _emit(HostLinkStatus next) {
    if (_closed) return;
    _status = next;
    _statuses.add(next);
  }

  @override
  Future<DshClient> open() {
    if (_closed) return Future.error(StateError('link closed'));
    final client = currentClient;
    if (client != null) return Future.value(client);
    return _opening ??= _run().whenComplete(() => _opening = null);
  }

  Future<DshClient> _run() async {
    _backoff.reset();
    var last = HostLinkError(HostLinkErrorKind.other, appL10n.commonConnectionFailed, retryable: true);
    while (!_closed) {
      try {
        return await _connectOnce();
      } on HostLinkError catch (e) {
        last = e;
      } catch (e) {
        last = HostLinkError(HostLinkErrorKind.other, appL10n.commonConnectionFailed, detail: '$e', retryable: true);
      }
      if (_closed || !last.retryable || _backoff.exhausted) break;
      final delay = _backoff.next();
      _emit(
        HostLinkStatus(
          HostLinkPhase.reconnecting,
          attempt: _backoff.attempt,
          error: last,
          nextRetryAt: DateTime.now().add(delay),
        ),
      );
      await _delay.wait(delay);
    }
    _emit(HostLinkStatus(HostLinkPhase.failed, error: last));
    throw last;
  }

  Future<DshClient> _connectOnce() async {
    final attempt = ++_attempt;
    if (!backend.available) {
      throw HostLinkError(HostLinkErrorKind.unavailable, appL10n.remoteUnavailable);
    }
    _emit(_status.withStep(HostLinkStep.connect));
    final host = await resolveHost();
    if (_closed) throw StateError('link closed');
    if (host == null) {
      throw HostLinkError(HostLinkErrorKind.notLoggedIn, appL10n.remoteErrHostNotFound);
    }
    if (!host.online) {
      throw HostLinkError(HostLinkErrorKind.hostOffline, appL10n.remoteErrHostOffline, retryable: true);
    }
    final previous = _client;
    _client = null;
    if (previous != null) unawaited(previous.close().catchError((_) {}));
    // States from an earlier attempt's client (closing now) are stale.
    (RelayConnectionState, HostLinkError?)? latestState;
    final client = await backend.connectHost(
      host,
      onState: (state, error) {
        if (attempt != _attempt) return;
        latestState = (state, error);
        _onRelayState(state, error);
      },
    );
    if (_closed) {
      await client.close();
      throw StateError('link closed');
    }
    _client = client;
    // Ready may have been followed by a loss before this continuation ran.
    if (latestState case (final state, final error)
        when state == RelayConnectionState.reconnecting ||
            state == RelayConnectionState.failed ||
            state == RelayConnectionState.disconnected) {
      _onRelayState(state, error);
    } else {
      _emit(_connected(client));
    }
    if (_published) _clients.add(client);
    _published = true;
    return client;
  }

  /// States from the relay client. Before [open] resolves they only move the
  /// progress steps; afterwards the client's own reconnects drive the status.
  void _onRelayState(RelayConnectionState state, HostLinkError? error) {
    _networkEpoch++;
    final opened = _client != null;
    switch (state) {
      case RelayConnectionState.connecting:
        if (!opened) _emit(_status.withStep(HostLinkStep.connect));
      case RelayConnectionState.handshaking:
        if (!opened) _emit(_status.withStep(HostLinkStep.login));
      case RelayConnectionState.connected:
        if (opened) _emit(_connected(_client!));
      case RelayConnectionState.reconnecting:
        if (opened) {
          _reconnects++;
          _emit(HostLinkStatus(HostLinkPhase.reconnecting, attempt: _reconnects, error: error));
        }
      case RelayConnectionState.failed:
        if (opened) {
          _emit(
            HostLinkStatus(
              HostLinkPhase.failed,
              error: error ?? HostLinkError(HostLinkErrorKind.other, appL10n.remoteConnectionStopped),
            ),
          );
        }
      case RelayConnectionState.disconnected:
        _client = null;
        _emit(HostLinkStatus.idle);
    }
    if (state == RelayConnectionState.connected) _reconnects = 0;
  }

  int _reconnects = 0;

  HostLinkStatus _connected(DshClient client) {
    final network = backend is RelayNetworkBackend ? (backend as RelayNetworkBackend).networkOf(client) : null;
    return HostLinkStatus(
      HostLinkPhase.connected,
      completed: HostLinkStep.values.toSet(),
      path: backend.pathOf(client),
      network: network,
    );
  }

  @override
  Future<RemoteNetworkStatus?> inspectNetwork() {
    final client = currentClient;
    final inspector = backend;
    if (_closed || client == null || inspector is! RelayNetworkBackend) return Future.value(null);
    return _networkInspection ??= _inspectNetwork(
      client,
      inspector as RelayNetworkBackend,
    ).whenComplete(() => _networkInspection = null);
  }

  Future<RemoteNetworkStatus?> _inspectNetwork(DshClient client, RelayNetworkBackend inspector) async {
    final epoch = _networkEpoch;
    try {
      final value = await inspector.inspectNetwork(client).timeout(const Duration(seconds: 3), onTimeout: () => null);
      if (_closed || epoch != _networkEpoch || currentClient != client || value == null) return null;
      _emit(_status.withNetwork(value));
      return value;
    } catch (_) {
      return null;
    }
  }

  @override
  void kick() {
    if (_closed) return;
    if (_status.phase == HostLinkPhase.connected) {
      // The tunnel's health check would notice a dead network only later.
      final client = _client;
      if (client != null) unawaited(backend.probe(client).then((_) {}, onError: (_) {}));
    } else if (_status.phase == HostLinkPhase.reconnecting) {
      // Cut the wait short: our retry loop's, the relay client's own, or
      // connect afresh when that client is gone.
      if (_opening != null) {
        _backoff.reset();
        _delay.skip();
        return;
      }
      final client = _client;
      if (client != null && backend.reconnect(client)) return;
      unawaited(open().then((_) {}, onError: (_) {}));
    } else if (_status.phase == HostLinkPhase.failed && (_status.error?.retryable ?? false)) {
      retry();
    }
  }

  /// "重新连接". A client that stopped on a terminal failure (replaced by
  /// another device, trust fixed, …) is restarted in place; without one, a
  /// fresh connect publishes a new client through [clients].
  @override
  void retry() {
    if (_status.phase == HostLinkPhase.reconnecting) {
      kick();
      return;
    }
    if (_status.isBusy) return;
    final client = _client;
    if (_status.phase == HostLinkPhase.failed && client != null && backend.reconnect(client)) {
      _emit(const HostLinkStatus(HostLinkPhase.reconnecting, attempt: 1));
      return;
    }
    unawaited(open().then((_) {}, onError: (_) {}));
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _delay.cancel();
    await _kickSub?.cancel();
    final client = _client;
    _client = null;
    if (client != null) await client.close().catchError((_) {});
    await _statuses.close();
    await _clients.close();
  }
}

// ── Scan-to-pair (device pairing v1) ─────────────────────────────────────────

/// A computer's pairing code, resolved but not claimed: show it and let the
/// person confirm it is their computer before [RelayPairingBackend.claimPairing].
class RelayPairingOffer {
  const RelayPairingOffer({
    required this.server,
    required this.hostName,
    required this.hostPlatform,
    required this.fingerprint,
    required this.token,
  });

  /// Origin of the Server the code belongs to (`https://dsh.r2049.cn`).
  final String server;

  /// Untrusted display name from the code / Server.
  final String hostName;
  final String hostPlatform;

  /// Full `lowercaseHex(SHA256(key))`, the same 64 digits the computer shows.
  final String fingerprint;

  /// The backend's own session object.
  final Object token;
}

/// Where a claimed pairing stands while the phone shows the code.
enum RelayPairingPhase {
  /// The computer has not submitted the code yet.
  waiting,

  /// The computer submitted the right code; the Server is finishing.
  approved,
}

/// A claimed pairing: show [code] until [completed] resolves.
class RelayPairingSession {
  RelayPairingSession({
    required this.code,
    required this.codeExpiresAt,
    required this.phases,
    required this.completed,
    required this._onPause,
    required this._onCancel,
  });

  /// 8 digits, leading zeros kept. Only ever shown on the pairing screen.
  final String code;
  final DateTime codeExpiresAt;
  final Stream<RelayPairingPhase> phases;

  /// The paired Host (its key pinned, this phone signed in); fails with a
  /// [RelayPairingError].
  final Future<RelayHost> completed;
  final void Function(bool paused) _onPause;
  final Future<void> Function() _onCancel;

  /// Polling stops in the background.
  set paused(bool value) => _onPause(value);

  Future<void> cancel() => _onCancel();
}

enum RelayPairingErrorKind {
  /// Not a pairing code (or an insecure / malformed one).
  invalidCode,

  /// The code belongs to another Server ([RelayPairingError.server]).
  otherServer,

  /// This Server cannot pair by scanning.
  unsupported,

  /// The code or session expired: show a new code on the computer.
  expired,

  /// The computer typed a wrong code: the session is over.
  codeRejected,
  cancelled,

  /// The phone is signed in to another account than the computer's owner.
  accountConflict,

  /// The session no longer matches the computer or this phone.
  identityMismatch,
  network,
  other,
}

class RelayPairingError implements Exception {
  const RelayPairingError(this.kind, this.message, {this.server, this.detail});

  final RelayPairingErrorKind kind;
  final String message;

  /// For [RelayPairingErrorKind.otherServer]: the code's Server origin.
  final String? server;

  /// Code and English text for diagnostics (never the pairing code).
  final String? detail;

  /// The whole scan has to start over (a new code on the computer).
  bool get needsNewCode =>
      kind == RelayPairingErrorKind.expired ||
      kind == RelayPairingErrorKind.codeRejected ||
      kind == RelayPairingErrorKind.identityMismatch;

  @override
  String toString() => 'RelayPairingError($kind${detail == null ? '' : ', $detail'})';
}

/// Scan-to-pair, implemented by `DshRemoteRelayBackend`; a backend without it
/// shows no pairing entry.
abstract interface class RelayPairingBackend {
  /// Whether this Server pairs by scanning (false when it cannot be asked).
  Future<bool> supportsPairing();

  /// Parses and resolves scanned text (nothing is claimed yet).
  Future<RelayPairingOffer> resolvePairing(String scanned);

  /// Claims [offer] once the person confirmed the computer. [deepseekUserId]
  /// is optional, unverified metadata.
  Future<RelayPairingSession> claimPairing(RelayPairingOffer offer, {String? deepseekUserId});
}
