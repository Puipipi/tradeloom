// A phone for the system-permission pages: readings set by the test, and
// trips to system settings that come back with whatever the test says the
// person did there. And the local engine as the native side keeps it, for
// what first run's end turns on.

import 'dart:async';

import 'package:dsh_app/phone/phone_channel.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/access_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../shell/golden_harness.dart';

/// Every item off, on a phone that reports them all.
const offPhone = AccessReadings(
  vendor: 'vivo',
  appLabel: 'DSH Go',
  mic: false,
  storage: false,
  notifications: false,
  battery: false,
  accessibility: false,
  overlay: false,
  restricted: RestrictedSettingsState.clear,
  sdk: 34,
  manufacturer: 'vivo',
  sideloaded: true,
  metered: false,
);

AccessReadings readingsWith(
  AccessReadings r, {
  String? vendor,
  bool clearVendor = false,
  bool? mic,
  bool? storage,
  bool? notifications,
  bool? battery,
  bool? accessibility,
  bool? overlay,
  RestrictedSettingsState? restricted,
  bool clearRestricted = false,
  String? manufacturer,
  bool? metered,
}) => AccessReadings(
  vendor: clearVendor ? null : (vendor ?? r.vendor),
  appLabel: r.appLabel,
  mic: mic ?? r.mic,
  storage: storage ?? r.storage,
  notifications: notifications ?? r.notifications,
  battery: battery ?? r.battery,
  accessibility: accessibility ?? r.accessibility,
  overlay: overlay ?? r.overlay,
  overlayBlocked: r.overlayBlocked,
  restricted: clearRestricted ? null : (restricted ?? r.restricted),
  sdk: r.sdk,
  manufacturer: manufacturer ?? r.manufacturer,
  sideloaded: r.sideloaded,
  metered: metered ?? r.metered,
);

/// What the person does in system settings for an item: the readings after.
typedef Answer = AccessReadings Function(AccessItem item, AccessReadings now);

class FakeAccessDriver implements AccessDriver {
  FakeAccessDriver(this.readings, {this.answer});

  AccessReadings readings;
  Answer? answer;

  /// `mic`, `notifications+` (again), `appInfo`, in order.
  final opened = <String>[];
  int reads = 0;

  @override
  Future<AccessReadings> read() async {
    reads++;
    return readings;
  }

  @override
  Future<bool> open(AccessItem item, {bool again = false}) async {
    opened.add(again ? '${item.name}+' : item.name);
    if (answer case final answer?) readings = answer(item, readings);
    return true;
  }

  @override
  Future<bool> openAppInfo() async {
    opened.add('appInfo');
    if (answer case final answer?) readings = answer(AccessItem.accessibility, readings);
    return true;
  }
}

/// Readings that fail [failures] more times from when the test says so (the
/// phone did not answer).
class FlakyAccessDriver extends FakeAccessDriver {
  FlakyAccessDriver(super.readings, {super.answer});

  int failures = 0;

  @override
  Future<AccessReadings> read() async {
    if (failures > 0) {
      failures--;
      reads++;
      throw PlatformException(code: 'unavailable', message: 'the phone did not answer');
    }
    return super.read();
  }
}

List<Override> accessOverrides(FakeAccessDriver driver) => [accessDriverProvider.overrideWithValue(driver)];

/// The local engine as the native side keeps it: a start mounts the phone's
/// files as 访问手机文件 stood when it was asked, until the next start.
class FakeEngine extends LocalRuntimeController {
  FakeEngine(this.phase, {this.storageMounted = false});

  final RuntimePhase phase;

  /// What the engine starting or running now mounts.
  bool storageMounted;

  /// 访问手机文件 as each start was given it, in order.
  final starts = <bool>[];
  int stops = 0;

  @override
  LocalRuntimeState build() => LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: phase));

  @override
  Future<void> start() async {
    storageMounted = ref.read(settingsProvider).phoneStorage;
    starts.add(storageMounted);
    state = const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.starting));
  }

  @override
  Future<void> stop() async {
    stops++;
    state = const LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.installed));
  }
}

/// Settings whose 访问手机文件 is written once [hold] completes (at once
/// without one).
class StorageSettings extends FakeSettings {
  StorageSettings() : super(const AppSettings(loaded: true));

  Completer<void>? hold;

  @override
  Future<void> setPhoneStorage(bool value) async {
    await hold?.future;
    state = state.copyWith(phoneStorage: value);
  }
}

/// The person leaves for system settings and comes back.
Future<void> awayAndBack(WidgetTester tester) async {
  for (final state in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
    tester.binding.handleAppLifecycleStateChanged(state);
  }
  for (final state in [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
    tester.binding.handleAppLifecycleStateChanged(state);
  }
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}
