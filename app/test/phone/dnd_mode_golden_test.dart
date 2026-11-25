// Golden screenshots of 不打扰模式's channel picker: a first visit, Sui in use,
// Sui waiting for its permission, root failing with its own reason and root
// waiting for its manager, root unfolded before the first su and its notice,
// self-paired ADB mid-pairing, and an old native module's three-way page; 保持
// on for root (connected, unfolded), for ADB waiting for Wi-Fi and for Sui after
// a failed reconnect; then 自动恢复无障碍 granting through root and offering it.
// The dense ones again at 320 dp with 1.3× text (`_320`), some in English.
//
//   flutter test --update-goldens test/phone/dnd_mode_golden_test.dart

import 'package:dsh_app/ui/phone/a11y_restore_sheet.dart';
import 'package:dsh_app/ui/phone/dnd_mode_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';
import '../support/english_preview.dart';
import 'harness.dart';
import 'support.dart';

const _narrow = Size(320, 1100);

void dndGolden(
  String name,
  Map<String, Object?> Function() status, {
  Widget page = const PhoneDndPage(),
  Size size = const Size(390, 1000),
  bool narrow = false,
  bool english = false,
  Future<void> Function(WidgetTester tester)? before,
}) {
  for (final brightness in Brightness.values) {
    final mode = brightness == Brightness.dark ? 'dark' : 'light';
    final file = '${english ? 'en_' : ''}$name${narrow ? '_320' : ''}_$mode';
    testWidgets(file, (tester) async {
      if (english) useEnglish();
      await tester.runAsync(loadGoldenFonts);
      if (narrow) {
        tester.platformDispatcher.textScaleFactorTestValue = 1.3;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      }
      await pumpPhone(
        tester,
        english ? inEnglish(page) : page,
        native: FakePhoneNative(status: status()),
        size: narrow ? Size(_narrow.width, size.height * 1.3) : size,
        brightness: brightness,
      );
      if (before != null) await before(tester);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/$file.png'));
    });
  }
}

Future<void> Function(WidgetTester) tapText(String text) => (tester) async {
  if (text == 'Root' || text == 'Sui' || text == '自连 ADB') {
    await openPhoneChannel(tester, text);
  } else {
    await tester.ensureVisible(find.text(text));
    await tester.tap(find.text(text));
    await tester.pumpAndSettle();
  }
};

Map<String, Object?> firstVisit() => privilegedStatus();

Map<String, Object?> suiInUse() => privilegedStatus(
  mode: 'sui',
  ready: true,
  recommended: 'sui',
  grantPath: 'sui',
  provider: 'sui',
  shizukuApp: true,
  running: true,
  granted: true,
  wirelessDebugging: true,
  paired: true,
);

Map<String, Object?> suiToGrant() => privilegedStatus(recommended: 'sui', provider: 'sui', running: true);

Map<String, Object?> rootLost() => privilegedStatus(
  mode: 'root',
  reason: 'root 通道已断开，请重新选择以连接',
  root: {'checked': true, 'available': true, 'reasonCode': 'rootDisconnected'},
  shizukuApp: true,
);

Map<String, Object?> rootKept() => privilegedStatus(
  mode: 'root',
  ready: true,
  root: {'checked': true, 'available': true, 'connected': true},
  keep: {'enabled': true, 'mode': 'root', 'phase': 'connected', 'reasonCode': null},
);

Map<String, Object?> adbKeptOffline() => privilegedStatus(
  mode: 'adb',
  reason: '无线调试未连接',
  wirelessDebugging: null,
  paired: true,
  keep: {'enabled': true, 'mode': 'adb', 'phase': 'waiting', 'reasonCode': 'networkUnavailable'},
);

Map<String, Object?> suiKeptFailed() => privilegedStatus(
  mode: 'sui',
  reason: '特权通道未就绪',
  provider: 'sui',
  running: true,
  granted: true,
  keep: {'enabled': true, 'mode': 'sui', 'phase': 'failed', 'reasonCode': 'connectFailed'},
);

