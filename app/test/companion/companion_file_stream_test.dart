import 'dart:async';

import 'package:dsh_app/companion/companion_file_stream.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _settled(Future<dynamic> future) =>
    future.then<void>((_) {}, onError: (Object _, StackTrace _) {});

// These fixtures use only synchronous controllers and microtasks. After their
// explicit gates are reached, an event marker drains queued microtasks without
// choosing a time interval or guessing at filesystem/network progress.
Future<void> _checkpoint() => Future<void>(() {});

class _Completion {
  _Completion(Future<void> future) {
    settled = future.then<void>(
      (_) {
        done = true;
      },
      onError: (Object error, StackTrace stack) {
        this.error = error;
        this.stack = stack;
        done = true;
      },
    );
  }

  late final Future<void> settled;
  bool done = false;
  Object? error;
  StackTrace? stack;
}

class _Reader {
  _Reader({this.cancelError, this.cancelStack}) {
    source = StreamController<List<int>>(
      sync: true,
      onListen: () {
        listens++;
        listened.complete();
      },
      onCancel: () async {
        cancels++;
        cancelling.complete();
        await release.future;
        final error = cancelError;
        if (error != null) Error.throwWithStackTrace(error, cancelStack!);
      },
    );
  }

  final Object? cancelError;
  final StackTrace? cancelStack;
  final listened = Completer<void>();
  final cancelling = Completer<void>();
  final release = Completer<void>();
  late final StreamController<List<int>> source;
  int listens = 0;
  int cancels = 0;

  void unblock() {
    if (!release.isCompleted) release.complete();
  }

  Future<void> dispose() async {
    unblock();
    await _settled(source.close());
  }
}

// No controller or other resource to dispose when the source stays unlistened.
class _ListenProbe extends Stream<List<int>> {
  _ListenProbe({this.error, this.stack});

  final Object? error;
  final StackTrace? stack;
  int listens = 0;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int>)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    listens++;
    final error = this.error;
    if (error != null) Error.throwWithStackTrace(error, stack!);
    return const Stream<List<int>>.empty().listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }
}

