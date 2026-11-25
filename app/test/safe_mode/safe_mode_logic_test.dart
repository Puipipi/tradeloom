// Safe mode, Dart side: parsing the native status, the failure card's decision table,
// the repair prompt, and the platform-channel calls.

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/engine_control.dart';
import 'package:dsh_app/state/safe_mode_state.dart';
import 'package:dsh_app/ui/common/status_dot.dart';
import 'package:dsh_app/ui/engine/engine_status.dart';
import 'package:dsh_app/ui/safe_mode/engine_failure_card.dart';
import 'package:dsh_app/ui/safe_mode/safe_mode_actions.dart';
import 'package:dsh_app/ui/safe_mode/safe_mode_banner.dart';
import 'package:dsh_app/ui/safe_mode/safe_mode_card.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('RuntimeStatus.fromMap', () {
    test('reads the safe-mode fields the controller sends', () {
      final status = RuntimeStatus.fromMap({
        'phase': 'error',
        'mode': 'safe',
        'safeState': 'on',
        'safeReason': 'auto',
        'strikes': 2,
        'autoSafe': false,
        'healthyAt': 1761204720000,
        'failure': {
          'kind': 'crashedEarly',
          'exitCode': 1,
          'at': 1761204600000,
          'safeMode': true,
          'summary': 'fatal uncaught exception: Error: boom',
          'requiredRows': <Object?>[],
          'suspects': ['@acme/x'],
          'recent': ['@acme/x', 'y'],
          'diagnostics': null,
          'upSeconds': 7,
        },
        'mainFailure': {
          'kind': 'startupFailed',
          'at': 1,
          'requiredRows': ['agent-loop'],
        },
      });
      expect(status.mode, EngineMode.safe);
      expect(status.inSafeMode, isTrue);
      expect(status.safeState, SafeModeState.on);
      expect(status.strikes, 2);
      expect(status.autoSafe, isFalse);
      expect(status.healthyAt, DateTime.fromMillisecondsSinceEpoch(1761204720000));
      final f = status.failure!;
      expect(f.kind, FailureKind.crashedEarly);
      expect(f.safeMode, isTrue);
      expect(f.upSeconds, 7);
      expect(f.culprits, ['@acme/x', 'y']);
      expect(status.mainFailure!.requiredRows, ['agent-loop']);
    });

    test('older native builds without the fields read as normal mode', () {
      final status = RuntimeStatus.fromMap({'phase': 'running', 'baseUrl': 'http://127.0.0.1:3080', 'token': 't'});
      expect(status.mode, EngineMode.normal);
      expect(status.safeState, SafeModeState.off);
      expect(status.autoSafe, isTrue);
      expect(status.failure, isNull);
      expect(RuntimeFailure.fromMap({'kind': 'whatever'}), isNull);
    });

    test('LastKnownGood', () {
      final lkg = LastKnownGood.fromMap({
        'available': true,
        'at': 1761200000000,
        'disable': ['a', 'b'],
        'enable': ['c'],
        'changed': ['b'],
        'patchChanged': true,
        'empty': false,
      });
      expect(lkg.useful, isTrue);
      expect(lkg.at, DateTime.fromMillisecondsSinceEpoch(1761200000000));
      expect(LastKnownGood.fromMap({'available': true, 'empty': true}).useful, isFalse);
      expect(LastKnownGood.fromMap({'available': false, 'at': null}).at, isNull);
      final text = SafeModeActions.describeRestore(lkg);
      expect(text, contains('停用：a、b'));
      expect(text, contains('b 之后升级过'));
      expect(text, contains('重新启用：c'));
      expect(text, contains('设置恢复'));
      expect(text, contains('不需要联网'));
    });
  });

  group('failure card', () {
    test('LKG first when it would change something, safe mode next', () {
      final m = FailureCardModel.of(startupFailure(), lkgUseful: true);
      expect(m.title, 'DSH 启动失败');
      expect(m.primary, FailureAction.restoreLkg);
      expect(m.secondary, [FailureAction.enterSafe, FailureAction.showLog, FailureAction.retry]);
      expect(m.body, contains('break-required'));
    });

    test('without a useful LKG, safe mode is the primary action', () {
      final m = FailureCardModel.of(startupFailure(recent: const []), lkgUseful: false);
      expect(m.primary, FailureAction.enterSafe);
      expect(m.body, '必需组件 agent-loop 没通过启动检查');
    });

    test('killed by the system: restart, no safe mode', () {
      final m = FailureCardModel.of(RuntimeFailure(kind: FailureKind.killed, at: failedAt), lkgUseful: true);
      expect(m.primary, FailureAction.retry);
      expect(m.secondary, isNot(contains(FailureAction.enterSafe)));
      expect(m.tone, StatusTone.warn);
      expect(m.secondary, contains(FailureAction.background));
      expect(m.body, '多半是内存不足或系统省电');
    });

    test('safe mode itself failed: runtime problem, not plugins', () {
      final m = FailureCardModel.of(startupFailure(safeMode: true), lkgUseful: true);
      expect(m.title, '安全模式也没能启动');
      expect(m.primary, FailureAction.retry);
      expect(m.secondary, contains(FailureAction.startNormal));
    });

    test('visible only while the engine is idle', () {
      expect(EngineFailureCard.visibleFor(failedStatus()), isTrue);
      expect(EngineFailureCard.visibleFor(const RuntimeStatus(phase: RuntimePhase.error)), isFalse);
      expect(
        EngineFailureCard.visibleFor(RuntimeStatus(phase: RuntimePhase.starting, failure: startupFailure())),
        isFalse,
      );
    });
  });

  group('status labels and banner', () {
    LocalRuntimeState s(RuntimeStatus status) => LocalRuntimeState(loaded: true, status: status);

    test('engine chip', () {
      expect(EngineStatusView.of(s(safeStatus())).label, '安全模式');
      expect(EngineStatusView.of(s(safeStatus())).tone, StatusTone.warn);
      expect(EngineStatusView.of(s(safeStatus(phase: RuntimePhase.starting))).label, '正在以安全模式启动');
      expect(EngineStatusView.of(s(failedStatus())).label, '启动失败');
      expect(EngineStatusView.of(s(const RuntimeStatus(phase: RuntimePhase.error))).label, '出错了');
      expect(
        EngineStatusView.of(s(const RuntimeStatus(phase: RuntimePhase.running, safeState: SafeModeState.probation)))
            .label,
        '运行中 · 试用',
      );
    });

    test('banner shows in safe mode and during the trial only', () {
      expect(SafeModeBanner.visibleFor(safeStatus()), isTrue);
      expect(SafeModeBanner.visibleFor(safeStatus(phase: RuntimePhase.installed)), isTrue);
      expect(SafeModeBanner.visibleFor(const RuntimeStatus(phase: RuntimePhase.running)), isFalse);
      expect(
        SafeModeBanner.visibleFor(const RuntimeStatus(phase: RuntimePhase.running, safeState: SafeModeState.probation)),
        isTrue,
      );
      expect(
        SafeModeBanner.visibleFor(
          const RuntimeStatus(phase: RuntimePhase.installed, safeState: SafeModeState.probation),
        ),
        isFalse,
      );
    });

    test('why safe mode is on', () {
      expect(safeModeReasonText(safeStatus()), contains('连续两次启动失败'));
      expect(safeModeReasonText(safeStatus(reason: 'probation')), contains('又崩溃'));
      expect(safeModeReasonText(const RuntimeStatus(phase: RuntimePhase.running, mode: EngineMode.safe)), '手动开启');
    });
  });

  group('repair prompt', () {
    test('names the failure and points at the briefing; never sent by itself', () {
      final prompt = repairPrompt(safeStatus());
      expect(prompt, startsWith('我的 DSH 正常模式出了问题（启动失败，可疑插件：break-required）'));
      expect(prompt, contains('「安全模式」说明'));
      expect(prompt, contains('trial'));
      expect(repairPrompt(const RuntimeStatus(phase: RuntimePhase.running)), contains('我手动进入了安全模式'));
    });

    test('one-liners', () {
      expect(failureOneLiner(startupFailure(recent: const [])), '启动失败，启动检查没通过：agent-loop');
      expect(
        failureOneLiner(
          RuntimeFailure(kind: FailureKind.crashedLate, at: failedAt, summary: 'fatal uncaught exception: x'),
        ),
        '运行中崩溃：fatal uncaught exception: x',
      );
    });
  });

  test('auto start waits for the user only after two failures with auto safe mode off', () {
    expect(EngineControl.shouldAutoStart(failedStatus(strikes: 2, autoSafe: false)), isFalse);
    expect(EngineControl.shouldAutoStart(failedStatus(strikes: 2)), isTrue);
    expect(EngineControl.shouldAutoStart(failedStatus(strikes: 1, autoSafe: false)), isTrue);
    expect(EngineControl.shouldAutoStart(safeStatus()), isTrue);
  });

  test('formatWhen', () {
    final now = DateTime(2026, 10, 23, 18);
    expect(SafeModeActions.formatWhen(DateTime(2026, 10, 23, 9, 5), now: now), '今天 09:05');
    expect(SafeModeActions.formatWhen(DateTime(2026, 10, 22, 21, 30), now: now), '10月22日 21:30');
  });

  group('platform channel', () {
    const channel = MethodChannel('dsh/runtime');
    final calls = <MethodCall>[];

    setUp(() {
      calls.clear();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return switch (call.method) {
          'lastKnownGood' => {
            'available': true,
            'at': 1,
            'disable': ['x'],
            'empty': false,
          },
          'restoreLastKnownGood' => {
            'disable': ['x'],
            'enable': <Object?>[],
            'changed': <Object?>[],
            'patchChanged': false,
            'empty': false,
          },
          'safePreflight' => [
            {'path': '/root/.dsh/.env', 'kind': 'homeEnv', 'detail': '设置了 NODE_OPTIONS'},
          ],
          'moveAside' => [
            {'from': '/root/.dsh/.env', 'to': '/root/.dsh/.env.off-20261023-153000'},
          ],
          'failureLog' => ['a', 'b'],
          _ => null,
        };
      });
    });

    tearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null),
    );

    test('start passes the mode (null keeps the current one)', () async {
      final bridge = RuntimeBridge();
      await bridge.start(phoneStorage: true, mode: EngineMode.safe);
      await bridge.start();
      expect(calls[0].arguments, {
        'env': <String, String>{},
        'phoneStorage': true,
        'visualReplies': true,
        'mode': 'safe',
      });
      expect((calls[1].arguments as Map)['mode'], isNull);
    });

    test('safe-mode calls round-trip', () async {
      final bridge = RuntimeBridge();
      expect((await bridge.lastKnownGood()).disable, ['x']);
      expect((await bridge.restoreLastKnownGood()).useful, isTrue);
      final hazards = await bridge.safePreflight();
      expect(hazards.single.path, '/root/.dsh/.env');
      expect(await bridge.moveAside(['/root/.dsh/.env']), ['/root/.dsh/.env.off-20261023-153000']);
      expect(calls.last.arguments, {
        'paths': ['/root/.dsh/.env'],
      });
      expect(await bridge.failureLog(), ['a', 'b']);
      await bridge.setAutoSafe(false);
      expect(calls.last.arguments, {'enabled': false});
    });
  });
}
