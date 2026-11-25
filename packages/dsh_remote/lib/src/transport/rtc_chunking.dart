// SPDX-FileCopyrightText: 2026 DSH Remote contributors
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.
// DataChannel chunking of upstream packages/webrtc/src/rtc-chunking.ts:
// Noise ciphertext above 8 KiB travels as `RTCH` chunks (some Host WebRTC
// stacks stall on large SCTP messages). Below Noise, above the DataChannel;
// the wire format must match upstream byte for byte.
library;

import 'dart:typed_data';

const int rtcChunkHeaderBytes = 12;
const int rtcChunkPayloadBytes = 8 * 1024;
const int rtcChunkMaxMessageBytes = 4 * 1024 * 1024;
const int _maxTotal = rtcChunkMaxMessageBytes ~/ rtcChunkPayloadBytes;
const int _maxInFlight = 8;
const Duration _maxAssemblyAge = Duration(seconds: 30);
const List<int> _magic = [0x52, 0x54, 0x43, 0x48]; // "RTCH"

/// Thrown for a chunk sequence that must close the connection.
class RtcChunkError implements Exception {
  const RtcChunkError(this.message);
  final String message;

  @override
  String toString() => 'RtcChunkError: $message';
}

class _Assembly {
  _Assembly(this.total);
  final int total;
  final List<Uint8List> chunks = [];
  int bytes = 0;
  DateTime updatedAt = DateTime.now();
}

/// `RTCH` framing: `magic(4) messageId(u32) index(u16) total(u16) payload`,
/// big-endian. Messages up to 8 KiB go unchanged.
class RtcChunkCodec {
  int _nextId = 1;
  final Map<int, _Assembly> _assemblies = {};

  List<Uint8List> encode(Uint8List data) {
    if (data.length <= rtcChunkPayloadBytes) return [data];
    if (data.length > rtcChunkMaxMessageBytes) {
      throw const RtcChunkError('WebRTC transport message exceeds the reassembly limit.');
    }
    final id = _nextId;
    _nextId = id == 0xffffffff ? 1 : id + 1;
    final total = (data.length + rtcChunkPayloadBytes - 1) ~/ rtcChunkPayloadBytes;
    final frames = <Uint8List>[];
    for (var index = 0; index < total; index++) {
      final start = index * rtcChunkPayloadBytes;
      final length = (data.length - start).clamp(0, rtcChunkPayloadBytes);
      final frame = Uint8List(rtcChunkHeaderBytes + length)
        ..setAll(0, _magic)
        ..setRange(rtcChunkHeaderBytes, rtcChunkHeaderBytes + length, data, start);
      ByteData.sublistView(frame)
        ..setUint32(4, id)
        ..setUint16(8, index)
        ..setUint16(10, total);
      frames.add(frame);
    }
    return frames;
  }

  /// The whole message once [frame] completes one, else `null`. Throws
  /// [RtcChunkError] for anything out of order, duplicated or oversized.
  Uint8List? decode(Uint8List frame) {
    if (!_isChunk(frame)) {
      if (frame.length > rtcChunkMaxMessageBytes) {
        throw const RtcChunkError('WebRTC transport message exceeds the reassembly limit.');
      }
      return frame;
    }
    if (frame.length < rtcChunkHeaderBytes) throw const RtcChunkError('WebRTC transport chunk header is invalid.');
    final view = ByteData.sublistView(frame);
    final id = view.getUint32(4);
    final index = view.getUint16(8);
    final total = view.getUint16(10);
    if (id == 0 || total < 2 || total > _maxTotal || index >= total) {
      throw const RtcChunkError('WebRTC transport chunk metadata is invalid.');
    }
    final chunk = Uint8List.sublistView(frame, rtcChunkHeaderBytes);
    if (chunk.length > rtcChunkPayloadBytes ||
        (index < total - 1 && chunk.length != rtcChunkPayloadBytes) ||
        (index == total - 1 && chunk.isEmpty)) {
      throw const RtcChunkError('WebRTC transport chunk length is invalid.');
    }
    final now = DateTime.now();
    _assemblies.removeWhere((_, a) => now.difference(a.updatedAt) > _maxAssemblyAge);
    var assembly = _assemblies[id];
    if (assembly == null) {
      if (index != 0 || _assemblies.length >= _maxInFlight) {
        throw const RtcChunkError('WebRTC transport chunk sequence is invalid.');
      }
      assembly = _assemblies[id] = _Assembly(total);
    }
    if (assembly.total != total || index != assembly.chunks.length) {
      _assemblies.remove(id);
      throw const RtcChunkError('WebRTC transport chunk sequence is invalid.');
    }
    assembly
      ..chunks.add(Uint8List.fromList(chunk))
      ..bytes += chunk.length
      ..updatedAt = now;
    if (assembly.chunks.length < total) return null;
    _assemblies.remove(id);
    final message = Uint8List(assembly.bytes);
    var offset = 0;
    for (final part in assembly.chunks) {
      message.setAll(offset, part);
      offset += part.length;
    }
    return message;
  }

  void reset() {
    _nextId = 1;
    _assemblies.clear();
  }

  static bool _isChunk(Uint8List frame) {
    if (frame.length < _magic.length) return false;
    for (var i = 0; i < _magic.length; i++) {
      if (frame[i] != _magic[i]) return false;
    }
    return true;
  }
}
