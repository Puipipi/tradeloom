import 'dart:io';

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/schedule_editor_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/common/status_dot.dart';
import 'package:dsh_app/ui/shell/home_shell.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_app/ui/bots/new_bot_page.dart';
import 'package:dsh_app/ui/common/discard_guard.dart';
import 'package:dsh_app/ui/features/preset_editor/preset_editor_page.dart';
import 'package:dsh_app/ui/features/schedule_editor/schedule_editor_page.dart';
import 'package:dsh_app/ui/providers/provider_form_page.dart';
import 'package:dsh_app/ui/remote/ssh_host_form.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../bots/support.dart' as bots;
import '../chat/support/harness.dart';
import '../plugins/support/fake_plugin_host.dart';
import '../providers/support.dart' as providers;
import '../remote/support/fake_ssh.dart';
import '../shell/golden_harness.dart' as shell;

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<NavigatorState> open(WidgetTester tester, Widget page, List<Override> overrides) async {
    usePhoneView(tester);
    await tester.pumpWidget(testApp(const Scaffold(body: Text('首页')), overrides: overrides));
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    navigator.push(MaterialPageRoute<void>(builder: (_) => page));
    await pumpFrames(tester, 12);
    return navigator;
  }

  Future<void> leave(WidgetTester tester, NavigatorState navigator) async {
    expect(find.byType(DiscardGuard), findsOneWidget);
    expect(await navigator.maybePop(), isTrue);
    await tester.pumpAndSettle();
    expect(find.text('放弃修改？'), findsNothing);
    expect(find.text('首页'), findsOneWidget);
    expect(find.byType(DiscardGuard), findsNothing);
  }

  testWidgets('渠道表单刚打开直接返回', (tester) async {
    await leave(
      tester,
      await open(tester, const ProviderFormPage(), providers.providerOverrides(providers.FakeProviderBackend())),
    );
  });

  testWidgets('预设异步加载完成后直接返回', (tester) async {
    final carrier = FakePluginCarrier();
    carrier.handlers['agentPresets/list'] = (_) => {
      'presets': [
        {'id': 'standard', 'order': 1, 'isDefault': true},
        {'id': 'cordis', 'order': 2, 'isDefault': false},
      ],
    };
    carrier.handlers['agentPresets/read'] = (_) => {
      'agentPreset': 'standard',
      'content': File('test/features/fixtures/preset_standard.yaml').readAsStringSync(),
    };
    carrier.handlers['pluginManager/listBundles'] = (_) => <Object?>[];
    final client = DshClient.withCarrier(carrier);
    addTearDown(client.close);
    final navigator = await open(tester, const PresetEditorPage(), [
      activeConnectionProvider.overrideWithValue(AsyncData(fakeHost(client))),
      localRuntimeProvider.overrideWith(StaticRuntime.new),
    ]);
    expect(carrier.argsOf('agentPresets/read'), isNotEmpty);
    expect(find.widgetWithText(TextField, 'You are a coding agent powered by the {{model}} model.'), findsOneWidget);
    await leave(tester, navigator);
  });

  testWidgets('计划初始化时间后直接返回', (tester) async {
    await leave(
      tester,
      await open(tester, const ScheduleEditorPage(), [
        activeConnectionProvider.overrideWithValue(const AsyncData(null)),
        sessionsProvider.overrideWith(FakeSessions.new),
        deviceTimeZoneProvider.overrideWith((ref) async => 'Asia/Shanghai'),
        hostWorkspacesProvider.overrideWith((ref) async => const []),
      ]),
    );
  });

  testWidgets('SSH 编辑读取已保存秘密后直接返回', (tester) async {
    final navigator = await open(tester, const SshHostFormPage(existing: sampleSsh), [
      secretStoreProvider.overrideWithValue(
        MemorySecretStore({SshSecrets.passwordKey(sampleSsh.id): 'saved-password'}),
      ),
    ]);
    expect(
      find.byWidgetPredicate((widget) => widget is TextField && widget.controller?.text == 'saved-password'),
      findsOneWidget,
    );
    await leave(tester, navigator);
  });

  testWidgets('新建 Bot 刚打开直接返回', (tester) async {
    await leave(tester, await open(tester, const NewBotPage(), bots.dsBotOverrides(bots.FakeDsBotTransport())));
  });

  testWidgets('关闭抽屉暂停运行圆点，打开后继续呼吸', (tester) async {
    usePhoneView(tester);
    await tester.pumpWidget(
      shell.goldenApp(
        brightness: Brightness.light,
        home: Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: false),
            child: HomeShell(
              chatBuilder: (open) => Center(
                child: TextButton(onPressed: open, child: const Text('打开抽屉')),
              ),
            ),
          ),
        ),
        overrides: [
          sessionsProvider.overrideWith(() => shell.FakeSessions(shell.sampleSessions())),
          settingsProvider.overrideWith(() => shell.FakeSettings(const AppSettings(loaded: true))),
          localRuntimeProvider.overrideWith(
            () => shell.FakeRuntime(const LocalRuntimeState(loaded: true, status: shell.runningStatus)),
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.binding.hasScheduledFrame, isFalse);
    expect(find.byType(StatusDot), findsNothing);
    await tester.tap(find.text('打开抽屉'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 450));
    final busy = find.byWidgetPredicate((widget) => widget is StatusDot && widget.tone == StatusTone.busy);
    expect(busy, findsWidgets);
    final fade = find.descendant(of: busy.first, matching: find.byType(FadeTransition));
    final before = tester.widget<FadeTransition>(fade).opacity.value;
    await tester.pump(const Duration(milliseconds: 200));
    expect(tester.widget<FadeTransition>(fade).opacity.value, isNot(before));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('真实 HomeShell 只有一层背景', (tester) async {
    usePhoneView(tester);
    await tester.pumpWidget(
      shell.goldenApp(
        brightness: Brightness.light,
        home: const HomeShell(),
        overrides: [
          activeConnectionProvider.overrideWithValue(const AsyncData(null)),
          sessionsProvider.overrideWith(() => shell.FakeSessions(const [])),
          settingsProvider.overrideWith(() => shell.FakeSettings(const AppSettings(loaded: true))),
          localRuntimeProvider.overrideWith(StaticRuntime.new),
        ],
      ),
    );
    await pumpFrames(tester);
    expect(find.byType(AppBackdrop), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('修改后返回：继续编辑保留文字，放弃才离开', (tester) async {
    final text = TextEditingController();
    addTearDown(text.dispose);
    final navigator = await open(
      tester,
      DiscardGuard(
        listenable: text,
        isDirty: () => text.text.isNotEmpty,
        child: Scaffold(body: TextField(controller: text)),
      ),
      [],
    );
    await tester.enterText(find.byType(TextField), '未保存的修改');
    await tester.pump();
    await navigator.maybePop();
    await tester.pumpAndSettle();
    expect(find.text('放弃修改？'), findsOneWidget);
    await tester.tap(find.text('继续编辑'));
    await tester.pumpAndSettle();
    expect(text.text, '未保存的修改');
    expect(find.byType(TextField), findsOneWidget);
    await navigator.maybePop();
    await tester.pumpAndSettle();
    await tester.tap(find.text('放弃'));
    await tester.pumpAndSettle();
    expect(find.text('首页'), findsOneWidget);
    expect(find.byType(DiscardGuard), findsNothing);
  });
}
