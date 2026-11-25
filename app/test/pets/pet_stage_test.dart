// The chat page's pet layer, measured (docs/design/pets.md §2.2, §2.5, §11):
// the foot line on the topmost capsule's top edge within 0.5 px (also every
// frame while the keyboard rises, in landscape and on a wide window), hops
// between perches, the default spot, drags and the keep-out area, taps that
// fall through everywhere but the body, panels that send it away, reactions,
// sleep, the menu and the bubble.

import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:dsh_app/pets/pet_mood.dart';
import 'package:dsh_app/pets/pet_pack.dart';
import 'package:dsh_app/pets/pet_prefs.dart';
import 'package:dsh_app/pets/pet_sheets.dart';
import 'package:dsh_app/pets/pet_signals.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/ui/chat/composer.dart';
import 'package:dsh_app/ui/pets/pet_bubble.dart';
import 'package:dsh_app/ui/pets/pet_perch.dart';
import 'package:dsh_app/ui/pets/pet_sprite.dart';
import 'package:dsh_app/ui/pets/pet_stage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support.dart';

late TestClock clock;
late ProviderContainer container;

Future<void> pumpPet(
  WidgetTester tester, {
  PetPack? pack,
  HarnessConfig config = const HarnessConfig(),
  double position = PetPrefs.defaultPosition,
  PetSize size = PetSize.medium,
  ValueChanged<Offset>? onListTap,
  VoidCallback? onComposerTap,
  Iterable<String> warm = const [],
  bool phone = true,
}) async {
  final p = pack ?? deepy;
  if (phone) usePhoneView(tester);
  await warmSheets(tester, p, [p.animFor(PetStateName.idle), for (final name in warm) p.animations[name]!]);
  await tester.pumpWidget(
    testApp(
      ChatBottomHarness(onListTap: onListTap, onComposerTap: onComposerTap),
      overrides: [
        ...petOverrides(pack: p, clock: clock, position: position, size: size),
        harnessConfigProvider.overrideWith(() => HarnessConfigController(config)),
      ],
    ),
  );
  container = ProviderScope.containerOf(tester.element(find.byType(ChatBottomHarness)));
  for (var i = 0; i < 4; i++) {
    await tester.pump();
  }
  await tester.pump(const Duration(milliseconds: 300));
}

/// Shows other bars (same container: the pet keeps its state).
Future<void> rebuild(
  WidgetTester tester, {
  bool strip = false,
  bool dock = false,
  bool cover = false,
  bool avoid = false,
}) async {
  container
      .read(harnessConfigProvider.notifier)
      .set(HarnessConfig(strip: strip, dock: dock, cover: cover, avoid: avoid));
  await tester.pump();
}

Rect composerRect(WidgetTester tester) => tester.getRect(find.byType(Composer));

/// The pet's foot line on screen (canvas top + baseline × scale).
double footY(WidgetTester tester, PetPack pack, [PetSize size = PetSize.medium]) =>
    petCanvas(tester).top + pack.baseline * petScaleOn(tester, pack, size);

double footX(WidgetTester tester, PetPack pack, [PetSize size = PetSize.medium]) =>
    petCanvas(tester).left + pack.anchorX * petScaleOn(tester, pack, size);

/// The body's hit box on screen.
Rect hitBox(WidgetTester tester, PetPack pack, [String anim = 'idle']) {
  final s = petScaleOn(tester, pack);
  final box = pack.hitBoxFor(pack.animations[anim]!);
  final canvas = petCanvas(tester);
  return Rect.fromLTRB(
    canvas.left + box.left * s,
    canvas.top + box.top * s,
    canvas.left + box.right * s,
    canvas.top + math.min(box.bottom, pack.baseline) * s,
  );
}

/// The shipped Deepy pack with parts of its pack.json replaced (reactions, bonus).
PetPack deepyWith(Map<String, Object?> changes) => PetPack.parse({
  ...jsonDecode(File('assets/pets/deepy-whale/pack.json').readAsStringSync()) as Map<String, Object?>,
  ...changes,
});

/// A [math.Random] that always draws zero: any chance is hit and index 0 picked.
class _ZeroRandom implements math.Random {
  @override
  bool nextBool() => false;

  @override
  double nextDouble() => 0;

