// Development entry point (DSH Remote's direct path end to end): signs in to a
// Server with email + password, connects the first online Host with 直连优先
// on (flutter_webrtc), and pushes traffic both ways through the tunnel. It
// prints `[p2p-probe] …` lines to logcat and ends with the path the tunnel
// took. Never sends prompts. Not part of any release.
//
//   tooling/build-apk.sh --debug -f x64 -t lib/dev/remote_p2p_probe_main.dart
//
// Config in `files/remote_p2p_probe.json`
// (`adb shell run-as … sh -c 'cat > files/remote_p2p_probe.json'`):
//   {"server": "http://10.0.2.2:8080", "email": "…", "password": "…"}
import 'dart:convert';
import 'dart:io';

import 'package:dsh_remote/dsh_remote.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import '../remote/relay/webrtc_peer.dart';

class _Secrets implements SecretStore {
  final _values = <String, String>{};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async => _values[key] = value;

  @override
  Future<void> delete(String key) async => _values.remove(key);
}

final _lines = ValueNotifier<List<String>>([]);

void _log(String line) {
  debugPrint('[p2p-probe] $line');
  _lines.value = [..._lines.value, line];
}

Future<void> _probe() async {
  final dir = await getApplicationSupportDirectory();
  final config = (jsonDecode(await File('${dir.path}/remote_p2p_probe.json').readAsString()) as Map)
      .cast<String, Object?>();
  final account = RemoteAccount(
    secrets: _Secrets(),
    serverUrl: config['server'],
    deviceName: 'DSH Go P2P probe',
    peerConnector: config['direct'] == false ? null : flutterPeerConnector,
    onDirectFallback: (reason) => _log('automatic fallback: $reason'),
    controlTracer: (direction, frame) {
      final type = frame['type'];
      if (type is String && (type.startsWith('signal.') || type.startsWith('transport.') || type == 'hello.ack')) {
        _log('$direction $type');
      }
    },
  );
  try {
    await account.loginWithPassword(config['email']! as String, config['password']! as String);
    final host = (await account.listHosts()).firstWhere((h) => h.online);
    _log('host ${host.name} plugin ${host.pluginVersion}');
    final started = DateTime.now();
    final client = await account.connectHost(host, timeout: const Duration(seconds: 45));
    final state = client.remoteCarrier!.state!;
    _log('connected via ${state.transport} in ${DateTime.now().difference(started).inMilliseconds} ms');
    _log('sessions: ${(await client.listSessions()).length}');
    // Phone → Host above 8 KiB (RTCH chunks, DSHF fragments above 48 KiB).
    final query = 'p2p-probe-${'x' * (120 * 1024)}';
    // The host intentionally rejects searches above 500 UTF-16 units. Receiving
    // that typed validation error proves the entire chunked JSON arrived; the
    // tunnel must remain usable for the following response and round trips.
    try {
      await client.searchSessions(query);
      throw StateError('oversized query unexpectedly accepted');
    } on DshRemoteException catch (error) {
      if (error.code != 'gateway/bad-request' || !error.message.contains('500')) rethrow;
      _log('120 KiB request reassembled; expected host validation returned');
    }
    // Host → phone: the settings schema is tens of KiB.
    final schema = jsonEncode(await client.rpc.call('settings/describe'));
    _log('settings/describe ${schema.length} bytes');
    for (var i = 0; i < 20; i++) {
      await client.listSessions();
    }
    _log('20 round trips ok; still via ${client.remoteCarrier!.state!.transport}');
    final session = client.remoteCarrier!.session!;
    final inspect = session.inspectNetwork;
    final network = inspect == null ? session.networkDiagnostics : await inspect();
    _log(
      'network ${jsonEncode({'transport': network?.transportMode?.name, 'connectDurationMs': network?.connectionDuration?.inMilliseconds, 'roundTripTimeMs': network?.roundTripTime?.inMilliseconds, 'fallbackReason': network?.fallbackReason?.name})}',
    );
    if (config['direct'] != false && network?.transportMode == null) {
      throw StateError('The actual ICE path was not observable.');
    }
    _log('ok transport=${network?.transportMode?.name ?? session.transport}');
    await client.close();
  } on Object catch (error) {
    _log('FAILED: $error');
  } finally {
    await account.close();
  }
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    MaterialApp(
      home: Scaffold(
        body: SafeArea(
          child: ValueListenableBuilder<List<String>>(
            valueListenable: _lines,
            builder: (context, lines, _) => ListView(
              padding: const EdgeInsets.all(12),
              children: [
                for (final line in lines) Text(line, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
              ],
            ),
          ),
        ),
      ),
    ),
  );
  _probe();
}
