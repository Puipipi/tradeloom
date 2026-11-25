import 'dart:io';
import 'dart:typed_data';

import '../ssh_errors.dart';
import '../ssh_packet.dart';

const sshZlibSupported = true;

/// One continuous RFC 1950 stream per direction and key-exchange epoch.
class SSHZlib {
  final bool _compress;
  RawZLibFilter? _filter;

  SSHZlib({required bool compress})
      : _compress = compress,
        _filter = compress
            ? RawZLibFilter.deflateFilter()
            : RawZLibFilter.inflateFilter();

  Uint8List process(Uint8List payload) {
    final filter = _filter!;
    final output = BytesBuilder(copy: false);
    try {
      filter.process(payload, 0, payload.length);
      while (true) {
        // Z_SYNC_FLUSH emits the packet boundary without ending the stream.
        final chunk = filter.processed(flush: true);
        if (chunk == null) break;
        if (!_compress && output.length + chunk.length > SSHPacket.maxLength) {
          throw SSHPacketError('Decompressed SSH payload exceeds '
              '${SSHPacket.maxLength} bytes');
        }
        output.add(chunk);
      }
    } on SSHPacketError {
      rethrow;
    } on Object catch (error) {
      throw SSHPacketError('Invalid SSH zlib stream: $error');
    }
    return output.takeBytes();
  }

  void close() {
    // RawZLibFilter has no abort/dispose method. Drop it for native finalization;
    // do not finish or drain untrusted input on close or emit a zlib trailer.
    _filter = null;
  }
}
