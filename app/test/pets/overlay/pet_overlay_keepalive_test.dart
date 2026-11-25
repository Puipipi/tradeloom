import 'package:dsh_app/pets/pet_overlay_actions.dart';
import 'package:dsh_app/pets/pet_overlay_bridge.dart';
import 'package:dsh_app/pets/pet_signals.dart';
import 'package:dsh_app/pets/pet_prefs.dart';
import 'package:dsh_app/ui/pets/pet_stage.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:dsh_app/state/live_activity_state.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support.dart' show testApp, FixedPetPrefs;

class _State extends Notifier<PetState> {
  @override
  PetState build() => const PetState(state: PetStateName.idle);

  void set(PetState next) => state = next;
}

final _state = NotifierProvider<_State, PetState>(_State.new);
typedef _View = ({bool enabled, bool shown, int revision});

Widget _app(ValueNotifier<_View> view, List<PetState> pushes) => testApp(
  ValueListenableBuilder<_View>(
    valueListenable: view,
    builder: (_, value, _) => TickerMode(
      enabled: value.enabled,
      child: value.shown
          ? PetStage(key: const ValueKey('stage'), child: const SizedBox.expand())
          : const SizedBox.shrink(),
    ),
  ),
  overrides: [
    // Actual production PetStage and overlay bridge. Isolate its visual
    // layer and independent native side effects, not the bridge listener.
    petPrefsProvider.overrideWith(() => FixedPetPrefs(const PetPrefs(packId: noPetId, loaded: true))),
    petScopedStateProvider.overrideWith((ref, scope) => const PetState()),
    petStateProvider.overrideWith((ref) => ref.watch(_state)),
    petOverlayPushProvider.overrideWithValue((state) async => pushes.add(state)),
    petOverlayActionBridgeProvider.overrideWith((ref) {}),
    liveActivityBridgeProvider.overrideWith((ref) {}),
  ],
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  for (final enabled in [true, false]) {
    testWidgets('production PetStage keeps overlay pushes active with TickerMode $enabled', (tester) async {
      final view = ValueNotifier<_View>((enabled: true, shown: true, revision: 0));
      final pushes = <PetState>[];
      try {
        await tester.pumpWidget(_app(view, pushes));
        await tester.pump();
        final container = ProviderScope.containerOf(tester.element(find.byType(PetStage)));
        expect(pushes.map((p) => p.state), [PetStateName.idle]);
        view.value = (enabled: enabled, shown: true, revision: 1);
        await tester.pump();
        expect(find.byType(PetStage), findsOneWidget);
        expect(TickerMode.valuesOf(tester.element(find.byType(PetStage))).enabled, enabled);
        container.read(_state.notifier).set(const PetState(state: PetStateName.working));
        await tester.pump();
        expect(pushes.map((p) => p.state), [PetStateName.idle, PetStateName.working]);

        container.read(_state.notifier).set(const PetState(state: PetStateName.working));
        await tester.pump();
        view.value = (enabled: enabled, shown: true, revision: 2);
        await tester.pump();
        expect(pushes.map((p) => p.state), [
          PetStateName.idle,
          PetStateName.working,
        ], reason: 'equal state and ordinary widget rebuild must not send duplicate pushes');
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        view.dispose();
      }
    });
  }

  testWidgets('removing PetStage stops its overlay pushes while the input container remains mounted', (tester) async {
    final view = ValueNotifier<_View>((enabled: true, shown: true, revision: 0));
    final pushes = <PetState>[];
    try {
      await tester.pumpWidget(_app(view, pushes));
      await tester.pump();
      final container = ProviderScope.containerOf(tester.element(find.byType(PetStage)));
      expect(pushes.map((p) => p.state), [PetStateName.idle]);
      view.value = (enabled: true, shown: false, revision: 1);
      await tester.pump();
      expect(find.byType(PetStage), findsNothing);
      container.read(_state.notifier).set(const PetState(state: PetStateName.working));
      await tester.pump();
      expect(container.read(_state).state, PetStateName.working);
      expect(pushes.map((p) => p.state), [
        PetStateName.idle,
      ], reason: 'the removed bridge must not keep feeding the external output');
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      view.dispose();
    }
  });
}