void main() {
  test('waits for a cancellation that the consumer does not await', () async {
    final reader = _Reader();
    final returned = Completer<void>();
    _Completion? downstreamCancellation;
    final completion = _Completion(consumeCompanionFileStream(reader.source.stream, (stream) {
      final subscription = stream.listen((_) {});
      downstreamCancellation = _Completion(subscription.cancel());
      returned.complete();
      return Future<void>.value();
    }));
    try {
      await returned.future;
      await reader.cancelling.future;
      await _checkpoint();
      expect(completion.done, isFalse);
      expect(reader.cancels, 1);
      reader.unblock();
      await completion.settled;
      await downstreamCancellation!.settled;
      expect(downstreamCancellation!.error, isNull);
      expect(completion.error, isNull);
      expect(reader.listens, 1);
      expect(reader.cancels, 1);
    } finally {
      reader.unblock();
      await completion.settled;
      final cancellation = downstreamCancellation;
      if (cancellation != null) await cancellation.settled;
      await reader.dispose();
    }
  });

  test('normal EOF preserves chunks and waits for the reader to close', () async {
    final reader = _Reader();
    List<List<int>>? received;
    final completion = _Completion(consumeCompanionFileStream(reader.source.stream, (stream) async {
      received = await stream.toList();
    }));
    Future<void>? sourceClosed;
    try {
      await reader.listened.future;
      reader.source.add([1, 2]);
      reader.source.add([3]);
      sourceClosed = _settled(reader.source.close());
      await reader.cancelling.future;
      await _checkpoint();
      expect(completion.done, isFalse);
      reader.unblock();
      await completion.settled;
      await sourceClosed;
      expect(completion.error, isNull);
      expect(received, [[1, 2], [3]]);
      expect(reader.listens, 1);
      expect(reader.cancels, 1);
    } finally {
      reader.unblock();
      await completion.settled;
      if (sourceClosed != null) await sourceClosed;
      await reader.dispose();
    }
  });

  test('forwards pause and resume without consuming paused data', () async {
    final reader = _Reader();
    final paused = Completer<void>();
    final resumed = Completer<void>();
    final received = Completer<List<int>>();
    final releaseConsumer = Completer<void>();
    reader.source.onPause = () => paused.complete();
    reader.source.onResume = () => resumed.complete();
    late final StreamSubscription<List<int>> subscription;
    final completion = _Completion(consumeCompanionFileStream(reader.source.stream, (stream) async {
      subscription = stream.listen(received.complete);
      subscription.pause();
      await releaseConsumer.future;
    }));
    try {
      await paused.future;
      reader.source.add([4, 5]);
      await _checkpoint();
      expect(received.isCompleted, isFalse);
      subscription.resume();
      expect(await received.future, [4, 5]);
      await resumed.future;
      releaseConsumer.complete();
      await reader.cancelling.future;
      reader.unblock();
      await completion.settled;
      expect(completion.error, isNull);
      expect(reader.listens, 1);
      expect(reader.cancels, 1);
    } finally {
      if (!releaseConsumer.isCompleted) releaseConsumer.complete();
      reader.unblock();
      await completion.settled;
      await _settled(subscription.cancel());
      await reader.dispose();
    }
  });

  for (final throwsBeforeListening in [false, true]) {
    test('an unlistened consumer ${throwsBeforeListening ? 'throw' : 'return'} cannot open a late reader', () async {
      final source = _ListenProbe();
      final failure = StateError('consumer before listen');
      final stack = StackTrace.fromString('consumer-before-listen');
      late final Stream<List<int>> retained;
      final completion = _Completion(consumeCompanionFileStream(source, (stream) {
        retained = stream;
        if (throwsBeforeListening) Error.throwWithStackTrace(failure, stack);
        return Future<void>.value();
      }));
      try {
        await completion.settled;
        expect(completion.error, throwsBeforeListening ? same(failure) : isNull);
        if (throwsBeforeListening) expect(completion.stack.toString(), stack.toString());
        expect(source.listens, 0);
        expect(await retained.toList(), isEmpty);
        expect(source.listens, 0);
      } finally {
        await completion.settled;
      }
    });
  }

  test('a source error keeps its identity and stack after cancellation settles', () async {
    final reader = _Reader();
    final failure = StateError('source read');
    final stack = StackTrace.fromString('source-read-stack');
    final completion = _Completion(consumeCompanionFileStream(reader.source.stream, (stream) async {
      await stream.toList();
    }));
    try {
      await reader.listened.future;
      reader.source.addError(failure, stack);
      await reader.cancelling.future;
      await _checkpoint();
      expect(completion.done, isFalse);
      reader.unblock();
      await completion.settled;
      expect(completion.error, same(failure));
      expect(completion.stack.toString(), stack.toString());
      expect(reader.cancels, 1);
    } finally {
      reader.unblock();
      await completion.settled;
      await reader.dispose();
    }
  });

  for (final consumerFails in [false, true]) {
    test('a cancellation error '
        '${consumerFails ? 'preserves the consumer error' : 'fails successful consumption'}', () async {
      final cancelError = StateError('reader cancel');
      final cancelStack = StackTrace.fromString('reader-cancel-stack');
      final consumerError = StateError('consumer');
      final consumerStack = StackTrace.fromString('consumer-stack');
      final reader = _Reader(cancelError: cancelError, cancelStack: cancelStack);
      final releaseConsumer = Completer<void>();
      late final _Completion downstreamCancellation;
      final completion = _Completion(consumeCompanionFileStream(reader.source.stream, (stream) async {
        final subscription = stream.listen((_) {});
        downstreamCancellation = _Completion(subscription.cancel());
        await releaseConsumer.future;
        if (consumerFails) Error.throwWithStackTrace(consumerError, consumerStack);
      }));
      try {
        await reader.cancelling.future;
        reader.unblock();
        await downstreamCancellation.settled;
        expect(downstreamCancellation.error, isNull);
        expect(completion.done, isFalse);
        releaseConsumer.complete();
        await completion.settled;
        expect(completion.error, same(consumerFails ? consumerError : cancelError));
        expect(completion.stack.toString(), (consumerFails ? consumerStack : cancelStack).toString());
        expect(reader.listens, 1);
        expect(reader.cancels, 1);
      } finally {
        if (!releaseConsumer.isCompleted) releaseConsumer.complete();
        reader.unblock();
        await completion.settled;
        await downstreamCancellation.settled;
        await reader.dispose();
      }
    });
  }

  test('a synchronous source listen failure reaches the consumer as a stream error', () async {
    final failure = StateError('source listen');
    final stack = StackTrace.fromString('source-listen-stack');
    final source = _ListenProbe(error: failure, stack: stack);
    final completion = _Completion(consumeCompanionFileStream(source, (stream) async {
      await stream.toList();
    }));
    try {
      await completion.settled;
      expect(completion.error, same(failure));
      expect(completion.stack.toString(), stack.toString());
      expect(source.listens, 1);
    } finally {
      await completion.settled;
    }
  });
}
