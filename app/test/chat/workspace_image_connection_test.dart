import 'dart:async';

import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_app/state/artifact_files.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/chat/render/markdown_body.dart';
import 'package:dsh_app/ui/chat/render/markdown_image.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../media/support.dart' show drawPicture;
import '../remote/support/fake_relay.dart';
import 'support/harness.dart';

const _host = HostRef.relay('mac');
const _path = '/root/workspace/chart.png';

class _SelectedHost extends ActiveHostController {
  @override
  HostRef build() => _host;
}

class _Name extends Notifier<String> {
  @override
  String build() => 'Workstation';
  void rename() => state = 'Renamed workstation';
}

final _name = NotifierProvider<_Name, String>(_Name.new);

class _Relay extends FakeRelayBackend {
  _Relay() : super(user: sampleRelayUser);
  late RelayStateCallback stateChanged;

  @override
  Future<DshClient> connectHost(RelayHost host, {RelayStateCallback? onState}) {
    stateChanged = onState!;
    return super.connectHost(host, onState: onState);
  }
}

// Only image I/O is held. Connection publication runs through RelayHostLink,
// RemoteConnectionController, activeConnectionProvider and ArtifactFiles.
class _Reader implements WorkspaceImageReader {
  final calls = <(String, String)>[];
  final replies = <Completer<LoadedImage>>[];

  @override
  Future<LoadedImage> read(String sessionId, String path) {
    calls.add((sessionId, path));
    final reply = Completer<LoadedImage>();
    replies.add(reply);
    return reply.future;
  }
}

class _Scene {
  _Scene(this.backend, this.link, this.container, this.readers, this.published);
  final _Relay backend;
  final RelayHostLink link;
  final ProviderContainer container;
  final Map<DshClient, _Reader> readers;
  final List<DshClient> published;

  DshClient get client => container.read(activeConnectionProvider).requireValue!.client;
  _Reader get reader {
    expect(readers, contains(client), reason: 'the published connection owns a new image read');
    return readers[client]!;
  }

  static Future<_Scene> mount(WidgetTester tester) async {
    final backend = _Relay();
    final link = RelayHostLink(backend: backend, hostId: _host.id, resolveHost: () async => sampleRelayHosts.first);
    addTearDown(link.close);
    final published = <DshClient>[];
    final subscription = link.clients.listen(published.add);
    addTearDown(subscription.cancel);
    final readers = <DshClient, _Reader>{};
    await tester.pumpWidget(
      testApp(
        Scaffold(
          body: Consumer(
            builder: (context, ref, _) {
              if (ref.watch(activeConnectionProvider).value == null) return const SizedBox.shrink();
              return const MarkdownImageScope(
                sessionId: 's1',
                child: SingleChildScrollView(child: MarkdownBody(text: '![Chart]($_path)', selectable: false)),
              );
            },
          ),
        ),
        overrides: [
          activeHostProvider.overrideWith(_SelectedHost.new),
          hostLinkProvider.overrideWith((ref, host) => link),
          hostNameProvider.overrideWith((ref, host) => ref.watch(_name)),
          workspaceImageReaderProvider.overrideWith((ref) {
            final client = ref.watch(artifactFilesProvider).connection!.client;
            return CachedImageReader(readers.putIfAbsent(client, _Reader.new));
          }),
        ],
      ),
    );
    final container = ProviderScope.containerOf(tester.element(find.byType(Scaffold)));
    await container.read(remoteConnectionProvider(_host).future);
    await tester.pump();
    await tester.pump();
    final scene = _Scene(backend, link, container, readers, published);
    expect(scene.reader.calls, [('s1', _path)]);
    return scene;
  }

  Future<void> reconnect(WidgetTester tester) async {
    final before = client;
    final imageState = tester.state(find.byType(MarkdownImage));
    backend.stateChanged(RelayConnectionState.failed, const HostLinkError(HostLinkErrorKind.other, 'closed'));
    container.read(remoteConnectionProvider(_host).notifier).retry();
    final next = await container.read(remoteConnectionProvider(_host).future);
    await tester.pump();
    await tester.pump();
    expect(next!.client, isNot(same(before)));
    expect(client, same(next.client));
    expect(published, contains(same(next.client)));
    expect(backend.closedClients, contains(before));
    expect(tester.state(find.byType(MarkdownImage)), same(imageState));
    expect(container.read(activeHostProvider), _host);
  }
}

