// The pack inside the app: unpacked by itself the first time the room opens,
// asked for on the setup screen after the person removed it.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:dsh_app/companion/companion_keeper.dart';
import 'package:dsh_app/companion/companion_pack.dart';
import 'package:dsh_app/l10n/gen/app_localizations.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/ui/companion/companion_page.dart';
import 'package:dsh_app/ui/companion/companion_stage.dart';
import 'package:dsh_app/ui/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'phone_keeper_fake.dart';

final _files = <String, List<int>>{
  'runtime/live2dcubismcore.min.js': utf8.encode('core'),
  'runtime/cubism-framework.js': utf8.encode('fw'),
  'character/m.model3.json': utf8.encode('{}'),
  'character/m.moc3': [1, 2, 3],
  'character/character.json': utf8.encode('{"name":"鲸鱼娘"}'),
};

String get _runtime => runtimeDigest({
  for (final e in _files.entries)
    if (e.key.startsWith('runtime/')) e.key: sha256.convert(e.value).toString(),
});

Uint8List _zip() {
  final archive = Archive();
  _files.forEach((name, data) => archive.add(ArchiveFile.bytes(name, data)));
  return Uint8List.fromList(ZipEncoder().encode(archive));
}

/// The real file, except that writing gets seven bytes onto the disk and fails.
class _HalfWritten implements File {
  _HalfWritten(this._real);

  final File _real;

  @override
  String get path => _real.path;

  @override
  Future<File> writeAsBytes(List<int> bytes, {FileMode mode = FileMode.write, bool flush = false}) async {
    await _real.writeAsBytes(bytes.take(7).toList(), flush: true);
    throw FileSystemException('disk full', path);
  }

  @override
  Future<FileSystemEntity> delete({bool recursive = false}) => _real.delete(recursive: recursive);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _Native extends IOOverrides {}

final class _FailingWrites extends IOOverrides {
  @override
  File createFile(String path) {
    final real = IOOverrides.runWithIOOverrides(() => File(path), _Native());
    return path.contains('companion-bundled-') ? _HalfWritten(real) : real;
  }
}

void main() {
  late Directory root;
  late CompanionPackStore store;
  const stageKey = Key('companion-bundled-stage');

  setUp(() {
    root = Directory.systemTemp.createTempSync('companion-bundled');
    store = CompanionPackStore(Directory('${root.path}/companion'), expectedRuntime: _runtime);
    SharedPreferences.setMockInitialValues({'companion_touch_hint_done': true, 'companion_home_hint_done': true});
  });
  tearDown(() {
    try {
      root.deleteSync(recursive: true);
    } on FileSystemException {
      // Windows can hold a file a moment longer; the system clears temp.
    }
  });

  Future<void> open(WidgetTester tester, Future<Uint8List?> Function() bundled) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          activeConnectionProvider.overrideWithValue(const AsyncData<HostConnection?>(null)),
          companionPhoneKeeperProvider.overrideWithValue((_) => FakePhoneKeeper() as CompanionKeeper),
        ],
        child: MaterialApp(
          theme: buildDarkTheme(),
          localizationsDelegates: L10n.localizationsDelegates,
          supportedLocales: L10n.supportedLocales,
          locale: const Locale('zh'),
          home: CompanionPage(
            storeOverride: store,
            bundledPack: bundled,
            stageBuilder: (_, _) => const SizedBox.expand(key: stageKey),
            stageController: CompanionStageController(sink: (_, _) {}),
          ),
        ),
      ),
    );
  }

  /// Real file and isolate work, then the frames it causes.
  Future<void> settle(WidgetTester tester, {bool Function()? until, int rounds = 60}) async {
    for (var i = 0; i < rounds && !(until?.call() ?? false); i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 10));
  }

  bool installed() => File('${store.pack.path}/character/index.json').existsSync();

  Iterable<File> temporaryPacks() =>
      root.listSync().whereType<File>().where((file) => file.path.contains('companion-bundled'));

  // The arriving text also appears during setup. Wait for the real stage
  // branch and its finally cleanup, not a fixed number of file-I/O turns.
  bool installationSettled() => find.byKey(stageKey).evaluate().isNotEmpty && temporaryPacks().isEmpty;

  testWidgets('the first time, the pack inside the app unpacks while she swims over', (tester) async {
    await open(tester, () async => _zip());
    await tester.pump();
    expect(find.text('导入素材包'), findsNothing);
    await settle(tester, until: installationSettled);
    expect(find.byKey(stageKey), findsOneWidget);
    expect(installed(), isTrue);
    // Straight on to her: the stage loading, no setup screen in between.
    expect(find.text('她正在游过来…'), findsOneWidget);
    expect(find.text('接她回家'), findsNothing);
    // Nothing left lying around next to her folder.
    expect(temporaryPacks(), isEmpty);
    await close(tester);
  });

  testWidgets('after the person removed it, it waits to be asked for', (tester) async {
    SharedPreferences.setMockInitialValues({'companion_pack_removed': true});
    await open(tester, () async => _zip());
    await settle(tester, until: () => find.text('接她回家').evaluate().isNotEmpty);
    expect(find.text('接她回家'), findsOneWidget);
    expect(find.text('导入别的素材包'), findsOneWidget);
    expect(installed(), isFalse);

    await tester.tap(find.text('接她回家'));
    await settle(tester, until: installationSettled);
    expect(find.byKey(stageKey), findsOneWidget);
    expect(installed(), isTrue);
    expect(find.text('她正在游过来…'), findsOneWidget);
    expect(temporaryPacks(), isEmpty);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('companion_pack_removed'), isNull);
    await close(tester);
  });

  testWidgets('a write that fails halfway leaves nothing behind, retry included (Pro C542)', (tester) async {
    List<String> leftovers() => [
      for (final f in root.listSync().whereType<File>())
        if (f.path.contains('companion-bundled-')) f.path,
    ];
    await IOOverrides.runWithIOOverrides(() async {
      await open(tester, () async => _zip());
      await settle(tester, until: () => find.text('接她回家').evaluate().isNotEmpty);
      expect(find.text('接她回家'), findsOneWidget);
      expect(installed(), isFalse);
      expect(leftovers(), isEmpty);

      await tester.tap(find.text('接她回家'));
      await settle(tester, rounds: 10);
      expect(find.text('接她回家'), findsOneWidget);
      expect(leftovers(), isEmpty);
      await close(tester);
    }, _FailingWrites());
  });

  testWidgets('a build without one asks for a zip, as before', (tester) async {
    await open(tester, () async => null);
    await settle(tester, until: () => find.text('导入素材包').evaluate().isNotEmpty);
    expect(find.text('导入素材包'), findsOneWidget);
    expect(find.text('接她回家'), findsNothing);
    expect(find.text('导入别的素材包'), findsNothing);
    await close(tester);
  });
}
