import 'dart:io';

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/providers_state.dart';
import 'package:dsh_app/ui/features/preset_editor/preset_editor_page.dart';
import 'package:dsh_app/ui/providers/provider_form_page.dart';
import 'package:dsh_app/ui/providers/provider_widgets.dart';
import 'package:dsh_app/ui/remote/ssh_host_form.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../plugins/support/fake_plugin_host.dart';
import '../shell/golden_harness.dart';
import 'support.dart';

Finder block(String label) => find.byWidgetPredicate((widget) => widget is FormFieldBlock && widget.label == label);
Finder field(String label) => find.descendant(of: block(label), matching: find.byType(TextField));

double left(WidgetTester tester, String text) => tester.getTopLeft(find.text(text)).dx;

void aligned(WidgetTester tester, String label, String message, {double? prior}) {
  expect(left(tester, message), moreOrLessEquals(left(tester, label), epsilon: 0.5));
  if (prior != null) expect(left(tester, message), moreOrLessEquals(prior, epsilon: 0.5));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<void> pump(WidgetTester tester, Widget page, List<Override> overrides, {double scale = 2}) async {
    await tester.runAsync(loadGoldenFonts);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(600, 2400);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        overrides: overrides,
        home: Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
            child: page,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    for (final element in find.byType(FormFieldBlock).evaluate()) {
      final widget = element.widget as FormFieldBlock;
      final label = find.descendant(of: find.byWidget(widget), matching: find.text(widget.label));
      final input = find.descendant(of: find.byWidget(widget), matching: find.byType(TextField));
      if (input.evaluate().isNotEmpty) {
        expect(tester.getRect(label).bottom, lessThanOrEqualTo(tester.getRect(input.first).top));
      }
    }
    expect(tester.takeException(), isNull);
  }

  testWidgets('渠道 Key 提示和错误共用标签左缘', (tester) async {
    await pump(
      tester,
      ProviderFormPage(existing: CustomProvider.fromProfile(gateway)),
      providerOverrides(sampleBackend()),
    );
    aligned(tester, 'API Key', '已保存，留空则不修改');
    final before = left(tester, '已保存，留空则不修改');
    await tester.enterText(field('API Key'), 'OPENAI_API_KEY=sk-123');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    aligned(tester, 'API Key', '只粘贴 Key 本身，不带变量名', prior: before);
    expect(tester.widget<TextField>(field('API Key')).decoration!.errorText, isNull);
    expect(tester.widget<TextField>(field('API Key')).decoration!.error, isA<SizedBox>());
    expect(tester.takeException(), isNull);
  });

  testWidgets('预设标识提示和错误共用标签左缘', (tester) async {
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
    final client = DshClient.withCarrier(carrier);
    addTearDown(client.close);
    await pump(tester, const PresetEditorPage(), [
      activeConnectionProvider.overrideWithValue(AsyncData(fakeHost(client))),
    ]);
    aligned(tester, '标识', '小写字母、数字和连字符');
    final before = left(tester, '小写字母、数字和连字符');
    await tester.tap(find.text('开始创建'));
    await tester.pumpAndSettle();
    final error = tester.widget<FormFieldBlock>(block('标识')).error;
    expect(error, isNotNull);
    aligned(tester, '标识', error!, prior: before);
    expect(tester.takeException(), isNull);
  });

  testWidgets('SSH 共用字段组件：提示和错误对齐标签', (tester) async {
    await pump(tester, const SshHostFormPage(), [secretStoreProvider.overrideWithValue(MemorySecretStore())]);
    aligned(tester, '启动命令', '用 nvm 安装的可以填完整路径');
    final before = left(tester, '用 nvm 安装的可以填完整路径');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    aligned(tester, '主机', '填写主机地址（IP 或域名）', prior: before);
    expect(tester.takeException(), isNull);
  });

  for (final brightness in Brightness.values) {
    testWidgets('字号 2.0 标签完整，提示切换错误不移动（${brightness.name}）', (tester) async {
      final error = ValueNotifier<String?>(null);
      addTearDown(error.dispose);
      await tester.runAsync(loadGoldenFonts);
      await tester.pumpWidget(
        goldenApp(
          brightness: brightness,
          home: Builder(
            builder: (context) => MediaQuery(
              data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(2)),
              child: Scaffold(
                body: ValueListenableBuilder<String?>(
                  valueListenable: error,
                  builder: (context, value, _) => FormFieldGroup(
                    children: [
                      FormFieldBlock(
                        label: '很长的字段名称和补充说明，需要完整显示',
                        helper: '字段提示',
                        error: value,
                        child: const TextField(),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      const label = '很长的字段名称和补充说明，需要完整显示';
      final labelRect = tester.getRect(find.text(label));
      final inputRect = tester.getRect(find.byType(TextField));
      expect(labelRect.height, greaterThan(28));
      expect(labelRect.bottom, lessThanOrEqualTo(inputRect.top));
      aligned(tester, label, '字段提示');
      final before = left(tester, '字段提示');
      error.value = '字段错误';
      await tester.pumpAndSettle();
      aligned(tester, label, '字段错误', prior: before);
      expect(find.text('字段提示'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
}
