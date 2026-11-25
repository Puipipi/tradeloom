import 'dart:io';

import 'package:dsh_app/launch/custom_launch.dart';
import 'package:dsh_app/launch/launch_import.dart';
import 'package:dsh_app/plugins/native/native_file_platform.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

// Keep the real channel adapter; observe its cancellation Future so cleanup is joined.
class _Files extends MethodNativeFilePlatform {
  Future<void>? cancellation;

  @override
  Future<void> cancel(String owner) => cancellation = super.cancel(owner);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final code in ['failed', 'cancelled', 'too-large', 'empty-selection']) {
    test('launch read classification: $code', () async {
      final dir = Directory.systemTemp.createTempSync('launch-read-error-');
      final fixture = File('test/wallpaper/fixtures/landscape.png').readAsBytesSync();
      final old = File('${dir.path}/previous.png')..writeAsBytesSync(fixture);
      final previous = CustomLaunch(kind: LaunchMediaKind.image, path: old.path, width: 300, height: 200);
      final calls = <MethodCall>[];
      final platform = _Files();
      var reads = 0;
      final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(MethodNativeFilePlatform.channel, (call) async {
        calls.add(call);
        switch (call.method) {
          case 'capabilities':
            return {'files': true};
          case 'pick':
            // Unknown length is a supported native selection; only read can report its limit.
            return code == 'empty-selection'
                ? null
                : [
                    {'handle': 'selected-image', 'name': 'new.png', 'mediaType': 'image/png'},
                  ];
          case 'read':
            if (reads++ == 0) return Uint8List.fromList(fixture.take(32).toList());
            throw PlatformException(code: code, message: 'native read did not complete');
          case 'cancel':
            return null;
          default:
            throw StateError('unexpected method ${call.method}');
        }
      });
      try {
        final result = await LaunchImport(platform: platform, directory: () async => dir).pick(previous: previous);
        expect(platform.cancellation, isNotNull);
        await platform.cancellation;
        final empty = code == 'empty-selection';
        expect(calls.map((call) => call.method), [
          'capabilities',
          'pick',
          if (!empty) ...['read', 'read'],
          'cancel',
        ]);
        final owner = (calls[1].arguments as Map)['owner'];
        expect(owner, isA<String>());
        for (final call in calls.where((call) => call.method == 'read')) {
          expect(call.arguments, {'owner': owner, 'handle': 'selected-image'});
        }
        expect(calls.last.arguments, {'owner': owner});
        expect(result.$1, isNull);
        expect(old.readAsBytesSync(), fixture);
        expect(dir.listSync().map((file) => file.path), [old.path]);
        expect(result.$2, switch (code) {
          'empty-selection' => LaunchImportProblem.cancelled,
          'too-large' => LaunchImportProblem.overLimit,
          _ => LaunchImportProblem.unreadable,
        });
      } finally {
        if (platform.cancellation != null) await platform.cancellation;
        messenger.setMockMethodCallHandler(MethodNativeFilePlatform.channel, null);
        dir.deleteSync(recursive: true);
      }
    });
  }
}
