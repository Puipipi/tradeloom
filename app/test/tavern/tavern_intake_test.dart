import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/ui/tavern/tavern_intake.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory dir;
  setUp(() => dir = Directory.systemTemp.createTempSync('tavern-intake'));
  tearDown(() => dir.deleteSync(recursive: true));

  File write(String name, List<int> bytes) => File('${dir.path}/$name')..writeAsBytesSync(bytes);

  const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  List<int> png(String? key) => [
    ...signature,
    ...[0, 0, 0, 13],
    ...ascii.encode('IHDR'),
    ...List.filled(17, 0),
    if (key != null) ...[0, 0, 0, 8, ...ascii.encode('tEXt$key'), 0, ...ascii.encode('e30='), 0, 0, 0, 0],
    ...[0, 0, 0, 0],
    ...ascii.encode('IEND'),
    0xAE,
    0x42,
    0x60,
    0x82,
  ];

  test('cards are recognised, other files are not', () async {
    expect(await isTavernCardFile(write('a.png', png('chara')), 'a.png'), isTrue);
    expect(await isTavernCardFile(write('b.png', png('ccv3')), 'b.png'), isTrue);
    expect(await isTavernCardFile(write('photo.png', png(null)), 'photo.png'), isFalse);
    expect(await isTavernCardFile(write('c.charx', [1, 2, 3]), 'c.charx'), isTrue);
    expect(
      await isTavernCardFile(write('d.json', utf8.encode('{"spec":"chara_card_v3","data":{}}')), 'd.json'),
      isTrue,
    );
    expect(await isTavernCardFile(write('e.json', utf8.encode('{"name":"x"}')), 'e.json'), isFalse);
    expect(await isTavernCardFile(write('notes.txt', utf8.encode('tEXtchara')), 'notes.txt'), isFalse);
  });
}
