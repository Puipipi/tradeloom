// The chat page tells the pet what its conversation does even with the app in
// the background, where Flutter draws no frames: the out-of-app pet must see
// the turn end, or it keeps working and swallows the turn's 做完了.

import 'package:dsh_app/pets/pet_overlay_bridge.dart';
import 'package:dsh_app/pets/pet_prefs.dart';
import 'package:dsh_app/pets/pet_signals.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:dsh_app/state/chat_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/ui_mode_state.dart';
import 'package:dsh_app/ui/pets/pet_stage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../chat/support/harness.dart' show FakeChatController;

class _Prefs extends PetPrefsController {
  @override
  PetPrefs build() => const PetPrefs(packId: noPetId, loaded: true);
}

class _Mode extends UiModeController {
  @override
  UiModeState build() => const UiModeState(loaded: true);
}

class _Host extends ActiveHostController {
  @override
  HostRef build() => HostRef.local;
}

void main() {
  testWidgets('a turn that ends in the background reaches the pet without a frame', (tester) async {
    final chats = <String, FakeChatController>{};
    final container = ProviderContainer(
      overrides: [
        petPrefsProvider.overrideWith(_Prefs.new),
        uiModeProvider.overrideWith(_Mode.new),
        activeHostProvider.overrideWith(_Host.new),
        petOverlayBridgeProvider.overrideWith((ref) {}),
        petScopedStateProvider.overrideWith((ref, scope) => const PetState(state: PetStateName.idle)),
        petClockProvider.overrideWithValue(() => DateTime(2026, 11, 1)),
        chatProvider.overrideWith2(
          (id) => chats[id] = FakeChatController(id, const ChatState(loading: false, running: true)),
        ),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: PetStage(sessionId: 'a', child: SizedBox.expand())),
      ),
    );
    await tester.pump();
    expect(container.read(petFocusProvider)?.sessionId, 'a');
    expect(container.read(petFocusProvider)?.running, isTrue);

    addTearDown(() => tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed));
    for (final state in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    expect(tester.binding.framesEnabled, isFalse);

    chats['a']!.emit(const ChatState(loading: false));
    // Timers and microtasks only: no frame is drawn while frames are off.
    await tester.pump(const Duration(milliseconds: 50));
    expect(tester.binding.hasScheduledFrame, isFalse);
    expect(container.read(petFocusProvider)?.running, isFalse);
    expect(container.read(petSignalsProvider).runsNow(HostRef.local, 'a'), isFalse);
  });
}
