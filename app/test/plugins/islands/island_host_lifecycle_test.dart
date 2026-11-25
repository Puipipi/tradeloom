import 'dart:async';

import 'package:dsh_app/ui/plugins/islands/islands.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

class _DelayedDevicePlatform extends FakeIslandPlatform {
  final result = Completer<IslandDevice>();
  int queries = 0;

  @override
  Future<IslandDevice> device() {
    queries++;
    return result.future;
  }
}

void main() {
  const device = IslandDevice(totalMem: 12 << 30, webView: 'test.webview');

  testWidgets('a live host applies and announces the delayed device budget', (tester) async {
    final platform = _DelayedDevicePlatform();
    final host = IslandHost(platform: platform);
    addTearDown(host.dispose);
    var notices = 0;
    host.addListener(() => notices++);
    expect(platform.queries, 1);
    expect(host.supported, isFalse);
    expect(host.max, 1);

    platform.result.complete(device);
    await tester.idle();

    expect(host.device, same(device));
    expect(host.supported, isTrue);
    expect(host.max, 3);
    expect(notices, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a delayed device result does not notify a disposed host', (tester) async {
    final platform = _DelayedDevicePlatform();
    final host = IslandHost(platform: platform);
    var notices = 0;
    host.addListener(() => notices++);
    expect(platform.queries, 1);
    host.dispose();

    platform.result.complete(device);
    await tester.idle();

    expect(notices, 0);
    expect(tester.takeException(), isNull);
  });
}
