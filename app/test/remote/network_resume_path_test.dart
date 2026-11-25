import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'traffic/fake_host.dart';

void main() {
  testWidgets('real lifecycle resume reaches the active relay probe and disposal stops it', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    final host = FakeHost();
    final backend = TrafficRelayBackend(host);
    final container = ProviderContainer(overrides: [relayBackendProvider.overrideWithValue(backend)]);
    const target = HostRef.relay('mac');
    final subscription = container.listen(hostLinkProvider(target), (_, _) {});
    final link = container.read(hostLinkProvider(target))!;
    try {
      final opening = link.open();
      for (var i = 0; i < 16 && link.currentClient == null; i++) {
        await tester.pump(const Duration(milliseconds: 1));
      }
      expect(link.currentClient, isNotNull);
      await opening;
      host.meter.reset();
      for (final state in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
        tester.binding.handleAppLifecycleStateChanged(state);
        await tester.pump();
      }
      expect(host.meter.count('probe harness.transport.describe'), 0);
      for (final state in [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
        tester.binding.handleAppLifecycleStateChanged(state);
        await tester.pump();
      }
      expect(host.meter.count('probe harness.transport.describe'), 1);
      // No fake-time health interval elapsed, and networkKicksProvider was not overridden.
      await tester.runAsync(link.close);
      host.meter.reset();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(host.meter.count('probe harness.transport.describe'), 0);
    } finally {
      subscription.close();
      container.dispose();
      for (final client in backend.clients) {
        await tester.runAsync(client.close);
      }
      await tester.pump();
    }
  });
}
