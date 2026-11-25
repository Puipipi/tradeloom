import 'package:dsh_client/dsh_client.dart';

/// A mux that is ready at once, for fake local clients: the local connection
/// starts the mux itself and waits for it before its repairs.
class ReadyMux extends DshMux {
  ReadyMux() : super(DshHttpCarrier(DshConnection(Uri.parse('http://127.0.0.1:9'))));

  @override
  Future<MuxGeneration> ready({Duration? timeout}) async => const MuxGeneration(1, 'fixture', '/tmp');
}
