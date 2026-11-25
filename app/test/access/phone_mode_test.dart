// First run's 确认方式 for 手机操控: picked right after its disclosure,
// nothing chosen to begin with, 全程自动 saying what stays with the person;
// written through the same `setPolicies` as 设置 › 手机操控 › 确认方式, kept
// when the phone can't take it yet or the write fails, and written on the
// next read of the policies.

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/access_state.dart';
import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/access/phone_mode_sheet.dart';
import 'package:dsh_app/ui/onboarding/access_step.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../phone/support.dart';
import '../shell/golden_harness.dart';
import 'support.dart';

const _key = PhoneController.confirmPendingKey;

List<Object?> _modes(FakePhoneNative native) => [
  for (final c in native.callsOf('setPolicies')) (c.arguments as Map)['confirmMode'],
];

Future<String?> _pending() async => (await SharedPreferences.getInstance()).getString(_key);

Future<void> _frames(WidgetTester tester, [int n = 8]) async {
  for (var i = 0; i < n; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _tapText(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text).last);
  await tester.tap(find.text(text).last);
  await _frames(tester);
}

void main() {
  group('the pick', () {
    late FakePhoneNative native;

    Future<ProviderContainer> pump(WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      native = FakePhoneNative(status: phoneStatus(enabled: false))..install();
      usePhoneSurface(tester);
      await tester.pumpWidget(
        goldenApp(
          home: AccessStepPage(onDone: () {}),
          brightness: Brightness.light,
          overrides: [
            ...accessOverrides(FakeAccessDriver(offPhone)),
            localRuntimeProvider.overrideWith(
              () => FakeRuntime(const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.installing))),
            ),
            settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
          ],
        ),
      );
      await _frames(tester);
      return ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
    }

    void expectPicked(WidgetTester tester, bool on) =>
        expect(tester.getSemantics(find.text('手机操控')), isSemantics(isChecked: on, hasCheckedState: true));

    testWidgets('after the disclosure: two ways, neither chosen, the key waits for one', (tester) async {
      await pump(tester);
      await _tapText(tester, '手机操控');
      await _tapText(tester, '同意并开启');
      expect(find.byType(PhoneModeSheet), findsOneWidget);
      expect(find.text('选择确认方式'), findsOneWidget);
      expect(find.text('随时可在设置里更改'), findsOneWidget);
      expect(find.text('关键步骤先问我'), findsOneWidget);
      expect(find.text('进新 App、发送、删除、付款前先问'), findsOneWidget);
      expect(find.text('全程自动'), findsOneWidget);
      for (final mode in ['ask', 'always']) {
        expect(
          tester.getSemantics(find.byKey(ValueKey('phone-mode-$mode'))),
          isSemantics(isChecked: false, hasCheckedState: true, isInMutuallyExclusiveGroup: true),
        );
      }
      expect(tester.widget<FilledButton>(find.byKey(const ValueKey('phone-mode-confirm'))).onPressed, isNull);
      expect(find.text('这些仍由你来操作'), findsNothing);
    });

    testWidgets('全程自动 says what stays with you, and is confirmed by name', (tester) async {
      final c = await pump(tester);
      await _tapText(tester, '手机操控');
      await _tapText(tester, '同意并开启');
      await _tapText(tester, '全程自动');
      expect(find.text('这些仍由你来操作'), findsOneWidget);
      expect(
        find.text(
          '系统设置和权限页面、密码和验证码、DSH Go 自身仍由你来操作；银行、支付类 App 默认不碰，可在设置里调整。\n'
          '如需让 AI 操作系统设置、密码等，可在 设置 › 手机操控 › 解除限制 中开启。',
        ),
        findsOneWidget,
      );
      expect(find.text('开启全程自动'), findsOneWidget);
      // Nothing is written by choosing alone.
      expect(native.callsOf('setPolicies'), isEmpty);
      await _tapText(tester, '开启全程自动');
      expect(find.byType(PhoneModeSheet), findsNothing);
      expectPicked(tester, true);
      expect(native.callsOf('setPolicies'), isEmpty);

      await tester.tap(find.byKey(const ValueKey('access-primary')));
      await _frames(tester);
      expect(_modes(native), ['always']);
      expect(c.read(phoneProvider).policies?.confirmMode, PhoneConfirmMode.always);
      expect(await _pending(), isNull);
    });

    testWidgets('关键步骤先问我 is written the same way', (tester) async {
      await pump(tester);
      await _tapText(tester, '手机操控');
      await _tapText(tester, '同意并开启');
      await _tapText(tester, '关键步骤先问我');
      expect(find.text('这些仍由你来操作'), findsNothing);
      await _tapText(tester, '继续');
      await tester.tap(find.byKey(const ValueKey('access-primary')));
      await _frames(tester);
      expect(_modes(native), ['ask']);
    });

    testWidgets('closed without a choice: not picked; picked again, asked again', (tester) async {
      await pump(tester);
      await _tapText(tester, '手机操控');
      await _tapText(tester, '同意并开启');
      await tester.tapAt(const Offset(195, 60));
      await _frames(tester);
      expect(find.byType(PhoneModeSheet), findsNothing);
      expectPicked(tester, false);

      // The disclosure was accepted: only the choice comes back.
      await _tapText(tester, '手机操控');
      expect(find.text('开启手机操控前'), findsNothing);
      expect(find.byType(PhoneModeSheet), findsOneWidget);
    });

    testWidgets('unpicked after choosing: nothing is written', (tester) async {
      await pump(tester);
      await _tapText(tester, '手机操控');
      await _tapText(tester, '同意并开启');
      await _tapText(tester, '全程自动');
      await _tapText(tester, '开启全程自动');
      await _tapText(tester, '手机操控');
      await _tapText(tester, '语音输入');
      await tester.tap(find.byKey(const ValueKey('access-primary')));
      await _frames(tester);
      expect(native.callsOf('setPolicies'), isEmpty);
      expect(await _pending(), isNull);
    });
  });

  group('written now, or kept until it can be', () {
    TestWidgetsFlutterBinding.ensureInitialized();

    ProviderContainer container() {
      final c = ProviderContainer(
        overrides: [
          localRuntimeProvider.overrideWith(
            () => FakeRuntime(const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.installing))),
          ),
          settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
          accessDriverProvider.overrideWithValue(FakeAccessDriver(offPhone)),
        ],
      );
      addTearDown(c.dispose);
      return c;
    }

    Future<void> settle() async {
      for (var i = 0; i < 20; i++) {
        await Future<void>.delayed(Duration.zero);
      }
    }

    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('the phone answers: written at once, the lists untouched', () async {
      final native = FakePhoneNative()..install();
      final c = container();
      await c.read(accessSetupProvider.notifier).choose({AccessFeature.phone}, phoneMode: PhoneConfirmMode.always);
      await settle();
      expect(_modes(native), ['always']);
      expect((native.callsOf('setPolicies').single.arguments as Map)['denyPackages'], isNotEmpty);
      expect(await _pending(), isNull);
    });

    test('not ready yet: kept, then written on the first read of the policies', () async {
      removePhoneNative();
      final c = container();
      await c.read(accessSetupProvider.notifier).choose({AccessFeature.phone}, phoneMode: PhoneConfirmMode.always);
      expect(await _pending(), 'always');

      final native = FakePhoneNative()..install();
      await c.read(phoneProvider.notifier).refresh();
      await settle();
      expect(_modes(native), ['always']);
      expect(c.read(phoneProvider).policies?.confirmMode, PhoneConfirmMode.always);
      expect(await _pending(), isNull);
      // Written once: the next read leaves it be.
      await c.read(phoneProvider.notifier).refresh();
      await settle();
      expect(_modes(native), ['always']);
    });

    test('a failed write is kept and tried again (the summary\'s 继续, the next start)', () async {
      final native = FakePhoneNative()
        ..accept = false
        ..install();
      final c = container();
      await c.read(accessSetupProvider.notifier).choose({AccessFeature.phone}, phoneMode: PhoneConfirmMode.always);
      await settle();
      expect(_modes(native), everyElement('always'));
      expect(_modes(native), isNotEmpty);
      expect(await _pending(), 'always');

      native.accept = true;
      await c.read(accessSetupProvider.notifier).apply(offPhone);
      await settle();
      expect(_modes(native).last, 'always');
      expect(await _pending(), isNull);
      expect(c.read(phoneProvider).policies?.confirmMode, PhoneConfirmMode.always);
    });

    test('the next start writes one still pending', () async {
      SharedPreferences.setMockInitialValues({_key: 'always'});
      final native = FakePhoneNative()..install();
      final c = container();
      c.read(phoneConfirmPendingProvider);
      await settle();
      expect(_modes(native), contains('always'));
      expect(await _pending(), isNull);
    });

    test('a choice made in settings since wins over one still pending', () async {
      final native = FakePhoneNative()
        ..accept = false
        ..install();
      final c = container();
      await c.read(phoneProvider.notifier).chooseConfirmMode(PhoneConfirmMode.always);
      await settle();
      expect(await _pending(), 'always');
      native.accept = true;
      expect(await c.read(phoneProvider.notifier).setConfirmMode(PhoneConfirmMode.ask), isTrue);
      expect(await _pending(), isNull);
      await c.read(phoneProvider.notifier).refresh();
      await settle();
      expect(_modes(native).last, 'ask');
    });

    test('without 手机操控 among the picks, no mode is written', () async {
      final native = FakePhoneNative()..install();
      final c = container();
      await c.read(accessSetupProvider.notifier).choose({AccessFeature.voice}, phoneMode: PhoneConfirmMode.always);
      expect(native.callsOf('setPolicies'), isEmpty);
      expect(await _pending(), isNull);
    });
  });
}
