// Real PhoneChannel/EventChannel and dialog; the native stream alone is synthetic.
// No replacement parser/decoder and no wall-clock sleeps. Engine decode is joined
// through Image.onCreate; lifecycle/cancel races use explicit barriers.
// Codec scenarios create the viewer and stream subscription in one real async zone.
import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/phone/phone_channel.dart';
import 'package:dsh_app/ui/phone/background_preview.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../shell/golden_harness.dart';

const _events = EventChannel('test/phone/background-preview');
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUiFrAwMDAxMDAgKAAFWIBKNw5NZUAAAAASUVORK5CYII=',
);

Map<String, Object?> _event(String state, int sequence, {int task = 7, int generation = 1}) => {
  'taskId': task, 'generation': generation, 'sequence': sequence, 'state': state,
  'width': state == 'frame' ? 2 : 0, 'height': state == 'frame' ? 3 : 0,
  'imageBytes': state == 'frame' ? _png : null,
};

class _NativePreview {
  final calls = <String>[];
  final arguments = <Object?>[];
  MockStreamHandlerEventSink? sink;

  void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockStreamHandler(
      _events,
      MockStreamHandler.inline(
        onListen: (args, events) {
          calls.add('listen'); arguments.add(args); sink = events;
        },
        onCancel: (_) { calls.add('cancel'); sink = null; },
      ),
    );
  }

  void emit(Object? event) => sink!.success(event);
}

/// Joins actual parsed event delivery before the sequence test pumps a frame.
/// The async completer resumes after this map forwards to the active viewer.
class _DeliveryPhoneChannel extends PhoneChannel {
  _DeliveryPhoneChannel() : super(preview: _events);
  Completer<void>? _delivery;
  int _remaining = 0;

  Future<void> expectDelivery(int count) {
    if (count <= 0 || _delivery != null) {
      throw StateError('A positive, non-overlapping event batch is required.');
    }
    final delivery = Completer<void>();
    _delivery = delivery;
    _remaining = count;
    return delivery.future.timeout(const Duration(seconds: 10));
  }

  @override
  Stream<PhonePreviewFrame?> previewFrames(int taskId) => super.previewFrames(taskId).map((frame) {
    final delivery = _delivery;
    if (delivery != null) {
      _remaining--;
      if (_remaining == 0) {
        _delivery = null;
        delivery.complete();
      }
    }
    return frame;
  });
}

/// Forces delivery during a real codec callback; parser and decoder stay real.
class _SynchronousPreviewChannel extends PhoneChannel {
  final events = StreamController<PhonePreviewFrame?>(sync: true);

  void emit(Object? event) => events.add(PhonePreviewFrame.parse(event));

  @override
  Stream<PhonePreviewFrame?> previewFrames(int taskId) => events.stream;
}

/// MockStreamHandler.onCancel is void. Delay only the encoded ACK, so the
/// production subscription must await its actual cancel Future before re-listen.
class _CancelAckMessenger implements BinaryMessenger {
  _CancelAckMessenger(this.delegate);
  final TestDefaultBinaryMessenger delegate;
  Completer<void>? cancelAck;
  Completer<void>? firstListenAck;
  bool _firstListenSeen = false;
  final calls = <String>[];

  @override
  Future<ByteData?> send(String channel, ByteData? message) async {
    final call = channel == _events.name && message != null
        ? _events.codec.decodeMethodCall(message) : null;
    if (call != null) {
      calls.add(call.method);
    }
    Completer<void>? listenAck;
    if (call?.method == 'listen' && !_firstListenSeen) {
      _firstListenSeen = true;
      listenAck = firstListenAck;
    }
    final response = await delegate.send(channel, message);
    if (listenAck != null) {
      await listenAck.future;
    }
    if (call?.method == 'cancel') {
      await cancelAck?.future;
    }
    return response;
  }

  @override
  void setMessageHandler(String channel, MessageHandler? handler) => delegate.setMessageHandler(channel, handler);

  @override
  Future<void> handlePlatformMessage(String channel, ByteData? data, ui.PlatformMessageResponseCallback? callback) =>
      delegate.handlePlatformMessage(channel, data, callback);
}

