import 'dart:async';

import 'package:dsh_app/links/launcher_entries.dart';
import 'package:dsh_app/notify/chat_alerts.dart';
import 'package:dsh_app/pets/pet_overlay_actions.dart';
import 'package:dsh_app/pets/pet_signals.dart';
import 'package:dsh_app/pets/pet_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../notify/support.dart' show session;

class _Mux extends DshMux {
  _Mux(super.carrier);
  MuxGeneration? current = const MuxGeneration(1, 'pet-client', '/tmp');
  @override
  MuxGeneration? get generation => current;
  @override
  Stream<DshConnectionState> get states => const Stream.empty();
}

class _Client extends DshClient {
  _Client() : super(DshConnection(Uri.parse('http://127.0.0.1:9')));
  late final testMux = _Mux(carrier);
  @override
  DshMux get mux => testMux;
  final prompts = <(String, String, String?)>[];
  bool fail = false;
  bool running = false;
  @override
  Stream<DshEvent> watch(String id, {WatchOptions options = const WatchOptions()}) async* {
    yield SessionSnapshotEvent.fromJson(id, {
      'header': {'id': id},
      'cursor': -1,
      'records': <Object?>[],
      'projections': {'asOfSeq': -1, 'values': <String, Object?>{}},
      'running': running,
    });
    await Completer<void>().future;
  }

  @override
  Future<String> prompt(
    String sessionId,
    String text, {
    List<PromptImage> images = const [],
    List<String> fileReceiptIds = const [],
    String? requestId,
    PromptMode mode = PromptMode.queue,
    String? timeZone,
  }) async {
    prompts.add((sessionId, text, requestId));
    if (fail) throw const DshRemoteException('network', 'offline');
    return requestId ?? 'r';
  }
}

class _Local extends LocalConnectionController {
  @override
  Future<HostConnection?> build() async => null;
}

class _Sessions extends SessionsController {
  int creates = 0;
  final list = [session('existing', title: 'Work')];
  Completer<String>? creation;
  @override
  Future<List<SessionSummary>> build() async => list;
  @override
  Future<String> create({bool autoApprove = true}) async {
    creates++;
    return creation?.future ?? 'new-chat';
  }
}

