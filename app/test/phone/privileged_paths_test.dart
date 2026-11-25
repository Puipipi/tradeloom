import 'dart:async';

import 'package:dsh_app/state/phone_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const modes = ['off', 'shizuku', 'sui', 'root', 'adb'];

Map<String, Object?> privileged({String mode = 'root', bool ready = true, bool rootSelected = true}) => {
  'v': 1,
  'mode': mode,
  'ready': ready,
  'reason': ready ? null : 'channel unavailable',
  'supportedModes': modes,
  'recommendedMode': mode,
  'grantPath': rootSelected ? 'root' : 'sui',
  'rootSelected': rootSelected,
};

PhoneStatus status({bool modern = true, String provider = 'sui'}) => PhoneStatus.fromMap({
  'enabled': true,
  'background': {
    'mode': 'off',
    'ready': false,
    'androidOk': true,
    'shizuku': {'installed': true, 'appInstalled': false, 'running': true, 'granted': true, 'provider': provider},
    if (modern) 'privileged': privileged(),
    if (modern) 'root': {'checked': true, 'available': true, 'connected': true, 'starting': false},
  },
});

class RecordingChannel extends PhoneChannel {
  RecordingChannel(this.value);
  PhoneStatus value;
  final calls = <String>[];

  @override
  Future<PhoneStatus> status() async {
    calls.add('status');
    return value;
  }

  @override
  Stream<PhoneStatus> get statusChanges => const Stream.empty();
  @override
  Future<PhonePolicies?> getPolicies() async => null;
  @override
  Future<List<PhoneLogEntry>> actionLog({int limit = 50}) async => [];
  @override
  Future<PhoneResult> prepareRoot() async {
    calls.add('prepareRoot');
    return const PhoneResult(true);
  }

  @override
  Future<PhoneResult> setPrivilegedMode(PhonePrivilegedMode mode) async {
    calls.add('mode:${mode.name}');
    return const PhoneResult(true);
  }

  @override
  Future<bool> requestPrivilegedPermission(String provider) async {
    calls.add('permission:$provider');
    return true;
  }

  @override
  Future<bool> requestShizukuPermission() async {
    calls.add('legacyPermission');
    return true;
  }

