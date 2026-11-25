import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _Bridge extends RuntimeBridge {
  final eventsController = StreamController<RuntimeEvent>.broadcast(sync: true);
  final snapshots = <Completer<RuntimeLogSnapshot>>[];
  final resetResult = Completer<void>();
  @override
  Stream<RuntimeEvent> get events => eventsController.stream;
  @override
  Future<RuntimeStatus> status() async => const RuntimeStatus(phase: RuntimePhase.installed);
  @override
  Future<RuntimeLogSnapshot> logSnapshot({int lines = 300}) {
    expect(lines, 300);
    final result = Completer<RuntimeLogSnapshot>();
    snapshots.add(result);
    return result.future;
  }

  @override
  Future<void> reset({ResetKeep keep = const ResetKeep()}) => resetResult.future;
  void batch(List<RuntimeLogEntry> entries) => eventsController.add(RuntimeLogsEvent(entries));
}

Future<void> _settle() async {
  for (var i = 0; i < 4; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

RuntimeLogEntry _entry(int seq, [String? line]) => RuntimeLogEntry(seq, line ?? 'line $seq', 'stdout');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Bridge bridge;
  late ProviderContainer c;
  setUp(() {
    bridge = _Bridge();
    c = ProviderContainer(
      overrides: [
        runtimeBridgeProvider.overrideWithValue(bridge),
        networkKicksProvider.overrideWithValue(const Stream.empty()),
      ],
    );
  });
  tearDown(() async {
    c.dispose();
    await bridge.eventsController.close();
  });

  test('state startup collects 1000 live lines before any log reader; no state or connection notification', () async {
    var runtimeChanges = 0;
    var connectionChanges = 0;
    c.listen(localRuntimeProvider, (_, _) => runtimeChanges++);
    c.listen(localConnectionProvider, (_, _) => connectionChanges++);
    expect(bridge.snapshots, hasLength(1));
    bridge.snapshots.single.complete(const RuntimeLogSnapshot([], 0));
    await _settle();
    runtimeChanges = 0;
    connectionChanges = 0;
    for (var start = 1; start <= 5000; start += 50) {
      bridge.batch([for (var seq = start; seq < start + 50; seq++) _entry(seq)]);
    }
    await _settle();
    expect(runtimeChanges, 0);
    expect(connectionChanges, 0);
    expect(c.read(localRuntimeLogsProvider), [for (var seq = 4001; seq <= 5000; seq++) 'line $seq']);
  });

  test('all 5000 lines are delivered once and in order before display-tail eviction', () async {
    c.read(localRuntimeLogsProvider);
    bridge.snapshots.single.complete(const RuntimeLogSnapshot([], 0));
    await _settle();
    final delivered = <String>[];
    c.listen(localRuntimeLogsProvider, (_, next) => delivered.addAll(next.skip(next.length - 50)));
    final expected = List.generate(5000, (i) => '2026-11-01 engine benchmark line $i repeated payload');
    for (var start = 0; start < 5000; start += 50) {
      bridge.batch([for (var i = start; i < start + 50; i++) _entry(i + 1, expected[i])]);
    }
    expect(delivered, expected);
    expect(c.read(localRuntimeLogsProvider), expected.sublist(4000));
    debugPrintSynchronously('B6_DELIVERY_JSON ${jsonEncode(delivered)}');
  });

  test('snapshot cutpoint retains distinct equal text, drops overlap, and ignores late duplicate batches', () async {
    c.read(localRuntimeLogsProvider);
    bridge.batch([_entry(1, 'same'), _entry(2, 'same'), _entry(3, 'later')]);
    bridge.snapshots.single.complete(RuntimeLogSnapshot([_entry(1, 'same'), _entry(2, 'same')], 2));
    await _settle();
    expect(c.read(localRuntimeLogsProvider), ['same', 'same', 'later']);
    var notifications = 0;
    c.listen(localRuntimeLogsProvider, (_, _) => notifications++);
    bridge.batch([_entry(1, 'same'), _entry(2, 'same'), _entry(3, 'later')]);
    bridge.batch([]);
    expect(notifications, 0);
    bridge.batch([_entry(4), _entry(5)]);
    expect(notifications, 1);
    expect(c.read(localRuntimeLogsProvider), ['same', 'same', 'later', 'line 4', 'line 5']);
  });

  test('pending live buffer is bounded to newest 1000 and snapshot cutoff can be beyond returned rows', () async {
    c.read(localRuntimeLogsProvider);
    bridge.batch([for (var seq = 1; seq <= 5000; seq++) _entry(seq)]);
    bridge.snapshots.single.complete(const RuntimeLogSnapshot([], 4500));
    await _settle();
    expect(c.read(localRuntimeLogsProvider), [for (var seq = 4501; seq <= 5000; seq++) 'line $seq']);
  });

  for (final error in [PlatformException(code: 'io_error'), const FormatException('bad snapshot')]) {
    test('snapshot ${error.runtimeType} keeps the live tail', () async {
      c.read(localRuntimeLogsProvider);
      bridge.batch([_entry(1)]);
      bridge.snapshots.single.completeError(error);
      await _settle();
      expect(c.read(localRuntimeLogsProvider), ['line 1']);
      bridge.batch([_entry(2)]);
      expect(c.read(localRuntimeLogsProvider), ['line 1', 'line 2']);
    });
  }

  test('invalidate retires old snapshot and keeps new build result', () async {
    c.read(localRuntimeLogsProvider);
    final first = bridge.snapshots.single;
    c.invalidate(localRuntimeLogsProvider);
    c.read(localRuntimeLogsProvider);
    expect(bridge.snapshots, hasLength(2));
    bridge.snapshots.last.complete(RuntimeLogSnapshot([_entry(2, 'new')], 2));
    await _settle();
    first.complete(RuntimeLogSnapshot([_entry(1, 'old')], 1));
    await _settle();
    expect(c.read(localRuntimeLogsProvider), ['new']);
    bridge.batch([_entry(3)]);
    expect(c.read(localRuntimeLogsProvider), ['new', 'line 3']);
  });

  test('dispose ignores a late snapshot', () async {
    c.read(localRuntimeLogsProvider);
    c.dispose();
    bridge.snapshots.single.complete(RuntimeLogSnapshot([_entry(1)], 1));
    await _settle();
    // tearDown receives a fresh container; the disposed one is not reused.
    c = ProviderContainer();
  });

  test('reset keeps the tail and the subscription', () async {
    final runtime = c.read(localRuntimeProvider.notifier);
    bridge.snapshots.single.complete(RuntimeLogSnapshot([_entry(1, 'before reset')], 1));
    await _settle();
    final reset = runtime.reset();
    bridge.resetResult.complete();
    await reset;
    expect(bridge.snapshots, hasLength(1));
    bridge.batch([_entry(2, 'after reset')]);
    expect(c.read(localRuntimeLogsProvider), ['before reset', 'after reset']);
  });

  test('real RuntimeBridge reads the snapshot and parses batches', () async {
    const methods = MethodChannel('test/b6/methods');
    const eventMethods = MethodChannel('test/b6/events');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final received = <RuntimeEvent>[];
    messenger.setMockMethodCallHandler(eventMethods, (call) async => null);
    messenger.setMockMethodCallHandler(methods, (call) async {
      expect(call.method, 'getLogSnapshot');
      expect(call.arguments, {'lines': 300});
      return {
        'entries': [
          {'seq': 1, 'line': 'same', 'stream': 'stdout'},
        ],
        'throughSeq': 1,
      };
    });
    final real = RuntimeBridge(methods: methods, events: const EventChannel('test/b6/events'));
    final sub = real.events.listen(received.add);
    await _settle();
    final snapshot = await real.logSnapshot();
    expect(snapshot.throughSeq, 1);
    expect(snapshot.entries.single.line, 'same');
    final done = Completer<void>();
    messenger.handlePlatformMessage(
      'test/b6/events',
      const StandardMethodCodec().encodeSuccessEnvelope({
        'type': 'logs',
        'entries': [
          {'seq': 2, 'line': 'same', 'stream': 'stderr'},
        ],
      }),
      (_) => done.complete(),
    );
    await done.future;
    await _settle();
    expect((received.single as RuntimeLogsEvent).entries.single.seq, 2);
    await sub.cancel();
    messenger.setMockMethodCallHandler(methods, null);
    messenger.setMockMethodCallHandler(eventMethods, null);
  });
}
