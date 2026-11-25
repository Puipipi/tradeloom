import 'dart:async';

import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/draft_store.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/state/voice_settings.dart';
import 'package:dsh_app/state/voice_state.dart';
import 'package:dsh_app/ui/chat/chat_screen.dart';
import 'package:dsh_app/ui/chat/composer.dart';
import 'package:dsh_app/ui/chat/voice/voice_bridge.dart';
import 'package:dsh_app/ui/chat/voice/voice_controller.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../plugins/support/fake_plugin_host.dart' show FakeMuxLink;
import '../remote/support/fake_relay.dart';
import 'support/composer_fakes.dart';
import 'support/harness.dart';

const _host = HostRef.relay('mac');

class _SelectedHost extends ActiveHostController {
  @override
  HostRef build() => _host;
}

class _Wire extends FakeRpcCarrier {
  _Wire() : super({'speech/catalog': (_) => readySpeechCatalog()});
  bool closed = false;

  @override
  Future<DshMuxLink> openLink(MuxOptions options) async => FakeMuxLink();

  @override
  Future<void> close() async => closed = true;
}

class _Relay extends FakeRelayBackend {
  _Relay() : super(user: sampleRelayUser);
  late RelayStateCallback stateChanged;
  final wires = <DshClient, _Wire>{};

  @override
  Future<DshClient> connectHost(RelayHost host, {RelayStateCallback? onState}) async {
    stateChanged = onState!;
    onState(RelayConnectionState.connecting, null);
    onState(RelayConnectionState.handshaking, null);
    connected.add(host.id);
    final wire = _Wire();
    final client = DshClient.withCarrier(wire);
    wires[client] = wire;
    await client.mux.start();
    return client;
  }
}

class _Bridge extends FakeVoiceBridge {
  Completer<void>? starting;

  @override
  Future<void> startRecognizer({String? language}) async {
    await super.startRecognizer(language: language);
    await starting?.future;
  }
}

class _Scene {
  _Scene(this.backend, this.link, this.bridge, this.container, this.published);
  final _Relay backend;
  final RelayHostLink link;
  final _Bridge bridge;
  final ProviderContainer container;
  final List<DshClient> published;

  DshClient get client => container.read(activeConnectionProvider).requireValue!.client;
  Composer composer(WidgetTester tester) => tester.widget<Composer>(find.byType(Composer));
  VoiceInputController voice(WidgetTester tester) => composer(tester).voice!;

  static Future<_Scene> mount(
    WidgetTester tester, {
    VoiceMode mode = VoiceMode.system,
    String? session = 'first-chat',
  }) async {
    SharedPreferences.setMockInitialValues({VoiceSettingsController.preferenceKey: mode.name});
    usePhoneView(tester);
    mockClipboard(tester);
    final backend = _Relay();
    final link = RelayHostLink(backend: backend, hostId: _host.id, resolveHost: () async => sampleRelayHosts.first);
    final bridge = _Bridge();
    final published = <DshClient>[];
    final subscription = link.clients.listen(published.add);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(milliseconds: 500));
      await subscription.cancel();
      await link.close();
    });
    final harness = ChatHarness(session: session);
    await tester.pumpWidget(
      testApp(
        const ChatScreen(),
        overrides: [
          for (final override in harness.overrides)
            if (override.origin != activeConnectionProvider) override,
          activeHostProvider.overrideWith(_SelectedHost.new),
          hostLinkProvider.overrideWith((ref, host) => link),
          hostNameProvider.overrideWith((ref, host) => 'Workstation'),
          voiceBridgeProvider.overrideWithValue(bridge),
        ],
      ),
    );
    final container = ProviderScope.containerOf(tester.element(find.byType(ChatScreen)));
    await container.read(remoteConnectionProvider(_host).future);
    await pumpFrames(tester);
    final scene = _Scene(backend, link, bridge, container, published);
    await scene.voice(tester).refresh();
    return scene;
  }

  Future<void> start(WidgetTester tester) async {
    await tester.tap(find.byIcon(AppIcons.voice));
    await tester.pump();
    await tester.pump();
    expect(voice(tester).phase, VoicePhase.listening);
  }

  Future<void> reconnect(WidgetTester tester) async {
    final before = client;
    final screen = tester.state(find.byType(ChatScreen));
    final controller = voice(tester);
    backend.stateChanged(RelayConnectionState.failed, const HostLinkError(HostLinkErrorKind.other, 'closed'));
    container.read(remoteConnectionProvider(_host).notifier).retry();
    final replacement = await container.read(remoteConnectionProvider(_host).future);
    await tester.pump();
    await tester.pump();
    expect(replacement!.client, isNot(same(before)));
    expect(client, same(replacement.client));
    expect(published, contains(same(replacement.client)));
    expect(backend.wires[before]!.closed, isTrue);
    expect(container.read(activeHostProvider), _host);
    expect(container.read(currentSessionProvider), 'first-chat');
    expect(tester.state(find.byType(ChatScreen)), same(screen));
    expect(voice(tester), same(controller));
  }
}

