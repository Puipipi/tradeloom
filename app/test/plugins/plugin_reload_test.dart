import 'dart:async';

import 'package:dsh_app/plugins/native/native_model.dart';
import 'package:dsh_app/plugins/native/native_state.dart';
import 'package:dsh_app/plugins/native/native_surface.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/plugin_reload.dart';
import 'package:dsh_app/state/plugins_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../safe_mode/support.dart' show RecordingRuntime;
import 'native/support.dart' show FakeBridge, contributions, plugin;
import 'support/fake_plugin_host.dart';

PluginBundle _bundle({bool enabled = true, String source = 'file:../example', String? readOnlyReason}) =>
    PluginBundle(name: 'example', installed: true, enabled: enabled, source: source, readOnlyReason: readOnlyReason);

const _running = LocalRuntimeState(loaded: true, status: RuntimeStatus(phase: RuntimePhase.running));

class _Active extends ActiveHostController {
  @override
  HostRef build() => HostRef.local;
  void use(HostRef next) => state = next;
}

class _Bundles extends InstalledPluginsController {
  _Bundles(this.initial);
  final List<PluginBundle> initial;
  @override
  Future<List<PluginBundle>?> build() async => initial;
  void use(List<PluginBundle> next) => state = AsyncData(next);
}

class _Host extends Notifier<PluginHost?> {
  _Host(this.initial);
  final PluginHost? initial;
  @override
  PluginHost? build() => initial;
  void use(PluginHost? next) => state = next;
}

final _host = NotifierProvider<_Host, PluginHost?>(() => _Host(null));

class _Runtime extends RecordingRuntime {
  _Runtime() : super(_running);
  bool fail = false;
  final calls = <String>[];
  @override
  Future<void> stop() {
    calls.add('stop');
    return super.stop();
  }

  @override
  Future<void> start() async {
    calls.add('start');
    if (fail) throw StateError('restart failed');
    return super.start();
  }
}

