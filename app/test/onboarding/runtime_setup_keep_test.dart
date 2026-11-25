import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/ui/onboarding/runtime_setup_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../shell/golden_harness.dart';

class _Runtime extends FakeRuntime {
  _Runtime(super.initial);

  final calls = <String>[];

  @override
  Future<void> install() async => calls.add('install');

  @override
  Future<void> installDroppingKept() async => calls.add('drop');
}

const _keepError = 'install failed: keep: could not move root/.agents/skills';

void main() {
  Future<_Runtime> pump(WidgetTester tester, String error) async {
    final runtime = _Runtime(
      LocalRuntimeState(
        loaded: true,
        status: RuntimeStatus(phase: RuntimePhase.error, error: error),
      ),
    );
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(
        home: RuntimeSetupPage(onDone: () {}),
        brightness: Brightness.light,
        overrides: [localRuntimeProvider.overrideWith(() => runtime)],
      ),
    );
    await tester.pumpAndSettle();
    return runtime;
  }

  testWidgets('a kept-files failure offers to install without them', (tester) async {
    final runtime = await pump(tester, _keepError);
    expect(find.text('没能放回保留的内容'), findsOneWidget);
    final drop = find.widgetWithText(TextButton, '不保留，继续安装');
    expect(drop, findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, '重试'));
    await tester.pump();
    expect(runtime.calls, ['install']);
    await tester.tap(drop);
    await tester.pump();
    expect(runtime.calls, ['install', 'drop']);
  });

  testWidgets('the way out is quiet and centred under the buttons', (tester) async {
    await pump(tester, _keepError);
    final retry = tester.getRect(find.widgetWithText(FilledButton, '重试'));
    final logs = tester.getRect(find.widgetWithText(OutlinedButton, '查看日志'));
    final drop = tester.getRect(find.widgetWithText(TextButton, '不保留，继续安装'));
    expect(drop.top, greaterThan(retry.bottom));
    expect(drop.center.dx, moreOrLessEquals((logs.left + retry.right) / 2, epsilon: 0.01));
    final style = tester.widget<TextButton>(find.widgetWithText(TextButton, '不保留，继续安装')).style!;
    final scheme = Theme.of(tester.element(find.byType(RuntimeSetupPage))).colorScheme;
    expect(style.foregroundColor!.resolve({}), scheme.onSurfaceVariant);
  });

  testWidgets('other install failures keep just 查看日志 and 重试', (tester) async {
    await pump(tester, 'install failed: something else');
    expect(find.text('不保留，继续安装'), findsNothing);
    expect(find.text('没能放回保留的内容'), findsNothing);
    expect(find.widgetWithText(FilledButton, '重试'), findsOneWidget);
  });

  test('keepFailed reads the native error', () {
    expect(const RuntimeStatus(phase: RuntimePhase.error, error: _keepError).keepFailed, isTrue);
    expect(const RuntimeStatus(phase: RuntimePhase.error, error: 'install failed: x').keepFailed, isFalse);
    expect(const RuntimeStatus(phase: RuntimePhase.notInstalled, error: _keepError).keepFailed, isFalse);
  });

  test('install sends dropKept only when asked', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    const channel = MethodChannel('test/runtime-install');
    final calls = <MethodCall>[];
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final bridge = RuntimeBridge(methods: channel);
    await bridge.install();
    await bridge.install(dropKept: true);
    expect(calls.map((c) => c.method), everyElement('install'));
    expect(calls.map((c) => c.arguments), [
      null,
      {'dropKept': true},
    ]);
  });
}
