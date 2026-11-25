// Ordinary outages keep backing off and retrying; a protocol mismatch stops
// at once and waits for a manual retry (RemoteTunnelCarrier.reconnect).
import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

void main() {
  test('a network outage keeps retrying past any small budget', () async {
    var attempts = 0;
    final carrier = RemoteTunnelCarrier(
      hostId: 'host',
      open: (_) async {
        attempts++;
        throw const RemoteConnectException(RemoteFailure('CONNECTION_FAILED', 'Socket closed.', retryable: true));
      },
    );
    final client = DshClient.withCarrier(carrier, muxOptions: const MuxOptions(retryCaps: [Duration(milliseconds: 2)]));
    carrier.attachMux(client.mux);
    addTearDown(client.close);
    client.mux.ready(timeout: const Duration(seconds: 5)).ignore();
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (attempts < 12 && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(attempts, greaterThanOrEqualTo(12));
    expect(carrier.lastFailure?.code, 'CONNECTION_FAILED');
  });

  test('a protocol mismatch stops after one attempt until a manual retry', () async {
    var attempts = 0;
    final carrier = RemoteTunnelCarrier(
      hostId: 'host',
      open: (_) async {
        attempts++;
        throw const RemoteConnectException(RemoteFailure('PROTOCOL_MISMATCH', 'Unknown Control frame type.', retryable: false));
      },
    );
    final client = DshClient.withCarrier(carrier, muxOptions: const MuxOptions(retryCaps: [Duration(milliseconds: 2)]));
    carrier.attachMux(client.mux);
    addTearDown(client.close);
    final failed = carrier.states.firstWhere((s) => s.phase == RemoteConnectionPhase.failed);
    client.mux.ready(timeout: const Duration(seconds: 2)).ignore();
    expect((await failed.timeout(const Duration(seconds: 2))).failure?.code, 'PROTOCOL_MISMATCH');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(attempts, 1, reason: 'no reconnect loop after a protocol mismatch');

    final failedAgain = carrier.states.firstWhere((s) => s.phase == RemoteConnectionPhase.failed);
    carrier.reconnect();
    await failedAgain.timeout(const Duration(seconds: 2));
    expect(attempts, 2, reason: 'a manual retry tries once more');
  });
}
