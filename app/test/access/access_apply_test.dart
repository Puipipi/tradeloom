// After the walk, what was picked is switched on as far as the phone
// allows: 访问手机文件 only with the files reachable, 手机操控's switch (its
// disclosure was accepted on the pick), the pet only once it can be drawn.
// An engine already on its way restarts once, so its start has them.

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/pets/overlay_channel.dart';
import 'package:dsh_app/state/access_state.dart';
import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../pets/overlay/fake_overlay_native.dart';
import '../phone/support.dart';
import '../shell/golden_harness.dart';
import 'support.dart';

class _Settings extends FakeSettings {
  _Settings() : super(const AppSettings(loaded: true));

  @override
  Future<void> setPhoneStorage(bool value) async => state = state.copyWith(phoneStorage: value);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakePhoneNative phone;
  late FakeOverlayNative pet;

  Future<ProviderContainer> container({LocalRuntimeController Function()? engine, bool phoneOn = false}) async {
    SharedPreferences.setMockInitialValues({});
    phone = FakePhoneNative(status: phoneStatus(enabled: phoneOn))..install();
    pet = FakeOverlayNative(permission: 'granted')..install();
    final c = ProviderContainer(
      overrides: [
        settingsProvider.overrideWith(_Settings.new),
        localRuntimeProvider.overrideWith(
          engine ??
              () => FakeRuntime(
                const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.notInstalled)),
              ),
        ),
        accessDriverProvider.overrideWithValue(FakeAccessDriver(offPhone)),
      ],
    );
    addTearDown(c.dispose);
    c.read(accessSetupProvider);
    c.read(petOverlayProvider);
    await Future<void>.delayed(Duration.zero);
    await c.read(phoneProvider.notifier).refreshStatus();
    return c;
  }

  test('everything the phone allows: files, phone control, the pet', () async {
    final c = await container();
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.files, AccessFeature.phone, AccessFeature.pet});
    await c.read(accessSetupProvider.notifier).apply(readingsWith(offPhone, storage: true, overlay: true));
    expect(c.read(settingsProvider).phoneStorage, isTrue);
    expect(phone.calls.where((m) => m.method == 'setEnabled').single.arguments, {'enabled': true});
    expect(pet.calls.where((m) => m.method == 'setEnabled').single.arguments, {'enabled': true});
    // Nothing opened behind the person's back.
    expect(pet.methods, isNot(contains('requestPermission')));
  });

  test('a permission still off leaves its feature off; phone control\'s switch is its own', () async {
    final c = await container();
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.files, AccessFeature.phone, AccessFeature.pet});
    await c.read(accessSetupProvider.notifier).apply(offPhone);
    expect(c.read(settingsProvider).phoneStorage, isFalse);
    expect(phone.methods, contains('setEnabled'));
    expect(pet.methods, isNot(contains('setEnabled')));
  });

  group('the engine, as far as it got', () {
    final storage = readingsWith(offPhone, storage: true);

    /// Lets the restart (not waited for) stop the engine and start it again.
    Future<void> settle() async {
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
    }

    Future<FakeEngine> applyWith(RuntimePhase phase, Set<AccessFeature> features, {bool phoneOn = false}) async {
      // Asked to start before the files were allowed: without them.
      final engine = FakeEngine(phase);
      final c = await container(engine: () => engine, phoneOn: phoneOn);
      await c.read(accessSetupProvider.notifier).choose(features);
      await c.read(accessSetupProvider.notifier).apply(storage);
      await settle();
      expect(c.read(settingsProvider).phoneStorage, isTrue);
      return engine;
    }

    test('starting, files only: restarted once, and the new start has them', () async {
      final engine = await applyWith(RuntimePhase.starting, {AccessFeature.files});
      expect(engine.stops, 1);
      expect(engine.starts, [true]);
      expect(engine.storageMounted, isTrue);
    });

    test('starting, files and phone control: phone control\'s one restart, with the files', () async {
      final engine = await applyWith(RuntimePhase.starting, {AccessFeature.files, AccessFeature.phone});
      expect(phone.methods, contains('setEnabled'));
      expect(engine.stops, 1);
      expect(engine.starts, [true]);
    });

    test('starting, phone control already on: the files\' one restart', () async {
      final engine = await applyWith(RuntimePhase.starting, {AccessFeature.files, AccessFeature.phone}, phoneOn: true);
      expect(phone.methods, isNot(contains('setEnabled')));
      expect(engine.stops, 1);
      expect(engine.starts, [true]);
    });

    test('running: restarted once, with the files', () async {
      final engine = await applyWith(RuntimePhase.running, {AccessFeature.files, AccessFeature.phone});
      expect(engine.stops, 1);
      expect(engine.starts, [true]);
    });

    test('not started: nothing to restart; its start takes the files', () async {
      for (final phase in [RuntimePhase.notInstalled, RuntimePhase.installing, RuntimePhase.installed]) {
        final engine = await applyWith(phase, {AccessFeature.files, AccessFeature.phone});
        expect(engine.stops, 0, reason: phase.name);
        expect(engine.starts, isEmpty, reason: phase.name);
        await engine.start();
        expect(engine.storageMounted, isTrue, reason: phase.name);
      }
    });
  });

  test('what wasn\'t picked is left alone', () async {
    final c = await container();
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.voice});
    await c.read(accessSetupProvider.notifier).apply(readingsWith(offPhone, storage: true, overlay: true));
    expect(c.read(settingsProvider).phoneStorage, isFalse);
    expect(phone.methods, isNot(contains('setEnabled')));
    expect(pet.methods, isNot(contains('setEnabled')));
  });
}
