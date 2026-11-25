import 'dart:async';
import 'dart:io';

import 'package:dsh_app/companion/companion_float.dart';
import 'package:dsh_app/companion/companion_pack.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

// Observe errors before another await. Tests still await the original Future;
// finally waits for settlement without replacing an earlier assertion failure.
Future<void> _settled(Future<void> pending) =>
    pending.then<void>((_) {}, onError: (Object _) {});

class _Store extends CompanionPackStore {
  _Store(this.log) : super(Directory('/synthetic-companion-float-test'));
  final List<String> log;
  final events = StreamController<int>.broadcast(sync: true);
  final hooks = <Future<void> Function()>[];
  int version = 0;
  String? problem;
  Future<String?> Function()? check;

  @override int get revision => version;
  @override Stream<int> get revisions => events.stream;
  @override void Function() beforeChanges(Future<void> Function() hook) {
    hooks.add(hook);
    return () => hooks.remove(hook);
  }
  @override Future<String?> unavailableReason() {
    log.add('check');
    return check?.call() ?? Future.value(problem);
  }

  Future<void> replaceWithMissing() async {
    events.add(++version);
    try {
      for (final hook in List.of(hooks)) { await hook(); }
      log.add('mutate');
      problem = 'companion_missing_model';
    } finally {
      events.add(++version);
    }
  }
}

class _Harness {
  _Harness() {
    store = _Store(log);
    session = CompanionFloatSession(
      loadStore: () async {
        log.add('store');
        if (failStore) throw const FileSystemException('synthetic_store_unavailable');
        if (storeGate != null) return await storeGate!.future;
        return store;
      },
      startPage: (_, options) async {
        log.add('open');
        expect(options.query['mode'], 'float');
        if (pageGate != null) return await pageGate!.future;
        return page;
      },
      configure: (uri) async {
        if (uri == null) {
          log.add('clear');
          if (failClear) throw PlatformException(code: 'synthetic_clear_failed');
        } else {
          log.add('configure');
          if (missingPlugin) throw MissingPluginException();
          await configureGate?.future;
          log.add('configured');
        }
      },
      changed: states.add,
    );
  }
  final log = <String>[];
  final states = <CompanionFloatState>[];
  late final _Store store;
  late final CompanionFloatSession session;
  Completer<CompanionPackStore>? storeGate;
  Completer<CompanionFloatPage>? pageGate;
  Completer<void>? configureGate;
  Completer<void>? closeGate;
  bool failClear = false;
  bool failClose = false;
  bool failStore = false;
  bool missingPlugin = false;
  CompanionFloatPage get page => CompanionFloatPage(
    Uri.parse('http://127.0.0.1:12345/${List.filled(32, 'a').join()}/app/index.html?mode=float'),
    () async {
      log.add('close:start');
      await closeGate?.future;
      if (failClose) throw const FileSystemException('synthetic_close_failed');
      log.add('close:end');
    },
  );

  Future<void> dispose() async {
    failClear = false;
    failClose = false;
    await session.close();
    await store.events.close();
  }
}

