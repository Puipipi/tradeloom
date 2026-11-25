import 'dart:io';
import 'dart:ui' as ui;

import 'package:dsh_app/ui/settings/appearance/launch_screen_section.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _Outcome {
  const _Outcome(this.image, this.error, this.stack);

  final ui.Image? image;
  final Object? error;
  final StackTrace? stack;
}

Future<File> _png(Directory directory) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawColor(const ui.Color(0xFF4060A0), ui.BlendMode.src);
  final picture = recorder.endRecording();
  ui.Image? image;
  try {
    image = await picture.toImage(2, 3);
    final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!;
    return await File('${directory.path}/thumb.png')
        .writeAsBytes(bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes));
  } finally {
    image?.dispose();
    picture.dispose();
  }
}

void main() {
  for (final retireOnCreation in [false, true]) {
    testWidgets('real launch thumbnail owns its image (retire on creation: $retireOnCreation)', (tester) async {
      // Container, engine work, callbacks, and terminal observation share the
      // real async zone. No fake-clock Completer is carried across runAsync.
      await tester.runAsync(() async {
        final directory = await Directory.systemTemp.createTemp('launch-thumb-owner-');
        final container = ProviderContainer();
        final previousCreate = ui.Image.onCreate;
        final previousDispose = ui.Image.onDispose;
        final created = <ui.Image>[];
        final disposed = <ui.Image>[];
        ui.Image? target;
        var containerDisposed = false;
        Future<_Outcome>? terminal;
        var joined = false;
        try {
          // Generate and dispose the fixture before observing image creation.
          final file = await _png(directory);
          ui.Image.onCreate = (image) {
            created.add(image);
            final isTarget = target == null && image.width == 2 && image.height == 3;
            if (isTarget) target = image;
            previousCreate?.call(image);
            if (isTarget && retireOnCreation) {
              containerDisposed = true;
              container.dispose();
            }
          };
          ui.Image.onDispose = (image) {
            disposed.add(image);
            previousDispose?.call(image);
          };
          final provider = launchThumbProvider(file.path);
          container.listen(provider, (_, _) {}, fireImmediately: true);
          terminal = container
              .read(provider.future)
              .then(
                (image) => _Outcome(image, null, null),
                onError: (Object error, StackTrace stack) => _Outcome(null, error, stack),
              );
          final outcome = await terminal;
          joined = true;
          expect(created, hasLength(1), reason: 'only this real provider decode may create the observed image');
          expect(target, isNotNull);
          expect(target!.width, 2);
          expect(target!.height, 3);
          if (retireOnCreation) {
            expect(containerDisposed, isTrue);
            expect(
              target!.debugDisposed,
              isTrue,
              reason: 'late image must be released after the provider future settled; error: ${outcome.error}',
            );
            expect(disposed.where((image) => identical(image, target)), hasLength(1));
            expect(outcome.error, isNull, reason: '${outcome.stack}');
          } else {
            expect(outcome.error, isNull, reason: '${outcome.stack}');
            expect(outcome.image, same(target));
            expect(target!.debugDisposed, isFalse);
            expect(disposed, isEmpty);
            containerDisposed = true;
            container.dispose();
            expect(target!.debugDisposed, isTrue);
            expect(disposed.where((image) => identical(image, target)), hasLength(1));
          }
        } finally {
          try {
            // Observe the actual provider future, not only the onCreate signal.
            if (terminal != null && !joined) await terminal;
            if (!containerDisposed) container.dispose();
            // A failed ownership assertion must not itself leak the test image.
            for (final image in created) {
              if (!image.debugDisposed) image.dispose();
            }
          } finally {
            ui.Image.onCreate = previousCreate;
            ui.Image.onDispose = previousDispose;
            await directory.delete(recursive: true);
          }
        }
      });
      expect(tester.takeException(), isNull);
    });
  }
}
