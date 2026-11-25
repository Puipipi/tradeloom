import 'package:dsh_app/pets/pet_prefs.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<ProviderContainer> loaded(Map<String, Object> values) async {
    SharedPreferences.setMockInitialValues(values);
    final container = ProviderContainer();
    addTearDown(container.dispose);
    container.listen(petPrefsProvider, (_, _) {});
    await pumpEventQueue();
    expect(container.read(petPrefsProvider).loaded, isTrue);
    return container;
  }

  test('old or unknown preferences stay pixel, with full-body framing', () async {
    final c = await loaded({PetPrefsController.keys.renderer: 'future-renderer'});
    final prefs = c.read(petPrefsProvider);
    expect(prefs.overlayRenderer, PetOverlayRenderer.pixel);
    expect(prefs.floatZoom, 0.9);
    expect(prefs.floatY, 0);
  });

  test('explicit renderer and a single framing record survive preference reload', () async {
    final c = await loaded({});
    final controller = c.read(petPrefsProvider.notifier);
    await controller.setOverlayRenderer(PetOverlayRenderer.companion);
    await controller.setOverlayFraming(zoom: 1.25, y: -0.15);
    final persisted = await SharedPreferences.getInstance();
    final second = await loaded({
      PetPrefsController.keys.renderer: persisted.getString(PetPrefsController.keys.renderer)!,
      PetPrefsController.keys.framing: persisted.getString(PetPrefsController.keys.framing)!,
    });
    final restored = second.read(petPrefsProvider);
    expect(restored.overlayRenderer, PetOverlayRenderer.companion);
    expect(restored.floatZoom, 1.25);
    expect(restored.floatY, -0.15);
    expect(restored.copyWith(overlayRenderer: PetOverlayRenderer.pixel), isNot(restored));
  });

  test('corrupt framing falls back independently from the explicit renderer', () async {
    final c = await loaded({PetPrefsController.keys.renderer: 'companion',
      PetPrefsController.keys.framing: '{broken'});
    expect(c.read(petPrefsProvider).overlayRenderer, PetOverlayRenderer.companion);
    expect(c.read(petPrefsProvider).floatZoom, 0.9);
  });

  test('invalid programmatic framing never enters state or storage', () async {
    final c = await loaded({});
    final controller = c.read(petPrefsProvider.notifier);
    for (final zoom in [0.0, -1.0, 4.01, double.nan, double.infinity]) {
      expect(() => controller.setOverlayFraming(zoom: zoom, y: 0), throwsArgumentError);
    }
    expect(() => controller.setOverlayFraming(zoom: 1, y: 1.01), throwsArgumentError);
    expect(c.read(petPrefsProvider).floatZoom, 0.9);
  });
}