void main() {
  const selected = CompanionFloatOptions(enabled: true);
  const pixels = CompanionFloatOptions();
  late _Harness h;
  setUp(() => h = _Harness());
  tearDown(() => h.dispose());

  test('default and repeated pixel selections do not touch storage or native', () async {
    await h.session.select(pixels);
    await h.session.select(pixels);
    expect(h.log, isEmpty);
    expect(h.store.hooks, isEmpty);
  });

  test('incomplete installed content never opens a page or configures native', () async {
    h.store.problem = 'companion_runtime_mismatch';
    await h.session.select(selected);
    expect(h.log, ['store', 'check']);
    expect(h.states.last.problem, 'companion_runtime_mismatch');
    expect(h.states.last.configured, isFalse);
  });

  test('switching off fences an integrity result that arrives later', () async {
    final gate = Completer<String?>();
    h.store.check = () => gate.future;
    final opening = h.session.select(selected);
    final settled = _settled(opening);
    try {
      await pumpEventQueue();
      expect(h.log, contains('check'));
      await h.session.select(pixels);
      gate.complete(null);
      await opening;
      expect(h.log, isNot(contains('open')));
      expect(h.states.last.configured, isFalse);
    } finally {
      if (!gate.isCompleted) gate.complete(null);
      await settled;
    }
  });

  test('a new explicit selection retries a failed pack factory', () async {
    h.failStore = true;
    await h.session.select(selected);
    expect(h.states.last.problem, 'companion_storage');
    expect(h.store.hooks, isEmpty);
    await h.session.select(pixels);
    h.failStore = false;
    await h.session.select(selected);
    expect(h.log.where((event) => event == 'store'), hasLength(2));
    expect(h.states.last.configured, isTrue);
  });

  test('retry takes the old page back from native, closes it, and hands over a new one', () async {
    await h.session.select(selected);
    h.log.clear();
    await h.session.retry();
    expect(h.log, ['clear', 'close:start', 'close:end', 'check', 'open', 'configure', 'configured']);
    expect(h.states.last.configured, isTrue);
  });

  test('retry asks for nothing while pixels are selected', () async {
    await h.session.retry();
    expect(h.log, isEmpty);
  });

  test('reopening settings retries the real provider path after a terminal factory failure', () async {
    var failing = true;
    var calls = 0;
    final container = ProviderContainer(
      retry: (_, _) => null,
      overrides: [companionFloatStoreProvider.overrideWithValue(() async {
        calls++;
        if (failing) throw const FileSystemException('synthetic_storage_unavailable');
        return h.store;
      })],
    );
    addTearDown(container.dispose);
    final first = container.listen(companionFloatAvailabilityProvider, (_, _) {});
    await expectLater(container.read(companionFloatAvailabilityProvider.future),
        throwsA(isA<FileSystemException>()));
    expect(calls, 1);
    first.close();
    await container.pump();
    failing = false;
    final reopened = container.listen(companionFloatAvailabilityProvider, (_, _) {});
    expect(await container.read(companionFloatAvailabilityProvider.future), isNull);
    expect(calls, 2);
    reopened.close();
    await container.pump();
  });

  test('a page opened after deselection is closed without exposing its capability', () async {
    h.pageGate = Completer<CompanionFloatPage>();
    final opening = h.session.select(selected);
    final settled = _settled(opening);
    try {
      await pumpEventQueue();
      expect(h.log, contains('open'));
      await h.session.select(pixels);
      h.pageGate!.complete(h.page);
      await opening;
      expect(h.log, containsAllInOrder(['open', 'close:start', 'close:end']));
      expect(h.log, isNot(contains('configure')));
    } finally {
      if (!h.pageGate!.isCompleted) h.pageGate!.complete(h.page);
      await settled;
    }
  });

  test('deselect during native setup waits for its ack, destroys, then closes server', () async {
    h.configureGate = Completer<void>();
    final opening = h.session.select(selected);
    final settled = _settled(opening);
    Future<void>? stoppingSettled;
    try {
      await pumpEventQueue();
      expect(h.log, contains('configure'));
      final stopping = h.session.select(pixels);
      stoppingSettled = _settled(stopping);
      await pumpEventQueue();
      expect(h.log, isNot(contains('clear')));
      h.configureGate!.complete();
      await Future.wait([opening, stopping]);
      expect(h.log, containsAllInOrder(['configure', 'configured', 'clear', 'close:start', 'close:end']));
      expect(h.states.any((state) => state.configured), isFalse);
    } finally {
      if (!h.configureGate!.isCompleted) h.configureGate!.complete();
      await settled;
      if (stoppingSettled != null) await stoppingSettled;
    }
  });

  test('failed cleanup of a late page remains owned across a later pack mutation', () async {
    h.pageGate = Completer<CompanionFloatPage>();
    final opening = h.session.select(selected);
    final settled = _settled(opening);
    try {
      await pumpEventQueue();
      expect(h.log, contains('open'));
      await h.session.select(pixels);
      h.failClose = true;
      h.pageGate!.complete(h.page);
      await opening;
      await expectLater(h.store.replaceWithMissing(), throwsA(isA<FileSystemException>()));
      expect(h.log, isNot(contains('configure')));
      expect(h.log, isNot(contains('mutate')));
      h.failClose = false;
      await h.store.replaceWithMissing();
      expect(h.log, containsAllInOrder(['close:end', 'mutate']));
    } finally {
      if (!h.pageGate!.isCompleted) h.pageGate!.complete(h.page);
      await settled;
    }
  });

  test('revision event and mutation hook both await the same outstanding server cleanup', () async {
    await h.session.select(selected);
    h.closeGate = Completer<void>();
    final replacing = h.store.replaceWithMissing();
    final settled = _settled(replacing);
    try {
      await pumpEventQueue();
      expect(h.log, contains('close:start'));
      expect(h.log, isNot(contains('mutate')));
      h.closeGate!.complete();
      await replacing;
      await pumpEventQueue();
      expect(h.log, containsAllInOrder(['clear', 'close:start', 'close:end', 'mutate', 'check']));
      expect(h.log.where((event) => event == 'open'), hasLength(1));
      expect(h.states.last.problem, 'companion_missing_model');
    } finally {
      if (!h.closeGate!.isCompleted) h.closeGate!.complete();
      await settled;
    }
  });

  test('disposing before the pack factory resolves leaves no hooks or renderer', () async {
    h.storeGate = Completer<CompanionPackStore>();
    final opening = h.session.select(selected);
    final settled = _settled(opening);
    try {
      await pumpEventQueue();
      await h.session.close();
      h.storeGate!.complete(h.store);
      await opening;
      expect(h.store.hooks, isEmpty);
      expect(h.log, ['store']);
    } finally {
      if (!h.storeGate!.isCompleted) h.storeGate!.complete(h.store);
      await settled;
    }
  });

  test('absent native method closes the page and does not poison later pack mutations', () async {
    h.missingPlugin = true;
    await h.session.select(selected);
    expect(h.states.last.problem, 'companion_native_unavailable');
    expect(h.log, contains('close:end'));
    await h.store.replaceWithMissing();
    expect(h.log, contains('mutate'));
  });

  test('an unacknowledged native destroy prevents the live directory from changing', () async {
    await h.session.select(selected);
    h.failClear = true;
    await expectLater(h.store.replaceWithMissing(), throwsA(isA<PlatformException>()));
    expect(h.log, isNot(contains('mutate')));
    expect(h.log, contains('close:end'));
    h.failClear = false;
    await h.session.select(pixels);
  });

  test('a failed server close keeps its ownership and blocks a later mutation caller', () async {
    await h.session.select(selected);
    h.failClose = true;
    await expectLater(h.store.replaceWithMissing(), throwsA(isA<FileSystemException>()));
    expect(h.log, isNot(contains('mutate')));
    h.failClose = false;
    await h.session.select(pixels);
    expect(h.log, contains('close:end'));
  });

  test('framing is explicit while motion preferences arrive with the native pet state', () {
    const options = CompanionFloatOptions(enabled: true, zoom: 1.3, y: 0.2);
    expect(options.query, {
      'mode': 'float', 'maxTexture': '2048', 'maskSize': '1024', 'antialias': '0',
      'floatZoom': '1.3', 'floatY': '0.2',
    });
    expect(const CompanionFloatOptions().query.containsKey('reduceMotion'), isFalse);
  });
}
