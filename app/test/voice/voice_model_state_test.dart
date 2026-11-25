import 'dart:async';
import 'dart:io';

import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/voice_model_state.dart';
import 'package:dsh_app/voice/voice_model_assets.dart';
import 'package:dsh_app/voice/voice_model_download.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../chat/support/composer_fakes.dart';
import 'voice_model_assets_test.dart' show rc2Lock;

/// Small stand-ins for the three files (the controller only knows sizes from the lock).
const _sizes = {'model.int8.onnx': 1000, 'tokens.txt': 40, 'silero_vad.onnx': 60};
const _total = 1100;

class _Platform implements VoiceModelPlatform {
  _Platform(this.root);

  final Directory root;
  int? free = 1 << 40;
  bool isMetered = false;

  /// What the next mirror download does: null writes the files.
  VoiceDownloadError? failWith;
  Completer<void>? hold;

  /// Set: a cancel reaches the download while it is finishing a file; that
  /// file still lands (its rename) when this completes, then it stops.
  Completer<void>? lingering;
  final notices = <(String?, int?)>[];

  /// When each of [notices] went out.
  final noticeTimes = <Duration>[];
  final clock = Stopwatch()..start();

  /// Progress reports per file (each a share of it), [stepDelay] apart.
  int steps = 1;
  Duration stepDelay = Duration.zero;
  final downloads = <List<VoiceDownloadJob>>[];
  bool cancelledDownload = false;

  /// Bytes that came "over the network".
  int fetched = 0;

  @override
  Future<VoiceModelFiles?> files() async => VoiceModelFiles(root);

  @override
  Future<int?> freeBytes() async => free;

  @override
  Future<bool> metered() async => isMetered;

  @override
  Future<VoiceDownloadRun> download(List<VoiceDownloadJob> jobs) async {
    downloads.add(jobs);
    final progress = StreamController<int>.broadcast();
    final done = Completer<void>();
    var cancelled = false;
    Future<void> run() async {
      await Future<void>.delayed(Duration.zero);
      var sum = 0;
      for (final j in jobs) {
        if (hold case final h?) await h.future;
        if (cancelled) {
          if (lingering case final l?) {
            await l.future;
            File(j.path)
              ..createSync(recursive: true)
              ..writeAsBytesSync(List.filled(j.bytes, 1));
          }
          done.completeError(const VoiceDownloadException(VoiceDownloadError.cancelled));
          return;
        }
        if (failWith case final kind?) {
          done.completeError(VoiceDownloadException(kind));
          return;
        }
        for (var i = 1; i < steps; i++) {
          progress.add(sum + j.bytes * i ~/ steps);
          await Future<void>.delayed(stepDelay);
        }
        // As the downloader: a file in place stays, a whole .part is checked and renamed.
        final target = File(j.path);
        final part = File(j.partPath);
        if (target.existsSync() && target.lengthSync() == j.bytes) {
          // In place.
        } else if (part.existsSync() && part.lengthSync() == j.bytes) {
          part.renameSync(j.path);
        } else {
          File(j.path)
            ..createSync(recursive: true)
            ..writeAsBytesSync(List.filled(j.bytes, 1));
          fetched += j.bytes;
        }
        sum += j.bytes;
        progress.add(sum);
      }
      done.complete();
    }

    unawaited(run());
    return VoiceDownloadRun(
      progress: progress.stream,
      done: done.future,
      cancel: () {
        cancelled = true;
        cancelledDownload = true;
        hold?.complete();
      },
    );
  }

  @override
  Future<void> notice(String? text, {int? progress}) async {
    notices.add((text, progress));
    noticeTimes.add(clock.elapsed);
  }
}

/// Answers like [FakeRpcCarrier]; `pluginManager/listBundles` can be held until the test lets it go.
class _Carrier extends FakeRpcCarrier {
  _Carrier(super.handlers);

  Completer<void>? holdList;
  final listing = Completer<void>();

  @override
  Future<RpcResult> call(String endpoint, Map<String, Object?> args, {Duration? timeout}) async {
    if (endpoint == 'pluginManager/listBundles' && holdList != null) {
      // The reply is read when the call arrives; it reaches the app only later.
      final reply = await super.call(endpoint, args, timeout: timeout);
      if (!listing.isCompleted) listing.complete();
      await holdList!.future;
      return reply;
    }
    return super.call(endpoint, args, timeout: timeout);
  }
}

