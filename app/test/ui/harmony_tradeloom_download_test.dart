import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/state/artifacts.dart';
import 'package:dsh_app/ui/tradeloom/harmony_tradeloom_download.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

final _origin = Uri.parse('https://portal.example');
final _attachment = _origin.resolve('/enterprise/deliveries/${'a' * 32}/${'b' * 32}/download');
const _method = MethodChannel('test/harmony-delivery');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late Directory directory;
  late List<Map<String, Object>> messages;
  late List<String> evaluations;
  late List<MethodCall> saves;

  HarmonyTradeLoomDownload download({String document = 'https://portal.example/enterprise/deliveries/'}) =>
      HarmonyTradeLoomDownload(
        currentUrl: () async => document,
        cache: () async => directory,
        files: const FilesChannel(_method),
        evaluate: (script) async {
          evaluations.add(script);
          if (script.startsWith('(function(') || script.contains('?.cancel()')) return true;
          return jsonEncode(jsonEncode(messages.removeAt(0)));
        },
      );

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('test-harmony-delivery-');
    evaluations = [];
    saves = [];
    messages = [
      {
        'kind': 'header',
        'disposition': 'attachment; filename="sample_checklist.json"',
        'mime': 'application/json; charset=utf-8',
        'length': '4',
      },
      {
        'kind': 'chunk',
        'bytes': base64Encode([0, 255]),
      },
      {
        'kind': 'chunk',
        'bytes': base64Encode([17, 0]),
      },
      {'kind': 'end'},
    ];
    messenger.setMockMethodCallHandler(_method, (call) async {
      saves.add(call);
      expect(call.method, 'saveToDownloads');
      expect(call.arguments['name'], 'sample_checklist.json');
      expect(call.arguments['mime'], 'application/json');
      expect(await File(call.arguments['path'] as String).readAsBytes(), [0, 255, 17, 0]);
      return 'file://docs/selected';
    });
  });

  tearDown(() async {
    messenger.setMockMethodCallHandler(_method, null);
    await directory.delete(recursive: true);
  });

  test('saves two decoded chunks once through the picker and removes staging', () async {
    expect(await download().save(_origin, _attachment), 'file://docs/selected');
    expect(saves, hasLength(1));
    expect(await directory.list().toList(), isEmpty);
    expect(evaluations.first, contains("credentials: 'same-origin'"));
    expect(evaluations.first, contains("redirect: 'error'"));
    expect(evaluations.last, contains('?.cancel()'));
  });

  test('foreign and non-enterprise documents never start web fetch', () async {
    for (final document in ['https://other.example/enterprise/', 'https://portal.example/accounts/login/']) {
      await expectLater(download(document: document).save(_origin, _attachment), throwsFormatException);
    }
    expect(evaluations, isEmpty);
    expect(saves, isEmpty);
  });

  test('mismatched media and premature EOF never launch the picker', () async {
    final header = messages.first;
    messages[0] = {...header, 'mime': 'text/html'};
    await expectLater(download().save(_origin, _attachment), throwsFormatException);
    messages = [
      header,
      {'kind': 'end'},
    ];
    await expectLater(download().save(_origin, _attachment), throwsFormatException);
    expect(saves, isEmpty);
    expect(await directory.list().toList(), isEmpty);
  });

  test('navigation retires a pending native picker owner before removing staging', () async {
    final opened = Completer<void>();
    final picker = Completer<String>();
    final transfer = download();
    messenger.setMockMethodCallHandler(_method, (call) {
      saves.add(call);
      if (call.method == 'saveToDownloads') {
        opened.complete();
        return picker.future;
      }
      expect(call.method, 'cancelDownloadSave');
      expect(call.arguments['owner'], saves.first.arguments['owner']);
      picker.completeError(PlatformException(code: 'cancelled'));
      return Future.value(null);
    });
    final saved = transfer.save(_origin, _attachment);
    await opened.future;
    transfer.cancel();
    expect(await saved, isNull);
    expect(saves, hasLength(2));
    expect(await directory.list().toList(), isEmpty);
  });
}
