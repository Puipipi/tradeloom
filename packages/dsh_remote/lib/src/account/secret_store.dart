/// Pluggable secret storage for device identity, tokens and Host pins.
library;

import 'dart:async';

/// Key-value store for secrets. The app backs it with
/// `flutter_secure_storage` (Android Keystore); tests use
/// [MemorySecretStore].
///
/// Values are JSON strings; keys look like
/// `dsh_remote.v1.<serverScope>.identity`. [write] must be atomic per key
/// (a refresh-token rotation is persisted with a single write).
abstract interface class SecretStore {
  Future<String?> read(String key);

  Future<void> write(String key, String value);

  Future<void> delete(String key);
}

/// In-memory [SecretStore] (tests, CLI probes).
class MemorySecretStore implements SecretStore {
  MemorySecretStore([Map<String, String>? initial]) : values = {...?initial};

  final Map<String, String> values;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
