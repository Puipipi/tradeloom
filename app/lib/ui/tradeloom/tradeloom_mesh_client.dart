// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import 'dart:convert';

import 'package:dsh_client/dsh_client.dart';

typedef TradeLoomMeshDevice = ({String nodeId, String name, bool isSelf, bool online, String? clientDeviceId});

class TradeLoomMeshFailure implements Exception {
  const TradeLoomMeshFailure(this.statusCode, [this.code]);
  final int statusCode;
  final String? code;
}

/// Read-only Mesh adapter for the App's authenticated, local DSH runtime.
/// The runtime owns relay credentials and performs all relay connections.
class TradeLoomMeshClient {
  TradeLoomMeshClient(this._engine) {
    final origin = _engine.baseUri;
    if (!const {'localhost', '127.0.0.1', '::1'}.contains(origin.host) ||
        !const {'http', 'https'}.contains(origin.scheme) ||
        _engine.hostHeader != null) {
      throw ArgumentError('A local runtime connection is required.');
    }
  }

  static const _root = '/.dsh-mesh/v1';
  static const _responseLimit = 4 * 1024 * 1024;
  static const _timeout = Duration(seconds: 35);
  final DshConnection _engine;

  Future<Map<String, Object?>> status() => _get('/status');

  Future<Map<String, Object?>> preferences() => _get('/prefs');

  Future<void> pair(String invitation, {required bool confirmed}) async {
    if (!confirmed) throw StateError('Confirm the pairing before proceeding.');
    await _post('/pair', {'pairing': invitation.trim(), 'confirmed': true});
  }

  Future<List<TradeLoomMeshDevice>> devices() async {
    final response = await _get('/nodes');
    final items = response['items'];
    if (items is! List) throw const FormatException('Invalid Mesh device directory.');
    return items
        .map((item) {
          if (item is! Map<String, Object?> || item['nodeId'] is! String || item['name'] is! String) {
            throw const FormatException('Invalid Mesh device.');
          }
          return (
            nodeId: item['nodeId'] as String,
            name: item['name'] as String,
            isSelf: item['self'] == true,
            online: item['online'] == true,
            clientDeviceId: item['clientDeviceId'] as String?,
          );
        })
        .toList(growable: false);
  }

  Future<void> checkReadAccess(String nodeId) async {
    final result = await _get('/access', query: {'nodeId': nodeId});
    if (result['allowed'] != true) throw const TradeLoomMeshFailure(403, 'not_connected');
  }

  Future<Map<String, Object?>> catalog(String nodeId) => _get('/tree', query: {'nodeId': nodeId});

  Future<Map<String, Object?>> session(String nodeId, String sessionId) =>
      _get('/sessions/${Uri.encodeComponent(nodeId)}/${Uri.encodeComponent(sessionId)}/page');

  Future<void> setReadConsent(String clientDeviceId, {required bool allow}) async {
    await _post('/consent', {'deviceId': clientDeviceId, 'allow': allow});
  }

  Future<void> unpair() async {
    await _post('/unpair', const {});
  }

  Future<Map<String, Object?>> _get(String path, {Map<String, String>? query}) async => _decode(
    await _engine.get(
      '$_root$path',
      query: query,
      followRedirects: false,
      maxResponseBytes: _responseLimit,
      timeout: _timeout,
    ),
  );

  Future<Map<String, Object?>> _post(String path, Map<String, Object?> data) async => _decode(
    await _engine.postBytes(
      '$_root$path',
      utf8.encode(jsonEncode(data)),
      contentType: 'application/json',
      followRedirects: false,
      maxResponseBytes: _responseLimit,
      timeout: _timeout,
    ),
  );

  Map<String, Object?> _decode(DshHttpResponse response) {
    if (response.statusCode != 200) {
      String? code;
      try {
        final data = jsonDecode(response.text);
        if (data is Map && data['error'] is String) code = data['error'] as String;
      } on FormatException {
        // Older engines can return HTML for an unavailable plugin route.
      }
      throw TradeLoomMeshFailure(response.statusCode, code);
    }
    final data = jsonDecode(response.text);
    if (data is! Map<String, Object?>) throw const FormatException('Invalid Mesh response.');
    return data;
  }
}