Future<void> _paint(WidgetTester tester, MemoryImage expected) async {
  await tester.pump();
  await tester.pump();
  final image = find.descendant(of: find.byType(MarkdownImage), matching: find.byType(Image));
  expect(image, findsOneWidget);
  final provider = tester.widget<Image>(image).image as ResizeImage;
  expect(provider.imageProvider, expected);
  await tester.runAsync(() => precacheImage(provider, tester.element(image)));
  await tester.pump();
  await tester.pump();
  expect(tester.widget<RawImage>(find.descendant(of: image, matching: find.byType(RawImage))).image, isNotNull);
  expect(tester.takeException(), isNull);
}

void main() {
  setUpAll(loadTestFonts);

  testWidgets('a surviving workspace image reloads after a new client is published', (tester) async {
    final scene = await _Scene.mount(tester);
    final old = scene.reader;
    final original = MemoryImage(tinyPng);
    old.replies.single.complete(RasterImage(original));
    await _paint(tester, original);
    await scene.reconnect(tester);
    expect(scene.reader.calls, [('s1', _path)]);
    expect(find.byType(Image), findsNothing, reason: 'the old decoded image is retired while the new read waits');
    final replacement = MemoryImage((await tester.runAsync(() => drawPicture(7, 3)))!);
    scene.reader.replies.single.complete(RasterImage(replacement));
    await _paint(tester, replacement);
    expect(tester.widget<RawImage>(find.byType(RawImage)).image!.width, 7);
    expect(old.calls, hasLength(1));
  });

  for (final fails in [false, true]) {
    testWidgets('old ${fails ? 'failure' : 'success'} cannot finish the replacement read', (tester) async {
      final scene = await _Scene.mount(tester);
      final old = scene.reader;
      await scene.reconnect(tester);
      if (fails) {
        old.replies.single.completeError(const ArtifactError('missing'));
      } else {
        old.replies.single.complete(RasterImage(MemoryImage(tinyPng)));
      }
      await tester.pump();
      await tester.pump();
      expect(find.byType(Image), findsNothing);
      expect(find.textContaining('重试'), findsNothing);
      expect(scene.reader.calls, [('s1', _path)]);
      final replacement = MemoryImage((await tester.runAsync(() => drawPicture(7, 3)))!);
      scene.reader.replies.single.complete(RasterImage(replacement));
      await _paint(tester, replacement);
    });
  }

  testWidgets('an old completion after the new pixels cannot replace them', (tester) async {
    final scene = await _Scene.mount(tester);
    final old = scene.reader;
    await scene.reconnect(tester);
    expect(scene.reader.calls, [('s1', _path)]);
    final replacement = MemoryImage((await tester.runAsync(() => drawPicture(7, 3)))!);
    scene.reader.replies.single.complete(RasterImage(replacement));
    await _paint(tester, replacement);
    old.replies.single.complete(RasterImage(MemoryImage(tinyPng)));
    await _paint(tester, replacement);
  });

  testWidgets('the replacement reader keeps its failure and retry behavior', (tester) async {
    final scene = await _Scene.mount(tester);
    final old = scene.reader;
    await scene.reconnect(tester);
    expect(scene.reader.calls, [('s1', _path)]);
    scene.reader.replies.single.completeError(const ArtifactError('missing'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('重试'), findsOneWidget);
    await tester.tap(find.textContaining('重试'));
    await tester.pump();
    expect(scene.reader.calls, [('s1', _path), ('s1', _path)]);
    final replacement = MemoryImage(tinyPng);
    scene.reader.replies.last.complete(RasterImage(replacement));
    await _paint(tester, replacement);
    old.replies.single.completeError(const ArtifactError('offline'));
    await _paint(tester, replacement);
  });

  testWidgets('a renamed host with the same client keeps its decoded image', (tester) async {
    final scene = await _Scene.mount(tester);
    final connection = scene.container.read(activeConnectionProvider).requireValue!;
    final reader = scene.reader;
    final image = MemoryImage(tinyPng);
    reader.replies.single.complete(RasterImage(image));
    await _paint(tester, image);
    scene.container.read(_name.notifier).rename();
    await tester.pump();
    final renamed = scene.container.read(activeConnectionProvider).requireValue!;
    expect(renamed, isNot(same(connection)));
    expect(renamed.client, same(connection.client));
    expect(renamed.name, 'Renamed workstation');
    expect(reader.calls, hasLength(1));
    await _paint(tester, image);
  });
}
