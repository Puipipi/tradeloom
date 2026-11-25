import 'dart:async';
import 'dart:io';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_backup.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// The preview, writing a small ZIP where it is asked to back up.
class _Backed extends PreviewTavern {
  _Backed() : super(tick: Duration.zero);

  final paths = <String>[];

  @override
  Future<TavernBackupInfo> backup(String destinationPath) async {
    paths.add(destinationPath);
    File(destinationPath).writeAsBytesSync([0x50, 0x4b, 5, 6]);
    return TavernBackupInfo(
      createdAt: DateTime(2026, 11, 11),
      sqliteUserVersion: 6,
      fileCount: 12,
      totalBytes: 3670016,
    );
  }
}

late Directory _temp;

/// 酒馆设置 with the files and the share sheet swapped: backups go to a
/// temporary folder, [picked] is what the picker returns, [restore] stands in
/// for closing, restoring and reopening the engine.
Future<List<(String, String)>> _open(
  WidgetTester tester,
  PreviewTavern tavern, {
  String? picked,
  Future<TavernBackupInfo> Function(String path)? restore,
}) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  final shared = <(String, String)>[];
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tavernProvider.overrideWith((ref) => tavern),
        tavernBackupDirProvider.overrideWithValue(() async => _temp),
        tavernBackupShareProvider.overrideWithValue((path, name) async => shared.add((path, name))),
        tavernBackupPickerProvider.overrideWithValue(() async => picked),
        tavernRestoreProvider.overrideWithValue(restore ?? (path) async => throw StateError('not expected')),
      ],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: const TavernSettingsPage(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return shared;
}

Future<void> _tap(WidgetTester tester, String key) async {
  final row = find.byKey(ValueKey(key));
  await tester.scrollUntilVisible(row, 200, scrollable: find.byType(Scrollable).first);
  unawaited(Scrollable.ensureVisible(tester.element(row), alignment: 0.5));
  await tester.pumpAndSettle();
  await tester.tap(row);
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => _temp = Directory.systemTemp.createTempSync('dsh-tavern-backup-test-'));
  tearDown(() => _temp.deleteSync(recursive: true));

  test('sizes read as KB or MB; a backup is named by when it was made', () {
    expect(tavernSize(2048), '2 KB');
    expect(tavernSize(3670016), '3.5 MB');
    expect(tavernBackupName(DateTime(2026, 11, 11, 8, 5)), 'dshgo-tavern-20261111-0805.zip');
  });

  testWidgets('备份 writes one ZIP, hands it on, and says how much is in it', (tester) async {
    final tavern = _Backed();
    final shared = await _open(tester, tavern);
    await _tap(tester, 'tavern-backup');

    expect(tavern.paths, hasLength(1));
    expect(tavern.paths.single, startsWith(_temp.path));
    final (path, name) = shared.single;
    expect(path, tavern.paths.single);
    expect(name, matches(RegExp(r'^dshgo-tavern-\d{8}-\d{4}\.zip$')));
    expect(File(path).existsSync(), isTrue);
    expect(find.text('备份好了：12 个文件，3.5 MB'), findsOneWidget);
  });

  testWidgets('a backup that fails says so and hands nothing on', (tester) async {
    final shared = await _open(tester, PreviewTavern(tick: Duration.zero));
    await _tap(tester, 'tavern-backup');
    expect(shared, isEmpty);
    expect(find.textContaining('没能备份'), findsOneWidget);
  });

  testWidgets('恢复 asks first; only on 恢复 does it replace the tavern', (tester) async {
    final restored = <String>[];
    await _open(
      tester,
      PreviewTavern(tick: Duration.zero),
      picked: '/backups/dshgo-tavern.zip',
      restore: (path) async {
        restored.add(path);
        return TavernBackupInfo(createdAt: DateTime(2026, 11, 10), sqliteUserVersion: 5, fileCount: 30, totalBytes: 1);
      },
    );
    await _tap(tester, 'tavern-restore');
    expect(find.text('用这份备份替换现在的酒馆？'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '取消'));
    await tester.pumpAndSettle();
    expect(restored, isEmpty);

    await _tap(tester, 'tavern-restore');
    await tester.tap(find.widgetWithText(TextButton, '恢复'));
    await tester.pumpAndSettle();
    expect(restored, ['/backups/dshgo-tavern.zip']);
    expect(find.text('恢复好了：30 个文件'), findsOneWidget);
  });

  testWidgets('nothing picked, nothing asked', (tester) async {
    await _open(tester, PreviewTavern(tick: Duration.zero));
    await _tap(tester, 'tavern-restore');
    expect(find.byType(AlertDialog), findsNothing);
  });

  testWidgets('a restore that fails says the tavern is as it was', (tester) async {
    await _open(
      tester,
      PreviewTavern(tick: Duration.zero),
      picked: '/backups/broken.zip',
      restore: (path) async => throw const FormatException('not a tavern backup'),
    );
    await _tap(tester, 'tavern-restore');
    await tester.tap(find.widgetWithText(TextButton, '恢复'));
    await tester.pumpAndSettle();
    expect(find.textContaining('没能恢复，现在的数据没动'), findsOneWidget);
  });
}