void main() {
  setUpAll(loadTestFonts);

  for (final mode in [VoiceMode.system, VoiceMode.auto]) {
    testWidgets('${mode.name} phone dictation keeps its draft through a real same-host client replacement', (
      tester,
    ) async {
      final scene = await _Scene.mount(tester, mode: mode);
      await scene.start(tester);
      expect(scene.voice(tester).engine, VoiceEngine.system);
      scene.bridge.emit(const VoicePartial('spoken words'));
      await tester.pump();
      expect(scene.composer(tester).controller.text, 'spoken words');
      await scene.reconnect(tester);
      expect(scene.voice(tester).phase, VoicePhase.listening);
      expect(scene.bridge.calls, isNot(contains('cancel')));
      expect(scene.composer(tester).controller.text, 'spoken words');
      scene.bridge.emit(const VoiceFinal('completed words'));
      await tester.pump();
      expect(scene.voice(tester).phase, VoicePhase.idle);
      expect(scene.composer(tester).controller.text, 'completed words');
      expect(scene.container.read(draftStoreProvider).drafts['first-chat']?.text, 'completed words');
      expect(scene.bridge.calls.where((call) => call == 'recognizer'), hasLength(1));
      expect(
        scene.backend.wires.values.expand((wire) => wire.calls).where((call) => call.$1.startsWith('speech/')),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('a stopped system recognizer can finish after the same-host reconnect', (tester) async {
    final scene = await _Scene.mount(tester);
    await scene.start(tester);
    scene.bridge.emit(const VoicePartial('partial'));
    await tester.pump();
    await scene.voice(tester).stop();
    expect(scene.voice(tester).phase, VoicePhase.transcribing);
    await scene.reconnect(tester);
    expect(scene.voice(tester).phase, VoicePhase.transcribing);
    scene.bridge.emit(const VoiceFinal('final'));
    await tester.pump();
    expect(scene.composer(tester).controller.text, 'final');
    expect(scene.bridge.calls.where((call) => call == 'stop'), hasLength(1));
    expect(scene.bridge.calls, isNot(contains('cancel')));
  });

  testWidgets('a pending system start acknowledgement survives the same-host reconnect', (tester) async {
    final scene = await _Scene.mount(tester);
    final gate = scene.bridge.starting = Completer<void>();
    final starting = scene.voice(tester).start();
    await tester.pump();
    expect(scene.voice(tester).engine, VoiceEngine.system);
    expect(scene.voice(tester).phase, VoicePhase.starting);
    await scene.reconnect(tester);
    expect(scene.voice(tester).phase, VoicePhase.starting);
    gate.complete();
    await starting;
    expect(scene.voice(tester).phase, VoicePhase.listening);
    scene.bridge.emit(const VoiceFinal('late start'));
    await tester.pump();
    expect(scene.composer(tester).controller.text, 'late start');
    expect(scene.bridge.calls, isNot(contains('cancel')));
  });

  testWidgets('a real host selection change still cancels phone dictation before late results', (tester) async {
    final scene = await _Scene.mount(tester);
    await scene.start(tester);
    scene.bridge.emit(const VoicePartial('old host'));
    await tester.pump();
    scene.container.read(activeHostProvider.notifier).select(HostRef.local);
    await pumpFrames(tester);
    expect(scene.voice(tester).phase, VoicePhase.idle);
    expect(scene.bridge.calls, contains('cancel'));
    expect(scene.container.read(currentSessionProvider), isNull);
    scene.bridge.emit(const VoiceFinal('must not enter the new host'));
    await tester.pump();
    expect(scene.composer(tester).controller.text, isEmpty);
    expect(scene.container.read(draftStoreProvider).drafts['first-chat'], isNull);
  });

  testWidgets('switching host from a new conversation cancels without a session change', (tester) async {
    final scene = await _Scene.mount(tester, session: null);
    await scene.start(tester);
    scene.bridge.emit(const VoicePartial('previous host words'));
    await tester.pump();
    expect(scene.container.read(currentSessionProvider), isNull);
    scene.container.read(activeHostProvider.notifier).select(HostRef.local);
    await pumpFrames(tester);
    expect(scene.container.read(currentSessionProvider), isNull);
    expect(scene.voice(tester).phase, VoicePhase.idle);
    expect(scene.bridge.calls, contains('cancel'));
    scene.bridge.emit(const VoiceFinal('must not enter the new host'));
    await tester.pump();
    expect(scene.composer(tester).controller.text, isEmpty);
    expect(scene.container.read(draftStoreProvider).drafts['new'], isNull);
  });

  testWidgets('a conversation switch still cancels local words owned by the previous draft', (tester) async {
    final scene = await _Scene.mount(tester);
    await scene.start(tester);
    scene.bridge.emit(const VoicePartial('old conversation'));
    await tester.pump();
    scene.container.read(currentSessionProvider.notifier).select('second-chat');
    await pumpFrames(tester);
    scene.bridge.emit(const VoiceFinal('must not enter the second draft'));
    await tester.pump();
    expect(scene.voice(tester).phase, VoicePhase.idle);
    expect(scene.composer(tester).controller.text, isEmpty);
    expect(scene.bridge.calls, contains('cancel'));
    expect(scene.container.read(draftStoreProvider).drafts['first-chat'], isNull);
  });

  testWidgets('engine recording remains attached to its original client after the same-host reconnect', (tester) async {
    final scene = await _Scene.mount(tester, mode: VoiceMode.engine);
    await scene.start(tester);
    expect(scene.voice(tester).engine, VoiceEngine.engine);
    await scene.reconnect(tester);
    expect(scene.voice(tester).phase, VoicePhase.idle);
    expect(scene.bridge.calls, contains('cancel'));
    expect(
      scene.backend.wires.values.expand((wire) => wire.calls).where((call) => call.$1 == 'speech/transcribe'),
      isEmpty,
    );
    expect(scene.composer(tester).controller.text, isEmpty);
  });

  testWidgets('a system error after reconnect cannot start engine fallback on the replacement client', (tester) async {
    final scene = await _Scene.mount(tester, mode: VoiceMode.auto);
    await scene.start(tester);
    await scene.reconnect(tester);
    scene.bridge.emit(const VoiceError(2));
    await tester.pump();
    await tester.pump();
    expect(scene.voice(tester).phase, VoicePhase.idle);
    expect(scene.bridge.calls.where((call) => call.startsWith('recorder:')), isEmpty);
    expect(
      scene.backend.wires.values.expand((wire) => wire.calls).where((call) => call.$1.startsWith('speech/')),
      isEmpty,
    );
    expect(scene.composer(tester).controller.text, isEmpty);
  });
}