/// Observes the real engine image handles without intercepting codec work.
class _Images {
  final previousCreate = ui.Image.onCreate;
  final previousDispose = ui.Image.onDispose;
  final created = <ui.Image>[];
  final disposed = <ui.Image>[];
  Completer<ui.Image>? next;
  void Function()? retireOnCreate;

  void install() {
    ui.Image.onCreate = (image) {
      previousCreate?.call(image);
      if (image.width != 2 || image.height != 3) return;
      created.add(image);
      final pending = next;
      next = null;
      final retire = retireOnCreate;
      retireOnCreate = null;
      retire?.call();
      pending?.complete(image);
    };
    ui.Image.onDispose = (image) {
      disposed.add(image);
      previousDispose?.call(image);
    };
  }

  void restore() {
    ui.Image.onCreate = previousCreate;
    ui.Image.onDispose = previousDispose;
  }
}

Future<void> _flush(WidgetTester tester) async {
  await tester.pumpAndSettle();
}

void _pause(WidgetTester tester) {
  for (final state in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
    tester.binding.handleAppLifecycleStateChanged(state);
  }
}

void _resume(WidgetTester tester) {
  if (tester.binding.lifecycleState == AppLifecycleState.paused) {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
  }
  if (tester.binding.lifecycleState == AppLifecycleState.hidden) {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  }
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
}

Future<void> _mount(WidgetTester tester, PhoneChannel channel, {bool resumed = true}) async {
  _resume(tester);
  if (!resumed) _pause(tester);
  await tester.pumpWidget(goldenApp(
    brightness: Brightness.light,
    home: PhoneBackgroundPreviewDialog(channel: channel, taskId: 7),
  ));
  await _flush(tester);
}

Future<ui.Image> _frame(WidgetTester tester, _NativePreview native, _Images images, int sequence) async {
  final made = Completer<ui.Image>();
  images.next = made;
  native.emit(_event('frame', sequence));
  await _flush(tester); // Deliver EventChannel and start the real engine codec.
  final image = await made.future.timeout(const Duration(seconds: 10));
  await _flush(tester); // Join the dialog continuation and any render handle clone.
  return image;
}

Future<void> _unmount(WidgetTester tester) async {
  // Resume frame scheduling before removing a viewer that the test left paused.
  _resume(tester);
  await tester.pumpWidget(const SizedBox.shrink());
  await _flush(tester);
}

