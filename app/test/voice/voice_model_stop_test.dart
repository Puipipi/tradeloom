// Delete after a cancel whose download has not said it stopped writing
// (CR-62ed230 S1), 重新下载's staging copy included: a stop wait that runs
// out is not a stop. Nothing is
// deleted and nothing reports success; once the download has stopped, the
// delete goes through. The production controller and VoiceModelFiles run
// unchanged; only the VoiceModelPlatform / RPC seams are controlled.

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

/// A download that writes a .part at once, then goes on writing (the final
/// file) only when [release] completes, and reports only after that. With
/// [spawning], its handle reaches the app only when that completes (the
/// isolate already runs while it is being started).
class _HeldWriter implements VoiceModelPlatform {
  _HeldWriter(this.root, {this.spawning});
  final Directory root;
  final Completer<void>? spawning;
  final started = Completer<void>();
  final cancelled = Completer<void>();
  final release = Completer<void>();
  final stopped = Completer<void>();
  final progress = StreamController<int>.broadcast();
  late VoiceDownloadJob job;
  late Future<void> worker;

  @override
  Future<VoiceModelFiles?> files() async => VoiceModelFiles(root);
  @override
  Future<int?> freeBytes() async => 1 << 40;
  @override
  Future<bool> metered() async => false;
  @override
  Future<void> notice(String? text, {int? progress}) async {}
  @override
  Future<VoiceDownloadRun> download(List<VoiceDownloadJob> jobs) async {
    job = jobs.first;
    File(job.partPath)
      ..createSync(recursive: true)
      ..writeAsBytesSync(List.filled(16, 1));
    worker = () async {
      await release.future;
      File(job.path)
        ..createSync(recursive: true)
        ..writeAsBytesSync(List.filled(job.bytes, 7));
      stopped.completeError(const VoiceDownloadException(VoiceDownloadError.cancelled));
      await progress.close();
    }();
    started.complete();
    if (spawning case final s?) await s.future;
    return VoiceDownloadRun(
      progress: progress.stream,
      done: stopped.future,
      cancel: () {
        if (!cancelled.isCompleted) cancelled.complete();
      },
    );
  }
}

/// Two downloads, one after the other (CR-7881a22 S1): the first writes a
/// .part at once, hands its handle over only when [firstHandle] completes
/// and goes on writing (its final file) until [firstRelease]; the second
/// puts every file in place and is done at once.
class _TwoWriters implements VoiceModelPlatform {
  _TwoWriters(this.root);
  final Directory root;
  final firstStarted = Completer<void>();
  final firstHandle = Completer<void>();
  final firstCancelled = Completer<void>();
  final firstRelease = Completer<void>();
  final firstStopped = Completer<void>();
  final firstProgress = StreamController<int>.broadcast();
  late VoiceDownloadJob firstJob;
  Future<void> firstWorker = Future<void>.value();
  int downloads = 0;
  bool secondDone = false;

  @override
  Future<VoiceModelFiles?> files() async => VoiceModelFiles(root);
  @override
  Future<int?> freeBytes() async => 1 << 40;
  @override
  Future<bool> metered() async => false;
  @override
  Future<void> notice(String? text, {int? progress}) async {}
  @override
  Future<VoiceDownloadRun> download(List<VoiceDownloadJob> jobs) async {
    downloads++;
    if (downloads == 1) {
      firstJob = jobs.first;
      File(firstJob.partPath)
        ..createSync(recursive: true)
        ..writeAsBytesSync(List.filled(16, 1));
      firstWorker = () async {
        await firstRelease.future;
        File(firstJob.path)
          ..createSync(recursive: true)
          ..writeAsBytesSync(List.filled(firstJob.bytes, 7));
        firstStopped.completeError(const VoiceDownloadException(VoiceDownloadError.cancelled));
        await firstProgress.close();
      }();
      firstStarted.complete();
      await firstHandle.future;
      return VoiceDownloadRun(
        progress: firstProgress.stream,
        done: firstStopped.future,
        cancel: () {
          if (!firstCancelled.isCompleted) firstCancelled.complete();
        },
      );
    }
    for (final job in jobs) {
      File(job.path)
        ..createSync(recursive: true)
        ..writeAsBytesSync(List.filled(job.bytes, 3));
    }
    secondDone = true;
    return VoiceDownloadRun(progress: const Stream<int>.empty(), done: Future<void>.value(), cancel: () {});
  }
}

