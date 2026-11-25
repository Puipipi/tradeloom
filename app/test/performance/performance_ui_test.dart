// ignore_for_file: depend_on_referenced_packages

import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:dsh_app/app.dart';
import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/performance/performance_state.dart';
import 'package:dsh_app/pets/pet_pack.dart';
import 'package:dsh_app/pets/pet_sheets.dart';
import 'package:dsh_app/state/locale_state.dart';
import 'package:dsh_app/state/ui_mode_state.dart';
import 'package:dsh_app/ui/common/app_sheet.dart';
import 'package:dsh_app/ui/common/display_image.dart';
import 'package:dsh_app/ui/onboarding/runtime_choice.dart';
import 'package:dsh_app/runtime/local_footprint.dart';
import 'package:dsh_app/ui/pets/pet_sprite.dart';
import 'package:dsh_app/ui/plugins/plugin_widgets.dart';
import 'package:dsh_app/ui/settings/performance_page.dart';
import 'package:dsh_app/ui/settings/settings_widgets.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_app/ui/web/mode_home.dart';
import 'package:dsh_app/ui/web/web_view_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import '../web/support/fake_webview.dart';
import 'support.dart';

class _Language extends AppLanguageController {
  _Language(this.language);
  final AppLanguage language;
  @override
  AppLanguage build() => language;
}

Future<ProviderContainer> mount(
  WidgetTester tester,
  Widget home, {
  DeviceTier tier = DeviceTier.high,
  AppLanguage language = AppLanguage.zh,
  List<Override> overrides = const [],
  FakePerformanceChannel? channel,
}) async {
  final native = channel ?? FakePerformanceChannel(Future.value(snapshot(tier)));
  final container = ProviderContainer(
    overrides: [
      performanceChannelProvider.overrideWithValue(native),
      appLanguageProvider.overrideWith(() => _Language(language)),
      noUiJson,
      ...overrides,
    ],
  );
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    container.dispose();
    await native.events.close();
  });
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: DshApp(home: home),
    ),
  );
  return container;
}

void window(
  WidgetTester tester, {
  double width = 390,
  double height = 1000,
  double scale = 1,
  Brightness brightness = Brightness.light,
}) {
  tester.view.devicePixelRatio = 2;
  tester.view.physicalSize = Size(width * 2, height * 2);
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  tester.platformDispatcher.platformBrightnessTestValue = brightness;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearAllTestValues);
}

Future<ByteData> png(int width, int height) async {
  final recorder = ui.PictureRecorder();
  Canvas(recorder).drawRect(Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()), Paint()..color = Colors.blue);
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  picture.dispose();
  final data = (await image.toByteData(format: ui.ImageByteFormat.png))!;
  image.dispose();
  return data;
}