/// The engine: the voice bundle (off until switched on) and SenseVoice's preparation.
class _Engine {
  bool enabled = false;
  bool hasBundle = true;
  String selection = voiceModelProviderId;

  /// Phases `speech/catalog` reports after `speech/prepare`, one per read; the last one stays.
  List<Map<String, Object?>> afterPrepare = [
    {'phase': 'checking', 'step': 'verify'},
    {'phase': 'loading', 'step': 'load'},
    {'phase': 'ready'},
  ];
  Map<String, Object?> preparation = {'phase': 'unprepared'};
  bool prepared = false;

  /// Set: the official sources are out of reach, so `speech/prepare` fails
  /// unless this says every file is already in the cache.
  bool Function()? cached;

  /// How `setBundleEnabled(false)` goes: null applies it; 'failed' answers
  /// so without switching off; 'throws' fails the call.
  String? disable;
  late final carrier = _Carrier({
    'pluginManager/listBundles': (_) => [
      if (hasBundle) {'name': voiceInputBundle, 'official': true, 'optional': true, 'enabled': enabled},
    ],
    'pluginManager/setBundleEnabled': (args) {
      if (args['enabled'] == false && disable == 'throws') throw DshHttpException(500, 'plugin manager busy');
      if (args['enabled'] == false && disable == 'failed') {
        return {
          'stage': 'enable',
          'target': voiceInputBundle,
          'enabled': false,
          'changed': false,
          'application': 'failed',
        };
      }
      enabled = args['enabled'] == true;
      return {
        'stage': 'enable',
        'target': voiceInputBundle,
        'enabled': enabled,
        'changed': true,
        'application': 'applied',
      };
    },
    'speech/catalog': (_) {
      if (!enabled) throw DshHttpException(404, 'not served');
      if (prepared && afterPrepare.length > 1) preparation = afterPrepare.removeAt(0);
      if (prepared && afterPrepare.length == 1) preparation = afterPrepare.first;
      return {
        'providers': [
          {
            'id': voiceModelProviderId,
            'name': 'SenseVoiceSmall (INT8)',
            'location': 'host-local',
            'preparation': preparation,
          },
        ],
        'selection': {'providerId': selection, 'language': 'auto'},
        'maxAudioBytes': 4194304,
        'maxDurationSeconds': 120,
      };
    },
    'speech/prepare': (_) {
      prepared = true;
      if (cached case final inCache? when !inCache()) {
        afterPrepare = [
          {'phase': 'downloading', 'resource': 'silero_vad.onnx', 'completedBytes': 0, 'totalBytes': 60, 'step': 'vad'},
          {
            'phase': 'failed',
            'download': {'resource': 'silero_vad.onnx', 'source': 'https://huggingface.co', 'reason': 'network'},
          },
        ];
      }
      return null;
    },
    'speech/cancelPreparation': (_) {
      // As the provider: unfinished preparation is cancelled, completed readiness is retained.
      if (const {'ready', 'standby'}.contains(preparation['phase'])) return null;
      preparation = {'phase': 'cancelled'};
      prepared = false;
      return null;
    },
    'speech/configure': (args) {
      selection = (args['patch'] as Map)['providerId'] as String;
      return null;
    },
  });
  late final client = DshClient.withCarrier(carrier);

  List<String> get calls => [for (final (e, _) in carrier.calls) e];
}

class _Local extends LocalConnectionController {
  _Local(this.client);
  final DshClient? Function() client;

