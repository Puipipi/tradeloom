import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

/// Drive real loopback I/O and widget/Riverpod work without moving production
/// work between zones or reaching into Riverpod's scheduler. Completion of the
/// observed operation is the gate; an event turn is never evidence of success.
Future<T?> driveRealIo<T>(WidgetTester tester, Future<T> Function() operation) async {
  final caller = StackTrace.current;
  final done = Completer<void>();
  T? value;
  Object? failure;
  StackTrace? failureStack;
  final deadline = Stopwatch()..start();
  await tester.runAsync(() async {
    unawaited(Future<T>.sync(operation).then<void>((result) {
      value = result;
      done.complete();
    }, onError: (Object error, StackTrace stack) {
      failure = error;
      failureStack = stack;
      done.complete();
    }));
  });
  while (!done.isCompleted) {
    if (deadline.elapsed >= const Duration(seconds: 8)) {
      Error.throwWithStackTrace(
        TimeoutException('Real I/O / widget completion gate did not settle', const Duration(seconds: 8)),
        caller,
      );
    }
    await tester.pump();
    await tester.runAsync(() async {
      // Yield a real event turn, with no positive-duration sleep or extension
      // of the deadline. This also lets pre-existing real HTTP futures advance.
      await Future.any<void>([done.future, Future<void>.delayed(Duration.zero)]);
    });
  }
  if (failure != null) Error.throwWithStackTrace(failure!, failureStack!);
  return value;
}
