import 'dart:io';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/share_code/guest_fs.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/features_state.dart';
import 'package:dsh_app/state/permission_default_repair.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../plugins/support/fake_plugin_host.dart';
import '../remote/support/wait.dart';

/// The main profile once an older app saved Auto as the default for new chats
/// (DSH's settings forms write it this way).
const _poisoned = '''
# Your patch layer for this dsh profile, applied after every bundle layer:
- id: model
  config:
    model: deepseek-chat
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: auto
''';

/// The on-device engine: it reads the profile when it starts, and an Auto
/// default fails its permission presets (DSH 0.2.1 `PermissionPresetService`).
class _Engine extends LocalRuntimeController {
  _Engine(this.patch);

  final File patch;
  final calls = <String>[];

  /// Whether each start's permission presets failed.
  final boots = <bool>[];
  bool get presetsFailed => boots.last;

  static final _running = LocalRuntimeState(
    loaded: true,
    status: RuntimeStatus.fromMap({'phase': 'running', 'baseUrl': 'http://127.0.0.1:9', 'token': 't'}),
  );

  void _boot() => boots.add(patch.readAsStringSync().contains('defaultPreset: auto'));

  @override
  LocalRuntimeState build() {
    _boot();
    return _running;
  }

  @override
  Future<void> stop() async {
    calls.add('stop');
    state = const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.installed));
  }

  @override
  Future<void> start() async {
    calls.add('start');
    _boot();
    state = _running;
  }
}

class _Settings extends SettingsController {
  @override
  AppSettings build() => const AppSettings(loaded: true);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  late File patch;
  late _Engine engine;
  late FakePluginCarrier carrier;
  late int connects;

  ProviderContainer connect(String profile) {
    final root = Directory.systemTemp.createTempSync('auto-default-');
    addTearDown(() => root.deleteSync(recursive: true));
    final fs = GuestFs(root);
    patch = fs.file(mainProfilePatch)
      ..createSync(recursive: true)
      ..writeAsStringSync(profile);
    engine = _Engine(patch);
    carrier = FakePluginCarrier();
    connects = 0;
    // A failed plugin is missing from the settings forms, and its service is down.
    carrier.handlers['settings/describe'] = (_) => {
      'writable': true,
      'namespaces': [
        if (!engine.presetsFailed) {'ns': 'permission', 'value': <String, Object?>{}, 'revision': 0},
      ],
    };
    carrier.handlers['permissionPresets/catalog'] = (_) {
      if (engine.presetsFailed) {
        throw const DshRemoteException(
          'gateway/service-unavailable',
          'permissionPresets/catalog: active Service "permissionPresets" is unavailable',
        );
      }
      return {
        'options': [
          {'value': 'workspace-write', 'name': 'workspace-write'},
          {'value': 'danger-full-access', 'name': 'danger-full-access'},
          {'value': 'auto', 'name': 'auto'},
        ],
        'defaultPreset': 'workspace-write',
      };
    };
    final c = ProviderContainer(
      overrides: [
        settingsProvider.overrideWith(_Settings.new),
        localRuntimeProvider.overrideWith(() => engine),
        guestFsProvider.overrideWith((_) async => fs),
        networkKicksProvider.overrideWithValue(const Stream.empty()),
        localClientConnectorProvider.overrideWithValue(({required baseUri, required token}) async {
          connects++;
          return DshClient.withCarrier(carrier);
        }),
      ],
    );
    addTearDown(c.dispose);
    final sub = c.listen(localConnectionProvider, (_, _) {});
    addTearDown(sub.close);
    return c;
  }

  test('an Auto default an older app saved comes out once, and the presets load', () async {
    final c = connect(_poisoned);
    await until(c, localConnectionProvider, (s) => s.value != null && connects == 2, what: '重启后再连上');
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(engine.boots, [true, false]);
    expect(engine.calls, ['stop', 'start'], reason: 'one restart; the clean profile is not written again');
    expect(connects, 2);
    expect(patch.readAsStringSync(), '''
# Your patch layer for this dsh profile, applied after every bundle layer:
- id: model
  config:
    model: deepseek-chat
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
''');
    expect(carrier.argsOf('settings/mutate'), isEmpty);

    final sub = c.listen(permissionStateProvider(null), (_, _) {});
    addTearDown(sub.close);
    final state = await c.read(permissionStateProvider(null).future);
    expect(state!.options.map((o) => o.value), ['workspace-write', 'danger-full-access', 'auto']);
    expect(state.hostDefault, 'workspace-write');
    expect(state.invalidDefault, isFalse);
  });

  test('a normal default is never touched', () async {
    final ordinary = _poisoned.replaceFirst('defaultPreset: auto', 'defaultPreset: danger-full-access');
    final c = connect(ordinary);
    await until(c, localConnectionProvider, (s) => s.value != null, what: '连上');
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(engine.calls, isEmpty);
    expect(connects, 1);
    expect(patch.readAsStringSync(), ordinary);
  });

  group('withoutAutoDefaultPreset', () {
    test('keeps the rest of the config', () {
      expect(
        withoutAutoDefaultPreset('''
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
    defaultPreset: auto # picked in the app
  disabled: false
'''),
        '''
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
  disabled: false
''',
      );
    });

    test('works without a final newline', () {
      expect(withoutAutoDefaultPreset('- id: permission\n  config:\n    defaultPreset: "auto"'), '- id: permission\n');
    });

    test('leaves anything else alone', () {
      for (final patch in [
        '[]\n',
        '- id: permission\n  config:\n    defaultPreset: read-only\n',
        '- id: other\n  config:\n    defaultPreset: auto\n',
        '- id: permission\n  config: {defaultPreset: auto}\n',
        '- id: permission\n  disabled: !!js process.platform === "win32"\n  config:\n    defaultPreset: auto\n',
        'not: [valid',
      ]) {
        expect(withoutAutoDefaultPreset(patch), isNull, reason: patch);
      }
    });
  });
}
