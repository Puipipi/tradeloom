import 'dart:typed_data';

const sshZlibSupported = false;

class SSHZlib {
  SSHZlib({required bool compress});

  Uint8List process(Uint8List payload) =>
      throw UnsupportedError('SSH zlib compression requires dart:io');

  void close() {}
}