void main() {
  testWidgets('availability suspension keeps the original cancel ACK barrier and task', (tester) async {
    final native = _NativePreview()..install();
    final gate = _CancelAckMessenger(TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger);
    final channel = PhoneChannel(preview: EventChannel(_events.name, _events.codec, gate));
    var enabled = true;
    late StateSetter update;
    _resume(tester);
    await tester.pumpWidget(goldenApp(brightness: Brightness.light, home: StatefulBuilder(
      builder: (_, setState) {
        update = setState;
        return PhoneBackgroundPreviewDialog(channel: channel, taskId: 7, enabled: enabled);
      },
    )));
    await _flush(tester);
    expect(gate.calls, ['listen']);
    final ack = Completer<void>();
    gate.cancelAck = ack;
    try {
      update(() => enabled = false);
      await _flush(tester);
      expect(gate.calls, ['listen', 'cancel']);
      expect(find.byType(RawImage), findsNothing);
      update(() => enabled = true);
      await _flush(tester);
      expect(gate.calls, ['listen', 'cancel']);
      ack.complete();
      await _flush(tester);
      expect(gate.calls, ['listen', 'cancel', 'listen']);
      expect(native.arguments, [{'taskId': 7}, {'taskId': 7}]);
    } finally {
      if (!ack.isCompleted) ack.complete();
      gate.cancelAck = null;
      await _unmount(tester);
    }
    expect(tester.takeException(), isNull);
  });

  TestWidgetsFlutterBinding.ensureInitialized();

  test('preview parser accepts every non-image state and rejects malformed identity', () {
    for (final state in ['off', 'waiting', 'unavailable', 'protected', 'inUse']) {
      final value = PhonePreviewFrame.parse(_event(state, 0));
      expect(value?.state, state);
      expect(value?.imageBytes, isNull);
    }
    for (final malformed in [
      null, 'frame', _event('busy', 1), _event('waiting', -1),
      _event('waiting', 1, task: 0), _event('waiting', 1, generation: -1),
      {..._event('waiting', 1), 'taskId': 7.0},
    ]) { expect(PhonePreviewFrame.parse(malformed), isNull); }
    final legacy = PhoneBackgroundStatus.fromMap({});
    expect(legacy.previewVersion, isNull);
    expect(legacy.previewEnabled, isFalse);
  });

  test('frame parser bounds byte payload and geometry independently', () {
    expect(PhonePreviewFrame.parse(_event('frame', 1))?.imageBytes, same(_png));
    expect(PhonePreviewFrame.parse({..._event('frame', 1), 'imageBytes': Uint8List(128 * 1024)}), isNotNull);
    for (final fields in <Map<String, Object?>>[
      {'imageBytes': Uint8List(0)}, {'imageBytes': Uint8List(128 * 1024 + 1)},
      {'imageBytes': [1, 2, 3]}, {'imageBytes': null}, {'width': 0},
      {'width': 801}, {'height': 801}, {'height': 1.5},
    ]) { expect(PhonePreviewFrame.parse({..._event('frame', 1), ...fields}), isNull); }
  });

  testWidgets('only resumed and current route subscribes; covering route cancels', (tester) async {
    final native = _NativePreview()..install();
    try {
      await _mount(tester, PhoneChannel(preview: _events), resumed: false);
      expect(native.calls, isEmpty);
      _resume(tester);
      await _flush(tester);
      expect(native.calls, ['listen']);
      expect(native.arguments, [{'taskId': 7}]);
      native.emit(_event('waiting', 0));
      await _flush(tester);
      expect(find.text(appL10n.phonePreviewWaiting), findsOneWidget);
      final navigator = Navigator.of(tester.element(find.byType(PhoneBackgroundPreviewDialog)));
      unawaited(navigator.push<void>(PageRouteBuilder<void>(
        opaque: false, transitionDuration: Duration.zero, reverseTransitionDuration: Duration.zero,
        pageBuilder: (_, _, _) => const Scaffold(body: Text('cover')),
      )));
      await _flush(tester);
      expect(native.calls, ['listen', 'cancel']);
      navigator.pop();
      await _flush(tester);
      final routeDialogElements = find
          .byType(PhoneBackgroundPreviewDialog, skipOffstage: false)
          .evaluate()
          .toList();
      final routeDialog =
          routeDialogElements.length == 1 ? routeDialogElements.single : null;
      final routeCurrent = routeDialog != null && routeDialog.mounted
          ? ModalRoute.of(routeDialog)?.isCurrent
          : null;
      final routeError = tester.takeException();
      final routeFacts =
          'after cover pop: dialogs=${routeDialogElements.length}, '
          'mounted=${routeDialog?.mounted}, current=$routeCurrent, '
          'covers=${find.text('cover', skipOffstage: false).evaluate().length}, '
          'lifecycle=${tester.binding.lifecycleState}, '
          'scheduledFrame=${tester.binding.hasScheduledFrame}, '
          'nativeCalls=${native.calls}, exception=$routeError';
      expect(routeError, isNull, reason: routeFacts);
      expect(routeDialogElements, hasLength(1), reason: routeFacts);
      expect(routeDialog?.mounted, isTrue, reason: routeFacts);
      expect(routeCurrent, isTrue, reason: routeFacts);
      expect(native.calls, ['listen', 'cancel', 'listen'], reason: routeFacts);
    } finally {
      await _unmount(tester);
    }
    expect(native.calls.last, 'cancel');
    expect(tester.takeException(), isNull);
  });

  testWidgets('rapid background and resume awaits cancel ACK before another listen', (tester) async {
    final native = _NativePreview()..install();
    final gate = _CancelAckMessenger(TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger);
    final channel = PhoneChannel(preview: EventChannel(_events.name, _events.codec, gate));
    await _mount(tester, channel);
    expect(gate.calls, ['listen']);
    expect(native.calls, ['listen']);
    final ack = Completer<void>();
    gate.cancelAck = ack;
    try {
      _pause(tester);
      _resume(tester);
      await _flush(tester);
      expect(gate.calls, ['listen', 'cancel']);
      expect(native.calls, ['listen', 'cancel']);
      ack.complete();
      await _flush(tester);
      expect(gate.calls, ['listen', 'cancel', 'listen']);
    } finally {
      if (!ack.isCompleted) ack.complete();
      gate.cancelAck = null;
      await _unmount(tester);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('retired viewer cancels before reopen even when its listen ACK is late', (tester) async {
    final native = _NativePreview()..install();
    final gate = _CancelAckMessenger(TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger);
    final channel = PhoneChannel(preview: EventChannel(_events.name, _events.codec, gate));
    final firstAck = Completer<void>();
    gate.firstListenAck = firstAck;
    try {
      await _mount(tester, channel);
      expect(gate.calls, ['listen']);
      expect(native.calls, ['listen']);
      expect(firstAck.isCompleted, isFalse);

      await _unmount(tester);
      await _mount(tester, channel);
      // Capture both sides before releasing A's reply, then complete the late
      // response before checking the saved sequence and B's active subscription.
      final beforeAck = List<String>.of(gate.calls);
      final nativeBeforeAck = List<String>.of(native.calls);
      expect(native.calls.where((call) => call == 'listen'), hasLength(2));
      expect(firstAck.isCompleted, isFalse);
      firstAck.complete();
      await _flush(tester);

      expect(beforeAck, ['listen', 'cancel', 'listen'],
          reason: 'A must send cancel without waiting for its listen response.');
      expect(nativeBeforeAck, ['listen', 'cancel', 'listen']);
      expect(gate.calls, ['listen', 'cancel', 'listen'],
          reason: 'Releasing A\'s late listen response must not send a cancel for B.');
      expect(native.calls, ['listen', 'cancel', 'listen']);
      expect(native.arguments, [{'taskId': 7}, {'taskId': 7}]);
      native.emit(_event('off', 1));
      await _flush(tester);
      expect(find.text(appL10n.phonePreviewOff), findsOneWidget,
          reason: 'B must still receive events through its registered handler.');
      expect(find.byType(RawImage), findsNothing);
    } finally {
      if (!firstAck.isCompleted) {
        firstAck.complete();
      }
      gate.firstListenAck = null;
      await _unmount(tester);
    }
    expect(gate.calls, ['listen', 'cancel', 'listen', 'cancel']);
    expect(native.calls, ['listen', 'cancel', 'listen', 'cancel']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('continuous same-generation frames do not retire every decoding image', (tester) async {
    await tester.runAsync<void>(() async {
      final channel = _SynchronousPreviewChannel();
      final images = _Images()..install();
      final lastCreated = Completer<ui.Image>();
      ui.Image? first;
      bool? firstRetiredBeforeSecond;
      try {
        await _mount(tester, channel);
        images.retireOnCreate = () {
          first = images.created.last;
          images.retireOnCreate = () {
            firstRetiredBeforeSecond = first!.debugDisposed;
            images.next = lastCreated;
            channel.emit(_event('frame', 3));
          };
          channel.emit(_event('frame', 2));
        };
        channel.emit(_event('frame', 1));
        final last = await lastCreated.future.timeout(const Duration(seconds: 10));
        await _flush(tester);
        expect(firstRetiredBeforeSecond, isFalse,
            reason: 'The first decode must be held by the viewer while the next decode starts.');
        expect(tester.widget<RawImage>(find.byType(RawImage)).image, same(last));
        expect(first!.debugDisposed, isTrue);
        expect(last.debugDisposed, isFalse);
      } finally {
        try {
          await _unmount(tester);
          await channel.events.close();
          expect(images.created.every((image) => image.debugDisposed), isTrue);
        } finally { images.restore(); }
      }
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('a new generation retires the in-flight decode before its replacement', (tester) async {
    await tester.runAsync<void>(() async {
      final channel = _SynchronousPreviewChannel();
      final images = _Images()..install();
      final replacement = Completer<ui.Image>();
      ui.Image? old;
      bool? oldRetired;
      try {
        await _mount(tester, channel);
        images.retireOnCreate = () {
          old = images.created.last;
          images.next = replacement;
          images.retireOnCreate = () { oldRetired = old!.debugDisposed; };
          channel.emit(_event('frame', 1, generation: 2));
        };
        channel.emit(_event('frame', 1));
        final next = await replacement.future.timeout(const Duration(seconds: 10));
        await _flush(tester);
        expect(oldRetired, isTrue);
        expect(tester.widget<RawImage>(find.byType(RawImage)).image, same(next));
      } finally {
        try {
          await _unmount(tester);
          await channel.events.close();
          expect(images.created.every((image) => image.debugDisposed), isTrue);
        } finally { images.restore(); }
      }
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed decode preserves a newer pending frame', (tester) async {
    await tester.runAsync<void>(() async {
      final channel = _SynchronousPreviewChannel();
      final images = _Images()..install();
      final recovered = Completer<ui.Image>();
      try {
        await _mount(tester, channel);
        images.next = recovered;
        channel.emit({..._event('frame', 1), 'imageBytes': _png.sublist(0, 8)});
        channel.emit(_event('frame', 2));
        final next = await recovered.future.timeout(const Duration(seconds: 10));
        await _flush(tester);
        expect(tester.widget<RawImage>(find.byType(RawImage)).image, same(next));
        expect(find.text(appL10n.phonePreviewUnavailable), findsNothing);
      } finally {
        try {
          await _unmount(tester);
          await channel.events.close();
          expect(images.created.every((image) => image.debugDisposed), isTrue);
        } finally { images.restore(); }
      }
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('cover and background release decoded images without ImageCache', (tester) async {
    await tester.runAsync<void>(() async {
      final native = _NativePreview()..install();
      final images = _Images()..install();
      try {
        await _mount(tester, PhoneChannel(preview: _events));
        final cache = PaintingBinding.instance.imageCache;
        final entries = cache.currentSize;
        final live = cache.liveImageCount;
        final image = await _frame(tester, native, images, 1);
        expect(tester.widget<RawImage>(find.byType(RawImage)).image, same(image));
        expect(image.debugDisposed, isFalse);
        expect(cache.currentSize, entries);
        expect(cache.liveImageCount, live);
        final navigator = Navigator.of(tester.element(find.byType(PhoneBackgroundPreviewDialog)));
        unawaited(navigator.push<void>(PageRouteBuilder<void>(
          opaque: false, transitionDuration: Duration.zero, reverseTransitionDuration: Duration.zero,
          pageBuilder: (_, _, _) => const Scaffold(body: Text('cover')),
        )));
        await _flush(tester);
        expect(find.byType(RawImage, skipOffstage: false), findsNothing);
        expect(image.debugDisposed, isTrue);
        expect(images.disposed.where((value) => identical(value, image)), hasLength(1));
        expect(native.calls, ['listen', 'cancel']);
        navigator.pop();
        await _flush(tester);
        final next = await _frame(tester, native, images, 2);
        _pause(tester);
        await _flush(tester);
        expect(find.byType(RawImage, skipOffstage: false), findsNothing);
        expect(next.debugDisposed, isTrue);
        expect(native.calls, ['listen', 'cancel', 'listen', 'cancel']);
      } finally {
        try {
          await _unmount(tester);
          expect(images.created.every((image) => image.debugDisposed), isTrue,
              reason: 'Both owner handles and RawImage render clones must retire.');
        } finally { images.restore(); }
      }
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('task, generation and sequence reject late state; a newer clear releases pixels', (tester) async {
    await tester.runAsync<void>(() async {
      final native = _NativePreview()..install();
      final images = _Images()..install();
      final channel = _DeliveryPhoneChannel();
      try {
        await _mount(tester, channel);
        final image = await _frame(tester, native, images, 10);
        final rejected = channel.expectDelivery(4);
        for (final event in [
          _event('off', 99, task: 8), _event('off', 99, generation: 0),
          _event('off', 9), _event('off', 10),
        ]) { native.emit(event); }
        await rejected;
        await _flush(tester);
        expect(tester.widget<RawImage>(find.byType(RawImage)).image, same(image));
        final cleared = channel.expectDelivery(1);
        native.emit(_event('off', 11));
        await cleared;
        await _flush(tester);
        expect(find.byType(RawImage), findsNothing, reason: 'after current off sequence 11');
        expect(find.text(appL10n.phonePreviewOff), findsOneWidget);
        expect(image.debugDisposed, isTrue);
        // Older waiting/protected events must not revive or relabel the cleared observation.
        final older = channel.expectDelivery(2);
        native.emit(_event('waiting', 10));
        native.emit(_event('protected', 99, task: 8));
        await older;
        await _flush(tester);
        expect(find.text(appL10n.phonePreviewOff), findsOneWidget);
        final recovered = await _frame(tester, native, images, 12);
        expect(tester.widget<RawImage>(find.byType(RawImage)).image, same(recovered));
        final malformed = channel.expectDelivery(1);
        native.emit({'malformed': true});
        await malformed;
        await _flush(tester);
        expect(find.byType(RawImage), findsNothing, reason: 'after malformed event');
        expect(recovered.debugDisposed, isTrue);
        expect(find.text(appL10n.phonePreviewUnavailable), findsOneWidget);
      } finally {
        try {
          await _unmount(tester);
          expect(images.created.every((image) => image.debugDisposed), isTrue,
              reason: 'Both owner handles and RawImage render clones must retire.');
        } finally { images.restore(); }
      }
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('image created after the viewer retires is disposed without becoming RawImage', (tester) async {
    await tester.runAsync<void>(() async {
      final native = _NativePreview()..install();
      final images = _Images()..install();
      try {
        await _mount(tester, PhoneChannel(preview: _events));
        // The real codec calls onCreate before returning its FrameInfo. Retire the
        // consumer at this exact boundary, not after an arbitrary timed sleep.
        images.retireOnCreate = () => _pause(tester);
        final late = await _frame(tester, native, images, 1);
        expect(late.debugDisposed, isTrue);
        expect(images.disposed.where((value) => identical(value, late)), hasLength(1));
        expect(find.byType(RawImage), findsNothing);
        expect(native.calls, ['listen', 'cancel']);
      } finally {
        try {
          await _unmount(tester);
          expect(images.created.every((image) => image.debugDisposed), isTrue,
              reason: 'Both owner handles and RawImage render clones must retire.');
        } finally { images.restore(); }
      }
    });
    expect(tester.takeException(), isNull);
  });
  testWidgets('in-use preview clears its image and rejects old or foreign frames', (tester) async {
    await tester.runAsync<void>(() async {
      final native = _NativePreview()..install();
      final channel = _DeliveryPhoneChannel();
      final images = _Images()..install();
      try {
        await _mount(tester, channel);
        final image = await _frame(tester, native, images, 1);
        final inUse = channel.expectDelivery(1);
        native.emit(_event('inUse', 2));
        await inUse;
        await _flush(tester);
        expect(image.debugDisposed, isTrue);
        expect(find.byType(RawImage), findsNothing);
        expect(find.text(appL10n.phonePreviewInUse), findsOneWidget);

        final rejected = channel.expectDelivery(2);
        native.emit(_event('frame', 1));
        native.emit(_event('frame', 99, task: 8));
        await rejected;
        await _flush(tester);
        expect(find.byType(RawImage), findsNothing);
        expect(find.text(appL10n.phonePreviewInUse), findsOneWidget);

        final waiting = channel.expectDelivery(1);
        native.emit(_event('waiting', 3, generation: 2));
        await waiting;
        await _flush(tester);
        expect(find.text(appL10n.phonePreviewWaiting), findsOneWidget);
      } finally {
        try {
          await _unmount(tester);
          expect(images.created.every((image) => image.debugDisposed), isTrue,
              reason: 'Both owner handles and RawImage render clones must retire.');
        } finally { images.restore(); }
      }
    });
    expect(tester.takeException(), isNull);
  });
}