class _Local extends LocalConnectionController {
  _Local(this.client);
  final DshClient client;
  @override
  Future<HostConnection?> build() async => HostConnection(client: client, isLocal: true);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory root;
  late VoiceModelFiles files;
  late Directory models;
  var enabled = true;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('voice-stop');
    files = VoiceModelFiles(root);
    files.host(VoiceModelPaths.lock)
      ..createSync(recursive: true)
      ..writeAsStringSync(
        rc2Lock
            .replaceFirst('"bytes": 239233841', '"bytes": 1000')
            .replaceFirst('"bytes": 315894', '"bytes": 40')
            .replaceFirst('"bytes": 1807522', '"bytes": 60'),
      );
    models = Directory(files.host(VoiceModelPaths.models).path);
    enabled = true;
  });
  tearDown(() async {
    VoiceModelController.downloadStopWait = const Duration(seconds: 10);
    await root.delete(recursive: true);
  });

  /// [ready]: whether the engine says the model is ready (else unprepared).
  ProviderContainer container(VoiceModelPlatform platform, {bool Function()? ready}) {
    final client = DshClient.withCarrier(
      FakeRpcCarrier({
        'pluginManager/listBundles': (_) => [
          {'name': voiceInputBundle, 'official': true, 'optional': true, 'enabled': enabled},
        ],
        'pluginManager/setBundleEnabled': (args) {
          enabled = args['enabled'] == true;
          return {
            'stage': 'enable',
            'target': voiceInputBundle,
            'enabled': enabled,
            'changed': true,
            'application': 'applied',
          };
        },
        'speech/catalog': (_) => {
          'providers': [
            {
              'id': voiceModelProviderId,
              'name': 'SenseVoiceSmall (INT8)',
              'location': 'host-local',
              'preparation': {'phase': enabled && (ready?.call() ?? false) ? 'ready' : 'unprepared'},
            },
          ],
          'selection': {'providerId': voiceModelProviderId, 'language': 'auto'},
          'maxAudioBytes': 4194304,
          'maxDurationSeconds': 120,
        },
        'speech/cancelPreparation': (_) => null,
      }),
    );
    final c = ProviderContainer(
      overrides: [
        voiceModelPlatformProvider.overrideWithValue(platform),
        localConnectionProvider.overrideWith(() => _Local(client)),
      ],
    );
    addTearDown(c.dispose);
    c.listen(voiceModelProvider, (_, _) {}, fireImmediately: true);
    return c;
  }

  testWidgets('a download still writing at the 10 s stop deadline: nothing is deleted; '
      'once it stopped, delete goes through', (tester) async {
    late _HeldWriter platform;
    late ProviderContainer c;
    late VoiceModelController controller;
    late Future<void> downloading;
    // File setup and the real writer run outside the test clock. Only the
    // controller's stop deadline below is advanced; the writer stays held.
    await tester.runAsync(() async {
      platform = _HeldWriter(root);
      c = container(platform);
      await c.read(localConnectionProvider.future);
      controller = c.read(voiceModelProvider.notifier);
      downloading = controller.download();
      await platform.started.future;
      await Future<void>.delayed(Duration.zero);
    });
    expect(models.existsSync(), isTrue);
    expect(VoiceModelController.downloadStopWait, const Duration(seconds: 10));

    bool? deleted;
    final deleting = controller.delete().then((value) => deleted = value);
    await tester.pump();
    expect(platform.cancelled.isCompleted, isTrue);
    expect(deleted, isNull);
    await tester.pump(const Duration(milliseconds: 9999));
    expect(deleted, isNull, reason: 'the stop deadline has not elapsed');
    expect(platform.stopped.isCompleted, isFalse);
    await tester.pump(const Duration(milliseconds: 1));
    await deleting;
    expect(platform.stopped.isCompleted, isFalse);
    expect(deleted, isFalse, reason: 'no success without the download having stopped');
    expect(models.existsSync(), isTrue);
    expect(File(platform.job.partPath).lengthSync(), 16, reason: 'nothing deleted');
    expect(enabled, isTrue, reason: 'nothing changed on the engine either');
    expect(controller.downloadStopping, isTrue);

    // Advancing the stop timer did not complete the writer. Release it for
    // real, then require the actual file deletion to succeed.
    await tester.runAsync(() async {
      platform.release.complete();
      await platform.worker;
      await downloading;
      expect(controller.downloadStopping, isFalse);
      expect(File(platform.job.path).lengthSync(), 1000);
      expect(await controller.delete(), isTrue);
      expect(models.existsSync(), isFalse);
      expect(enabled, isFalse);
    });
    // cancel also queued the notification coalescer's ordinary window.
    // Drain that test-zone timer before the widget binding checks cleanup.
    await tester.pump(VoiceModelController.noticeEvery);
  }, timeout: const Timeout(Duration(seconds: 30)));

  test('a delete while the download is still being started (no handle yet) waits for it, not for the clock', () async {
    VoiceModelController.downloadStopWait = const Duration(milliseconds: 200);
    final spawning = Completer<void>();
    final platform = _HeldWriter(root, spawning: spawning);
    final c = container(platform);
    await c.read(localConnectionProvider.future);
    final controller = c.read(voiceModelProvider.notifier);
    final downloading = controller.download();
    await platform.started.future;
    // Nothing to cancel yet: the handle has not come back.
    expect(await controller.delete(), isFalse);
    expect(controller.downloadStopping, isTrue);
    expect(models.existsSync(), isTrue);
    expect(enabled, isTrue);

    // The handle arrives: the cancelled run stops it; once it reports, delete goes through.
    spawning.complete();
    await platform.cancelled.future;
    platform.release.complete();
    await platform.worker;
    await downloading;
    expect(await controller.delete(), isTrue);
    expect(models.existsSync(), isFalse);
    expect(enabled, isFalse);
  });

  test('a download that never reports keeps every delete from going through, and nothing stays busy', () async {
    VoiceModelController.downloadStopWait = const Duration(milliseconds: 200);
    final platform = _HeldWriter(root);
    final c = container(platform);
    await c.read(localConnectionProvider.future);
    final controller = c.read(voiceModelProvider.notifier);
    final downloading = controller.download();
    await platform.started.future;
    await Future<void>.delayed(Duration.zero);
    for (var attempt = 0; attempt < 2; attempt++) {
      expect(await controller.delete(), isFalse);
      expect(controller.downloadStopping, isTrue);
      expect(File(platform.job.partPath).existsSync(), isTrue);
      expect(enabled, isTrue);
    }
    // The card offers its buttons again (download, or delete later), not a stuck progress bar.
    for (var i = 0; i < 100 && c.read(voiceModelProvider).busy; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(c.read(voiceModelProvider).status, VoiceModelStatus.absent);
    // Let it end, so nothing writes after the test.
    platform.release.complete();
    await platform.worker;
    await downloading;
  });

  // CR-7881a22 S1: a cancelled run can end while its download is still
  // stopping (the handle came back after the cancel: the run stops it and
  // returns), and the retry starts another. The newer download finishing
  // says nothing about the older one: no delete goes through until every
  // download that may still write has said it stopped. Both orders: the
  // handle back after the delete's wait ran out, and during it.
  for (final handleDuringWait in [false, true]) {
    final when = handleDuringWait ? 'during the delete\'s wait' : 'after the delete\'s wait ran out';
    test('the older download\'s handle back $when, then a retry that finishes: no delete until the older one '
        'stopped too', () async {
      VoiceModelController.downloadStopWait = const Duration(milliseconds: 300);
      final platform = _TwoWriters(root);
      addTearDown(() async {
        if (!platform.firstHandle.isCompleted) platform.firstHandle.complete();
        if (!platform.firstRelease.isCompleted) platform.firstRelease.complete();
        await platform.firstWorker;
      });
      final c = container(platform, ready: () => platform.secondDone);
      await c.read(localConnectionProvider.future);
      final controller = c.read(voiceModelProvider.notifier);
      final first = controller.download();
      await platform.firstStarted.future;

      // No handle yet: nothing to cancel, the delete keeps everything.
      final deleting = controller.delete();
      if (handleDuringWait) platform.firstHandle.complete();
      expect(await deleting, isFalse);
      expect(models.existsSync(), isTrue);
      expect(enabled, isTrue);
      if (!handleDuringWait) platform.firstHandle.complete();

      // The stale run gets its handle, stops it and returns; it is still writing.
      await platform.firstCancelled.future;
      await first;
      expect(platform.firstStopped.isCompleted, isFalse);
      expect(controller.downloadStopping, isTrue);

      // 下载 again: the newer download finishes and the model is ready.
      await controller.download();
      expect(platform.downloads, 2);
      expect(platform.secondDone, isTrue);
      expect(c.read(voiceModelProvider).status, VoiceModelStatus.ready);
      expect(controller.downloadStopping, isTrue, reason: 'the older download has not said it stopped');

      // 删除: the older one may still write after it, so nothing goes.
      expect(await controller.delete(), isFalse, reason: 'a newer finished download does not stand for an older one');
      expect(models.existsSync(), isTrue, reason: 'nothing deleted while the older download may still write');
      expect(enabled, isTrue, reason: 'nothing changed on the engine either');
      expect(controller.downloadStopping, isTrue);

      // The older one stops (its last write lands): now the delete goes through.
      platform.firstRelease.complete();
      await platform.firstWorker;
      await Future<void>.delayed(Duration.zero);
      expect(controller.downloadStopping, isFalse);
      expect(await controller.delete(), isTrue);
      expect(models.existsSync(), isFalse);
      expect(enabled, isFalse);
    });
  }

  // 重新下载 (SMOKE-098-5) with CR-62ed230 / CR-7881a22: its copy comes into
  // staging, and staging counts as "may still be written" too. Cancelled
  // while its download does not stop: the model in place stays as it was,
  // the copy stays where it is, and delete changes nothing until the
  // download has said it stopped.
  test('重新下载 cancelled, its download slow to stop: delete is refused and the model stays; once it stopped, '
      'delete takes the model and the copy', () async {
    VoiceModelController.downloadStopWait = const Duration(milliseconds: 200);
    // The model in place, ready on the engine.
    final assets = files.assets()!;
    for (final a in assets) {
      files.host(a.guestPath)
        ..createSync(recursive: true)
        ..writeAsBytesSync(List.filled(a.bytes, 5));
    }
    bool kept() => assets.every((a) => files.host(a.guestPath).readAsBytesSync().every((b) => b == 5));
    final staging = Directory(files.host(VoiceModelPaths.staging).path);
    final platform = _HeldWriter(root);
    addTearDown(() async {
      if (!platform.release.isCompleted) platform.release.complete();
      if (platform.started.isCompleted) await platform.worker;
    });
    final c = container(platform, ready: () => true);
    await c.read(localConnectionProvider.future);
    final controller = c.read(voiceModelProvider.notifier);
    for (var i = 0; i < 100 && c.read(voiceModelProvider).status != VoiceModelStatus.ready; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(c.read(voiceModelProvider).status, VoiceModelStatus.ready);

    // 重新下载: its first file is coming into staging.
    final redownloading = controller.redownload();
    await platform.started.future;
    await Future<void>.delayed(Duration.zero);
    expect(platform.job.path, startsWith(staging.path));
    expect(File(platform.job.partPath).existsSync(), isTrue);

    // 取消: the download is told to stop and does not, within the wait.
    await controller.cancel();
    await platform.cancelled.future;
    expect(platform.stopped.isCompleted, isFalse);
    expect(controller.downloadStopping, isTrue);
    expect(File(platform.job.partPath).existsSync(), isTrue, reason: 'staging may still be written: left alone');
    expect(c.read(voiceModelProvider).status, VoiceModelStatus.ready, reason: 'the model in place is still in use');

    // 删除: refused, nothing changes.
    expect(await controller.delete(), isFalse);
    expect(kept(), isTrue, reason: 'the model in place stays');
    expect(enabled, isTrue, reason: 'nothing changed on the engine');
    expect(File(platform.job.partPath).existsSync(), isTrue);
    expect(controller.downloadStopping, isTrue);

    // The download stops; its last write lands in staging, never in the model.
    platform.release.complete();
    await platform.worker;
    await redownloading;
    expect(controller.downloadStopping, isFalse);
    expect(File(platform.job.path).existsSync(), isTrue);
    expect(kept(), isTrue);

    // 删除 again: now it goes through, the copy with it.
    expect(await controller.delete(), isTrue);
    expect(models.existsSync(), isFalse);
    expect(staging.existsSync(), isFalse);
    expect(enabled, isFalse);
  });
}