class _Host extends ActiveHostController {
  @override
  HostRef build() => HostRef.local;
  @override
  void select(HostRef host) {
    state = host;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Client client;
  late ProviderContainer container;
  late _Sessions sessions;
  late PetOverlayActions actions;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    client = _Client();
    sessions = _Sessions();
    container = ProviderContainer(
      overrides: [
        activeHostProvider.overrideWith(_Host.new),
        localConnectionProvider.overrideWith(_Local.new),
        activeConnectionProvider.overrideWithValue(AsyncData(HostConnection(client: client, isLocal: true))),
        sessionsProvider.overrideWith(() => sessions),
        petStateProvider.overrideWithValue(const PetState(target: PetTarget(HostRef.local, 'existing'))),
      ],
    );
    await container.read(sessionsProvider.future);
    actions = container.read(petOverlayActionsProvider);
  });

  tearDown(() async {
    container.dispose();
    await client.close();
  });

  Future<Map> offer() async => await actions.handle(const MethodCall('askTarget')) as Map;
  Future<Map> send(Map target, {bool fresh = false, String? host, int? offerId}) async => await actions.handle(
    MethodCall('ask', {
      'offer': offerId ?? target['offer'],
      'host': host ?? HostRef.local.encode(),
      'sessionId': fresh ? null : 'existing',
      'fresh': fresh,
      'text': 'hello from pet',
    }),
  ) as Map;

  test('idle target sends through real ChatController with a request receipt', () async {
    final target = await offer();
    expect((target['current'] as Map)['sessionId'], 'existing');
    expect((await send(target))['sent'], true);
    expect(client.prompts.single.$1, 'existing');
    expect(client.prompts.single.$2, 'hello from pet');
    expect(client.prompts.single.$3, isNotEmpty);
    expect(container.read(petAskedProvider), contains(const PetTarget(HostRef.local, 'existing')));
    expect(sessions.creates, 0);
  });

  test('fresh send creates once and uses the new session', () async {
    final target = await offer();
    expect((await send(target, fresh: true))['sent'], true);
    expect(sessions.creates, 1);
    expect(client.prompts.single.$1, 'new-chat');
  });

  test('failed new send preserves the same created session for retry', () async {
    final target = await offer();
    client.fail = true;
    expect((await send(target, fresh: true))['problem'], isNotEmpty);
    client.fail = false;
    expect((await send(target, fresh: true))['sent'], true);
    expect(sessions.creates, 1);
    expect(client.prompts.map((p) => p.$1), ['new-chat', 'new-chat']);
  });

  test('changed host, generation, malformed host and old offer cannot send', () async {
    var target = await offer();
    expect((await send(target, host: '{}'))['problem'], isNotEmpty);
    expect((await send(target, offerId: -1))['problem'], isNotEmpty);
    client.testMux.current = const MuxGeneration(2, 'another', '/tmp');
    expect((await send(target))['problem'], isNotEmpty);
    target = await offer();
    container.read(activeHostProvider.notifier).select(const HostRef.ssh('other'));
    expect((await send(target))['problem'], isNotEmpty);
    expect(client.prompts, isEmpty);
  });

  test('host switch during create never sends into another host', () async {
    sessions.creation = Completer<String>();
    final target = await offer();
    final pending = send(target, fresh: true);
    await Future<void>.delayed(Duration.zero);
    container.read(activeHostProvider.notifier).select(const HostRef.ssh('other'));
    sessions.creation!.complete('created');
    expect((await pending)['problem'], isNotEmpty);
    expect(client.prompts, isEmpty);
  });

  test('concurrent sends do not create or send twice', () async {
    sessions.creation = Completer<String>();
    final target = await offer();
    final first = send(target, fresh: true);
    expect((await send(target, fresh: true))['problem'], isNotEmpty);
    sessions.creation!.complete('created');
    expect((await first)['sent'], true);
    expect(sessions.creates, 1);
    expect(client.prompts, hasLength(1));
  });

  test('missing engine is explicit and never creates a chat', () async {
    client.testMux.current = null;
    final target = await offer();
    expect(target['problem'], isNotEmpty);
    expect((await send(target, fresh: true))['problem'], isNotEmpty);
    expect(sessions.creates, 0);
  });

  test('malformed action host never silently becomes local', () {
    for (final input in [null, '', '{}', '{"kind":"other","id":"x"}', '{"kind":"local","id":"x"}']) {
      expect(petActionHost(input), isNull);
    }
  });

  test('foreground fallback retains typed text without sending it', () {
    final entry = LauncherEntry.parse({'kind': 'new', 'text': 'keep this draft'}) as NewChatEntry;
    expect(entry.text, 'keep this draft');
    expect(entry.voice, false);
  });

  test('only quick ask completion gets a reply preview; merged bubbles drop it', () async {
    final bus = PetEventBus();
    final heard = [];
    final sub = bus.events.listen(heard.add);
    final alert = ChatAlert(
      host: HostRef.local,
      sessionId: 's',
      kind: AlertKind.done,
      key: turnKey,
      title: 'Work',
      text: 'done',
      reply: 'first reply lines',
    );
    bus.alert(alert, DateTime(2026), asked: true);
    bus.alert(alert, DateTime(2026), asked: false);
    expect(heard.first.preview, 'first reply lines');
    expect(heard.last.preview, isNull);
    final bubble = PetBubble(
      id: 'b',
      kind: PetBubbleKind.done,
      target: const PetTarget(HostRef.local, 's'),
      until: DateTime(2026),
      preview: heard.first.preview,
    );
    expect(bubble.toMap()['detail'], 'first reply lines');
    expect(bubble.copyWith(count: 2).toMap().containsKey('detail'), false);
    await sub.cancel();
    bus.dispose();
  });
}