Future<({ProviderContainer container, _Runtime runtime, FakePluginCarrier carrier})> _fixture({
  List<Override> extra = const [],
}) async {
  final carrier = FakePluginCarrier();
  final client = DshClient.withCarrier(carrier);
  final runtime = _Runtime();
  final container = ProviderContainer(
    overrides: [
      activeHostProvider.overrideWith(_Active.new),
      _host.overrideWith(() => _Host(PluginHost(client: client, label: 'Local', kind: HostKind.local))),
      pluginHostProvider.overrideWith((ref) => ref.watch(_host)),
      installedPluginsProvider.overrideWith(() => _Bundles([_bundle()])),
      localRuntimeProvider.overrideWith(() => runtime),
      ...extra,
    ],
  );
  addTearDown(container.dispose);
  addTearDown(client.close);
  await container.read(installedPluginsProvider.future);
  return (container: container, runtime: runtime, carrier: carrier);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final source in [
    'file:../example',
    'link:./example',
    '/root/plugins/example',
    './example',
    '../example',
    '~/example',
    'file:///root/example',
  ]) {
    test('recognizes local directory source $source', () => expect(isLocalPluginSource(source), isTrue));
  }
  for (final source in <String?>[
    null,
    '',
    'example',
    'latest',
    '^1.0.0',
    'npm:example@1',
    'https://host/example',
    'git+https://host/example',
    'file:',
    'link:',
    'file:https://host/example',
    'file://server/example',
    '/tmp/example.tgz',
    'file:../example.tar.gz',
  ]) {
    test('does not offer source reload for $source', () => expect(isLocalPluginSource(source), isFalse));
  }

  test('confirmation precedes the existing stop-then-start flow', () async {
    final f = await _fixture();
    final controller = f.container.read(localPluginReloadProvider.notifier);
    var asked = false;
    final result = await controller.reload(
      _bundle(),
      confirm: () async {
        asked = true;
        expect(f.runtime.calls, isEmpty);
        return true;
      },
    );
    expect(asked, isTrue);
    expect(result, PluginReloadResult.requested);
    expect(f.runtime.calls, ['stop', 'start']);
    expect(f.carrier.calls, isEmpty, reason: 'no invented HMR or enable/disable RPC');
    expect(f.container.read(localPluginReloadProvider), isFalse);
  });

  test('one shared busy guard includes confirmation and cancellation releases it', () async {
    final f = await _fixture();
    final controller = f.container.read(localPluginReloadProvider.notifier);
    final confirm = Completer<bool>();
    final first = controller.reload(_bundle(), confirm: () => confirm.future);
    expect(f.container.read(localPluginReloadProvider), isTrue);
    final second = await controller.reload(_bundle(), confirm: () => throw StateError('must not ask twice'));
    expect(second, PluginReloadResult.busy);
    confirm.complete(false);
    expect(await first, PluginReloadResult.cancelled);
    expect(f.runtime.calls, isEmpty);
    expect(f.container.read(localPluginReloadProvider), isFalse);
  });

  for (final changed in ['host', 'connection', 'removed', 'disabled', 'source', 'read-only', 'safe mode', 'stopping']) {
    test('rechecks $changed after confirmation without restarting another context', () async {
      final f = await _fixture();
      final controller = f.container.read(localPluginReloadProvider.notifier);
      final confirm = Completer<bool>();
      final pending = controller.reload(_bundle(), confirm: () => confirm.future);
      final bundles = f.container.read(installedPluginsProvider.notifier) as _Bundles;
      switch (changed) {
        case 'host':
          (f.container.read(activeHostProvider.notifier) as _Active).use(const HostRef.ssh('other'));
        case 'connection':
          final other = DshClient.withCarrier(FakePluginCarrier());
          addTearDown(other.close);
          f.container.read(_host.notifier).use(PluginHost(client: other, label: 'Local again', kind: HostKind.local));
        case 'removed':
          bundles.use([]);
        case 'disabled':
          bundles.use([_bundle(enabled: false)]);
        case 'source':
          bundles.use([_bundle(source: 'file:../changed')]);
        case 'read-only':
          bundles.use([_bundle(readOnlyReason: 'management-required')]);
        case 'safe mode':
          f.runtime.emit(
            const LocalRuntimeState(
              status: RuntimeStatus(phase: RuntimePhase.running, mode: EngineMode.safe),
            ),
          );
        case 'stopping':
          f.runtime.emit(const LocalRuntimeState(status: RuntimeStatus(phase: RuntimePhase.stopping)));
      }
      confirm.complete(true);
      expect(await pending, PluginReloadResult.unavailable);
      expect(f.runtime.calls, isEmpty);
      expect(f.container.read(localPluginReloadProvider), isFalse);
    });
  }

  test('ineligible state does not open a confirmation', () async {
    final f = await _fixture();
    (f.container.read(activeHostProvider.notifier) as _Active).use(const HostRef.relay('remote'));
    final result = await f.container
        .read(localPluginReloadProvider.notifier)
        .reload(_bundle(), confirm: () => throw StateError('must not ask for an unavailable action'));
    expect(result, PluginReloadResult.unavailable);
    expect(f.runtime.calls, isEmpty);
  });

  test('a restart failure releases the busy guard and propagates to the UI', () async {
    final f = await _fixture();
    f.runtime.fail = true;
    await expectLater(
      f.container.read(localPluginReloadProvider.notifier).reload(_bundle(), confirm: () async => true),
      throwsStateError,
    );
    expect(f.container.read(localPluginReloadProvider), isFalse);
    expect(f.runtime.calls, ['stop', 'start']);
  });

  test('a full restart refreshes an open view even when declarations stay available', () async {
    final bridge = FakeBridge(
      contributions([
        plugin(
          'example',
          panels: [
            {'id': 'panel', 'title': 'Panel'},
          ],
        ),
      ]),
    );
    DshGoView view(String text) =>
        DshGoView(pkg: 'example', id: 'panel', rev: text, view: {'type': 'text', 'text': text}, bytes: 40, live: false);
    bridge.views['example/panel'] = view('Before');
    final f = await _fixture(extra: [nativeBridgeProvider.overrideWithValue(bridge)]);
    const key = NativeSurfaceKey(package: 'example', surface: NativeSurface.panel, id: 'panel', live: false);
    final sub = f.container.listen(nativeSurfaceProvider(key), (_, _) {});
    addTearDown(sub.close);
    for (var i = 0; i < 8; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(f.container.read(nativeSurfaceProvider(key)).view, {'type': 'text', 'text': 'Before'});
    bridge.views['example/panel'] = view('After');
    await f.container.read(localPluginReloadProvider.notifier).reload(_bundle(), confirm: () async => true);
    for (var i = 0; i < 8; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(f.container.read(nativeSurfaceProvider(key)).view, {'type': 'text', 'text': 'After'});
  });
}
