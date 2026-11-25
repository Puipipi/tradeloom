// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import '../../state/artifacts.dart';
import '../web/web_navigation.dart';
import 'tradeloom_attachment.dart';

const _maxBytes = 64 * 1024 * 1024;
const _chunkBytes = 32 * 1024;
const _mimeTypes = {
  'catalog.html': {'text/html'},
  'catalog.md': {'text/markdown', 'text/plain', 'application/octet-stream'},
  'sample_checklist.csv': {'text/csv', 'application/vnd.ms-excel'},
  'sample_checklist.json': {'application/json'},
  'quality_report.json': {'application/json'},
};
final _disposition = RegExp(r'^attachment\s*;\s*filename\s*=\s*"([a-z_.]+)"\s*$', caseSensitive: false);

/// Owns one enterprise download on the currently authenticated ArkWeb document.
class HarmonyTradeLoomDownload {
  HarmonyTradeLoomDownload({
    required this.evaluate,
    required this.currentUrl,
    Future<Directory> Function()? cache,
    this.files = const FilesChannel(),
  }) : _cache = cache ?? getTemporaryDirectory;

  final Future<Object> Function(String) evaluate;
  final Future<String?> Function() currentUrl;
  final Future<Directory> Function() _cache;
  final FilesChannel files;
  final _owner = _newOwner();
  String get _key => jsonEncode(_owner);

  static String _newOwner() {
    final random = Random.secure();
    final suffix = List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return '__tradeLoomDownload_$suffix';
  }

  bool _cancelled = false;
  bool _started = false;
  bool _saving = false;

  void _active() {
    if (_cancelled) throw const _DownloadCancelled();
  }

  void cancel() {
    _cancelled = true;
    if (_started) unawaited(_retire());
    if (_saving) unawaited(files.cancelDownloadSave(_owner).catchError((Object _) {}));
  }

  Future<void> _retire() async {
    try {
      await evaluate('window[$_key]?.cancel(); delete window[$_key]; true').timeout(const Duration(seconds: 2));
    } on Object {
      // A replaced document or renderer has already lost its fetch.
    }
  }

  Future<Map<String, dynamic>> _next() async {
    final watch = Stopwatch()..start();
    const deadline = Duration(seconds: 15);
    while (watch.elapsed < deadline) {
      _active();
      final raw = await evaluate('JSON.stringify(window[$_key]?.next() ?? {kind:"error"})')
          .timeout(deadline - watch.elapsed);
      _active();
      final decoded = raw is String ? jsonDecode(raw) : raw;
      final result = (decoded is String ? jsonDecode(decoded) : decoded) as Map<String, dynamic>;
      if (result['kind'] != 'pending') return result;
      await Future<void>.delayed(const Duration(milliseconds: 25));
    }
    throw const FormatException('Attachment download timed out');
  }

  Future<String?> save(Uri origin, Uri attachment) async {
    Directory? directory;
    RandomAccessFile? output;
    try {
      final document = await currentUrl();
      _active();
      if (document == null ||
          !staysOnOrigin(origin, document) ||
          Uri.tryParse(document)?.path.startsWith('/enterprise/') != true ||
          tradeLoomAttachmentUri(origin, attachment.toString(), isMainFrame: true) == null) {
        throw const FormatException('Attachment requires the enterprise page');
      }
      _started = true;
      final args = [_key, jsonEncode(origin.origin), jsonEncode(attachment.path), '$_chunkBytes', '$_maxBytes'];
      final started = await evaluate('$_start(${args.join(',')})').timeout(const Duration(seconds: 15));
      if (started != true) throw const FormatException('Attachment document changed');
      final header = await _next();
      final name = _disposition.firstMatch(header['disposition'] as String? ?? '')?.group(1);
      final mime = (header['mime'] as String?)?.split(';').first.trim().toLowerCase();
      final length = int.tryParse(header['length'] as String? ?? '');
      if (header['kind'] != 'header' ||
          name == null ||
          mime == null ||
          _mimeTypes[name]?.contains(mime) != true ||
          length == null ||
          length <= 0 ||
          length > _maxBytes) {
        throw const FormatException('Invalid attachment response');
      }
      directory = await (await _cache()).createTemp('tradeloom-delivery-');
      final file = File('${directory.path}/payload');
      output = await file.open(mode: FileMode.write);
      var received = 0;
      while (true) {
        final part = await _next();
        if (part['kind'] == 'end') break;
        final encoded = part['bytes'];
        if (part['kind'] != 'chunk' || encoded is! String || encoded.length > ((_chunkBytes + 2) ~/ 3) * 4) {
          throw const FormatException('Invalid attachment chunk');
        }
        final Uint8List bytes = base64Decode(encoded);
        received += bytes.length;
        if (bytes.isEmpty || bytes.length > _chunkBytes || received > length) {
          throw const FormatException('Attachment size mismatch');
        }
        await output.writeFrom(bytes);
      }
      if (received != length) throw const FormatException('Incomplete attachment');
      await output.close();
      output = null;
      _active();
      _saving = true;
      return await files.saveOwnedDownload(file.path, name: name, mime: mime, owner: _owner);
    } on _DownloadCancelled {
      return null;
    } on Object catch (error) {
      if (_cancelled || saveWindowDismissed(error)) return null;
      rethrow;
    } finally {
      _saving = false;
      if (_started) await _retire();
      try {
        await output?.close();
      } finally {
        if (directory != null) await directory.delete(recursive: true);
      }
    }
  }
}

class _DownloadCancelled implements Exception {
  const _DownloadCancelled();
}

// Each pull takes one bounded payload. The next stream read starts only after
// Dart has consumed the previous result, and credentials stay inside ArkWeb.
const _start = r'''(function(key, origin, path, chunkBytes, maxBytes) {
  if (location.origin !== origin || !location.pathname.startsWith('/enterprise/')) return false;
  const abort = new AbortController();
  let reader, buffer, offset = 0, total = 0;
  let reply, reading = false;
  window[key] = {
    cancel() { abort.abort(); },
    next() {
      if (reply) {
        const value = reply;
        reply = undefined;
        return value;
      }
      if (reader && !reading) {
        reading = true;
        const read = async () => {
          if (!buffer) {
            const result = await reader.read();
            if (result.done) return {kind: 'end'};
            buffer = result.value;
            total += buffer.length;
            if (total > maxBytes) throw new Error();
          }
          const chunk = buffer.subarray(offset, offset + chunkBytes);
          offset += chunk.length;
          if (offset === buffer.length) { buffer = undefined; offset = 0; }
          let text = '';
          for (const byte of chunk) text += String.fromCharCode(byte);
          return {kind: 'chunk', bytes: btoa(text)};
        };
        read().then(value => { reply = value; }, () => { abort.abort(); reply = {kind: 'error'}; })
          .finally(() => { reading = false; });
      }
      return {kind: 'pending'};
    }
  };
  fetch(origin + path, {credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: abort.signal})
    .then(response => {
      const headers = response.headers;
      if (response.status !== 200 || !response.body || response.url !== origin + path ||
          (headers.get('content-encoding') || 'identity').toLowerCase() !== 'identity') throw new Error();
      reader = response.body.getReader();
      reply = {
        kind: 'header',
        disposition: headers.get('content-disposition'),
        mime: headers.get('content-type'),
        length: headers.get('content-length')
      };
    })
    .catch(() => { abort.abort(); reply = {kind: 'error'}; });
  return true;
})''';