class _SheetBundle extends CachingAssetBundle {
  _SheetBundle(this.data);
  final ByteData data;
  @override
  Future<ByteData> load(String key) async => data;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('an unavailable native plugin never activates an event channel', (tester) async {
    final channel = PerformanceChannel();
    await tester.runAsync(() async {
      expect((await channel.snapshot()).available, isFalse);
      expect(await channel.changes.toList(), isEmpty);
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('leaving while the native snapshot never replies cancels its deadline', (tester) async {
    final channel = FakePerformanceChannel(Completer<PerformanceSnapshot>().future);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [performanceChannelProvider.overrideWithValue(channel)],
        child: Consumer(
          builder: (context, ref, child) {
            ref.watch(performanceProvider);
            return const SizedBox.shrink();
          },
        ),
      ),
    );
    await tester.pumpWidget(const SizedBox.shrink());
    await channel.events.close();
    expect(tester.takeException(), isNull);
    // The framework also verifies that no timer survives this test's widget tree.
  });

  testWidgets('light defaults drive both theme blur and the existing motion path', (tester) async {
    window(tester);
    const body = SizedBox(key: ValueKey('policy-probe'));
    final c = await mount(tester, body, tier: DeviceTier.low);
    await tester.pumpAndSettle();
    BuildContext context() => tester.element(find.byKey(const ValueKey('policy-probe')));
    expect(DshSurfaces.of(context()).blurEnabled, isFalse);
    expect(AppMotion.of(context(), AppMotion.standard), Duration.zero);
    await c.read(performancePrefsProvider.notifier).setMode(PerformanceMode.full);
    await tester.pumpAndSettle();
    expect(DshSurfaces.of(context()).blurEnabled, isTrue);
    expect(AppMotion.of(context(), AppMotion.standard), AppMotion.standard);
  });

  testWidgets('the system remove-animations setting wins over explicit full animation', (tester) async {
    window(tester);
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
    SharedPreferences.setMockInitialValues({'performance.mode': 'full', 'performance.animations': true});
    await mount(tester, const SizedBox(key: ValueKey('system-probe')));
    await tester.pumpAndSettle();
    final context = tester.element(find.byKey(const ValueKey('system-probe')));
    expect(AppMotion.reduced(context), isTrue);
    expect(DshSurfaces.of(context).blurEnabled, isTrue);
  });

  testWidgets('remove animations turned on with the app open takes the transition off pages', (tester) async {
    window(tester);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    SharedPreferences.setMockInitialValues({'performance.mode': 'full'});
    await mount(
      tester,
      Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const Scaffold(body: Center(child: Text('page'))),
                ),
              ),
              child: const Text('push'),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(AppMotion.reduced(tester.element(find.text('push'))), isFalse);

    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
    await tester.pump();
    expect(AppMotion.reduced(tester.element(find.text('push'))), isTrue);
    await tester.tap(find.text('push'));
    await tester.pump();
    expect(tester.getCenter(find.text('page')).dx, 195);
    Navigator.of(tester.element(find.text('page'))).pop();
    await tester.pumpAndSettle();

    // And off again: the transition is back.
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures();
    await tester.pump();
    expect(AppMotion.reduced(tester.element(find.text('push'))), isFalse);
    await tester.tap(find.text('push'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(tester.getCenter(find.text('page')).dx, greaterThan(195));
    await tester.pumpAndSettle();
  });

  testWidgets('the animation switch takes the transition off pages and sheets', (tester) async {
    window(tester);
    SharedPreferences.setMockInitialValues({'performance.mode': 'full'});
    final c = await mount(
      tester,
      Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const Scaffold(body: Center(child: Text('page'))),
                    ),
                  ),
                  child: const Text('push'),
                ),
                TextButton(
                  onPressed: () => showAppSheet<void>(context, builder: (_) => const Text('sheet')),
                  child: const Text('open'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    NavigatorState navigator() => tester.state<NavigatorState>(find.byType(Navigator).first);

    // On: both take their time.
    await tester.tap(find.text('push'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(tester.getCenter(find.text('page')).dx, greaterThan(195));
    await tester.pumpAndSettle();
    navigator().pop();
    await tester.pump();
    expect(find.text('page'), findsOneWidget, reason: 'still on its way out');
    await tester.pumpAndSettle();
    await tester.tap(find.text('open'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    final rising = tester.getTopLeft(find.text('sheet')).dy;
    await tester.pumpAndSettle();
    final resting = tester.getTopLeft(find.text('sheet')).dy;
    expect(rising, greaterThan(resting));
    navigator().pop();
    await tester.pumpAndSettle();

    // Off, the switch from the settings page: the first frame is the last one.
    await c.read(performancePrefsProvider.notifier).setAnimations(false);
    await tester.pumpAndSettle();
    expect(AppMotion.reduced(tester.element(find.text('push'))), isTrue);
    await tester.tap(find.text('push'));
    await tester.pump();
    expect(tester.getCenter(find.text('page')).dx, 195);
    navigator().pop();
    await tester.pump();
    expect(find.text('page'), findsNothing);
    await tester.pumpAndSettle();
    await tester.tap(find.text('open'));
    await tester.pump();
    expect(tester.getTopLeft(find.text('sheet')).dy, resting);
    navigator().pop();
    await tester.pump();
    expect(find.text('sheet'), findsNothing);
  });

  for (final brightness in Brightness.values) {
    for (final language in [AppLanguage.zh, AppLanguage.en]) {
      for (final scale in [1.0, 2.0]) {
        testWidgets('performance choices fit 320dp ${brightness.name} ${language.name} at ${scale}x', (tester) async {
          window(tester, width: 320, height: 1400, brightness: brightness, scale: scale);
          final c = await mount(tester, const PerformancePage(), language: language);
          await tester.pumpAndSettle();
          final widths = <double>[];
          for (final mode in PerformanceMode.values) {
            final row = find.byKey(ValueKey('performance-mode-${mode.name}'));
            await tester.ensureVisible(row);
            await tester.pumpAndSettle();
            final rect = tester.getRect(row);
            expect(rect.height, greaterThanOrEqualTo(48));
            expect(rect.left, closeTo(16, 0.01));
            expect(320 - rect.right, closeTo(16, 0.01));
            widths.add(rect.width);
            await tester.tap(row);
            await tester.pumpAndSettle();
            expect(c.read(performancePrefsProvider).mode, mode);
            expect(tester.takeException(), isNull);
          }
          expect(widths.toSet(), hasLength(1));
          final blur = find.byKey(const ValueKey('performance-blur'));
          await tester.ensureVisible(blur);
          await tester.tap(blur);
          await tester.pumpAndSettle();
          expect(c.read(performancePrefsProvider).blur, isTrue);
          final reset = find.byKey(const ValueKey('performance-reset-effects'));
          await tester.ensureVisible(reset);
          await tester.tap(reset);
          await tester.pumpAndSettle();
          expect(c.read(performancePrefsProvider).blur, isNull);
          expect(tester.takeException(), isNull);
        });
      }
    }
  }

  group('fluid motion', () {
    bool scoped(WidgetTester tester) => tester.widget<AppMotionScope>(find.byType(AppMotionScope)).fluid;

    testWidgets('reaches the whole app, and the switch turns it off', (tester) async {
      window(tester);
      final c = await mount(tester, const PerformancePage());
      await tester.pumpAndSettle();
      expect(scoped(tester), isTrue);
      expect(FrameClock.instance.enabled, isTrue);
      final fluid = find.byKey(const ValueKey('performance-fluid'));
      await tester.ensureVisible(fluid);
      await tester.tap(fluid);
      await tester.pumpAndSettle();
      expect(c.read(performancePrefsProvider).fluid, isFalse);
      expect(scoped(tester), isFalse);
      expect(FrameClock.instance.enabled, isFalse);
      expect(Theme.of(tester.element(fluid)).splashFactory, isNot(AppInkGlow.splashFactory));
    });

    testWidgets('with animations off in the system there is no switch to offer', (tester) async {
      window(tester);
      tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(
        disableAnimations: true,
      );
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      await mount(tester, const PerformancePage());
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('performance-fluid')), findsNothing);
    });

    testWidgets('a low device starts without it, and its switch comes with animations', (tester) async {
      window(tester);
      final c = await mount(tester, const PerformancePage(), tier: DeviceTier.low);
      await tester.pumpAndSettle();
      expect(scoped(tester), isFalse);
      final fluid = find.byKey(const ValueKey('performance-fluid'));
      expect(fluid, findsNothing);
      // Light mode leaves animations off; asking for them brings the finer choice.
      await c.read(performancePrefsProvider.notifier).setAnimations(true);
      await c.read(performancePrefsProvider.notifier).setFluid(true);
      await tester.pumpAndSettle();
      await tester.ensureVisible(fluid);
      await tester.pumpAndSettle();
      expect(tester.widget<SettingsSwitchTile>(fluid).value, isTrue);
      expect(scoped(tester), isTrue);
      await tester.tap(fluid);
      await tester.pumpAndSettle();
      expect(c.read(performancePrefsProvider).fluid, isFalse);
      expect(scoped(tester), isFalse);
    });

    testWidgets('going back to the mode forgets the choice', (tester) async {
      window(tester);
      final c = await mount(tester, const PerformancePage());
      await tester.pumpAndSettle();
      await c.read(performancePrefsProvider.notifier).setFluid(false);
      await tester.pumpAndSettle();
      final reset = find.byKey(const ValueKey('performance-reset-effects'));
      await tester.ensureVisible(reset);
      await tester.tap(reset);
      await tester.pumpAndSettle();
      expect(c.read(performancePrefsProvider).fluid, isNull);
      expect(scoped(tester), isTrue);
    });
  });

  testWidgets('a low device recommends remote but keeps a deliberate local selection', (tester) async {
    window(tester);
    var local = 0;
    var remote = 0;
    final channel = FakePerformanceChannel(Future.value(snapshot(DeviceTier.low)));
    await mount(
      tester,
      RuntimeChoiceView(onLocal: () => local++, onRemote: () => remote++),
      channel: channel,
      overrides: [localFootprintProvider.overrideWith((ref) async => const LocalFootprint(totalMemoryMb: 8192))],
    );
    await tester.pumpAndSettle();
    expect(find.text(appL10n.performanceRemoteHint), findsOneWidget);
    await tester.tap(find.text(appL10n.commonContinue));
    expect(remote, 1);
    await tester.tap(find.byKey(const ValueKey('runtime-option-local')));
    channel.events.add(snapshot(DeviceTier.low, hot: true, sequence: 2));
    await tester.pumpAndSettle();
    await tester.tap(find.text(appL10n.commonContinue));
    expect(local, 1);
  });

  testWidgets('light native mode creates no WebView until the user selects web', (tester) async {
    window(tester);
    final platform = FakeWebViewPlatform();
    final previous = WebViewPlatform.instance;
    WebViewPlatform.instance = platform;
    if (previous != null) addTearDown(() => WebViewPlatform.instance = previous);
    SharedPreferences.setMockInitialValues({'performance.mode': 'light'});
    final c = await mount(
      tester,
      ModeHome(
        native: const Center(child: Text('native')),
        web: (_) => WebViewPage(url: Uri.parse('http://127.0.0.1:41234'), title: 'web'),
      ),
    );
    await tester.pumpAndSettle();
    expect(platform.controllers, isEmpty);
    await c.read(uiModeProvider.notifier).set(UiMode.web);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(platform.controllers, hasLength(1));
    for (var i = 0; i < 20 && platform.controller.loads.isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump();
    }
    expect(platform.controller.loads, hasLength(1));
    platform.controller.finish();
    await tester.pumpAndSettle();
    await c.read(uiModeProvider.notifier).set(UiMode.native);
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 30));
    expect(platform.controllers, hasLength(1), reason: 'No hidden replacement/prewarm is created');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a real looping sprite becomes still in light mode and resumes in full', (tester) async {
    window(tester);
    const anim = PetAnimation(
      name: 'idle',
      sheet: 'fixture.png',
      frameWidth: 8,
      frameHeight: 8,
      cols: 2,
      box: Rect.fromLTWH(0, 0, 8, 8),
      frames: [PetFrame(0, 100), PetFrame(1, 100)],
    );
    const pack = PetPack(
      id: 'a4-fixture',
      name: 'Fixture',
      canvas: Size(8, 8),
      anchorX: 4,
      baseline: 8,
      contentBox: Rect.fromLTWH(0, 0, 8, 8),
      animations: {'idle': anim},
      states: {
        'idle': ['idle'],
      },
    );
    PetSheets.enabled = true;
    addTearDown(() {
      PetSheets.instance.clear();
      PetSheets.enabled = false;
    });
    await tester.runAsync(() async {
      final loaded = await PetSheets.instance.load(pack, anim, _SheetBundle(await png(16, 8)));
      loaded.dispose();
    });
    final c = await mount(
      tester,
      const Center(
        child: PetSprite(pack: pack, anim: anim, scale: 4),
      ),
    );
    await tester.pump(const Duration(milliseconds: 110));
    PetSpriteState sprite() => tester.state(find.byType(PetSprite));
    expect(sprite().frame, 1);
    await c.read(performancePrefsProvider.notifier).setMode(PerformanceMode.light);
    await tester.pump();
    expect(sprite().frame, 0);
    await tester.pump(const Duration(seconds: 5));
    expect(sprite().frame, 0);
    expect(tester.binding.hasScheduledFrame, isFalse);
    await c.read(performancePrefsProvider.notifier).setMode(PerformanceMode.full);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 110));
    expect(sprite().frame, 1);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('inline plugin avatars retain cover detail at their physical display size', (tester) async {
    window(tester);
    final bytes = (await tester.runAsync(() => png(1024, 512)))!.buffer.asUint8List();
    await mount(
      tester,
      Center(
        child: PluginAvatar(name: 'fixture', size: 40, icon: 'data:image/png;base64,${base64Encode(bytes)}'),
      ),
    );
    await tester.pump();
    final image = tester.widget<Image>(find.descendant(of: find.byType(PluginAvatar), matching: find.byType(Image)));
    await tester.runAsync(() async {
      final complete = Completer<ImageInfo>();
      final stream = image.image.resolve(ImageConfiguration.empty);
      final listener = ImageStreamListener((info, _) => complete.complete(info), onError: complete.completeError);
      stream.addListener(listener);
      final info = await complete.future;
      stream.removeListener(listener);
      expect(info.image.width, 160);
      expect(info.image.height, 80);
      info.dispose();
    });
  });

  testWidgets('display decode preserves aspect and enough pixels for the visible cover crop', (tester) async {
    await tester.runAsync(() async {
      final bytes = (await png(1024, 512)).buffer.asUint8List();
      final provider = imageForDisplay(MemoryImage(bytes), width: 32, height: 32, pixelRatio: 3);
      final complete = Completer<ImageInfo>();
      final stream = provider.resolve(ImageConfiguration.empty);
      final listener = ImageStreamListener((info, _) => complete.complete(info), onError: complete.completeError);
      stream.addListener(listener);
      final info = await complete.future;
      stream.removeListener(listener);
      expect(info.image.width, 192);
      expect(info.image.height, 96);
      info.dispose();
      await provider.evict();
    });
  });
}
