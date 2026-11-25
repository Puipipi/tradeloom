import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/ui/phone/a11y_restore_sheet.dart';
import 'package:dsh_app/ui/phone/phone_control_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'harness.dart';
import 'support.dart';

const command = 'adb shell pm grant io.github.ccch1mneyyy.dsh_app android.permission.WRITE_SECURE_SETTINGS';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  FakePhoneNative native({String path = 'shizuku', bool granted = false, bool enabled = true}) => FakePhoneNative(
    status: {
      ...phoneStatus(enabled: enabled),
      'a11yKeeper': {'granted': granted, 'path': path, 'command': command},
    },
  );

  test('legacy native status defaults to unauthorized and preserves the grant on master switch updates', () {
    expect(PhoneStatus.fromMap(phoneStatus()).a11yKeeper.granted, isFalse);
    final status = PhoneStatus.fromMap(native(granted: true).status);
    expect(status.copyWith(enabled: false).a11yKeeper.granted, isTrue);
    expect(status.a11yKeeper.command, command);
    expect(PhoneResult.fromMap({'ok': false, 'pending': true}).pending, isTrue);
  });

  testWidgets('root restore rechecks availability after the risk confirmation', (tester) async {
    final n = FakePhoneNative(status: {...privilegedStatus(), 'statusRevision': 1});
    await pumpPhone(tester, const Scaffold(body: A11yRestoreSheet()), native: n);
    await tester.tap(find.byKey(const Key('a11y-restore-root')));
    await tester.pumpAndSettle();
    n.onStatus = () async => throw PlatformException(code: 'offline');
    expect(await containerOf(tester).read(phoneProvider.notifier).refreshStatus(), isFalse);
    await tester.tap(find.byKey(const ValueKey('risk-confirm')));
    await tester.pumpAndSettle();
    expect(n.callsOf('prepareRoot'), isEmpty);
    expect(n.callsOf('grantSecureSettings'), isEmpty);
  });

  testWidgets('an open restore sheet disables retained grant state when status becomes unavailable', (tester) async {
    final n = native();
    n.status = {...n.status, 'statusRevision': 1};
    await pumpPhone(tester, const Scaffold(body: A11yRestoreSheet()), native: n);
    final grant = find.byKey(const Key('a11y-restore-grant'));
    expect(grant, findsOneWidget);
    final queued = tester.widget<FilledButton>(grant).onPressed!;
    n.onStatus = () async => throw PlatformException(code: 'offline');
    expect(await containerOf(tester).read(phoneProvider.notifier).refreshStatus(), isFalse);
    await settlePhone(tester);
    expect(tester.widget<FilledButton>(grant).onPressed, isNull);
    n.calls.clear();
    queued();
    await settlePhone(tester);
    expect(n.calls, isEmpty);
    n.onStatus = null;
    n.push({...n.status, 'statusRevision': 2});
    await settlePhone(tester);
    expect(tester.widget<FilledButton>(grant).onPressed, isNotNull);
  });

  testWidgets('the row opens a disclosure; opening never grants, explicit tap does', (tester) async {
    final n = native();
    await pumpPhone(tester, const PhoneControlScreen(), native: n);
    await openPhoneFold(tester, 'phone-more-options');
    final row = find.byKey(const Key('phone-a11y-restore'));
    await tester.ensureVisible(row);
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.byType(A11yRestoreSheet), findsOneWidget);
    expect(find.textContaining('要关闭手机操控'), findsOneWidget);
    expect(n.callsOf('grantSecureSettings'), isEmpty);
    await tester.tap(find.byKey(const Key('a11y-restore-grant')));
    await tester.pumpAndSettle();
    expect(n.callsOf('grantSecureSettings'), hasLength(1));
    expect(find.byKey(const Key('a11y-restore-grant')), findsNothing);
  });

  testWidgets('copy uses the native command and does not request the grant', (tester) async {
    final n = native(path: 'setup');
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await pumpPhone(tester, const Scaffold(body: A11yRestoreSheet()), native: n);
    await tester.tap(find.byKey(const Key('a11y-restore-copy')));
    await tester.pumpAndSettle();
    expect(copied, command);
    expect(n.callsOf('grantSecureSettings'), isEmpty);
  });

  testWidgets('pending authorization is not shown as enabled, denial stays retryable', (tester) async {
    final n = native(path: 'shizukuPermission');
    n.results['grantSecureSettings'] = {'ok': false, 'pending': true};
    await pumpPhone(tester, const Scaffold(body: A11yRestoreSheet()), native: n);
    await tester.tap(find.byKey(const Key('a11y-restore-grant')));
    await tester.pumpAndSettle();
    expect(find.text('请在 Shizuku 中允许授权'), findsOneWidget);
    expect(find.byKey(const Key('a11y-restore-grant')), findsOneWidget);
    n.results['grantSecureSettings'] = {'ok': false, 'reason': 'denied'};
    await tester.tap(find.byKey(const Key('a11y-restore-grant')));
    await tester.pumpAndSettle();
    expect(find.text('denied'), findsOneWidget);
  });

  testWidgets('turning phone control off disables authorization even in an already open sheet', (tester) async {
    final n = native();
    await pumpPhone(tester, const Scaffold(body: A11yRestoreSheet()), native: n);
    n.push({...n.status, 'enabled': false});
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.byKey(const Key('a11y-restore-grant'))).onPressed, isNull);
    expect(n.callsOf('grantSecureSettings'), isEmpty);
  });

  FakePhoneNative modern({String grantPath = 'setup', bool? rootSelected, bool androidOk = true}) => FakePhoneNative(
    status: {
      ...privilegedStatus(grantPath: grantPath, rootSelected: rootSelected, androidOk: androidOk),
      'a11yKeeper': {'granted': false, 'path': 'setup', 'command': command},
    },
  );

  const sheet = Scaffold(body: A11yRestoreSheet());

  for (final (path, label) in [
    ('shizuku', '通过 Shizuku 授予'),
    ('shizukuPermission', '先授权 Shizuku，再授予权限'),
    ('sui', '通过 Sui 授予'),
    ('suiPermission', '先授权 Sui，再授予权限'),
    ('adb', '通过自连 ADB 授予'),
  ]) {
    testWidgets('the versioned path $path names its way', (tester) async {
      await pumpPhone(tester, sheet, native: modern(grantPath: path));
      expect(find.widgetWithText(FilledButton, label), findsOneWidget);
      expect(find.byKey(const Key('a11y-restore-root')), findsNothing);
    });
  }

  testWidgets('root grants over its connection, and only on the tap', (tester) async {
    final n = modern(grantPath: 'root', rootSelected: true);
    await pumpPhone(tester, sheet, native: n);
    expect(find.widgetWithText(FilledButton, '通过 root 授予'), findsOneWidget);
    expect(find.text('通过已授权的 root 连接，只授予这一项权限。'), findsOneWidget);
    expect(n.callsOf('grantSecureSettings'), isEmpty);
    await tester.tap(find.byKey(const Key('a11y-restore-grant')));
    await tester.pumpAndSettle();
    expect(n.callsOf('grantSecureSettings'), hasLength(1));
    expect(n.callsOf('prepareRoot'), isEmpty);
  });

  testWidgets('Sui asks in its own dialog, and the wait says Sui', (tester) async {
    final n = modern(grantPath: 'suiPermission');
    n.results['grantSecureSettings'] = {'ok': false, 'pending': true};
    await pumpPhone(tester, sheet, native: n);
    await tester.tap(find.byKey(const Key('a11y-restore-grant')));
    await tester.pumpAndSettle();
    expect(find.text('请在 Sui 中允许授权'), findsOneWidget);
  });

  testWidgets('with nothing set up root is offered, below Android 14 too, after its notice', (tester) async {
    final n = modern(androidOk: false);
    await pumpPhone(tester, sheet, native: n);
    expect(find.text('配置 Shizuku 或无线调试'), findsOneWidget);
    await tester.tap(find.byKey(const Key('a11y-restore-root')));
    await tester.pumpAndSettle();
    expect(n.callsOf('prepareRoot'), isEmpty);
    await tester.tap(find.byKey(const ValueKey('risk-confirm')));
    await tester.pumpAndSettle();
    expect(n.callsOf('prepareRoot'), hasLength(1));
    // Only the connection: 不打扰模式 stays off, nothing is granted yet.
    expect(n.callsOf('setBackgroundMode'), isEmpty);
    expect(n.callsOf('grantSecureSettings'), isEmpty);
  });

  testWidgets('a lost root connection is asked for again, never swapped for another way', (tester) async {
    final n = modern(rootSelected: true);
    await pumpPhone(tester, sheet, native: n);
    expect(find.text('配置 Shizuku 或无线调试'), findsNothing);
    expect(find.byKey(const Key('a11y-restore-root')), findsNothing);
    expect(find.widgetWithText(FilledButton, '申请 root 授权'), findsOneWidget);
    await tester.tap(find.byKey(const Key('a11y-restore-grant')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('risk-confirm')));
    await tester.pumpAndSettle();
    expect(n.callsOf('prepareRoot'), hasLength(1));
    expect(n.callsOf('grantSecureSettings'), isEmpty);
  });

  testWidgets('an old native module offers no root', (tester) async {
    await pumpPhone(tester, sheet, native: native(path: 'setup'));
    expect(find.text('配置 Shizuku 或无线调试'), findsOneWidget);
    expect(find.byKey(const Key('a11y-restore-root')), findsNothing);
  });
}
