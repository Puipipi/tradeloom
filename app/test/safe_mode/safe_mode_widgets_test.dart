// Safe mode UI: the failure card's buttons, the banner, the repair draft, notices,
// and goldens of the engine page in both states.

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/safe_mode_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/engine/engine_screen.dart';
import 'package:dsh_app/ui/engine/log_view.dart';
import 'package:dsh_app/ui/safe_mode/engine_failure_card.dart';
import 'package:dsh_app/ui/safe_mode/recovery_actions.dart';
import 'package:dsh_app/ui/safe_mode/safe_mode_actions.dart';
import 'package:dsh_app/ui/safe_mode/safe_mode_banner.dart';
import 'package:dsh_app/ui/safe_mode/safe_mode_card.dart';
import 'package:dsh_app/ui/safe_mode/safe_mode_notice_listener.dart';
import 'package:dsh_app/ui/safe_mode/safe_mode_settings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../shell/golden_harness.dart';
import 'support.dart';

void main() {
  // The sample failure happened "today".
  setUpAll(() => safeModeClock = () => DateTime(2026, 10, 23, 16));
  tearDownAll(() => safeModeClock = DateTime.now);

  late FakeBridge bridge;
  late RecordingRuntime runtime;

  List<Override> overrides(RuntimeStatus status) {
    runtime = RecordingRuntime(LocalRuntimeState(loaded: true, status: status));
    return [
      runtimeBridgeProvider.overrideWithValue(bridge),
      localRuntimeProvider.overrideWith(() => runtime),
      localRuntimeLogsProvider.overrideWithBuild((ref, notifier) => sampleLogs),
      settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
    ];
  }

  Future<ProviderContainer> pump(WidgetTester tester, Widget home, RuntimeStatus status) async {
    usePhoneSurface(tester);
    await tester.pumpWidget(goldenApp(home: home, brightness: Brightness.light, overrides: overrides(status)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    return ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
  }

  Widget page(Widget child) => Scaffold(
    body: SafeArea(
      child: Padding(padding: const EdgeInsets.all(16), child: child),
    ),
  );

  setUp(() => bridge = FakeBridge(lkg: lkgUseful));

  testWidgets('failure card: restoring the last good config confirms, restores, starts normally', (tester) async {
    await pump(tester, page(const EngineFailureCard()), failedStatus());
    expect(find.text('DSH 启动失败'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '恢复配置'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, '进入安全模式'), findsOneWidget);
    expect(find.text('查看日志'), findsOneWidget);
    expect(find.text('恢复会停用：break-required'), findsNothing);
    expect(find.text(startupFailure().summary!), findsNothing);

    await tester.tap(find.text('恢复配置'));
    await tester.pumpAndSettle();
    expect(find.text('恢复上次正常的配置？'), findsOneWidget);
    expect(find.textContaining('• 停用：break-required'), findsOneWidget);
    await tester.tap(find.text('恢复并启动'));
    await tester.pumpAndSettle();
    expect(bridge.calls, contains('restoreLastKnownGood'));
    expect(runtime.starts, ['normal']);
  });

  testWidgets('failure card: entering safe mode offers to move home-level files aside', (tester) async {
    bridge = FakeBridge(
      hazards: const [SafeHazard(path: '/root/.dsh/.env', kind: 'homeEnv', detail: '设置了 NODE_OPTIONS，DSH 会拒绝启动。')],
    );
    await pump(tester, page(const EngineFailureCard()), failedStatus());
    // No useful LKG: safe mode is the primary action.
    expect(find.widgetWithText(FilledButton, '进入安全模式'), findsOneWidget);
    expect(find.text('恢复配置'), findsNothing);

    await tester.tap(find.text('进入安全模式'));
    await tester.pumpAndSettle();
    expect(find.text('先移开这些文件？'), findsOneWidget);
    expect(find.text('/root/.dsh/.env'), findsOneWidget);
    await tester.tap(find.text('移开并启动'));
    await tester.pumpAndSettle();
    expect(bridge.moved, [
      ['/root/.dsh/.env'],
    ]);
    expect(runtime.starts, ['safe']);
  });

  testWidgets('safe-mode card: one primary; moving the patch aside is a secondary below it', (tester) async {
    bridge = FakeBridge(
      lkg: lkgUseful,
      hazards: const [
        SafeHazard(path: '/root/.dsh/cordis.patch.yml', kind: 'homePatch', detail: '全局补丁文件：对所有配置（包括安全模式）都生效。'),
      ],
    );
    await pump(tester, page(const SafeModeCard()), safeStatus());
    await tester.pump();
    expect(find.byType(FilledButton), findsOneWidget);
    final primary = tester.getRect(find.widgetWithText(FilledButton, '帮我修复'));
    final move = tester.getRect(find.widgetWithText(OutlinedButton, '移开补丁'));
    expect(move.top, greaterThan(primary.bottom));
    // Every button sits in RecoveryActions, so the gaps are its gaps.
    expect(find.descendant(of: find.byType(RecoveryActions), matching: find.byType(OutlinedButton)), findsNWidgets(3));
    expect(find.byType(OutlinedButton), findsNWidgets(3));

    await tester.tap(find.text('移开补丁'));
    await tester.pumpAndSettle();
    expect(bridge.moved, [
      ['/root/.dsh/cordis.patch.yml'],
    ]);
    expect(runtime.starts, ['safe']);
  });

  test('the move-aside button names what it moves', () {
    const patch = SafeHazard(path: 'p', kind: 'homePatch', detail: '');
    const env = SafeHazard(path: 'e', kind: 'homeEnv', detail: '');
    expect(SafeModeActions.moveAsideLabel(const [patch]), '移开补丁');
    expect(SafeModeActions.moveAsideLabel(const [env]), '移开文件');
    expect(SafeModeActions.moveAsideLabel(const [patch, env]), '移开文件');
  });

  testWidgets('failure card: the log sheet shows the failure output', (tester) async {
    await pump(tester, page(const EngineFailureCard()), failedStatus());
    await tester.tap(find.text('查看日志'));
    await tester.pumpAndSettle();
    expect(find.text('失败前后的日志'), findsOneWidget);
    final log = tester.widget<LogView>(find.byType(LogView));
    expect(log.lines, bridge.log);
    expect(find.text(startupFailure().summary!), findsOneWidget);
  });

  testWidgets('failure card stays hidden while the engine runs', (tester) async {
    await pump(tester, page(const EngineFailureCard()), const RuntimeStatus(phase: RuntimePhase.running));
    expect(find.text('DSH 启动失败'), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('banner: repair draft is queued, not sent; leaving safe mode restarts normally', (tester) async {
    final container = await pump(tester, page(const SafeModeBanner()), safeStatus());
    expect(find.text('安全模式 · 插件没有加载'), findsOneWidget);

    await tester.tap(find.text('帮我修复'));
    await tester.pump();
    final draft = container.read(repairDraftProvider);
    expect(draft, startsWith('我的 DSH 正常模式出了问题（启动失败，可疑插件：break-required）'));
    expect(container.read(repairDraftProvider.notifier).take(), draft);
    expect(container.read(repairDraftProvider), isNull);

    await tester.tap(find.text('正常启动'));
    await tester.pumpAndSettle();
    expect(find.text('恢复正常模式？'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '恢复正常模式'));
    await tester.pumpAndSettle();
    expect(runtime.stops, 1);
    expect(runtime.starts, ['normal']);
  });

  testWidgets('banner: a custom repair callback replaces the default', (tester) async {
    var called = 0;
    await pump(tester, page(SafeModeBanner(onRepair: () => called++)), safeStatus());
    await tester.tap(find.text('帮我修复'));
    expect(called, 1);
  });

  testWidgets('banner during the two-minute trial', (tester) async {
    await pump(
      tester,
      page(const SafeModeBanner()),
      const RuntimeStatus(phase: RuntimePhase.running, safeState: SafeModeState.probation),
    );
    expect(find.text('正在试用正常模式'), findsOneWidget);
    expect(find.text('正常启动'), findsNothing);
  });

  testWidgets('notices show once as snack bars', (tester) async {
    await pump(tester, page(const SafeModeNoticeListener(child: SizedBox.expand())), safeStatus());
    runtime.emit(runtime.state.copyWith(notice: const RuntimeNotice(1, 'DSH 连续两次启动失败，已用安全模式启动。你的对话都在。')));
    await tester.pump();
    expect(find.text('DSH 连续两次启动失败，已用安全模式启动。你的对话都在。'), findsOneWidget);
  });

  testWidgets('settings tiles switch automatic safe mode natively', (tester) async {
    await pump(tester, page(const SafeModeSettingsTiles()), failedStatus());
    expect(find.text('以安全模式启动'), findsOneWidget);
    await tester.tap(find.byType(Switch));
    await tester.pump();
    expect(bridge.calls, contains('setAutoSafe:false'));
  });

  group('goldens', () {
    goldenBoth(
      'engine_failed',
      () => const EngineScreen(),
      overrides: () {
        bridge = FakeBridge(lkg: lkgUseful);
        return overrides(failedStatus());
      },
    );
    goldenBoth(
      'engine_safe_mode',
      () => const EngineScreen(),
      overrides: () {
        bridge = FakeBridge(
          lkg: lkgUseful,
          hazards: const [
            SafeHazard(path: '/root/.dsh/cordis.patch.yml', kind: 'homePatch', detail: '全局补丁文件：对所有配置（包括安全模式）都生效。'),
          ],
        );
        return overrides(safeStatus());
      },
    );
    goldenBoth(
      'banner_safe_mode',
      () => page(const Column(children: [SafeModeBanner()])),
      overrides: () {
        bridge = FakeBridge();
        return overrides(safeStatus());
      },
    );
  });
}
