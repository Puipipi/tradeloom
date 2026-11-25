import 'package:dsh_app/phone/android_shell_channel.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = AndroidShellChannel();

  test('status is standalone, typed and read-only', () async {
    final native = ShellNative(
      status: {
        ...shellStatus(enabled: true, backend: 'adb', ready: true, uid: 2000, reasonCode: null),
        'adb': {'paired': true, 'connected': true},
      },
    )..install();
    final status = await channel.status();
    expect(native.calls.map((call) => call.method), ['androidShellStatus']);
    expect(status.supported, isTrue);
    expect(status.enabled, isTrue);
    expect(status.backend, AndroidShellBackend.adb);
    expect(status.ready, isTrue);
    expect(status.uid, 2000);
    expect(status.reasonCode, isNull);
    expect(status.shizuku.installed, isTrue);
    expect(status.shizuku.running, isTrue);
    expect(status.shizuku.granted, isFalse);
    expect(status.adb.paired, isTrue);
    expect(status.adb.connected, isTrue);
    expect(status.limits['maxCommandBytes'], 2048);
  });

  test('absent, malformed or unknown protocols fail closed without fallback', () {
    for (final value in <Map<Object?, Object?>>[
      {},
      {...shellStatus(), 'v': 2},
      {...shellStatus(), 'v': 1.0},
      {...shellStatus(), 'backend': 'root'},
      {...shellStatus(), 'enabled': 1},
      {...shellStatus(), 'ready': 'yes'},
    ]) {
      final status = AndroidShellStatus.fromMap(value);
      expect(status.supported, isFalse);
      expect(status.enabled, isFalse);
      expect(status.ready, isFalse);
      expect(status.uid, isNull);
      expect(status.reasonCode, isNotNull);
    }
  });

  test('UID and limits are reported, never inferred or coerced', () {
    for (final uid in <Object?>[null, -1, 2000.0, '2000', true]) {
      expect(AndroidShellStatus.fromMap({...shellStatus(ready: true), 'uid': uid}).uid, isNull);
    }
    expect(AndroidShellStatus.fromMap(shellStatus(uid: 0)).uid, 0);
    final status = AndroidShellStatus.fromMap({
      ...shellStatus(),
      'limits': {'maxTimeoutMs': '30000', 'maxOutputBytes': -1, 'maxCommandBytes': 2048, 'unknown': 1},
    });
    expect(status.limits, {'maxCommandBytes': 2048});
    expect(AndroidShellStatus.fromMap({...shellStatus(), 'reasonCode': 'private input 123456'}).reasonCode, isNull);
  });

  test('explicit setup methods use their own native contract and separate ports', () async {
    final native = ShellNative()..install();
    expect((await channel.configure(enabled: false, backend: AndroidShellBackend.adb)).ok, isTrue);
    expect(await channel.requestPermission(), isTrue);
    expect((await channel.startPairing()).ok, isTrue);
    expect((await channel.pair('654321', port: 37111)).ok, isTrue);
    expect((await channel.connect(port: 42123)).ok, isTrue);
    expect((await channel.pair('123456')).ok, isTrue);
    expect((await channel.connect()).ok, isTrue);
    expect(await channel.stop(), isTrue);
    expect(native.calls.map((call) => call.method), [
      'configureAndroidShell',
      'androidShellRequestPermission',
      'androidShellStartPairing',
      'androidShellPair',
      'androidShellConnect',
      'androidShellPair',
      'androidShellConnect',
      'androidShellStop',
    ]);
    expect(native.calls[0].arguments, {'enabled': false, 'backend': 'adb'});
    expect(native.calls[3].arguments, {'code': '654321', 'port': 37111});
    expect(native.calls[4].arguments, {'port': 42123});
    expect(native.calls[5].arguments, {'code': '123456'});
    expect(native.calls[6].arguments, isEmpty);
  });

  test('invalid pairing input never reaches native', () async {
    final native = ShellNative()..install();
    for (final code in ['12345', '1234567', 'abc123', '123456\n']) {
      expect((await channel.pair(code)).errorCode, 'invalidArguments');
    }
    for (final port in [0, -1, 65536]) {
      expect((await channel.pair('123456', port: port)).ok, isFalse);
      expect((await channel.connect(port: port)).ok, isFalse);
    }
    expect(native.calls, isEmpty);
  });

  test('missing native support returns stable unavailability and false booleans', () async {
    final native = ShellNative()..install();
    native.onCall = (_) => throw MissingPluginException();
    expect((await channel.status()).reasonCode, 'nativeUnavailable');
    expect(
      (await channel.configure(enabled: true, backend: AndroidShellBackend.shizuku)).errorCode,
      'nativeUnavailable',
    );
    expect((await channel.startPairing()).errorCode, 'nativeUnavailable');
    expect((await channel.pair('123456')).errorCode, 'nativeUnavailable');
    expect((await channel.connect()).errorCode, 'nativeUnavailable');
    expect(await channel.requestPermission(), isFalse);
    expect(await channel.stop(), isFalse);
  });

  test('native errors expose stable codes, not raw reason or exception messages', () async {
    final native = ShellNative()..install();
    native.replies['androidShellPair'] = {'ok': false, 'errorCode': 'timeout', 'reason': 'code 654321'};
    expect((await channel.pair('654321')).errorCode, 'timeout');
    native.onCall = (_) => throw PlatformException(code: 'transportLost', message: 'private code 654321');
    expect((await channel.status()).reasonCode, 'transportLost');
    expect((await channel.connect()).errorCode, 'transportLost');
    expect(await channel.stop(), isFalse);
  });

  test('empty or malformed results never become success', () async {
    final native = ShellNative()..install();
    for (final reply in <Object?>[
      null,
      true,
      {},
      {'ok': 'true'},
      {'ok': false, 'errorCode': 'unsafe text'},
    ]) {
      native.replies['androidShellConnect'] = reply;
      expect((await channel.connect()).errorCode, 'invalidResponse');
    }
    native.replies['androidShellStatus'] = null;
    expect((await channel.status()).reasonCode, 'invalidResponse');
  });
}
