// First run's 「桌宠与悬浮窗」 means "show me the pet": on a phone whose default
// is no pet (a light device) and with no pet chosen yet, finishing the step
// picks the default one, so 「App 外显示」 has something to show (0.9.8 smoke
// 03j / 03k). A choice already made, 「不显示」 included, stays.

import 'package:dsh_app/performance/performance_state.dart';
import 'package:dsh_app/pets/overlay_channel.dart';
import 'package:dsh_app/pets/pet_prefs.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/access_state.dart';
import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../performance/support.dart';
import '../pets/overlay/fake_overlay_native.dart';
import '../phone/support.dart';
import '../shell/golden_harness.dart';
import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeOverlayNative pet;

  Future<ProviderContainer> container({Map<String, Object> prefs = const {}, DeviceTier tier = DeviceTier.low}) async {
    SharedPreferences.setMockInitialValues(prefs);
    FakePhoneNative(status: phoneStatus()).install();
    pet = FakeOverlayNative(permission: 'granted')..install();
    final c = ProviderContainer(
      overrides: [
        settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
        localRuntimeProvider.overrideWith(
          () => FakeRuntime(const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.notInstalled))),
        ),
        accessDriverProvider.overrideWithValue(FakeAccessDriver(offPhone)),
        performanceChannelProvider.overrideWithValue(FakePerformanceChannel(Future.value(snapshot(tier)))),
      ],
    );
    addTearDown(c.dispose);
    c.read(accessSetupProvider);
    c.read(petOverlayProvider);
    c.read(petPrefsProvider);
    await Future<void>.delayed(Duration.zero);
    await c.read(phoneProvider.notifier).refreshStatus();
    return c;
  }

  Future<String?> storedPack() async => (await SharedPreferences.getInstance()).getString(PetPrefsController.keys.pack);

  test('picked, granted, no pet chosen on a light phone: the default pet, and the overlay on', () async {
    final c = await container();
    expect(c.read(petPrefsProvider).packId, noPetId, reason: 'a light phone starts without a pet');
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.pet});
    await c.read(accessSetupProvider.notifier).apply(readingsWith(offPhone, overlay: true));
    expect(c.read(petPrefsProvider).packId, defaultPetId);
    expect(c.read(petPrefsProvider).packExplicit, isTrue);
    expect(await storedPack(), defaultPetId);
    expect(pet.calls.where((m) => m.method == 'setEnabled').single.arguments, {'enabled': true});
  });

  test('picked but the floating window still off: the pet shows in the app at least', () async {
    final c = await container();
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.pet});
    await c.read(accessSetupProvider.notifier).apply(offPhone);
    expect(c.read(petPrefsProvider).packId, defaultPetId);
    expect(pet.methods, isNot(contains('setEnabled')));
  });

  test('the whole step through 继续 picks it too', () async {
    final c = await container();
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.pet});
    await c.read(accessSetupProvider.notifier).finish();
    expect(c.read(petPrefsProvider).packId, defaultPetId);
  });

  for (final chosen in [noPetId, 'whale-girl']) {
    test('a pet choice already made stays: $chosen', () async {
      final c = await container(prefs: {PetPrefsController.keys.pack: chosen});
      await c.read(accessSetupProvider.notifier).choose({AccessFeature.pet});
      await c.read(accessSetupProvider.notifier).apply(readingsWith(offPhone, overlay: true));
      expect(c.read(petPrefsProvider).packId, chosen);
      expect(await storedPack(), chosen);
    });
  }

  test('not picked: the light phone keeps its default (no pet), nothing stored', () async {
    final c = await container();
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.voice});
    await c.read(accessSetupProvider.notifier).apply(readingsWith(offPhone, overlay: true));
    expect(c.read(petPrefsProvider).packId, noPetId);
    expect(c.read(petPrefsProvider).packExplicit, isFalse);
    expect(await storedPack(), isNull);
  });

  test('a full phone shows the default pet anyway; picking it makes the choice its own', () async {
    final c = await container(tier: DeviceTier.high);
    await c.read(accessSetupProvider.notifier).choose({AccessFeature.pet});
    await c.read(accessSetupProvider.notifier).apply(readingsWith(offPhone, overlay: true));
    expect(c.read(petPrefsProvider).packId, defaultPetId);
    expect(await storedPack(), defaultPetId);
  });
}