  @override
  Future<PhoneResult> grantSecureSettings() async {
    calls.add('grant');
    return const PhoneResult(true);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<void> settle() async {
    for (var i = 0; i < 20; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  ProviderContainer container(RecordingChannel channel) {
    final result = ProviderContainer(overrides: [phoneChannelProvider.overrideWithValue(channel)]);
    addTearDown(result.dispose);
    result.read(phoneProvider);
    return result;
  }

  test('old native status preserves the legacy three modes and unknown root facts', () {
    final s = PhoneBackgroundStatus.fromMap({'mode': 'adb', 'ready': true, 'androidOk': true});
    expect(s.privileged, isNull);
    expect(s.effectiveMode, PhonePrivilegedMode.adb);
    expect(s.effectiveReady, isTrue);
    expect(s.supportedModes, [PhonePrivilegedMode.off, PhonePrivilegedMode.shizuku, PhonePrivilegedMode.adb]);
    expect(s.root.checked, isFalse);
    expect(s.root.available, isNull);
    expect(s.shizuku.provider, isNull);
    expect(s.shizuku.appInstalled, isNull);
  });

  test('Sui has a compatible Shizuku projection and a separate actual source', () {
    final s = PhoneBackgroundStatus.fromMap({
      'mode': 'shizuku',
      'ready': true,
      'shizuku': {'installed': true, 'running': true, 'granted': true, 'provider': 'sui', 'appInstalled': false},
      'privileged': privileged(mode: 'sui', rootSelected: false),
    });
    expect(s.mode, PhoneBackgroundMode.shizuku);
    expect(s.ready, isTrue);
    expect(s.effectiveMode, PhonePrivilegedMode.sui);
    expect(s.effectiveReady, isTrue);
    expect(s.shizuku.provider, 'sui');
    expect(s.shizuku.appInstalled, isFalse);
    expect(s.privileged!.grantPath, 'sui');
  });

  test('root never exposes legacy off with ready true', () {
    final s = status().background;
    expect(s.mode, PhoneBackgroundMode.off);
    expect(s.ready, isFalse);
    expect(s.effectiveMode, PhonePrivilegedMode.root);
    expect(s.effectiveReady, isTrue);
    expect(s.root.checked && s.root.connected, isTrue);
    expect(s.privileged!.rootSelected, isTrue);
  });

  test('all five modern choices and their reasons parse', () {
    for (final mode in modes) {
      final s = PhoneBackgroundStatus.fromMap({'privileged': privileged(mode: mode, ready: mode != 'off')});
      expect(s.effectiveMode.name, mode);
      expect(s.effectiveReady, mode != 'off');
      expect(s.supportedModes.map((m) => m.name), modes);
    }
    final failed = PhoneBackgroundStatus.fromMap({'privileged': privileged(ready: false)});
    expect(failed.effectiveReady, isFalse);
    expect(failed.effectiveReason, 'channel unavailable');
  });

  test('unknown or malformed versions cannot advertise root capabilities', () {
    for (final version in [null, false, '1', 1.0, 2]) {
      final s = PhoneBackgroundStatus.fromMap({
        'mode': 'adb',
        'ready': true,
        'privileged': {...privileged(), 'v': version},
      });
      expect(s.privileged, isNull);
      expect(s.effectiveMode, PhonePrivilegedMode.adb);
      expect(s.supportedModes, isNot(contains(PhonePrivilegedMode.root)));
    }
  });

  test('unknown mode and unadvertised readiness cannot become an active channel', () {
    final unknown = PhonePrivilegedStatus.parse({...privileged(), 'mode': 'future', 'grantPath': 'future'})!;
    expect(unknown.mode, PhonePrivilegedMode.off);
    expect(unknown.ready, isFalse);
    expect(unknown.grantPath, 'setup');
    final missingCaps = PhonePrivilegedStatus.parse({...privileged(), 'supportedModes': false})!;
    expect(missingCaps.ready, isFalse);
    expect(missingCaps.supportedModes, isEmpty);
    expect(missingCaps.recommendedMode, PhonePrivilegedMode.off);
  });

  test('wrong field types stay inert and unknown option names are ignored', () {
    final s = PhoneBackgroundStatus.fromMap({
      'root': {'checked': 'true', 'available': 1, 'connected': 1, 'starting': 'true'},
      'shizuku': {'provider': 23, 'appInstalled': 'false'},
      'privileged': {
        ...privileged(),
        'supportedModes': ['off', 'future', 5, 'adb', 'adb'],
      },
    });
    expect(s.root.checked || s.root.connected || s.root.starting, isFalse);
    expect(s.root.available, isNull);
    expect(s.shizuku.provider, isNull);
    expect(s.shizuku.appInstalled, isNull);
    expect(s.supportedModes, [PhonePrivilegedMode.off, PhonePrivilegedMode.adb]);
    expect(s.effectiveReady, isFalse);
  });

  test('controller loading and refresh never prepare root or request permission', () async {
    final native = RecordingChannel(status());
    final c = container(native);
    await settle();
    await c.read(phoneProvider.notifier).refreshStatus();
    await settle();
    expect(native.calls.where((call) => call != 'status'), isEmpty);
  });

  test('old native capabilities block new user actions before any channel call', () async {
    final native = RecordingChannel(status(modern: false));
    final c = container(native);
    await settle();
    final controller = c.read(phoneProvider.notifier);
    expect((await controller.prepareRoot()).ok, isFalse);
    expect((await controller.setPrivilegedMode(PhonePrivilegedMode.root)).ok, isFalse);
    expect((await controller.setPrivilegedMode(PhonePrivilegedMode.sui)).ok, isFalse);
    expect(await controller.requestPrivilegedPermission(PhonePrivilegedMode.sui), isFalse);
    expect(native.calls.where((call) => call != 'status'), isEmpty);
    expect((await controller.setPrivilegedMode(PhonePrivilegedMode.off)).ok, isTrue);
    expect(native.calls, contains('mode:off'));
  });

  test('explicit root actions run once and then only refresh cached status', () async {
    final native = RecordingChannel(status());
    final c = container(native);
    await settle();
    final controller = c.read(phoneProvider.notifier);
    expect((await controller.prepareRoot()).ok, isTrue);
    expect((await controller.setPrivilegedMode(PhonePrivilegedMode.root)).ok, isTrue);
    expect((await controller.grantSecureSettings()).ok, isTrue);
    await controller.refreshStatus();
    expect(native.calls.where((call) => call != 'status'), ['prepareRoot', 'mode:root', 'grant']);
  });

  test('legacy Shizuku choice asks the actual Sui provider when it owns the API', () async {
    final native = RecordingChannel(status(provider: 'sui'));
    final c = container(native);
    await settle();
    final controller = c.read(phoneProvider.notifier);
    expect(await controller.requestPrivilegedPermission(PhonePrivilegedMode.shizuku), isTrue);
    expect(native.calls, contains('permission:sui'));
    expect(native.calls, isNot(contains('permission:shizuku')));
    expect(await controller.requestPrivilegedPermission(PhonePrivilegedMode.root), isFalse);
  });

  test('new method arguments use only the agreed native actions', () async {
    final calls = <MethodCall>[];
    const methods = MethodChannel('dsh/phone');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(methods, (call) async {
      calls.add(call);
      return call.method == 'requestShizukuPermission' ? true : {'ok': true};
    });
    addTearDown(() => messenger.setMockMethodCallHandler(methods, null));
    final channel = PhoneChannel();
    expect((await channel.prepareRoot()).ok, isTrue);
    expect((await channel.setPrivilegedMode(PhonePrivilegedMode.root)).ok, isTrue);
    expect(await channel.requestPrivilegedPermission('sui'), isTrue);
    expect(calls.map((call) => call.method), ['prepareRoot', 'setBackgroundMode', 'requestShizukuPermission']);
    expect(calls[1].arguments, {'mode': 'root'});
    expect(calls[2].arguments, {'provider': 'sui'});
  });

  test('missing native methods fail normally instead of throwing', () async {
    const methods = MethodChannel('dsh/phone');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(methods, (_) async => throw MissingPluginException());
    addTearDown(() => messenger.setMockMethodCallHandler(methods, null));
    final channel = PhoneChannel();
    expect((await channel.prepareRoot()).ok, isFalse);
    expect((await channel.setPrivilegedMode(PhonePrivilegedMode.root)).ok, isFalse);
    expect(await channel.requestPrivilegedPermission('sui'), isFalse);
  });
}
