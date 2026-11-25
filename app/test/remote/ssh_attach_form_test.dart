import 'dart:convert';

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/remote/ssh_host_form.dart';
import 'package:dsh_app/ui/remote/link_progress.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';
import 'support/fake_ssh.dart';

void main() {
  Future<ProviderContainer> pump(WidgetTester tester, SshHostConfig config, FakeSshServer server) async {
    usePhoneSurface(tester);
    SharedPreferences.setMockInitialValues({HostsController.prefsKey: jsonEncode([config.toJson()])});
    final secrets = MemorySecretStore({SshSecrets.passwordKey(config.id): 'synthetic-password'});
    await tester.pumpWidget(goldenApp(
      brightness: Brightness.light,
      overrides: [
        secretStoreProvider.overrideWithValue(secrets),
        sshTransportFactoryProvider.overrideWithValue(server.connect),
      ],
      home: Builder(builder: (context) => Scaffold(body: TextButton(
        onPressed: () => Navigator.of(context).push<void>(
          MaterialPageRoute(builder: (_) => SshHostFormPage(existing: config)),
        ),
        child: const Text('Open host'),
      ))),
    ));
    await tester.tap(find.text('Open host'));
    await tester.pumpAndSettle();
    return ProviderScope.containerOf(tester.element(find.byType(SshHostFormPage)));
  }

  testWidgets('attach form validates token and saves port/compression without token in config', (tester) async {
    final server = FakeSshServer();
    final config = sampleSsh.copyWith(dshMode: SshDshMode.attachOnly, remotePort: 4080);
    final container = await pump(tester, config, server);
    expect(find.text('启动命令'), findsNothing);
    expect(find.text('重启托管 DSH'), findsNothing);
    await tester.tap(find.widgetWithText(FilledButton, '测试连接'));
    await tester.pumpAndSettle();
    expect(server.connects, isEmpty);
    expect(find.text('请填写有效的远端 DSH 端口和登录令牌'), findsOneWidget);
    final token = find.byWidgetPredicate(
      (widget) => widget is TextField && widget.obscureText && widget.keyboardType != TextInputType.visiblePassword,
    );
    await tester.ensureVisible(token);
    await tester.enterText(token, 'synthetic-token');
    await tester.ensureVisible(find.byType(Switch));
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
    final saved = container.read(hostsProvider).ssh.single;
    expect(saved.dshMode, SshDshMode.attachOnly);
    expect(saved.remotePort, 4080);
    expect(saved.compression, isFalse);
    expect((await container.read(hostsProvider.notifier).loadSecrets(config.id)).attachToken, 'synthetic-token');
    final raw = (await SharedPreferences.getInstance()).getString(HostsController.prefsKey)!;
    expect(raw, isNot(contains('synthetic-token')));
  });

  testWidgets('managed restart requires a separate confirmation and normal test never kills', (tester) async {
    final server = FakeSshServer();
    server.remote.dshInstalled = false;
    await pump(tester, sampleSsh, server);
    final restart = find.widgetWithText(TextButton, '重启托管 DSH');
    await tester.ensureVisible(restart);
    await tester.pumpAndSettle();
    await tester.tap(restart);
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(server.connects, isEmpty);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(server.connects, isEmpty);

    await tester.tap(find.widgetWithText(FilledButton, '测试连接'));
    await tester.pump();
    expect(server.connects, hasLength(1), reason: 'normal test reached the fake SSH transport');
    expect(server.last.scripts, hasLength(2), reason: 'normal test completed probe and start');
    expect(server.last.isClosed, isTrue, reason: 'nodsh terminated the SSH connection');
    final progress = tester.widget<LinkProgressCard>(find.byType(LinkProgressCard));
    expect(progress.status.phase, HostLinkPhase.failed, reason: 'last step: ${progress.status.step}');
    // Subscription cancellation resumes outside FakeAsync; yield a real event
    // turn, then verify the terminal UI rather than sleeping or skipping it.
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pumpAndSettle();
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(server.last.scripts.any((script) => script.contains(r'kill "$P"')), isFalse);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '测试连接')).onPressed, isNotNull);

    await tester.ensureVisible(restart);
    await tester.pumpAndSettle();
    await tester.tap(restart);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '重启托管 DSH'));
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pumpAndSettle();
    expect(server.last.scripts.single, contains(r'kill "$P"'));
  });
}
