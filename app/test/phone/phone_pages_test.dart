// The sub-pages: restricted-settings guide, 不打扰模式 (the Shizuku and 自连 ADB
// set-ups; the channel picker itself is dnd_channels_test.dart), 应用名单 with
// its risk notes.

import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/ui/common/app_sheet.dart';
import 'package:dsh_app/ui/common/ask_ai.dart';
import 'package:dsh_app/ui/common/list_page_row.dart';
import 'package:dsh_app/ui/common/risk_notice.dart';
import 'package:dsh_app/ui/phone/app_rules_page.dart';
import 'package:dsh_app/ui/phone/dnd_mode_page.dart';
import 'package:dsh_app/ui/phone/phone_widgets.dart';
import 'package:dsh_app/ui/phone/restricted_settings_guide.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'harness.dart';
import 'support.dart';

Finder groupTitled(String title) => find.ancestor(of: find.text(title), matching: find.byType(ListPageCard));

ButtonStyleButton button(WidgetTester tester, String label) => tester.widget<ButtonStyleButton>(
  find.ancestor(of: find.text(label), matching: find.bySubtype<ButtonStyleButton>()).first,
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('restricted settings guide', () {
    testWidgets('picks the ROM from the device, switches, opens system pages', (tester) async {
      final h = await pumpPhone(tester, const RestrictedSettingsGuidePage());
      bool selected(String label) => tester.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, label)).selected;
      expect(selected('vivo / iQOO'), isTrue);
      expect(find.textContaining('点右上角的三个点'), findsOneWidget);
      expect(find.textContaining('OriginOS'), findsOneWidget);
      expect(find.byType(GuideDiagram), findsOneWidget);

      await tester.tap(find.text('小米 / Redmi'));
      await tester.pumpAndSettle();
      expect(selected('小米 / Redmi'), isTrue);
      expect(find.text('在「高级设置」里找到「允许受限制的设置」，打开它。'), findsOneWidget);
      expect(tester.widget<GuideDiagram>(find.byType(GuideDiagram)).advanced, isTrue);

      await tester.tap(find.text('OPPO / 一加 / realme'));
      await tester.pumpAndSettle();
      expect(find.textContaining('覆盖安装一次'), findsOneWidget);

      await tester.tap(find.text('华为'));
      await tester.pumpAndSettle();
      expect(find.byType(GuideDiagram), findsNothing);

      await tester.tap(find.text('打开应用信息'));
      await tester.pump();
      await tester.tap(find.text('去开无障碍'));
      await tester.pump();
      expect(h.native!.methods, containsAll(['openAppDetails', 'openAccessibilitySettings']));
    });

    test('manufacturer → ROM family', () {
      expect(RomFamily.of('vivo'), RomFamily.vivo);
      expect(RomFamily.of('iQOO'), RomFamily.vivo);
      expect(RomFamily.of('Xiaomi'), RomFamily.xiaomi);
      expect(RomFamily.of('Redmi'), RomFamily.xiaomi);
      expect(RomFamily.of('OnePlus'), RomFamily.oppo);
      expect(RomFamily.of('HONOR'), RomFamily.honor);
      expect(RomFamily.of('HUAWEI'), RomFamily.huawei);
      expect(RomFamily.of('Google'), RomFamily.stock);
      expect(RomFamily.of(null), RomFamily.stock);
    });
  });

  group('不打扰模式', () {
    for (final manufacturer in ['Xiaomi', 'Google']) {
      testWidgets('USB debugging note only appears on Xiaomi: $manufacturer', (tester) async {
        await pumpPhone(
          tester,
          const PhoneDndPage(),
          native: FakePhoneNative(
            status: phoneStatus(device: {'manufacturer': manufacturer, 'sdkInt': 35, 'sideloaded': true}),
          ),
        );
        await tester.tap(find.text('自连 ADB'));
        await tester.pumpAndSettle();
        await openPhoneFold(tester, 'phone-adb-pairing-help');
        expect(find.textContaining('USB 调试（安全设置）'), manufacturer == 'Xiaomi' ? findsOneWidget : findsNothing);
      });
    }
    for (final sdk in [35, 37]) {
      testWidgets('Shizuku compatibility note follows Android version $sdk', (tester) async {
        await pumpPhone(
          tester,
          const PhoneDndPage(),
          native: FakePhoneNative(
            status: phoneStatus(device: {'manufacturer': 'Google', 'sdkInt': sdk, 'sideloaded': true}),
          ),
        );
        await tester.tap(find.text('Shizuku'));
        await tester.pumpAndSettle();
        expect(find.textContaining('官方版 Shizuku'), sdk >= 37 ? findsOneWidget : findsNothing);
      });
    }

    testWidgets('honest notes; below Android 14 nothing can be enabled', (tester) async {
      await pumpPhone(
        tester,
        const PhoneDndPage(),
        native: FakePhoneNative(
          status: phoneStatus(androidOk: false, shizukuInstalled: true, shizukuRunning: true, shizukuGranted: true),
        ),
      );
      expect(find.text('这台手机用不了：需要 Android 14 及以上。'), findsOneWidget);
      expect(find.textContaining('保持亮屏、解锁'), findsNothing);
      await openPhoneFold(tester, 'phone-dnd-options');
      expect(find.textContaining('保持亮屏、解锁'), findsOneWidget);
      expect(find.textContaining('重启手机后重新激活'), findsOneWidget);
      expect(find.textContaining('保持无线调试开启'), findsOneWidget);
      await tester.tap(find.text('Shizuku'));
      await tester.pumpAndSettle();
      expect(button(tester, '用 Shizuku 开启').onPressed, isNull);
    });

    testWidgets('Shizuku: install link, grant, enable, turn off', (tester) async {
      final h = await pumpPhone(tester, const PhoneDndPage());
      await tester.tap(find.text('Shizuku'));
      await tester.pumpAndSettle();
      expect(find.text('打开 Shizuku 官网'), findsOneWidget);
      expect(find.text('用 Shizuku 开启'), findsNothing);

      h.native!.push(phoneStatus(shizukuInstalled: true));
      await settlePhone(tester);
      expect(find.textContaining('通过无线调试启动'), findsOneWidget);

      h.native!.push(phoneStatus(shizukuInstalled: true, shizukuRunning: true));
      await settlePhone(tester);
      await tester.tap(find.text('授权给 DSH Go'));
      await tester.pump();
      expect(h.native!.callsOf('requestShizukuPermission'), hasLength(1));

      h.native!.push(phoneStatus(shizukuInstalled: true, shizukuRunning: true, shizukuGranted: true));
      await settlePhone(tester);
      expect(find.text('Shizuku 已启动并授权，接下来连接后台屏。'), findsOneWidget);
      await tester.tap(find.text('用 Shizuku 开启'));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('setBackgroundMode').single.arguments, {'mode': 'shizuku'});
      expect(find.text('正在使用：Shizuku'), findsOneWidget);
      expect(find.text('用 Shizuku 开启'), findsNothing);

      await tester.tap(find.widgetWithText(TextButton, '关闭'));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('setBackgroundMode').last.arguments, {'mode': 'off'});
      expect(find.text('正在使用：Shizuku'), findsNothing);
    });

    testWidgets('Sui can grant and enable without the Shizuku manager', (tester) async {
      final h = await pumpPhone(
        tester,
        const PhoneDndPage(),
        native: FakePhoneNative(status: privilegedStatus(provider: 'sui', running: true)),
      );
      await openPhoneChannel(tester, 'Sui');
      await tester.pumpAndSettle();
      expect(find.text('打开 Shizuku 官网'), findsNothing);
      expect(find.text('用 Sui 开启'), findsNothing);
      await tester.tap(find.text('授权给 DSH Go'));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('requestShizukuPermission').single.arguments, {'provider': 'sui'});

      h.native!.push(privilegedStatus(provider: 'sui', running: true, granted: true));
      await settlePhone(tester);
      expect(find.text('Sui 已启动并授权，接下来连接后台屏。'), findsOneWidget);
      await tester.tap(find.text('用 Sui 开启'));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('setBackgroundMode').single.arguments, {'mode': 'sui'});
    });

    testWidgets('Sui binder death disables enabling despite a stale grant', (tester) async {
      final h = await pumpPhone(
        tester,
        const PhoneDndPage(),
        native: FakePhoneNative(status: privilegedStatus(provider: 'sui', running: true, granted: true)),
      );
      await openPhoneChannel(tester, 'Sui');
      await tester.pumpAndSettle();
      expect(find.text('用 Sui 开启'), findsOneWidget);
      h.native!.push(privilegedStatus(provider: 'sui', granted: true));
      await settlePhone(tester);
      expect(find.text('用 Sui 开启'), findsNothing);
      expect(find.text('Sui 接口当前不可用。确认 Sui 模块已启用，重启手机后再试。'), findsOneWidget);
    });

    testWidgets('a refused mode shows the native reason', (tester) async {
      final native = FakePhoneNative(
        status: phoneStatus(shizukuInstalled: true, shizukuRunning: true, shizukuGranted: true),
      );
      native.results['setBackgroundMode'] = {'ok': false, 'reason': '这台手机建不了受信的虚拟屏'};
      await pumpPhone(tester, const PhoneDndPage(), native: native);
      await tester.tap(find.text('Shizuku'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('用 Shizuku 开启'));
      await tester.pumpAndSettle();
      expect(find.text('这台手机建不了受信的虚拟屏'), findsOneWidget);
    });

    testWidgets('自连 ADB: walkthrough, notification pairing, manual pairing, connect', (tester) async {
      final h = await pumpPhone(
        tester,
        const PhoneDndPage(),
        native: FakePhoneNative(status: phoneStatus(wirelessDebugging: null)),
      );
      await tester.tap(find.text('自连 ADB'));
      await tester.pumpAndSettle();
      expect(find.textContaining('连点「版本号」7 次'), findsNothing);
      await openPhoneFold(tester, 'phone-adb-pairing-help');
      expect(find.textContaining('使用配对码配对设备'), findsWidgets);
      expect(find.textContaining('连点「版本号」7 次'), findsOneWidget);
      // Unknown wireless-debugging state is not presented as a failed check.
      expect(find.text('不确定'), findsNothing);
      expect(find.textContaining('恶意软件'), findsNothing);
      expect(find.text('连接'), findsNothing);

      await tester.tap(find.text('开始配对'));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('adbStartPairing'), hasLength(1));

      await tester.tap(find.text('手动填写'));
      await tester.pumpAndSettle();
      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), '12345');
      await tester.pump();
      expect(button(tester, '配对').onPressed, isNull);
      await tester.enterText(fields.at(0), '482913');
      await tester.enterText(fields.at(1), '37123');
      await tester.pump();
      await tester.tap(find.text('配对'));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('adbPair').single.arguments, {'code': '482913', 'port': 37123});

      h.native!.push(phoneStatus(wirelessDebugging: true, paired: true));
      await settlePhone(tester);
      await tester.tap(find.text('连接'));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('adbConnect'), hasLength(1));
      expect(h.native!.callsOf('setBackgroundMode'), isEmpty);

      h.native!.push(phoneStatus(wirelessDebugging: true, paired: true, adbConnected: true));
      await settlePhone(tester);
      await tester.tap(find.text('用自连 ADB 开启'));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('setBackgroundMode').single.arguments, {'mode': 'adb'});
    });

    testWidgets('manual ADB connection validates the connect port and keeps mode off', (tester) async {
      final h = await pumpPhone(
        tester,
        const PhoneDndPage(),
        native: FakePhoneNative(status: phoneStatus(paired: true)),
      );
      await tester.tap(find.text('自连 ADB'));
      await tester.pumpAndSettle();
      await openPhoneFold(tester, 'phone-adb-connect-help');
      await tester.tap(find.text('按端口连接'));
      await tester.pumpAndSettle();
      final connect = find.descendant(of: find.byType(AlertDialog), matching: find.widgetWithText(FilledButton, '连接'));
      expect(tester.widget<FilledButton>(connect).onPressed, isNull);
      for (final invalid in ['0', '65536']) {
        await tester.enterText(find.byKey(const ValueKey('adb-connect-port')), invalid);
        await tester.pump();
        expect(tester.widget<FilledButton>(connect).onPressed, isNull);
      }
      await tester.enterText(find.byKey(const ValueKey('adb-connect-port')), '45269');
      await tester.pump();
      await tester.tap(connect);
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('adbConnect').single.arguments, {'port': 45269});
      expect(h.native!.callsOf('setBackgroundMode'), isEmpty);
    });

    test('summary line for the main page', () {
      expect(dndSummary(const PhoneBackgroundStatus(androidOk: true)), '在看不见的屏幕上操作');
      expect(dndSummary(const PhoneBackgroundStatus()), '需要 Android 14 及以上');
      expect(
        dndSummary(const PhoneBackgroundStatus(androidOk: true, mode: PhoneBackgroundMode.adb, ready: true)),
        '自连 ADB · 可以用了',
      );
      expect(
        dndSummary(const PhoneBackgroundStatus(androidOk: true, mode: PhoneBackgroundMode.shizuku)),
        'Shizuku · 还没准备好',
      );
    });
  });

  group('应用名单', () {
    testWidgets('banks and payment are off limits; WeChat confirms each step', (tester) async {
      await pumpPhone(tester, const PhoneAppRulesPage());
      final deny = groupTitled('不碰');
      for (final app in ['支付宝', '云闪付', '招商银行', '中国工商银行']) {
        expect(find.descendant(of: deny, matching: find.text(app)), findsOneWidget);
      }
      expect(find.descendant(of: groupTitled('每一步都确认'), matching: find.text('微信')), findsOneWidget);
      expect(find.text('密码、验证码、付款和系统设置都由你来'), findsOneWidget);
    });

    testWidgets('loosening shows the risk first; tightening does not', (tester) async {
      final h = await pumpPhone(tester, const PhoneAppRulesPage());
      Future<void> pick(String app, String rule) async {
        await tester.tap(find.text(app));
        await tester.pumpAndSettle();
        await tester.tap(
          find.descendant(of: find.byType(SheetGroup), matching: find.widgetWithText(ListPageRow, rule)),
        );
        await tester.pumpAndSettle();
      }

      await pick('支付宝', '照常');
      expect(find.text('让 DSH 操作「支付宝」？'), findsOneWidget);
      expect(find.textContaining('冻结账号'), findsOneWidget);
      // Every time, in the danger colour: the cost lands outside the app.
      final notice = tester.widget<RiskNoticeSheet>(find.byType(RiskNoticeSheet)).notice;
      expect(notice.level, RiskLevel.high);
      expect(notice.ask, AskAiTopic.appRules);
      await tester.tap(find.descendant(of: find.byType(SheetHeader), matching: find.byType(SheetIconButton)));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('setPolicies'), isEmpty);

      await pick('支付宝', '照常');
      await tester.tap(find.text('我知道风险，仍然修改'));
      await tester.pumpAndSettle();
      expect(h.native!.callsOf('setPolicies'), hasLength(1));
      expect(
        (h.native!.callsOf('setPolicies').single.arguments as Map)['denyPackages'],
        isNot(contains('com.eg.android.AlipayGphone')),
      );
      // Still listed, so it can be put back.
      expect(find.descendant(of: groupTitled('照常 · 你改过的'), matching: find.text('支付宝')), findsOneWidget);

      await pick('支付宝', '不碰');
      expect(find.byType(RiskNoticeSheet), findsNothing);
      expect(h.native!.callsOf('setPolicies'), hasLength(2));

      await pick('微信', '照常');
      expect(find.text('「微信」不再逐步确认？'), findsOneWidget);
      expect(find.textContaining('强制下线'), findsOneWidget);
    });

    testWidgets('adds an app by package name', (tester) async {
      final h = await pumpPhone(tester, const PhoneAppRulesPage());
      await tester.tap(find.text('添加 App'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'not a package');
      await tester.pump();
      expect(button(tester, '添加').onPressed, isNull);
      await tester.enterText(find.byType(TextField), 'com.taobao.taobao');
      await tester.pump();
      await tester.tap(find.text('添加'));
      await tester.pumpAndSettle();
      expect((h.native!.callsOf('setPolicies').single.arguments as Map)['denyPackages'], contains('com.taobao.taobao'));
      expect(find.descendant(of: groupTitled('不碰'), matching: find.text('淘宝')), findsOneWidget);
    });

    testWidgets('unreadable list says so', (tester) async {
      await pumpPhone(tester, const PhoneAppRulesPage(), missingNative: true);
      expect(find.text('读不到应用名单'), findsOneWidget);
      expect(find.byType(ListPageRow), findsNothing);
    });
  });

  testWidgets('CheckRow says the state in words', (tester) async {
    await pumpPhone(
      tester,
      const Scaffold(
        body: Column(
          children: [
            CheckRow(label: 'a', done: true),
            CheckRow(label: 'b', done: false),
            CheckRow(label: 'c', done: false, unknown: true),
          ],
        ),
      ),
    );
    expect(find.text('是'), findsOneWidget);
    expect(find.text('还没有'), findsOneWidget);
    expect(find.text('不确定'), findsOneWidget);
  });
}