  @override
  Future<HostConnection?> build() async {
    final c = client();
    return c == null ? null : HostConnection(client: c, isLocal: true);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory root;
  late _Platform platform;
  late _Engine engine;

  setUp(() async {
    VoiceModelController.pollEvery = const Duration(milliseconds: 5);
    VoiceModelController.stall = const Duration(seconds: 60);
    // Every line as it comes; the pace is tested on its own.
    VoiceModelController.noticeEvery = Duration.zero;
    SharedPreferences.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('voice-model');
    var lock = rc2Lock
        .replaceFirst('"bytes": 239233841', '"bytes": ${_sizes['model.int8.onnx']}')
        .replaceFirst('"bytes": 315894', '"bytes": ${_sizes['tokens.txt']}')
        .replaceFirst('"bytes": 1807522', '"bytes": ${_sizes['silero_vad.onnx']}');
    VoiceModelFiles(root).host(VoiceModelPaths.lock)
      ..createSync(recursive: true)
      ..writeAsStringSync(lock);
    platform = _Platform(root);
    engine = _Engine();
  });
  tearDown(() => root.delete(recursive: true));

  ProviderContainer container({DshClient? Function()? client, bool connected = true}) {
    final c = ProviderContainer(
      overrides: [
        voiceModelPlatformProvider.overrideWithValue(platform),
        localConnectionProvider.overrideWith(() => _Local(client ?? () => connected ? engine.client : null)),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  Future<VoiceModelState> settle(ProviderContainer c, bool Function(VoiceModelState) done) async {
    for (var i = 0; i < 400; i++) {
      final s = c.read(voiceModelProvider);
      if (done(s)) return s;
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    fail('voice model never settled: ${c.read(voiceModelProvider).status}');
  }

  Future<List<VoiceModelEvent>> listen(ProviderContainer c) async {
    final events = <VoiceModelEvent>[];
    c.listen(voiceModelProvider, (_, _) {}, fireImmediately: true);
    c.read(voiceModelProvider.notifier).events.listen(events.add);
    await c.read(localConnectionProvider.future);
    return events;
  }

  test('the onboarding choice downloads from the mirror, switches the bundle on and prepares', () async {
    SharedPreferences.setMockInitialValues({VoiceModelController.onboardingKey: true});
    final c = container();
    final events = await listen(c);
    final s = await settle(c, (s) => s.status == VoiceModelStatus.ready);
    expect(s.doneBytes, _total);
    expect(s.wanted, isFalse);
    expect(events.map((e) => e.kind), [VoiceModelEventKind.started, VoiceModelEventKind.ready]);
    expect(events.first.bytes, _total);
    expect(events.first.resumed, isFalse);
    // Every file from its mirror, into the provider's cache.
    expect(platform.downloads.single.map((j) => j.path.substring(root.path.length)), [
      '/root/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/model.int8.onnx',
      '/root/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/tokens.txt',
      '/root/.dsh/speech-to-text/sensevoice/models/silero/silero_vad.onnx',
    ]);
    expect(engine.enabled, isTrue);
    expect(engine.calls, containsAllInOrder(['pluginManager/setBundleEnabled', 'speech/prepare']));
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool(VoiceModelController.onboardingHandledKey), isTrue);
    expect(prefs.getBool(VoiceModelController.wantedKey), isFalse);

    // A later app start does not download again (onboarding was handled).
    final again = container();
    final more = await listen(again);
    await settle(again, (s) => s.status == VoiceModelStatus.ready);
    expect(more, isEmpty);
    expect(platform.downloads, hasLength(1));
  });

  test('nothing happens without the onboarding choice; a plain start reads the state', () async {
    final c = container();
    final events = await listen(c);
    final s = await settle(c, (s) => s.status == VoiceModelStatus.absent);
    expect(s.doneBytes, 0);
    expect(s.totalBytes, _total);
    expect(events, isEmpty);
    expect(platform.downloads, isEmpty);
  });

  test('the mirror failing hands the download to the engine, which still gets there', () async {
    platform.failWith = VoiceDownloadError.network;
    engine.afterPrepare = [
      {
        'phase': 'downloading',
        'resource': 'model.int8.onnx',
        'completedBytes': 400,
        'totalBytes': 1000,
        'step': 'model',
      },
      {
        'phase': 'downloading',
        'resource': 'model.int8.onnx',
        'completedBytes': 900,
        'totalBytes': 1000,
        'step': 'model',
      },
      {'phase': 'checking', 'step': 'verify'},
      {'phase': 'ready'},
    ];
    final c = container();
    final events = await listen(c);
    unawaited(c.read(voiceModelProvider.notifier).download());
    final s = await settle(c, (s) => s.status == VoiceModelStatus.ready);
    expect(s.failure, isNull);
    expect(events.map((e) => e.kind), [VoiceModelEventKind.started, VoiceModelEventKind.ready]);
    expect(engine.calls, contains('speech/prepare'));
  });

  test('too little free space stops before downloading, with how much is needed', () async {
    platform.free = 1000;
    final c = container();
    final events = await listen(c);
    await c.read(voiceModelProvider.notifier).download();
    final s = await settle(c, (s) => s.status == VoiceModelStatus.failed);
    expect(s.failure, VoiceModelFailure.storage);
    expect(s.neededBytes, _total + voiceModelSpareBytes);
    expect(platform.downloads, isEmpty);
    expect(engine.enabled, isFalse);
    expect(events.single.kind, VoiceModelEventKind.failed);
    expect(s.wanted, isFalse, reason: 'a failure waits for 重试, it does not loop');
  });

  test('cancel stops the download, keeps the files and forgets the wish', () async {
    platform.hold = Completer<void>();
    final c = container();
    await listen(c);
    unawaited(c.read(voiceModelProvider.notifier).download());
    await settle(c, (s) => s.status == VoiceModelStatus.downloading && platform.downloads.isNotEmpty);
    await c.read(voiceModelProvider.notifier).cancel();
    final s = await settle(c, (s) => s.status == VoiceModelStatus.absent);
    expect(platform.cancelledDownload, isTrue);
    expect(s.wanted, isFalse);
    expect((await SharedPreferences.getInstance()).getBool(VoiceModelController.wantedKey), isFalse);
    expect(engine.enabled, isFalse);
    expect(platform.notices.last, (null, null));
  });

  test('download right after cancel starts again once the old run has let go', () async {
    platform.hold = Completer<void>();
    final c = container();
    await listen(c);
    unawaited(c.read(voiceModelProvider.notifier).download());
    await settle(c, (s) => s.status == VoiceModelStatus.downloading && platform.downloads.isNotEmpty);
    final notifier = c.read(voiceModelProvider.notifier);
    unawaited(notifier.cancel());
    await notifier.download();
    final s = await settle(c, (s) => s.status == VoiceModelStatus.ready);
    expect(s.wanted, isFalse);
    expect(platform.downloads, hasLength(2));
  });

  for (final how in ['cancel', 'delete']) {
    test('a bundle list that answers after $how does not switch the bundle back on', () async {
      final hold = engine.carrier.holdList = Completer<void>();
      final c = container();
      await listen(c);
      final notifier = c.read(voiceModelProvider.notifier);
      unawaited(notifier.download());
      // Files in; the run asked the engine for its bundles (off) and waits for the answer.
      await engine.carrier.listing.future;
      if (how == 'cancel') {
        await notifier.cancel();
      } else {
        expect(await notifier.delete(), isTrue);
      }
      expect(engine.enabled, isFalse);
      // The person may switch it off on the web page as well; then the old answer arrives.
      hold.complete();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(engine.enabled, isFalse);
      expect(engine.carrier.argsOf('pluginManager/setBundleEnabled').map((a) => a['enabled']), isNot(contains(true)));
      expect(engine.calls, isNot(contains('speech/prepare')));
      final s = await settle(c, (s) => s.status == VoiceModelStatus.absent);
      expect(s.wanted, isFalse);
    });
  }

  test('a new engine during the engine part takes it over (no stuck "preparing")', () async {
    engine.afterPrepare = [
      for (var i = 0; i < 200; i++) {'phase': 'loading', 'step': 'load'},
    ];
    DshClient? current = engine.client;
    final c = container(client: () => current);
    await listen(c);
    unawaited(c.read(voiceModelProvider.notifier).download());
    await settle(c, (s) => s.status == VoiceModelStatus.preparing);
    // The engine restarts: the files are in its cache, the bundle stays on, it comes up ready.
    final second = _Engine()
      ..enabled = true
      ..preparation = {'phase': 'standby'};
    current = null;
    c.invalidate(localConnectionProvider);
    await c.read(localConnectionProvider.future);
    expect(c.read(voiceModelProvider).status, VoiceModelStatus.waiting);
    current = second.client;
    c.invalidate(localConnectionProvider);
    await c.read(localConnectionProvider.future);
    final s = await settle(c, (s) => s.status == VoiceModelStatus.ready);
    expect(s.wanted, isFalse);
  });

  test('delete switches the bundle off, then removes the files', () async {
    final c = container();
    await listen(c);
    await c.read(voiceModelProvider.notifier).download();
    await settle(c, (s) => s.status == VoiceModelStatus.ready);
    final files = VoiceModelFiles(root);
    expect(files.complete(files.assets()!), isTrue);
    expect(await c.read(voiceModelProvider.notifier).delete(), isTrue);
    expect(engine.enabled, isFalse);
    expect(files.complete(files.assets()!), isFalse);
    expect(Directory(files.host(VoiceModelPaths.models).path).existsSync(), isFalse);
    final s = await settle(c, (s) => s.status == VoiceModelStatus.absent);
    expect(s.doneBytes, 0);
  });

  test('delete waits for the download to stop: a file landing after the cancel is deleted too', () async {
    platform.hold = Completer<void>();
    final landing = platform.lingering = Completer<void>();
    final c = container();
    await listen(c);
    final notifier = c.read(voiceModelProvider.notifier);
    unawaited(notifier.download());
    await settle(c, (s) => s.status == VoiceModelStatus.downloading && platform.downloads.isNotEmpty);
    var deleted = false;
    final deleting = notifier.delete().then((ok) {
      deleted = true;
      return ok;
    });
    // The download is still finishing its file when the cancel reaches it.
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(deleted, isFalse, reason: 'the delete waits for the download to stop');
    landing.complete();
    expect(await deleting, isTrue);
    final files = VoiceModelFiles(root);
    expect(Directory(files.host(VoiceModelPaths.models).path).existsSync(), isFalse);
    expect(engine.enabled, isFalse);
  });

  for (final answer in ['failed', 'throws']) {
    test('delete keeps the files when the engine does not switch the bundle off ($answer)', () async {
      final c = container();
      await listen(c);
      await c.read(voiceModelProvider.notifier).download();
      await settle(c, (s) => s.status == VoiceModelStatus.ready);
      engine.disable = answer;
      expect(await c.read(voiceModelProvider.notifier).delete(), isFalse);
      final files = VoiceModelFiles(root);
      expect(files.complete(files.assets()!), isTrue, reason: 'the recognizer still has them');
      expect(engine.enabled, isTrue);
      await settle(c, (s) => s.status == VoiceModelStatus.ready);
    });
  }

  test('a download cut short (app killed) goes on at the next engine start', () async {
    SharedPreferences.setMockInitialValues({VoiceModelController.wantedKey: true});
    final files = VoiceModelFiles(root);
    final model = files.assets()!.first;
    files.host(model.guestPath)
      ..createSync(recursive: true)
      ..writeAsBytesSync(List.filled(model.bytes, 1));
    final c = container();
    final events = await listen(c);
    await settle(c, (s) => s.status == VoiceModelStatus.ready);
    expect(events.first.kind, VoiceModelEventKind.started);
    expect(events.first.resumed, isTrue);
    expect(events.first.bytes, _total - model.bytes);
  });

  test('a whole .part left by a kill is checked and renamed on resume: no network, no official download', () async {
    SharedPreferences.setMockInitialValues({VoiceModelController.wantedKey: true});
    final files = VoiceModelFiles(root);
    final assets = files.assets()!;
    for (final a in assets.take(2)) {
      files.host(a.guestPath)
        ..createSync(recursive: true)
        ..writeAsBytesSync(List.filled(a.bytes, 1));
    }
    // The last file's .part reached its full length; the app died before the check and rename.
    final last = assets.last;
    final part = File('${files.host(last.guestPath).path}${VoiceModelPaths.partSuffix}')
      ..createSync(recursive: true)
      ..writeAsBytesSync(List.filled(last.bytes, 1));
    expect(files.presentBytes(assets), _total);
    expect(files.complete(assets), isFalse);
    engine.cached = () => files.complete(assets);
    final c = container();
    final events = await listen(c);
    final s = await settle(c, (s) => s.status == VoiceModelStatus.ready || s.status == VoiceModelStatus.failed);
    expect(s.status, VoiceModelStatus.ready, reason: 'failure: ${s.failure}');
    expect(platform.downloads, hasLength(1), reason: 'the whole .part goes to the downloader to be checked');
    expect(platform.fetched, 0, reason: 'nothing comes over the network');
    expect(part.existsSync(), isFalse);
    expect(files.complete(assets), isTrue);
    expect(events.map((e) => e.kind), [VoiceModelEventKind.ready], reason: 'nothing left to download: no 继续下载 notice');
  });

  test('the wish waits for the engine and starts when it connects', () async {
    final c = container(connected: false);
    await listen(c);
    await c.read(voiceModelProvider.notifier).download();
    expect(c.read(voiceModelProvider).status, VoiceModelStatus.waiting);
    expect(c.read(voiceModelProvider).wanted, isTrue);
    expect(platform.downloads, isEmpty);
  });

  test('a model the engine already has is ready without a download', () async {
    engine.enabled = true;
    engine.preparation = {'phase': 'standby'};
    final c = container();
    final events = await listen(c);
    await settle(c, (s) => s.status == VoiceModelStatus.ready);
    expect(events, isEmpty);
    expect(platform.downloads, isEmpty);
  });

  test('an engine-side failure maps to a reason and asks for 重试', () async {
    platform.failWith = VoiceDownloadError.http;
    engine.afterPrepare = [
      {
        'phase': 'failed',
        'message': 'Unable to prepare model.int8.onnx from https://us.aws.cdn.hf.co: network (UND_ERR_SOCKET)',
        'download': {
          'resource': 'model.int8.onnx',
          'source': 'https://us.aws.cdn.hf.co',
          'reason': 'network',
          'code': 'UND_ERR_SOCKET',
        },
      },
    ];
    final c = container();
    final events = await listen(c);
    await c.read(voiceModelProvider.notifier).download();
    final s = await settle(c, (s) => s.status == VoiceModelStatus.failed);
    expect(s.failure, VoiceModelFailure.network);
    expect(events.last.kind, VoiceModelEventKind.failed);
  });

  test('the engine download stalling is given up and cancelled', () async {
    VoiceModelController.stall = const Duration(milliseconds: 60);
    platform.failWith = VoiceDownloadError.network;
    engine.afterPrepare = [
      {'phase': 'downloading', 'resource': 'model.int8.onnx', 'completedBytes': 5, 'totalBytes': 1000, 'step': 'model'},
    ];
    final c = container();
    await listen(c);
    await c.read(voiceModelProvider.notifier).download();
    final s = await settle(c, (s) => s.status == VoiceModelStatus.failed);
    expect(s.failure, VoiceModelFailure.timeout);
    expect(engine.calls, contains('speech/cancelPreparation'));
  });

  test('a runtime without the voice bundle is unsupported', () async {
    engine.hasBundle = false;
    VoiceModelFiles(root).host(VoiceModelPaths.lock).deleteSync();
    final c = container();
    await listen(c);
    await settle(c, (s) => s.status == VoiceModelStatus.unsupported);
  });

  test('ready selects SenseVoice when another recognizer was the default', () async {
    engine.selection = 'some-cloud';
    final c = container();
    await listen(c);
    await c.read(voiceModelProvider.notifier).download();
    await settle(c, (s) => s.status == VoiceModelStatus.ready);
    expect(engine.selection, voiceModelProviderId);
  });

  test('progress reaches the engine notification only with texts set, and clears in the foreground', () async {
    final c = container();
    await listen(c);
    c.read(voiceModelProvider.notifier).noticeText = VoiceModelNoticeText(
      downloading: (p) => 'dl $p',
      preparing: 'checking',
      ready: 'ready',
      failed: 'failed',
    );
    await c.read(voiceModelProvider.notifier).download();
    await settle(c, (s) => s.status == VoiceModelStatus.ready);
    expect(platform.notices.first.$1, startsWith('dl '));
    expect(platform.notices.map((n) => n.$1), contains('checking'));
    expect(platform.notices.last, (null, null));
  });

  group('重新下载', () {
    /// The model in place, ready, each file marked so a replacement shows.
    Future<(ProviderContainer, VoiceModelFiles, List<VoiceModelAsset>)> ready() async {
      final c = container();
      await listen(c);
      await c.read(voiceModelProvider.notifier).download();
      await settle(c, (s) => s.status == VoiceModelStatus.ready);
      final files = VoiceModelFiles(root);
      final assets = files.assets()!;
      for (final a in assets) {
        files.host(a.guestPath).writeAsBytesSync(List.filled(a.bytes, 7));
      }
      return (c, files, assets);
    }

    bool untouched(VoiceModelFiles files, List<VoiceModelAsset> assets) =>
        assets.every((a) => files.host(a.guestPath).readAsBytesSync().every((b) => b == 7));

    bool replaced(VoiceModelFiles files, List<VoiceModelAsset> assets) =>
        files.complete(assets) && assets.every((a) => files.host(a.guestPath).readAsBytesSync().every((b) => b == 1));

    Directory staging(VoiceModelFiles files) => Directory(files.host(VoiceModelPaths.staging).path);

    List<bool?> bundleSwitches() => [
      for (final a in engine.carrier.argsOf('pluginManager/setBundleEnabled')) a['enabled'] as bool?,
    ];

    test('cancelled midway: the model in place stays, still ready', () async {
      final (c, files, assets) = await ready();
      final notifier = c.read(voiceModelProvider.notifier);
      platform.hold = Completer<void>();
      unawaited(notifier.redownload());
      await settle(c, (s) => s.status == VoiceModelStatus.downloading && platform.downloads.length == 2);
      expect(files.complete(assets), isTrue, reason: 'nothing is removed while the new copy comes in');
      expect(untouched(files, assets), isTrue);
      expect(engine.enabled, isTrue);
      await notifier.cancel();
      final s = await settle(c, (s) => s.status == VoiceModelStatus.ready);
      expect(s.failure, isNull);
      expect(untouched(files, assets), isTrue);
      expect(engine.enabled, isTrue);
      expect(bundleSwitches(), isNot(contains(false)));
      expect(staging(files).existsSync(), isFalse, reason: 'the half-downloaded copy goes');
    });

    test('the new files go to staging and take the old ones\' place only when all are in and checked', () async {
      final (c, files, assets) = await ready();
      final events = <VoiceModelEvent>[];
      c.read(voiceModelProvider.notifier).events.listen(events.add);
      final hold = platform.hold = Completer<void>();
      unawaited(c.read(voiceModelProvider.notifier).redownload());
      await settle(c, (s) => s.status == VoiceModelStatus.downloading && platform.downloads.length == 2);
      final jobs = platform.downloads.last;
      expect(jobs.map((j) => j.path), everyElement(startsWith(staging(files).path)));
      expect(jobs.map((j) => j.sha256), assets.map((a) => a.sha256), reason: 'each checked against the lock');
      expect(untouched(files, assets), isTrue);
      hold.complete();
      await settle(c, (s) => s.status == VoiceModelStatus.ready && replaced(files, assets));
      expect(staging(files).existsSync(), isFalse);
      expect(engine.enabled, isTrue);
      expect(bundleSwitches(), isNot(contains(false)), reason: 'voice input never went away');
      expect(events.map((e) => e.kind), [VoiceModelEventKind.started, VoiceModelEventKind.ready]);
      expect(events.first.bytes, _total, reason: 'the whole model comes again');
    });

    test('a failed download keeps the model and offers 重试 for the same thing', () async {
      final (c, files, assets) = await ready();
      final events = <VoiceModelEvent>[];
      c.read(voiceModelProvider.notifier).events.listen(events.add);
      platform.failWith = VoiceDownloadError.network;
      final prepares = engine.calls.where((e) => e == 'speech/prepare').length;
      await c.read(voiceModelProvider.notifier).redownload();
      final s = await settle(c, (s) => s.status == VoiceModelStatus.ready);
      expect(s.failure, isNull);
      expect(untouched(files, assets), isTrue);
      expect(staging(files).existsSync(), isFalse);
      expect(engine.enabled, isTrue);
      expect(engine.calls.where((e) => e == 'speech/prepare').length, prepares, reason: 'no engine download either');
      final failed = events.lastWhere((e) => e.kind == VoiceModelEventKind.failed);
      expect(failed.failure, VoiceModelFailure.network);
      expect(failed.again, isTrue);
    });
  });

  test('download progress reaches the notification at most twice a second, and only when it moved', () async {
    VoiceModelController.noticeEvery = const Duration(milliseconds: 500);
    platform
      ..steps = 20
      ..stepDelay = const Duration(milliseconds: 25);
    final c = container();
    await listen(c);
    c.read(voiceModelProvider.notifier).noticeText = VoiceModelNoticeText(
      downloading: (p) => 'dl $p',
      preparing: 'checking',
      ready: 'ready',
      failed: 'failed',
    );
    await c.read(voiceModelProvider.notifier).download();
    // About 1.5 s of progress: longer than [settle] waits.
    for (var i = 0; i < 100 && c.read(voiceModelProvider).status != VoiceModelStatus.ready; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    expect(c.read(voiceModelProvider).status, VoiceModelStatus.ready);
    // The last line waits out its half second.
    await Future<void>.delayed(const Duration(milliseconds: 700));
    final times = platform.noticeTimes;
    expect(platform.notices.where((n) => n.$1?.startsWith('dl ') ?? false).length, greaterThan(1), reason: 'it moves');
    for (var i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1], greaterThanOrEqualTo(const Duration(milliseconds: 450)), reason: 'line $i');
      expect(platform.notices[i], isNot(platform.notices[i - 1]), reason: 'line $i repeats the one before');
    }
    expect(platform.notices.last, (null, null), reason: 'in the foreground the finished line leaves');
  });
}
