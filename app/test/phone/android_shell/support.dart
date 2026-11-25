import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const shellMethods = MethodChannel('dsh/phone');

Map<String, Object?> shellStatus({
  bool enabled = false,
  String backend = 'shizuku',
  bool ready = false,
  bool shizukuGranted = false,
  bool adbPaired = false,
  int? uid,
  String? reasonCode = 'disabled',
}) => {
  'v': 1,
  'enabled': enabled,
  'backend': backend,
  'ready': ready,
  'uid': uid,
  'reasonCode': reasonCode,
  'shizuku': {'installed': true, 'running': true, 'granted': shizukuGranted},
  'adb': {'paired': adbPaired, 'connected': false},
  'limits': {'defaultTimeoutMs': 10000, 'maxTimeoutMs': 30000, 'maxOutputBytes': 65536, 'maxCommandBytes': 2048},
};

class ShellNative {
  ShellNative({Map<String, Object?>? status}) : status = status ?? shellStatus();

  Map<String, Object?> status;
  final calls = <MethodCall>[];
  final replies = <String, Object?>{};
  FutureOr<Object?> Function(MethodCall call)? onCall;

  Iterable<MethodCall> callsOf(String method) => calls.where((call) => call.method == method);

  void install() {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(shellMethods, _handle);
    addTearDown(() => messenger.setMockMethodCallHandler(shellMethods, null));
  }

  Future<Object?> _handle(MethodCall call) async {
    calls.add(call);
    if (onCall != null) return onCall!(call);
    if (replies.containsKey(call.method)) return replies[call.method];
    switch (call.method) {
      case 'androidShellStatus':
        return status;
      case 'configureAndroidShell':
        final args = call.arguments as Map;
        status = {...status, 'enabled': args['enabled'], 'backend': args['backend']};
        return {'ok': true};
      case 'androidShellRequestPermission':
        return true;
      case 'androidShellPair':
        status = {
          ...status,
          'adb': {'paired': true, 'connected': false},
        };
        return {'ok': true};
      case 'androidShellStartPairing' || 'androidShellConnect':
        return {'ok': true};
      case 'androidShellStop':
        return true;
      default:
        throw MissingPluginException(call.method);
    }
  }
}
