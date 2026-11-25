// The app root keeps the skill auto-install alive: once the on-device engine
// runs, both bundled skills (dsh-go-ui, dsh-go-plugin) land in its skills
// folder, without any page having to ask for them.

import 'dart:io';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/shell/root_gate.dart';
import 'package:dsh_app/ui_config/ui_config.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../safe_mode/support.dart';
import '../shell/golden_harness.dart';
import 'support.dart';
import 'skill_native_support.dart';

void main() {
  late UiSkillBundle ui;
  late UiSkillBundle plugin;
  late Directory root;

  setUpAll(() async {
    ui = await loadUiSkillBundle(readAssetFromDisk);
    plugin = await loadUiSkillBundle(readAssetFromDisk, pluginSkillName);
  });

  setUp(() => root = tempRootfs());
  tearDown(() {
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  File skillMd(String name) => File('${root.path}/root/.dsh/skills/$name/SKILL.md');

  LocalRuntimeState state(RuntimePhase phase) => LocalRuntimeState(
    loaded: true,
    status: RuntimeStatus(
      phase: phase,
      bundledVersion: 'r7',
      installedVersion: 'r7',
      baseUrl: 'http://127.0.0.1:1',
      token: 'fixture-skill-run',
      managedSkillGeneration: 1,
    ),
  );

  Future<RecordingRuntime> pumpRoot(WidgetTester tester, RuntimePhase phase) async {
    final runtime = RecordingRuntime(state(phase));
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(
        home: const RootGate(home: Scaffold(body: Text('home'))),
        brightness: Brightness.light,
        overrides: [
          localRuntimeProvider.overrideWith(() => runtime),
          runtimeBridgeProvider.overrideWithValue(SkillFileBridge()),
          settingsProvider.overrideWith(
            () => FakeSettings(AppSettings(loaded: true, apiKey: 'key', autoStartLocal: false)),
          ),
          uiRootfsResolverProvider.overrideWithValue(() async => root),
          uiSkillBundleLoaderProvider.overrideWithValue(() async => ui),
          extraSkillLoadersProvider.overrideWithValue([() async => plugin]),
        ],
      ),
    );
    await tester.pump();
    return runtime;
  }

  /// Lets the install under way finish through the explicit file bridge fake.
  Future<void> settleInstall(WidgetTester tester) async {
    final container = ProviderScope.containerOf(tester.element(find.byType(RootGate)));
    await tester.runAsync(() async => container.read(uiSkillAutoInstallProvider.notifier).running);
    await tester.pump();
  }

  testWidgets('nothing is written until the engine runs; then both skills are in place', (tester) async {
    final runtime = await pumpRoot(tester, RuntimePhase.installed);
    await settleInstall(tester);
    expect(find.text('home'), findsOneWidget);
    expect(skillMd(uiSkillName).existsSync(), isFalse);
    expect(skillMd(pluginSkillName).existsSync(), isFalse);

    runtime.emit(state(RuntimePhase.starting));
    await tester.pump();
    runtime.emit(state(RuntimePhase.running));
    await tester.pump();
    await settleInstall(tester);
    expect(skillMd(uiSkillName).readAsStringSync(), ui.skillMd);
    expect(skillMd(pluginSkillName).readAsStringSync(), plugin.skillMd);
    expect(File('${root.path}/root/.dsh/skills/$pluginSkillName/kit/bin/check.mjs').existsSync(), isTrue);
  });

  testWidgets('an engine already running at launch gets them too, and a folder the person took over is left alone', (
    tester,
  ) async {
    await installUiSkill(root, plugin);
    final mine = skillMd(pluginSkillName)
        .readAsStringSync()
        .replaceFirst(RegExp(r'^# dsh-go:managed.*\n', multiLine: true), '');
    skillMd(pluginSkillName).writeAsStringSync('$mine\n我的补充\n');

    await pumpRoot(tester, RuntimePhase.running);
    await settleInstall(tester);
    expect(skillMd(uiSkillName).readAsStringSync(), ui.skillMd);
    expect(skillMd(pluginSkillName).readAsStringSync(), endsWith('我的补充\n'));
  });
}
