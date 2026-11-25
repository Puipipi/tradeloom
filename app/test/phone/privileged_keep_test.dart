import 'dart:async';

import 'package:dsh_app/state/phone_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _modes = ['off', 'shizuku', 'sui', 'root', 'adb'];
const _methods = MethodChannel('dsh/phone');

Map<String, Object?> _wire({
  Object? keep,
  bool modern = true,
  bool ready = false,
  String mode = 'root',
}) => {
  'enabled': true,
  'background': {
    'mode': mode == 'root'
        ? 'off'
        : mode == 'sui'
        ? 'shizuku'
        : mode,
    'ready': mode == 'root' ? false : ready,
    'androidOk': true,
    if (modern)
      'privileged': {
        'v': 1,
        'mode': mode,
        'ready': ready,
        'supportedModes': _modes,
        'recommendedMode': mode,
        'rootSelected': mode == 'root',
        'keep': ?keep,
      },
  },
};

Map<String, Object?> _keep({
  bool enabled = true,
  String mode = 'root',
  String phase = 'idle',
  String? reason,
}) => {'enabled': enabled, 'mode': mode, 'phase': phase, 'reasonCode': reason};

class _EventChannel extends PhoneChannel {
  final events = StreamController<PhoneStatus>.broadcast();

  @override
  Stream<PhoneStatus> get statusChanges => events.stream;
}

class _Native {
  final channel = _EventChannel();
  Map<String, Object?> value = _wire();
  Map<String, Object?> reply = {'ok': true};
  Completer<Map<String, Object?>>? nextStatus;
  final calls = <MethodCall>[];

  Future<Object?> handle(MethodCall call) async {
    calls.add(call);
    switch (call.method) {
      case 'status':
        final pending = nextStatus;
        nextStatus = null;
        return pending == null ? value : await pending.future;
      case 'getPolicies':
        return null;
      case 'actionLog':
        return <Object?>[];
      case 'setBackgroundKeep':
        return reply;
      default:
        throw StateError('Unexpected native action: ${call.method}');
    }
  }