/// The old field 自动恢复无障碍 still reads for the computer's command.
Map<String, Object?> withKeeper(Map<String, Object?> status) => {
  ...status,
  'a11yKeeper': {
    'granted': false,
    'path': 'setup',
    'command': 'adb shell pm grant io.github.ccch1mneyyy.dsh_app android.permission.WRITE_SECURE_SETTINGS',
  },
};

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // Nothing set up: four quiet rows, root 尚未检查.
  dndGolden('dnd_first_visit', firstVisit);
  dndGolden('dnd_first_visit', firstVisit, narrow: true);

  // The common case: one glance, everything folded.
  dndGolden('dnd_sui_in_use', suiInUse);
  dndGolden('dnd_sui_in_use', suiInUse, narrow: true);
  dndGolden('dnd_sui_in_use', suiInUse, narrow: true, english: true);

  // Sui runs, DSH Go isn't let in yet: suggested, unfolded by a tap.
  dndGolden('dnd_sui_grant', suiToGrant, before: tapText('Sui'));
  dndGolden('dnd_sui_grant', suiToGrant, narrow: true, before: tapText('Sui'));

  // Root picked, its connection gone: the native reason, root unfolded to ask again.
  dndGolden('dnd_root_lost', rootLost);
  dndGolden('dnd_root_lost', rootLost, narrow: true);

  // Root picked, the manager's prompt still open: waiting, not failing.
  dndGolden(
    'dnd_root_waiting',
    () => privilegedStatus(mode: 'root', reason: '正在等待 root 授权', root: {'checked': true, 'starting': true}),
  );

  // Root unfolded before anything ran, then the notice its button opens.
  dndGolden('dnd_root_open', firstVisit, before: tapText('Root'));
  dndGolden(
    'dnd_root_notice',
    firstVisit,
    before: (tester) async {
      await tapText('Root')(tester);
      await tapText('用 Root 开启')(tester);
    },
  );

  // Self-paired ADB with wireless debugging on, not paired yet.
  dndGolden(
    'dnd_adb_pairing',
    () => privilegedStatus(wirelessDebugging: true),
    size: const Size(390, 1500),
    before: tapText('自连 ADB'),
  );
  dndGolden(
    'dnd_adb_pairing',
    () => privilegedStatus(wirelessDebugging: true),
    size: const Size(390, 1500),
    narrow: true,
    before: tapText('自连 ADB'),
  );

  // 保持 on: root connected and unfolded, then two channels still reconnecting.
  dndGolden('dnd_keep_root', rootKept, before: tapText('Root'));
  dndGolden('dnd_keep_root', rootKept, narrow: true, before: tapText('Root'));
  dndGolden('dnd_keep_root', rootKept, narrow: true, english: true, before: tapText('Root'));
  dndGolden('dnd_keep_adb_waiting', adbKeptOffline, size: const Size(390, 1150), narrow: true);
  dndGolden('dnd_keep_sui_failed', suiKeptFailed, narrow: true);

  // An old native module: Shizuku and ADB only, Shizuku in use.
  dndGolden(
    'dnd_legacy',
    () => phoneStatus(
      mode: 'shizuku',
      backgroundReady: true,
      shizukuInstalled: true,
      shizukuRunning: true,
      shizukuGranted: true,
      wirelessDebugging: true,
      paired: true,
    ),
  );

  // 自动恢复无障碍 through root (pm grant), and offering root with nothing else set up.
  const sheet = Scaffold(body: A11yRestoreSheet());
  dndGolden(
    'a11y_restore_root',
    () => withKeeper(
      privilegedStatus(mode: 'root', ready: true, grantPath: 'root', root: {'checked': true, 'connected': true}),
    ),
    page: sheet,
    size: const Size(390, 680),
    narrow: true,
  );
  dndGolden(
    'a11y_restore_offer_root',
    () => withKeeper(privilegedStatus(androidOk: false)),
    page: sheet,
    size: const Size(390, 680),
  );
}
