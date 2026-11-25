// The stage's pause gate for a hidden pet: the sprite keeps playing while the
// body fades out, freezes once it is fully transparent, and resumes before a
// fade-in. Component state only, not pixels or timing. A synthetic three-cell
// sheet with one-minute frames keeps the sprite's own clock out of the way.
import 'package:dsh_app/pets/pet_overlay_bridge.dart';
import 'package:dsh_app/pets/pet_pack.dart';
import 'package:dsh_app/pets/pet_prefs.dart';
import 'package:dsh_app/pets/pet_sheets.dart';
import 'package:dsh_app/pets/pet_signals.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:dsh_app/state/ui_mode_state.dart';
import 'package:dsh_app/ui/pets/pet_perch.dart';
import 'package:dsh_app/ui/pets/pet_sprite.dart';
import 'package:dsh_app/ui/pets/pet_stage.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _idle = PetAnimation(
  name: 'idle',
  sheet: 'fixture.png',
  frameWidth: 1,
  frameHeight: 1,
  cols: 3,
  box: Rect.fromLTWH(0, 0, 1, 1),
  frames: [PetFrame(0, 60000), PetFrame(1, 60000), PetFrame(2, 60000)],
);
const deepy = PetPack(
  id: 'phase-test',
  name: 'Phase test',
  canvas: Size(1, 1),
  anchorX: 0.5,
  baseline: 1,
  contentBox: Rect.fromLTWH(0, 0, 1, 1),
  animations: {'idle': _idle},
  states: {
    'idle': ['idle'],
  },
);

/// A 3×1 PNG for the sheet.
class _Bundle extends CachingAssetBundle {
  @override
  Future<ByteData> load(String key) async => ByteData.sublistView(
    Uint8List.fromList([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      0,
      0,
      0,
      13,
      73,
      72,
      68,
      82,
      0,
      0,
      0,
      3,
      0,
      0,
      0,
      1,
      8,
      6,
      0,
      0,
      0,
      27,
      224,
      20, //
      180,
      0,
      0,
      0,
      21,
      73,
      68,
      65,
      84,
      120,
      156,
      99,
      248,
      207,
      192,
      240,
      159,
      225,
      63,
      195,
      127,
      6,
      134,
      255,
      255,
      1, //
      35, 233, 5, 251, 180, 33, 71, 134, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]),
  );
}

Future<void> warmSheets(WidgetTester tester, PetPack pack) async {
  PetSheets.enabled = true;
  PetSheets.instance.pin(pack, pack.animFor(PetStateName.idle));
  await tester.runAsync(() async {
    for (final anim in pack.animations.values) {
      final image = await PetSheets.instance.load(pack, anim, _Bundle());
      image.dispose();
    }
  });
}

class _Prefs extends PetPrefsController {
  @override
  PetPrefs build() => const PetPrefs(packId: 'phase-test', loaded: true);
}

class _Mode extends UiModeController {
  @override
  UiModeState build() => const UiModeState(loaded: true);
}

typedef _Controls = ({bool cover, bool reduced});

Future<void> _mountStage(WidgetTester tester, ValueNotifier<_Controls> controls) async {
  await warmSheets(tester, deepy);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        currentPetPackProvider.overrideWithValue(deepy),
        petPrefsProvider.overrideWith(_Prefs.new),
        uiModeProvider.overrideWith(_Mode.new),
        petOverlayBridgeProvider.overrideWith((ref) {}),
        petScopedStateProvider.overrideWith((ref, scope) => const PetState(state: PetStateName.sleeping)),
        petClockProvider.overrideWithValue(() => DateTime(2026)),
      ],
      child: MaterialApp(
        home: ValueListenableBuilder<_Controls>(
          valueListenable: controls,
          builder: (context, value, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: value.reduced),
            child: PetStage(
              child: Stack(
                children: [
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: PetCover(
                      active: value.cover,
                      child: const PetPerch(kind: PerchKind.composer, child: SizedBox(height: 80)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
  // Registry geometry and ready notifications intentionally cross frame boundaries.
  for (var i = 0; i < 5; i++) {
    await tester.pump();
  }
}

PetSprite _body(WidgetTester tester) => tester.widget<PetSprite>(find.byType(PetSprite));

Future<void> _setCover(WidgetTester tester, ValueNotifier<_Controls> controls, bool cover) async {
  controls.value = (cover: cover, reduced: controls.value.reduced);
  await tester.pump(); // Registry mutation is observed after this frame.
  await tester.pump(); // Stage updates its actual AnimatedOpacity target.
}

void main() {
  tearDown(PetSheets.instance.clear);

  testWidgets('fade completion gates pause; a rapid reversal stays resumed', (tester) async {
    final controls = ValueNotifier<_Controls>((cover: false, reduced: false));
    addTearDown(controls.dispose);
    await _mountStage(tester, controls);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();
    expect(_body(tester).paused, isFalse);

    await _setCover(tester, controls, true);
    expect(_body(tester).paused, isFalse, reason: 'the fading body is still visible');
    await tester.pump(const Duration(milliseconds: 100));
    expect(_body(tester).paused, isFalse);
    await _setCover(tester, controls, false);
    expect(_body(tester).paused, isFalse);
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
    expect(_body(tester).paused, isFalse, reason: 'a reversed fade must not leave a stale pause');

    await _setCover(tester, controls, true);
    await tester.pump(const Duration(milliseconds: 100));
    expect(_body(tester).paused, isFalse);
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump(); // onEnd's post-frame state reaches the child here.
    expect(_body(tester).paused, isTrue);
    await _setCover(tester, controls, false);
    expect(_body(tester).paused, isFalse, reason: 'resume before completing fade-in');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('initial cover pauses; zero-duration hide and show do not throw', (tester) async {
    final controls = ValueNotifier<_Controls>((cover: true, reduced: false));
    addTearDown(controls.dispose);
    await _mountStage(tester, controls);
    expect(_body(tester).paused, isTrue, reason: 'initial opacity zero has no fade-out onEnd');
    await _setCover(tester, controls, false);
    expect(_body(tester).paused, isFalse);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();

    controls.value = (cover: false, reduced: true);
    await tester.pump();
    await _setCover(tester, controls, true);
    await tester.pump();
    expect(_body(tester).paused, isTrue);
    expect(tester.takeException(), isNull, reason: 'zero-duration completion must not setState during build');
    await _setCover(tester, controls, false);
    await tester.pump();
    expect(_body(tester).paused, isFalse);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
