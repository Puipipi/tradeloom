// The pet and the plugins' bars above the composer: the
// capsule row and the status line are perches too. The pet stands on the
// topmost one — its foot line on the row's top edge within 0.5 px, its body
// clear of every capsule, the capsules still taking their taps — hops up
// when a bar appears and back down to the composer when the bars give way.

import 'dart:math' as math;

import 'package:dsh_app/pets/pet_sheets.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:dsh_app/ui/chat/composer.dart';
import 'package:dsh_app/ui/chat/widgets/attachments.dart';
import 'package:dsh_app/ui/pets/pet_perch.dart';
import 'package:dsh_app/ui/pets/pet_stage.dart';
import 'package:dsh_app/ui/plugins/native/composer_capsules.dart';
import 'package:dsh_app/ui/plugins/native/composer_strip.dart';
import 'package:dsh_app/ui/plugins/native/native_composer_bar.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../plugins/native/support.dart'
    show FakeBridge, FakeComposer, contributions, nativeOverrides, quickPlugin, usagePlugin, withComposer;
import 'support.dart';

late TestClock clock;

/// Whether the bars show (false: a reply generating).
final _visible = ValueNotifier<bool>(true);

/// The bottom of the chat page: the plugins' bars over the composer, under
/// the pet stage, as chat_screen.dart lays them out.
Widget _page(FakeComposer composer) => Scaffold(
  backgroundColor: Colors.transparent,
  body: AppBackdrop(
    child: PetStage(
      child: Stack(
        children: [
          const Positioned.fill(child: SizedBox.expand()),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: SafeArea(
              top: false,
              minimum: const EdgeInsets.only(bottom: 8),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                child: withComposer(
                  composer,
                  ValueListenableBuilder<bool>(
                    valueListenable: _visible,
                    builder: (context, visible, _) => Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        NativeComposerBar(sessionId: composer.sessionId, visible: visible),
                        Composer(
                          controller: TextEditingController(),
                          connected: true,
                          running: !visible,
                          onSend: () {},
                          onStop: () {},
                          leading: AttachButton(onPressed: () {}),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  ),
);

Future<void> _pump(WidgetTester tester, FakeBridge bridge, FakeComposer composer) async {
  usePhoneView(tester);
  await warmSheets(tester, deepy, [deepy.animFor(PetStateName.idle)]);
  await tester.pumpWidget(
    testApp(
      _page(composer),
      overrides: [
        ...nativeOverrides(bridge),
        ...petOverrides(pack: deepy, clock: clock),
      ],
    ),
  );
  // The contributions arrive, the row rises, the pet hops up onto it.
  await _settle(tester);
}

/// Lets a bar's rise and then the hop it causes finish.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 2; i++) {
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));
  }
}

double _footY(WidgetTester tester) => petCanvas(tester).top + deepy.baseline * petScaleOn(tester, deepy);

/// The body's hit box on screen (what takes the pet's taps).
Rect _body(WidgetTester tester) {
  final s = petScaleOn(tester, deepy);
  final box = deepy.hitBoxFor(deepy.animations['idle']!);
  final canvas = petCanvas(tester);
  return Rect.fromLTRB(
    canvas.left + box.left * s,
    canvas.top + box.top * s,
    canvas.left + box.right * s,
    canvas.top + math.min(box.bottom, deepy.baseline) * s,
  );
}

List<Rect> _capsules(WidgetTester tester) => [
  for (final e in find.byType(ComposerCapsule).evaluate()) tester.getRect(find.byWidget(e.widget)),
];

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    clock = TestClock();
    PetLayer.random = math.Random(7);
    _visible.value = true;
  });
  tearDown(PetSheets.instance.clear);

  testWidgets('the capsule row: the foot on its top edge, the body clear of every capsule', (tester) async {
    final bridge = FakeBridge(contributions([quickPlugin()]));
    final composer = FakeComposer();
    await _pump(tester, bridge, composer);

    final capsules = _capsules(tester);
    expect(capsules, hasLength(2));
    expect(petLayer(tester).perch, PerchKind.plugin);
    expect((_footY(tester) - capsules.first.top).abs(), lessThanOrEqualTo(0.5));
    final body = _body(tester);
    expect(body.bottom, lessThanOrEqualTo(capsules.first.top + 0.5));
    for (final c in capsules) {
      expect(body.intersect(c).isEmpty || body.intersect(c).height <= 0.5, isTrue, reason: '$body over $c');
    }
    // Default spot: a quarter along the row, so right above a capsule.
    final under = capsules.firstWhere(
      (c) => c.left <= body.center.dx && body.center.dx <= c.right,
      orElse: () => capsules.first,
    );

    // The capsules keep their taps, the one under the pet first.
    for (final c in [under, ...capsules.where((c) => c != under)]) {
      await tester.tapAt(c.center);
      await tester.pump(const Duration(milliseconds: 200));
    }
    expect(bridge.invocations.map((i) => i.id), contains('translate'));
    expect(composer.inserted, ['你好']);
  });

  testWidgets('the status line rises: it hops up onto it; the bars give way: back to the composer', (tester) async {
    final bridge = FakeBridge(contributions([usagePlugin(), quickPlugin()]));
    await _pump(tester, bridge, FakeComposer());
    expect(petLayer(tester).perch, PerchKind.plugin);
    expect((_footY(tester) - _capsules(tester).first.top).abs(), lessThanOrEqualTo(0.5));

    bridge.socket.push({
      't': 'data',
      'sub': bridge.socket.subOf('cost')!['sub'],
      'rev': '1',
      'data': {'text': '本对话 1.2k · 今日 8k'},
    });
    await _settle(tester);
    final strip = tester.getRect(find.byType(ComposerStrip));
    expect(petLayer(tester).perch, PerchKind.plugin);
    expect((_footY(tester) - strip.top).abs(), lessThanOrEqualTo(0.5), reason: 'on the topmost bar');
    expect(_body(tester).bottom, lessThanOrEqualTo(strip.top + 0.5));

    // A reply generating: both bars sink behind the composer; the pet goes
    // back to it (the bars on their way out are no perch).
    _visible.value = false;
    await _settle(tester);
    expect(petLayer(tester).perch, PerchKind.composer);
    expect((_footY(tester) - tester.getRect(find.byType(Composer)).top).abs(), lessThanOrEqualTo(0.5));

    _visible.value = true;
    await _settle(tester);
    expect(petLayer(tester).perch, PerchKind.plugin);
    expect((_footY(tester) - tester.getRect(find.byType(ComposerStrip)).top).abs(), lessThanOrEqualTo(0.5));
  });

  testWidgets('without plugins or ui.json capsules: on the composer, as before', (tester) async {
    await _pump(tester, FakeBridge(), FakeComposer());
    expect(find.byType(ComposerCapsule), findsNothing);
    expect(petLayer(tester).perch, PerchKind.composer);
    expect((_footY(tester) - tester.getRect(find.byType(Composer)).top).abs(), lessThanOrEqualTo(0.5));
  });
}