  @override
  int nextInt(int max) => 0;
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    clock = TestClock();
    PetLayer.random = math.Random(7);
  });
  tearDown(PetSheets.instance.clear);

  group('perch geometry', () {
    testWidgets('stands on the composer: foot line on its top edge, a quarter along', (tester) async {
      await pumpPet(tester);
      final composer = composerRect(tester);
      expect(petLayer(tester).perch, PerchKind.composer);
      expect((footY(tester, deepy) - composer.top).abs(), lessThanOrEqualTo(0.5));
      expect((footX(tester, deepy) - (composer.left + composer.width / 4)).abs(), lessThanOrEqualTo(0.5));
      expect(container.read(petLayerShownProvider), isTrue);
      expect(container.read(petHeadroomProvider), closeTo((48 - 26) * petScaleOn(tester, deepy), 0.5));
    });

    testWidgets('canvas top-left lands on a device pixel', (tester) async {
      await pumpPet(tester);
      final dpr = tester.view.devicePixelRatio;
      final r = petCanvas(tester);
      expect((r.left * dpr - (r.left * dpr).round()).abs(), lessThan(0.01));
      expect((r.top * dpr - (r.top * dpr).round()).abs(), lessThan(0.01));
    });

    testWidgets('the run strip appears: it hops up onto it, and back down when it goes', (tester) async {
      await pumpPet(tester);
      final before = footX(tester, deepy);
      await rebuild(tester, strip: true);
      await tester.pump();
      await tester.pump();
      expect(petLayer(tester).perch, PerchKind.strip);
      expect(petLayer(tester).hopping, isTrue);
      await tester.pump(const Duration(milliseconds: 190));
      final strip = tester.getRect(find.byKey(const ValueKey('strip')));
      final mid = footY(tester, deepy);
      expect(mid, lessThan(composerRect(tester).top - 10), reason: 'on its way up');
      expect(mid, greaterThan(strip.top - PetMetrics.hopHeight - 1));
      await tester.pump(const Duration(milliseconds: 400));
      expect(petLayer(tester).hopping, isFalse);
      expect((footY(tester, deepy) - strip.top).abs(), lessThanOrEqualTo(0.5));
      expect(
        (footX(tester, deepy) - (strip.left + strip.width / 4)).abs(),
        lessThanOrEqualTo(0.5),
        reason: 'same share along',
      );
      expect(before, isNot(0));
      await rebuild(tester);
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(petLayer(tester).perch, PerchKind.composer);
      expect((footY(tester, deepy) - composerRect(tester).top).abs(), lessThanOrEqualTo(0.5));
    });

    testWidgets('the topmost capsule wins: the todo bar over the strip', (tester) async {
      await pumpPet(tester, config: const HarnessConfig(strip: true, dock: true));
      expect(petLayer(tester).perch, PerchKind.dock);
      final dock = tester.getRect(find.byKey(const ValueKey('dock')));
      expect((footY(tester, deepy) - dock.top).abs(), lessThanOrEqualTo(0.5));
    });

    testWidgets('a phone on its side typing: the bars fold away, it stays on the composer', (tester) async {
      await pumpPet(tester, config: const HarnessConfig(strip: true));
      expect(petLayer(tester).perch, PerchKind.strip);
      container.read(harnessConfigProvider.notifier).set(const HarnessConfig(strip: true, aside: true));
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(petLayer(tester).perch, PerchKind.composer);
      expect((footY(tester, deepy) - composerRect(tester).top).abs(), lessThanOrEqualTo(0.5));
    });

    testWidgets('every frame while the keyboard rises, the foot stays on the edge', (tester) async {
      await pumpPet(tester);
      for (var inset = 0.0; inset <= 320; inset += 40) {
        tester.view.viewInsets = FakeViewPadding(bottom: inset * tester.view.devicePixelRatio);
        await tester.pump();
        final top = composerRect(tester).top;
        expect((footY(tester, deepy) - top).abs(), lessThanOrEqualTo(0.5), reason: 'inset $inset');
      }
      tester.view.resetViewInsets();
    });

    for (final (name, size, dpr) in [
      ('landscape phone', const Size(915, 412), 2.625),
      ('wide window', const Size(1280, 800), 2.0),
    ]) {
      testWidgets('$name: on the composer, inside its ends', (tester) async {
        tester.view.devicePixelRatio = dpr;
        tester.view.physicalSize = size * dpr;
        addTearDown(tester.view.reset);
        await pumpPet(tester, phone: false, position: 1);
        final composer = composerRect(tester);
        expect(composer.width, lessThanOrEqualTo(696.0 + 0.01));
        expect((footY(tester, deepy) - composer.top).abs(), lessThanOrEqualTo(0.5));
        final canvas = petCanvas(tester);
        final s = petScaleOn(tester, deepy);
        expect(canvas.left + deepy.contentBox.right * s, lessThanOrEqualTo(composer.right - PetMetrics.inset + 0.5));
      });
    }
  });

  group('drag and keep-out', () {
    testWidgets('dragged along: snaps onto the perch, the share is kept', (tester) async {
      await pumpPet(tester, warm: ['react-drag']);
      final start = footX(tester, deepy);
      final composer = composerRect(tester);
      final gesture = await tester.startGesture(hitBox(tester, deepy).center);
      await gesture.moveBy(const Offset(10, 0));
      await tester.pump();
      await gesture.moveBy(const Offset(90, -20));
      await tester.pump();
      expect(footY(tester, deepy), lessThan(composer.top - 4), reason: 'lifted while held');
      expect(petLayer(tester).playing!.name, 'react-drag');
      await gesture.up();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect((footY(tester, deepy) - composer.top).abs(), lessThanOrEqualTo(0.5));
      expect(footX(tester, deepy) - start, closeTo(100, 1));
      final share = container.read(petPrefsProvider).position;
      expect(share, closeTo((start + 100 - composer.left) / composer.width, 0.005));
    });

    testWidgets('the jump-to-bottom key is a keep-out area', (tester) async {
      await pumpPet(tester, config: const HarnessConfig(avoid: true), position: 0.95);
      final key = tester.getRect(find.byKey(const ValueKey('jump'))).inflate(PetMetrics.avoidGap);
      final s = petScaleOn(tester, deepy);
      final x = footX(tester, deepy);
      final body = Rect.fromLTRB(
        x - (deepy.anchorX - deepy.contentBox.left) * s,
        0,
        x + (deepy.contentBox.right - deepy.anchorX) * s,
        1,
      );
      expect(body.right <= key.left || body.left >= key.right, isTrue, reason: 'body $body, key $key');
    });

    testWidgets('dropped into the keep-out area: it settles beside it', (tester) async {
      await pumpPet(tester, config: const HarnessConfig(avoid: true), position: 0.5, warm: ['react-drag']);
      final key = tester.getRect(find.byKey(const ValueKey('jump'))).inflate(PetMetrics.avoidGap);
      final gesture = await tester.startGesture(hitBox(tester, deepy).center);
      await gesture.moveBy(const Offset(10, 0));
      await tester.pump();
      await gesture.moveTo(Offset(key.center.dx, hitBox(tester, deepy).center.dy));
      await tester.pump();
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 400));
      final s = petScaleOn(tester, deepy);
      final x = footX(tester, deepy);
      expect(x + (deepy.contentBox.right - deepy.anchorX) * s, lessThanOrEqualTo(key.left + 0.5));
    });
  });

  group('touches', () {
    testWidgets('only the body takes touches; around it they reach the list and the composer', (tester) async {
      final list = <Offset>[];
      var composerTaps = 0;
      await pumpPet(
        tester,
        onListTap: list.add,
        onComposerTap: () => composerTaps++,
        warm: ['react-left', 'react-right'],
      );
      final canvas = petCanvas(tester);
      final body = hitBox(tester, deepy);
      // Inside the canvas, outside the body (its top-left corner).
      await tester.tapAt(canvas.topLeft + const Offset(2, 2));
      await tester.pump(const Duration(milliseconds: 500));
      expect(list, hasLength(1));
      // Just under the foot line: the composer.
      await tester.tapAt(Offset(body.center.dx, composerRect(tester).top + 3));
      await tester.pump(const Duration(milliseconds: 500));
      expect(composerTaps, 1);
      // The body: the pet, not the list.
      await tester.tapAt(body.center);
      await tester.pump(const Duration(milliseconds: 100));
      expect(list, hasLength(1));
      await tester.pump(const Duration(seconds: 3));
    });

    testWidgets('a panel up (slash palette, @, dictation): it fades and takes no touches', (tester) async {
      final list = <Offset>[];
      await pumpPet(tester, onListTap: list.add);
      final body = hitBox(tester, deepy);
      await rebuild(tester, cover: true);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(container.read(petLayerShownProvider), isFalse);
      final opacity = tester.widget<AnimatedOpacity>(
        find.ancestor(of: find.byKey(const ValueKey('pet-body')), matching: find.byType(AnimatedOpacity)),
      );
      expect(opacity.opacity, 0);
      await tester.tapAt(body.center);
      await tester.pump(const Duration(milliseconds: 500));
      expect(list, hasLength(1));
    });

    testWidgets('tap left / right: their reactions; three quick taps: tickle', (tester) async {
      await pumpPet(tester, warm: ['react-left', 'react-right', 'react-double']);
      final body = hitBox(tester, deepy);
      final s = petScaleOn(tester, deepy);
      final split = petCanvas(tester).left + deepy.anchorX * s;
      await tester.tapAt(Offset(split - 6, body.center.dy));
      await tester.pump();
      expect(petLayer(tester).playing!.name, 'react-left');
      await tester.pump(const Duration(seconds: 3));
      clock.advance(const Duration(seconds: 3));
      await tester.tapAt(Offset(split + 6, body.center.dy));
      await tester.pump();
      expect(petLayer(tester).playing!.name, 'react-right');
      await tester.pump(const Duration(seconds: 3));
      clock.advance(const Duration(seconds: 3));
      for (var i = 0; i < 3; i++) {
        await tester.tapAt(body.center);
        await tester.pump(const Duration(milliseconds: 50));
        clock.advance(const Duration(milliseconds: 300));
      }
      expect(petLayer(tester).playing!.name, 'react-double');
      await tester.pump(const Duration(seconds: 3));
      expect(petLayer(tester).playing!.name, 'idle');
    });

    testWidgets('six quick taps without an annoyed reaction: it keeps tickling', (tester) async {
      await pumpPet(tester, warm: ['react-left', 'react-right', 'react-double']);
      final body = hitBox(tester, deepy);
      Future<void> tap() async {
        await tester.tapAt(body.center);
        await tester.pump(const Duration(milliseconds: 50));
        clock.advance(const Duration(milliseconds: 150));
      }

      for (var i = 0; i < 3; i++) {
        await tap();
      }
      expect(petLayer(tester).playing!.name, 'react-double', reason: 'three quick taps tickle');
      for (var i = 0; i < 3; i++) {
        await tap();
      }
      expect(petLayer(tester).playing!.name, 'react-double', reason: 'no annoyed reaction to move on to');
    });

    testWidgets('tapped on to six with an annoyed reaction: annoyed, then the tap loop again', (tester) async {
      final pack = deepyWith({
        'reactions': {
          'tapLeft': 'react-left',
          'tapRight': 'react-right',
          'tickle': 'react-double',
          'drag': 'react-drag',
          'annoyed': 'error',
        },
      });
      await pumpPet(tester, pack: pack, warm: ['react-left', 'react-right', 'react-double', 'error']);
      final body = hitBox(tester, pack);
      Future<void> tap() async {
        await tester.tapAt(body.center);
        await tester.pump(const Duration(milliseconds: 50));
        clock.advance(const Duration(milliseconds: 150));
      }

      for (var i = 0; i < 5; i++) {
        await tap();
      }
      expect(petLayer(tester).playing!.name, 'react-double', reason: 'the fourth and fifth keep tickling');
      await tap();
      expect(petLayer(tester).playing!.name, 'error', reason: 'the sixth taps it out');
      await tap();
      expect(petLayer(tester).playing!.name, 'react-right', reason: 'the count was cleared: a plain poke again');
    });

    testWidgets('a bare pack (idle only, no reactions): taps and states fall back quietly', (tester) async {
      final bare = deepyWith({
        'states': {'idle': ['idle']},
        'reactions': <String, Object?>{},
        'bonus': <String, Object?>{},
        'tiers': <String, Object?>{},
      });
      await pumpPet(tester, pack: bare);
      final body = hitBox(tester, bare);
      for (var i = 0; i < 6; i++) {
        await tester.tapAt(body.center);
        await tester.pump(const Duration(milliseconds: 50));
        clock.advance(const Duration(milliseconds: 150));
      }
      expect(tester.takeException(), isNull, reason: 'a reaction the pack does not write is skipped, not a crash');
      expect(petLayer(tester).playing!.name, 'idle');
      container
          .read(testSignalsProvider.notifier)
          .set(
            PetSignals(
              lastInteraction: clock.now,
              focus: const PetFocus(host: HostRef.local, sessionId: 'a', activity: PetActivity.thinking),
            ),
          );
      await tester.pump();
      await tester.pump();
      expect(petLayer(tester).playing!.name, 'idle', reason: 'no thinking state: idle is the fallback');
    });

    testWidgets('long press: 换宠物 · 藏起来 1 小时 · 宠物设置; hiding it hides it', (tester) async {
      await pumpPet(tester);
      await tester.longPressAt(hitBox(tester, deepy).center);
      await tester.pumpAndSettle();
      expect(find.text('换宠物'), findsOneWidget);
      expect(find.text('藏起来 1 小时'), findsOneWidget);
      expect(find.text('宠物设置'), findsOneWidget);
      await tester.tap(find.text('藏起来 1 小时'));
      await tester.pumpAndSettle();
      expect(container.read(petPrefsProvider).hiddenUntil, clock.now.add(const Duration(hours: 1)));
      expect(container.read(petLayerShownProvider), isFalse);
    });
  });

  group('moods on the page', () {
    testWidgets('left alone for a minute: it sleeps; a touch wakes it', (tester) async {
      await pumpPet(tester, warm: ['sleeping', 'waking']);
      clock.advance(const Duration(seconds: 61));
      container.read(petMoodProvider(PetScope.global).notifier).refresh();
      await tester.pump();
      expect(petLayer(tester).playing!.name, 'sleeping');
      await tester.tapAt(hitBox(tester, deepy, 'sleeping').center);
      container.read(petMoodProvider(PetScope.global).notifier).refresh();
      await tester.pump();
      expect(petLayer(tester).playing!.name, 'waking', reason: 'a tap only wakes it');
    });

    testWidgets('on the strip it reads the conversation on screen', (tester) async {
      await pumpPet(tester, config: const HarnessConfig(strip: true), warm: ['thinking', 'music']);
      expect(petLayer(tester).perch, PerchKind.strip);
      container
          .read(testSignalsProvider.notifier)
          .set(
            PetSignals(
              lastInteraction: clock.now,
              focus: const PetFocus(host: HostRef.local, sessionId: 'a', activity: PetActivity.thinking),
              runs: [const PetRun(HostRef.local, 'a'), const PetRun(HostRef.local, 'b')],
            ),
          );
      await tester.pump();
      expect(petLayer(tester).playing!.name, 'thinking', reason: 'b runs elsewhere; the strip is a’s');
      await rebuild(tester);
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(petLayer(tester).playing!.name, 'music', reason: 'on the composer: everything — a and b run, tier 2');
    });

    testWidgets('bonus also plays on a state that is not attention', (tester) async {
      final pack = deepyWith({
        'bonus': {
          'thinking': {'anims': ['error'], 'chance': 0.5},
        },
      });
      // A die that always draws zero: the chance is hit, the lone extra picked.
      PetLayer.random = _ZeroRandom();
      await pumpPet(tester, pack: pack, warm: ['thinking', 'error']);
      container
          .read(testSignalsProvider.notifier)
          .set(
            PetSignals(
              lastInteraction: clock.now,
              focus: const PetFocus(host: HostRef.local, sessionId: 'a', activity: PetActivity.thinking),
            ),
          );
      await tester.pump();
      await tester.pump();
      expect(petLayer(tester).playing!.name, 'error', reason: 'the thinking bonus, not the plain thinking animation');
      await tester.pump(Duration(milliseconds: pack.playOf(pack.animations['error']!) + 1));
      expect(petLayer(tester).playing!.name, 'thinking', reason: 'one pass of the extra, then back to the state');
    });
  });

  group('ringing and reduced motion', () {
    testWidgets('while something waits, a tap goes to look (another conversation opens)', (tester) async {
      await pumpPet(tester, warm: ['notification']);
      container
          .read(testSignalsProvider.notifier)
          .set(
            PetSignals(
              lastInteraction: clock.now,
              pending: const [PetPending(host: HostRef.local, sessionId: 'waits', key: 'e1')],
            ),
          );
      await tester.pump();
      expect(petLayer(tester).playing!.name, 'notification');
      await tester.tapAt(hitBox(tester, deepy, 'notification').center);
      await tester.pump();
      expect(container.read(currentSessionProvider), 'waits');
      expect(petLayer(tester).playing!.name, 'notification', reason: 'no poke on a tap that goes to look');
    });

    testWidgets('animations off: no hop (it is simply there), the first frame only, no walks', (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(
        disableAnimations: true,
      );
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      await pumpPet(tester);
      await rebuild(tester, strip: true);
      await tester.pump();
      await tester.pump();
      expect(petLayer(tester).perch, PerchKind.strip);
      expect(petLayer(tester).hopping, isFalse);
      final strip = tester.getRect(find.byKey(const ValueKey('strip')));
      expect((footY(tester, deepy) - strip.top).abs(), lessThanOrEqualTo(0.5));
      await tester.pump(const Duration(seconds: 2));
      expect(tester.state<PetSpriteState>(find.byType(PetSprite)).frame, 0);
      await tester.pump(const Duration(minutes: 6));
      expect(petLayer(tester).walking, isFalse);
    });

    testWidgets('idle, now and then it walks a little way along its perch, inside its ends', (tester) async {
      await pumpPet(tester, warm: ['roam-hop', 'idle-look', 'idle-spout']);
      final composer = composerRect(tester);
      var walked = false;
      for (var i = 0; i < 330 && !walked; i++) {
        await tester.pump(const Duration(seconds: 1));
        clock.advance(const Duration(seconds: 1));
        // Keep it awake: a touch somewhere on the page every so often.
        if (i % 30 == 0) container.read(petInteractionProvider.notifier).touch();
        walked = petLayer(tester).walking;
      }
      expect(walked, isTrue, reason: 'within 5 min');
      expect(petLayer(tester).playing!.name, 'roam-hop');
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 250));
        final s = petScaleOn(tester, deepy);
        final x = footX(tester, deepy);
        expect(
          x - (deepy.anchorX - deepy.contentBox.left) * s,
          greaterThanOrEqualTo(composer.left + PetMetrics.inset - 0.5),
        );
        expect(
          x + (deepy.contentBox.right - deepy.anchorX) * s,
          lessThanOrEqualTo(composer.right - PetMetrics.inset + 0.5),
        );
        expect((footY(tester, deepy) - composer.top).abs(), lessThanOrEqualTo(0.5));
      }
    });
  });

  group('bubble', () {
    testWidgets('another conversation finished: a bubble over its head, inside the page; a tap opens it', (
      tester,
    ) async {
      await pumpPet(tester, position: 0, warm: ['error']);
      container
          .read(petEventBusProvider)
          .add(
            PetEvent(
              kind: PetEventKind.failed,
              host: HostRef.local,
              sessionId: 'other',
              key: 'turn',
              title: '修复登录重复提交',
              at: clock.now,
              bubble: true,
            ),
          );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      final bubble = find.byType(PetBubbleView);
      expect(bubble, findsOneWidget);
      expect(find.text('修复登录重复提交'), findsOneWidget);
      expect(find.text('出错了'), findsOneWidget);
      final r = tester.getRect(bubble);
      // Over the body and over what the state holds up (error's sparks).
      final top = math.min(deepy.contentBox.top, deepy.animFor(PetStateName.error).box.top);
      final head = petCanvas(tester).top + top * petScaleOn(tester, deepy);
      expect((r.bottom - (head - PetBubbleMetrics.lift)).abs(), lessThanOrEqualTo(0.5));
      expect(r.left, greaterThanOrEqualTo(PetMetrics.bubbleMargin - 0.01));
      expect(r.height, PetBubbleMetrics.height);
      await tester.tap(bubble);
      await tester.pump();
      expect(container.read(currentSessionProvider), 'other');
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(PetBubbleView), findsNothing);
    });

    testWidgets('an upward flick sends it away without opening anything', (tester) async {
      await pumpPet(tester);
      container
          .read(petEventBusProvider)
          .add(
            PetEvent(
              kind: PetEventKind.failed,
              host: HostRef.local,
              sessionId: 'other',
              key: 'turn',
              at: clock.now,
              bubble: true,
            ),
          );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.fling(find.byType(PetBubbleView), const Offset(0, -60), 800);
      expect(container.read(petMoodProvider(PetScope.global)).bubble, isNull);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(PetBubbleView), findsNothing);
      expect(container.read(currentSessionProvider), isNull);
    });
  });
}
