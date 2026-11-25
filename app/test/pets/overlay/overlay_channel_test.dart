// The Dart side of the floating pet: what goes over `dsh/pet_overlay`, how the
// status reads, and the switch's permission flow (docs/design/pets.md §6.4).

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:dsh_app/pets/overlay_channel.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_overlay_native.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('PetOverlayChannel', () {
    test('push sends the PetState map as interface.md has it', () async {
      final native = FakeOverlayNative()..install();
      final state = PetState(
        state: PetStateName.working,
        tier: 2,
        target: const PetTarget(HostRef.local, 's1'),
        bubble: PetBubble(
          id: 'b1',
          kind: PetBubbleKind.done,
          target: const PetTarget(HostRef.local, 's1'),
          until: DateTime.fromMillisecondsSinceEpoch(1729850000000),
          title: '修复登录',
        ),
        active: true,
        foreground: false,
        packId: 'deepy-whale',
        size: PetSize.large,
        quiet: false,
        reduceMotion: true,
      );
      await PetOverlayChannel().push(state);
      expect(native.methods, ['push']);
      final args = native.calls.single.arguments as Map;
      expect(args['state'], 'working');
      expect(args['tier'], 2);
      expect(args['packId'], 'deepy-whale');
      expect(args['size'], 'large');
      expect(args['active'], isTrue);
      expect(args['reduceMotion'], isTrue);
      expect((args['target'] as Map)['sessionId'], 's1');
      final bubble = args['bubble'] as Map;
      expect(bubble['text'], '修复登录 · 做完了');
      expect(bubble['untilMs'], 1729850000000);
      expect(bubble['host'], HostRef.local.encode());
    });

    test('native action calls share the status channel and receive their result', () async {
      final channel = PetOverlayChannel();
      channel.setActionHandler((call) async => {'received': call.method, 'text': (call.arguments as Map)['text']});
      final response = Completer<Object?>();
      await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.handlePlatformMessage(
        channel.channel.name,
        channel.channel.codec.encodeMethodCall(const MethodCall('ask', {'text': 'draft'})),
        (data) => response.complete(channel.channel.codec.decodeEnvelope(data!)),
      );
      expect(await response.future, {'received': 'ask', 'text': 'draft'});
      channel.setActionHandler(null);
    });

    test('a brought pet whose files changed: the overlay is told to read it again', () async {
      final native = FakeOverlayNative()..install();
      await PetOverlayChannel().reloadPack('user-cat');
      expect(native.methods, ['reloadPack']);
      expect(native.calls.single.arguments, {'id': 'user-cat'});
    });

    test('reads the status map', () async {
      FakeOverlayNative(permission: 'blocked', enabled: true, alwaysShow: true, snoozed: true, sdk: 34).install();
      final s = await PetOverlayChannel().status();
      expect(s.native, isTrue);
      expect(s.enabled, isTrue);
      expect(s.alwaysShow, isTrue);
      expect(s.permission, PetOverlayPermission.blocked);
      expect(s.permission.usable, isFalse);
      expect(s.working, isFalse);
      expect(s.snoozed, isTrue);
      expect(s.sdk, 34);
      expect(s.manufacturer, 'vivo');
      expect(PetOverlayPermission.fromName('accessibility').usable, isTrue);
      expect(PetOverlayPermission.fromName('granted').usable, isTrue);
      expect(PetOverlayPermission.fromName('nonsense'), PetOverlayPermission.denied);
    });

    test('companion setup and clear require a native acknowledgement', () async {
      final native = FakeOverlayNative(permission: 'granted')..install();
      final channel = PetOverlayChannel();
      final page = Uri.parse('http://127.0.0.1:4321/${List.filled(32, 'a').join()}/app/index.html?mode=float');
      expect((await channel.configureCompanion(page: page, notice: '她没能出来')).native, isTrue);
      expect(native.calls.last.arguments, {'url': page.toString(), 'notice': '她没能出来'});
      await channel.configureCompanion();
      expect(native.calls.last.arguments, {'url': null, 'notice': null});
      removeOverlayNative();
      await expectLater(channel.configureCompanion(page: page, notice: '她没能出来'),
          throwsA(isA<MissingPluginException>()));
    });

    test('old status defaults to pixel and renderer problems survive controller copies', () {
      final old = PetOverlayStatus.fromMap({});
      expect(old.companionRendering, isFalse);
      expect(old.companionFallback, isFalse);
      expect(old.companionProblem, isNull);
      final fallback = PetOverlayStatus.fromMap({'companionFallback': true,
        'companionRendering': false, 'companionProblem': 'companion_context_lost'});
      final copied = fallback.copyWith(refused: true);
      expect(copied.companionFallback, isTrue);
      expect(copied.companionProblem, 'companion_context_lost');
      expect(copied, isNot(old));
    });

    test('without the native side nothing throws and nothing is offered', () async {
      removeOverlayNative();
      final channel = PetOverlayChannel();
      await channel.push(const PetState());
      await channel.reloadPack('user-cat');
      expect((await channel.status()).native, isFalse);
      expect((await channel.setEnabled(true)).native, isFalse);
      expect(await channel.requestPermission(), isFalse);
      expect(await channel.openAppDetails(), isFalse);
    });

    test('native status events and 宠物设置 requests reach Dart', () async {
      final native = FakeOverlayNative(permission: 'granted')..install();
      final channel = PetOverlayChannel();
      final statuses = <PetOverlayStatus>[];
      var settings = 0;
      final a = channel.statusChanges.listen(statuses.add);
      final b = channel.settingsRequests.listen((_) => settings++);
      native.snoozed = true;
      await native.emitStatus();
      await native.emitOpenSettings();
      await pumpEventQueue();
      expect(statuses.single.snoozed, isTrue);
      expect(settings, 1);
      await a.cancel();
      await b.cancel();
    });
  });

  group('PetOverlayController', () {
    Future<(ProviderContainer, PetOverlayController)> controller(FakeOverlayNative native) async {
      native.install();
      final c = ProviderContainer();
      addTearDown(c.dispose);
      c.listen(petOverlayProvider, (_, _) {});
      await pumpEventQueue();
      return (c, c.read(petOverlayProvider.notifier));
    }

    test('turning on with the permission just turns on', () async {
      final native = FakeOverlayNative(permission: 'granted');
      final (c, overlay) = await controller(native);
      await overlay.turnOn();
      expect(c.read(petOverlayProvider).working, isTrue);
      expect(native.methods, isNot(contains('requestPermission')));
    });

    test('the accessibility overlay needs no permission', () async {
      final native = FakeOverlayNative(permission: 'accessibility');
      final (c, overlay) = await controller(native);
      await overlay.turnOn();
      expect(c.read(petOverlayProvider).working, isTrue);
      expect(native.methods, isNot(contains('requestPermission')));
    });

    test('without it: to system settings, back off and 「未授权」 if refused', () async {
      final native = FakeOverlayNative();
      final (c, overlay) = await controller(native);
      await overlay.turnOn();
      expect(native.methods, containsAllInOrder(['setEnabled', 'permissionStatus', 'requestPermission']));
      // Back from settings, still denied: the switch goes back off and the row says 未授权.
      await overlay.refresh();
      final s = c.read(petOverlayProvider);
      expect(s.enabled, isFalse);
      expect(s.refused, isTrue);
      expect(native.enabled, isFalse);
      // Granted on the next try.
      await overlay.turnOn();
      native.permission = 'granted';
      await overlay.refresh();
      expect(c.read(petOverlayProvider).working, isTrue);
      expect(c.read(petOverlayProvider).refused, isFalse);
    });

    test('vivo-style block goes to the app page, not the system list', () async {
      final native = FakeOverlayNative(permission: 'blocked');
      final (_, overlay) = await controller(native);
      await overlay.turnOn();
      expect(native.methods, contains('openAppDetails'));
      expect(native.methods, isNot(contains('requestPermission')));
    });

    test('settings that cannot open count as refused', () async {
      final native = FakeOverlayNative(opens: false);
      final (c, overlay) = await controller(native);
      await overlay.turnOn();
      expect(c.read(petOverlayProvider).enabled, isFalse);
      expect(c.read(petOverlayProvider).refused, isTrue);
    });

    test('一直显示 and 恢复 go through', () async {
      final native = FakeOverlayNative(permission: 'granted', enabled: true, snoozed: true);
      final (c, overlay) = await controller(native);
      await overlay.setAlwaysShow(true);
      expect(c.read(petOverlayProvider).alwaysShow, isTrue);
      await overlay.unsnooze();
      expect(c.read(petOverlayProvider).snoozed, isFalse);
    });

    test('native changes land in the provider', () async {
      final native = FakeOverlayNative(permission: 'granted', enabled: true);
      final (c, _) = await controller(native);
      native.snoozed = true;
      await native.emitStatus();
      await pumpEventQueue();
      expect(c.read(petOverlayProvider).snoozed, isTrue);
    });
  });
}
