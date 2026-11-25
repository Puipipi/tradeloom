import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/state/attachments.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter_test/flutter_test.dart';

final class _PickedFile extends PlatformFile {
  _PickedFile(this.chunks, {this.reportedLength, this.readError, this.source});

  final List<Uint8List> chunks;
  final int? reportedLength;
  final Object? readError;
  final Stream<Uint8List> Function()? source;
  int wholeReads = 0;
  int lengthReads = 0;
  int streams = 0;
  int emitted = 0;
  bool closed = false;

  @override
  String get name => 'synthetic-private-key';
  @override
  Uri get uri => Uri.parse('memory:synthetic-private-key');
  @override
  Never get xFile => throw UnsupportedError('The picker exposes its byte stream');
  @override
  int? lengthSync() => reportedLength;
  @override
  Future<int?> length() async {
    lengthReads++;
    return reportedLength;
  }

  @override
  Future<Uint8List> readAsBytes() async {
    wholeReads++;
    final bytes = BytesBuilder();
    if (source != null) {
      await for (final chunk in source!()) {
        bytes.add(chunk);
      }
    } else {
      for (final chunk in chunks) {
        bytes.add(chunk);
      }
    }
    if (readError != null) throw readError!;
    return bytes.takeBytes();
  }

  @override
  Stream<Uint8List> readAsByteStream() async* {
    streams++;
    try {
      if (source != null) {
        yield* source!();
      } else {
        for (final chunk in chunks) {
          emitted++;
          yield chunk;
        }
      }
      if (readError != null) throw readError!;
    } finally {
      closed = true;
    }
  }
}

class _Picker extends FilePickerPlatform {
  PlatformFile? selected;

  @override
  Future<PlatformFile?> pickFile({
    String? dialogTitle,
    String? initialDirectory,
    FileType type = FileType.any,
    List<String>? allowedExtensions,
    Function(FilePickerStatus)? onFileLoading,
    int compressionQuality = 0,
    AndroidOptions androidOptions = const AndroidOptions(),
    DarwinOptions darwinOptions = const DarwinOptions(),
    WindowsOptions windowsOptions = const WindowsOptions(),
    LinuxOptions linuxOptions = const LinuxOptions(),
    WebOptions webOptions = const WebOptions(),
  }) async => selected;
}

Future<void> expectTooLarge(Future<String?> result) async {
  Object? failure;
  try {
    await result;
  } catch (error) {
    failure = error;
  }
  // Do not put selected private-key contents into an assertion failure.
  expect(failure, isA<FormatException>().having((e) => e.message, 'message', appL10n.statePrivateKeyTooLarge));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const device = DeviceAttachmentPicker();
  const budget = 64 * 1024;
  late FilePickerPlatform original;
  late _Picker picker;

  setUp(() {
    original = FilePickerPlatform.instance;
    picker = _Picker();
    FilePickerPlatform.instance = picker;
  });
  tearDown(() => FilePickerPlatform.instance = original);

  test('cancel returns null', () async {
    expect(await device.pickTextFile(), isNull);
  });

  test('known oversize is rejected without opening or fully reading it', () async {
    final file = _PickedFile([], reportedLength: budget + 1);
    picker.selected = file;
    await expectTooLarge(device.pickTextFile());
    expect(file.streams, 0);
    expect(file.wholeReads, 0);
  });

  for (final reported in <int?>[null, 0, 1, budget]) {
    test('reported length $reported cannot bypass the actual byte budget', () async {
      final file = _PickedFile([Uint8List(budget), Uint8List(1), Uint8List(1)], reportedLength: reported);
      picker.selected = file;
      await expectTooLarge(device.pickTextFile());
      expect(file.emitted, 2, reason: 'do not request a third chunk after overflow');
      expect(file.closed, isTrue);
      expect(file.wholeReads, 0);
      expect(file.lengthReads, 0, reason: 'size lookup must not itself read an unknown file');
    });
  }

  test('one oversized chunk is rejected and the stream is cancelled', () async {
    final file = _PickedFile([Uint8List(budget + 1), Uint8List(1)]);
    picker.selected = file;
    await expectTooLarge(device.pickTextFile());
    expect(file.emitted, 1);
    expect(file.closed, isTrue);
    expect(file.wholeReads, 0);
  });

  test('exactly 64 KiB is accepted with no whole-file read', () async {
    final file = _PickedFile([Uint8List(budget ~/ 2), Uint8List(budget ~/ 2)]);
    picker.selected = file;
    expect((await device.pickTextFile())!.length, budget);
    expect(file.wholeReads, 0);
    expect(file.closed, isTrue);
  });

  test('empty file remains empty for the existing key-format validation', () async {
    picker.selected = _PickedFile([]);
    expect(await device.pickTextFile(), '');
  });

  test('UTF-8 split between chunks is decoded after collection', () async {
    final bytes = utf8.encode('密钥\n');
    final file = _PickedFile([Uint8List.fromList(bytes.sublist(0, 2)), Uint8List.fromList(bytes.sublist(2))]);
    picker.selected = file;
    expect(await device.pickTextFile(maxBytes: bytes.length), '密钥\n');
    expect(file.wholeReads, 0);
  });

  test('the budget measures UTF-8 bytes rather than characters', () async {
    picker.selected = _PickedFile([Uint8List.fromList(utf8.encode('密钥'))]);
    await expectTooLarge(device.pickTextFile(maxBytes: 2));
  });

  test('malformed UTF-8 keeps the existing replacement behavior within the limit', () async {
    picker.selected = _PickedFile([
      Uint8List.fromList([0x41, 0xff]),
    ]);
    expect(await device.pickTextFile(maxBytes: 2), 'A\ufffd');
  });

  test('a stream error propagates without returning partial key text', () async {
    final failure = FileSystemException('synthetic read failure');
    final file = _PickedFile([
      Uint8List.fromList([0x41]),
    ], readError: failure);
    picker.selected = file;
    await expectLater(device.pickTextFile(), throwsA(same(failure)));
    expect(file.closed, isTrue);
  });

  test('a real local file growing after selection is still rejected', () async {
    final directory = await Directory.systemTemp.createTemp('dsh-key-budget-');
    addTearDown(() => directory.delete(recursive: true));
    final disk = File('${directory.path}/synthetic-key');
    await disk.writeAsBytes([0x41]);
    final file = _PickedFile(
      [],
      reportedLength: await disk.length(),
      source: () => disk.openRead().map(Uint8List.fromList),
    );
    picker.selected = file;
    await disk.writeAsBytes(Uint8List(budget + 1));
    await expectTooLarge(device.pickTextFile());
    expect(file.closed, isTrue);
    expect(file.wholeReads, 0);
  });
}