  Iterable<MethodCall> get actions => calls.where(
    (call) => !{'status', 'getPolicies', 'actionLog'}.contains(call.method),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  setUp(() => SharedPreferences.setMockInitialValues({}));
  tearDown(() => messenger.setMockMethodCallHandler(_methods, null));

  _Native native() {
    final result = _Native();
    messenger.setMockMethodCallHandler(_methods, result.handle);
    addTearDown(result.channel.events.close);
    return result;
  }

  ProviderContainer container(_Native native) {
    final result = ProviderContainer(
      overrides: [phoneChannelProvider.overrideWithValue(native.channel)],
    );
    addTearDown(result.dispose);
    result.read(phoneProvider);
    return result;
  }

  Future<void> settle() async {
    for (var i = 0; i < 20; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  test('legacy and v1 status without keep default to disabled without changing readiness', () {
    for (final modern in [false, true]) {
      final status = PhoneStatus.fromMap(
        _wire(modern: modern, mode: 'adb', ready: true),
      ).background;
      expect(status.keep.enabled, isFalse);
      expect(status.keep.mode, PhonePrivilegedMode.off);
      expect(status.keep.phase, PhoneKeepPhase.disabled);
      expect(status.keep.reasonCode, isNull);
      expect(status.effectiveMode, PhonePrivilegedMode.adb);
      expect(status.effectiveReady, isTrue);
    }
  });

  test(
    'all four explicit targets and six phases retain their separate wire facts',
    () {
      for (final mode in PhonePrivilegedMode.values.where(
        (mode) => mode != PhonePrivilegedMode.off,
      )) {
        for (final phase in PhoneKeepPhase.values) {
          final status = PhoneStatus.fromMap(
            _wire(
              mode: mode.name,
              keep: _keep(
                mode: mode.name,
                phase: phase.name,
                reason: 'serviceUnavailable',
              ),
            ),
          ).background;
          expect(status.keep.enabled, isTrue);
          expect(status.keep.mode, mode);
          expect(status.keep.phase, phase);
          expect(status.keep.reasonCode, 'serviceUnavailable');
          expect(status.effectiveReady, isFalse);
        }
      }
    },
  );

  test('connected transport never upgrades display readiness', () {
    final background = PhoneStatus.fromMap(
      _wire(keep: _keep(phase: 'connected')),
    ).background;
    expect(background.keep.phase, PhoneKeepPhase.connected);
    expect(background.ready, isFalse);
    expect(background.effectiveReady, isFalse);
  });

  test(
    'failed persistence remains visible when automatic restoration is disabled',
    () {
      final status = PhonePrivilegedKeepStatus.parse(
        _keep(
          enabled: false,
          mode: 'off',
          phase: 'failed',
          reason: 'persistenceFailed',
        ),
      );
      expect(status.enabled, isFalse);
      expect(status.mode, PhonePrivilegedMode.off);
      expect(status.phase, PhoneKeepPhase.failed);
      expect(status.reasonCode, 'persistenceFailed');
    },
  );

  test(
    'unknown phases wait and unknown reason codes remain available to the page',
    () {
      final status = PhonePrivilegedKeepStatus.parse(
        _keep(phase: 'futurePhase', reason: 'futureReason'),
      );
      expect(status.phase, PhoneKeepPhase.waiting);
      expect(status.reasonCode, 'futureReason');
    },
  );

  test('absent and wrong wire types do not become root keep intent', () {
    for (final raw in [null, false, 'root', <String, Object?>{}]) {
      final status = PhonePrivilegedKeepStatus.parse(raw);
      expect(status.enabled, isFalse);
      expect(status.mode, PhonePrivilegedMode.off);
      expect(status.phase, PhoneKeepPhase.disabled);
    }
    final status = PhonePrivilegedKeepStatus.parse({
      'enabled': 'true',
      'mode': 7,
      'phase': 4,
      'reasonCode': false,
    });
    expect(status.enabled, isFalse);
    expect(status.mode, PhonePrivilegedMode.off);
    expect(status.phase, PhoneKeepPhase.waiting);
    expect(status.reasonCode, isNull);
  });

  test(
    'explicit keep calls serialize only the agreed method and two arguments',
    () async {
      final n = native();
      for (final mode in PhonePrivilegedMode.values.where(
        (mode) => mode != PhonePrivilegedMode.off,
      )) {
        for (final enabled in [true, false]) {
          expect((await n.channel.setBackgroundKeep(mode, enabled)).ok, isTrue);
          expect(n.calls.last.method, 'setBackgroundKeep');
          expect(n.calls.last.arguments, {
            'mode': mode.name,
            'enabled': enabled,
          });
        }
      }
      expect(n.calls, hasLength(8));
    },
  );

  test('native refusal, old missing method and platform failure do not become success', () async {
    final n = native();
    n.reply = {
      'ok': false,
      'reasonCode': 'selectionChanged',
      'reason': 'selection changed',
    };
    final refused = await n.channel.setBackgroundKeep(
      PhonePrivilegedMode.root,
      true,
    );
    expect(refused.ok, isFalse);
    expect(refused.reason, 'selection changed');
    messenger.setMockMethodCallHandler(
      _methods,
      (_) async => throw MissingPluginException(),
    );
    expect(
      (await n.channel.setBackgroundKeep(PhonePrivilegedMode.root, true)).ok,
      isFalse,
    );
    messenger.setMockMethodCallHandler(
      _methods,
      (_) async =>
          throw PlatformException(code: 'phone_failed', message: 'save failed'),
    );
    final failed = await n.channel.setBackgroundKeep(
      PhonePrivilegedMode.root,
      false,
    );
    expect(failed.ok, isFalse);
    expect(failed.reason, 'save failed');
  });

  test('loading, refresh and keep status pushes never request permission or write a keep choice', () async {
    final n = native()..value = _wire(keep: _keep(phase: 'waiting'));
    final c = container(n);
    await settle();
    await c.read(phoneProvider.notifier).refreshStatus();
    n.channel.events.add(
      PhoneStatus.fromMap(_wire(keep: _keep(phase: 'connected'))),
    );
    await settle();
    expect(
      c.read(phoneProvider).status.background.keep.phase,
      PhoneKeepPhase.connected,
    );
    expect(c.read(phoneProvider).status.background.effectiveReady, isFalse);
    expect(n.actions, isEmpty);
  });

  test('saving keep does not optimistically claim either a saved state or a connection', () async {
    final n = native();
    final c = container(n);
    await settle();
    final pending = Completer<Map<String, Object?>>();
    n.nextStatus = pending;
    final result = await c
        .read(phoneProvider.notifier)
        .setBackgroundKeep(PhonePrivilegedMode.root, true);
    expect(result.ok, isTrue);
    expect(c.read(phoneProvider).status.background.keep.enabled, isFalse);
    expect(c.read(phoneProvider).status.background.effectiveReady, isFalse);
    expect(n.actions.map((call) => call.method), ['setBackgroundKeep']);
    expect(n.actions.single.arguments, {'mode': 'root', 'enabled': true});
    pending.complete(_wire(keep: _keep(phase: 'restoring')));
    await settle();
    expect(c.read(phoneProvider).status.background.keep.enabled, isTrue);
    expect(
      c.read(phoneProvider).status.background.keep.phase,
      PhoneKeepPhase.restoring,
    );
    expect(c.read(phoneProvider).status.background.effectiveReady, isFalse);
  });

  test('a stale page refusal never changes mode or silently prepares another channel', () async {
    final n = native()
      ..value = _wire(mode: 'sui')
      ..reply = {
        'ok': false,
        'reasonCode': 'selectionChanged',
        'reason': 'selection changed',
      };
    final c = container(n);
    await settle();
    final result = await c
        .read(phoneProvider.notifier)
        .setBackgroundKeep(PhonePrivilegedMode.root, true);
    await settle();
    expect(result.ok, isFalse);
    expect(
      c.read(phoneProvider).status.background.effectiveMode,
      PhonePrivilegedMode.sui,
    );
    expect(c.read(phoneProvider).status.background.keep.enabled, isFalse);
    expect(n.actions.map((call) => call.method), ['setBackgroundKeep']);
  });

  test('old native capabilities reject unsupported root keep before sending the method', () async {
    final n = native()..value = _wire(modern: false, mode: 'adb');
    final c = container(n);
    await settle();
    expect(
      (await c
              .read(phoneProvider.notifier)
              .setBackgroundKeep(PhonePrivilegedMode.root, true))
          .ok,
      isFalse,
    );
    expect(n.actions, isEmpty);
  });

  test(
    'turning keep off preserves the reported healthy manually selected channel',
    () async {
      final n = native()
        ..value = _wire(ready: true, keep: _keep(phase: 'connected'));
      final c = container(n);
      await settle();
      n.value = _wire(
        ready: true,
        keep: _keep(enabled: false, mode: 'off', phase: 'disabled'),
      );
      expect(
        (await c
                .read(phoneProvider.notifier)
                .setBackgroundKeep(PhonePrivilegedMode.root, false))
            .ok,
        isTrue,
      );
      await settle();
      expect(n.actions.single.arguments, {'mode': 'root', 'enabled': false});
      expect(c.read(phoneProvider).status.background.keep.enabled, isFalse);
      expect(
        c.read(phoneProvider).status.background.keep.phase,
        PhoneKeepPhase.disabled,
      );
      expect(
        c.read(phoneProvider).status.background.effectiveMode,
        PhonePrivilegedMode.root,
      );
      expect(c.read(phoneProvider).status.background.effectiveReady, isTrue);
    },
  );
}
