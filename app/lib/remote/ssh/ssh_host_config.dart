import 'dart:math' as math;

/// How an SSH host authenticates. The secret itself lives in the
/// [SecretStore] under [SshSecrets] keys, never in this config.
enum SshAuthMethod { password, privateKey }

/// Whether the app owns the remote DSH process or only opens a tunnel to it.
enum SshDshMode { managed, attachOnly }

/// The remote `dsh web` launch command used when none is configured.
const defaultDshLaunchCommand = 'dsh web';

/// One saved SSH host. Persisted as JSON in SharedPreferences (no secrets).
class SshHostConfig {
  const SshHostConfig({
    required this.id,
    required this.name,
    required this.host,
    this.port = 22,
    required this.user,
    this.auth = SshAuthMethod.password,
    this.launchCommand = defaultDshLaunchCommand,
    this.dshMode = SshDshMode.managed,
    this.remotePort = 3080,
    this.compression = true,
    this.workingDirectory,
    this.hostKeyType,
    this.hostKeyFingerprint,
  });

  /// Stable id (`ssh-<hex>`); also the secret-store namespace.
  final String id;

  /// What the person calls it ("电脑", "家里的 Mac").
  final String name;
  final String host;
  final int port;
  final String user;
  final SshAuthMethod auth;
  final SshDshMode dshMode;

  /// Fixed remote loopback port in attach-only mode.
  final int remotePort;

  /// Negotiate delayed SSH compression when supported by the server.
  final bool compression;

  /// Shell command that starts DSH's web server on the remote. dsh-app appends
  /// `--host 127.0.0.1 --port 0 --no-open`.
  final String launchCommand;

  /// Default cwd for new conversations on this host (and where `dsh web`
  /// starts). `~/…` is expanded on the remote. Null: DSH's own default.
  final String? workingDirectory;

  /// Pinned host key (trust on first use), e.g. `ssh-ed25519` and the
  /// OpenSSH `SHA256:…` fingerprint. Null until the person accepts it.
  final String? hostKeyType;
  final String? hostKeyFingerprint;

  String get address => port == 22 ? '$user@$host' : '$user@$host:$port';

  bool get usesDefaultCommand => launchCommand.trim() == defaultDshLaunchCommand;

  /// Fields that require a new SSH session when they change (name and the
  /// pinned key don't).
  String get connectionKey =>
      [host, port, user, auth.name, dshMode.name, remotePort, compression, launchCommand.trim()].join('\u0000');

  /// Changing where we connect forgets the pinned key: it belonged to the old
  /// machine.
  SshHostConfig copyWith({
    String? name,
    String? host,
    int? port,
    String? user,
    SshAuthMethod? auth,
    String? launchCommand,
    SshDshMode? dshMode,
    int? remotePort,
    bool? compression,
    String? Function()? workingDirectory,
    String? Function()? hostKeyType,
    String? Function()? hostKeyFingerprint,
  }) {
    final moved = (host != null && host != this.host) || (port != null && port != this.port);
    return SshHostConfig(
      id: id,
      name: name ?? this.name,
      host: host ?? this.host,
      port: port ?? this.port,
      user: user ?? this.user,
      auth: auth ?? this.auth,
      launchCommand: launchCommand ?? this.launchCommand,
      dshMode: dshMode ?? this.dshMode,
      remotePort: remotePort ?? this.remotePort,
      compression: compression ?? this.compression,
      workingDirectory: workingDirectory != null ? workingDirectory() : this.workingDirectory,
      hostKeyType: hostKeyType != null ? hostKeyType() : (moved ? null : this.hostKeyType),
      hostKeyFingerprint: hostKeyFingerprint != null ? hostKeyFingerprint() : (moved ? null : this.hostKeyFingerprint),
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'host': host,
    'port': port,
    'user': user,
    'auth': auth.name,
    'launchCommand': launchCommand,
    'dshMode': dshMode.name,
    'remotePort': remotePort,
    'compression': compression,
    if (workingDirectory != null) 'workingDirectory': workingDirectory,
    if (hostKeyType != null) 'hostKeyType': hostKeyType,
    if (hostKeyFingerprint != null) 'hostKeyFingerprint': hostKeyFingerprint,
  };

  static SshHostConfig? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final host = raw['host'];
    final user = raw['user'];
    if (id is! String || host is! String || user is! String || id.isEmpty || host.isEmpty) return null;
    final name = raw['name'];
    final port = raw['port'];
    final command = raw['launchCommand'];
    final cwd = raw['workingDirectory'];
    final remotePort = raw['remotePort'];
    if (raw['dshMode'] == 'attachOnly' && (remotePort is! int || remotePort < 1 || remotePort > 65535)) {
      return null;
    }
    return SshHostConfig(
      id: id,
      name: name is String && name.trim().isNotEmpty ? name : host,
      host: host,
      port: port is int && port > 0 && port < 65536 ? port : 22,
      user: user,
      auth: SshAuthMethod.values.firstWhere((m) => m.name == raw['auth'], orElse: () => SshAuthMethod.password),
      launchCommand: command is String && command.trim().isNotEmpty ? command : defaultDshLaunchCommand,
      workingDirectory: cwd is String && cwd.trim().isNotEmpty ? cwd : null,
      dshMode: raw['dshMode'] == 'attachOnly' ? SshDshMode.attachOnly : SshDshMode.managed,
      remotePort: remotePort is int && remotePort > 0 && remotePort < 65536 ? remotePort : 3080,
      compression: raw['compression'] is bool ? raw['compression'] as bool : true,
      hostKeyType: raw['hostKeyType'] as String?,
      hostKeyFingerprint: raw['hostKeyFingerprint'] as String?,
    );
  }

  static String newId([math.Random? random]) {
    final r = random ?? math.Random.secure();
    final hex = List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return 'ssh-$hex';
  }

  @override
  bool operator ==(Object other) =>
      other is SshHostConfig &&
      other.id == id &&
      other.name == name &&
      other.host == host &&
      other.port == port &&
      other.user == user &&
      other.auth == auth &&
      other.launchCommand == launchCommand &&
      other.dshMode == dshMode &&
      other.remotePort == remotePort &&
      other.compression == compression &&
      other.workingDirectory == workingDirectory &&
      other.hostKeyType == hostKeyType &&
      other.hostKeyFingerprint == hostKeyFingerprint;

  @override
  int get hashCode =>
      Object.hash(id, name, host, port, user, auth, launchCommand, dshMode, remotePort, compression,
          workingDirectory, hostKeyType, hostKeyFingerprint);
}

/// The secret material for one SSH host, loaded from the [SecretStore].
class SshSecrets {
  const SshSecrets({this.password, this.privateKey, this.passphrase, this.attachToken});

  final String? password;

  /// PEM text (OpenSSH, PKCS#1 RSA or SEC1 EC).
  final String? privateKey;
  final String? passphrase;

  /// Launch token supplied by the owner of an existing DSH instance.
  final String? attachToken;

  static String passwordKey(String hostId) => 'ssh.$hostId.password';
  static String privateKeyKey(String hostId) => 'ssh.$hostId.privateKey';
  static String passphraseKey(String hostId) => 'ssh.$hostId.passphrase';
  static String attachTokenKey(String hostId) => 'ssh.$hostId.attachToken';

  bool get isEmpty => (password == null || password!.isEmpty) && (privateKey == null || privateKey!.trim().isEmpty);
}
