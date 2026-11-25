import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/diagnostics/diagnostics_bundle.dart';
import 'package:dsh_app/diagnostics/diagnostics_channel.dart';
import 'package:dsh_app/diagnostics/diagnostics_export.dart';
import 'package:dsh_app/runtime/local_footprint.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/artifacts.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/onboarding_state.dart';
import 'package:dsh_app/state/phone_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/common/app_sheet.dart';
import 'package:dsh_app/ui/common/side_insets.dart';
import 'package:dsh_app/ui/engine/diagnostics_export_card.dart';
import 'package:dsh_app/ui/onboarding/runtime_setup_page.dart';
import 'package:dsh_app/ui/shell/root_gate.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:share_plus/share_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../diagnostics/support/zip_reader.dart';
import '../shell/golden_harness.dart' show FakeOnboardingPrefs, FakeRuntime, FakeSettings, usePhoneSurface;
import '../support/test_fonts.dart';

const _newRuntime = 'test-bundled-runtime';
const _installError = 'install failed: Compressed data is corrupt';
const _memoryLog = '[installer] in-memory unpack failure';
const _diskLog = '[installer] disk unpack failure';
const _fakeSecret = 'test-only-diagnostic-token';
final _at = DateTime.utc(2026, 11, 5, 12, 34, 56);

class _Runtime extends FakeRuntime {
  _Runtime(RuntimeStatus status, {this.rejectInstall = false}) : super(LocalRuntimeState(loaded: true, status: status));

  final bool rejectInstall;
  final mutations = <String>[];

  @override
  Future<void> install() async {
    mutations.add('install');
    if (rejectInstall) throw PlatformException(code: 'unavailable');
  }

  @override
  Future<void> installDroppingKept() async => mutations.add('drop-kept');
  @override
  Future<void> start() async => mutations.add('start');
  @override
  Future<void> startIn(EngineMode mode) async => mutations.add('start-${mode.name}');
  @override
  Future<void> stop() async => mutations.add('stop');
  @override
  Future<void> reset() async => mutations.add('reset');
  @override
  Future<void> resetKeeping(ResetKeep keep) async => mutations.add('reset-keeping');
}

class _Logs extends LocalRuntimeLogsController {
  @override
  List<String> build() => const [_memoryLog, 'token=$_fakeSecret'];
}

class _Bridge extends RuntimeBridge {
  int logReads = 0;

  @override
  Stream<RuntimeEvent> get events => const Stream.empty();
  @override
  Future<List<String>> logs({int lines = 500}) async {
    logReads++;
    throw PlatformException(code: 'unavailable');
  }
}

class _Native extends DiagnosticsChannel {
  _Native({this.failReads = false});

  final bool failReads;
  int infoReads = 0;
  int logReads = 0;

  @override
  Future<NativeDiagnostics> info() async {
    infoReads++;
    if (failReads) throw PlatformException(code: 'unavailable');
    return const NativeDiagnostics(
      app: {'versionName': 'test-app'},
      device: {'model': 'test-phone'},
      manifest: {'runtimeVersion': _newRuntime},
    );
  }

  @override
  Future<List<String>> engineLog({int maxBytes = 512 * 1024}) async {
    logReads++;
    if (failReads) throw PlatformException(code: 'unavailable');
    return const [_diskLog, 'token=$_fakeSecret'];
  }
}

class _Phone extends PhoneChannel {
  @override
  Future<PhoneStatus> status() async => const PhoneStatus.notReady();
}

class _Files extends FilesChannel {
  final saved = <({String name, String mime, Uint8List bytes})>[];

  @override
  Future<String> saveToDownloads(String hostPath, {required String name, required String mime}) async {
    saved.add((name: name, mime: mime, bytes: await File(hostPath).readAsBytes()));
    return 'Download/DSH-Go/$name';
  }
}

class _Active extends ActiveHostController {
  _Active(this.host);
  final HostRef host;
  @override
  HostRef build() => host;
}

class _NoConnection extends LocalConnectionController {
  _NoConnection(this.onRead);
  final VoidCallback onRead;
  @override
  Future<HostConnection?> build() async {
    onRead();
    return null;
  }
}

// Only expose the completion of the real exporter. Both operations delegate
// to production code, including collectDiagnostics, ZIP creation and cleanup.
class _ObservedExporter extends DiagnosticsExporter {
  _ObservedExporter({
    required super.collect,
    required super.files,
    required super.share,
    required super.cacheRoot,
    required super.clock,
  });

  Future<Object?>? operation;

  @override
  Future<String> saveToDownloads({void Function(DiagnosticsStep step)? onStep}) {
    final result = super.saveToDownloads(onStep: onStep);
    operation = result;
    return result;
  }

  @override
  Future<bool> share({void Function(DiagnosticsStep step)? onStep}) {
    final result = super.share(onStep: onStep);
    operation = result;
    return result;
  }
}

class _Fixture {
  _Fixture(RuntimeStatus status, {bool rejectInstall = false, bool failReads = false})
    : runtime = _Runtime(status, rejectInstall: rejectInstall),
      native = _Native(failReads: failReads),
      cache = Directory.systemTemp.createTempSync('runtime-setup-diagnostics-') {
    addTearDown(() => cache.deleteSync(recursive: true));
  }

  final _Runtime runtime;
  final _Native native;
  final Directory cache;
  final bridge = _Bridge();
  final files = _Files();
  final shared = <({ShareParams params, Uint8List bytes})>[];
  late _ObservedExporter exporter;
  int exporterBuilds = 0;
  int activeConnectionReads = 0;
  int localConnectionReads = 0;
  int linkBuilds = 0;
  int completed = 0;
  int remoteChoices = 0;

  Future<void> pump(
    WidgetTester tester, {
    bool rootGate = false,
    HostRef host = HostRef.local,
    Size size = const Size(390, 844),
    double scale = 1,
  }) async {
    usePhoneSurface(tester);
    tester.view.physicalSize = size * tester.view.devicePixelRatio;
    tester.platformDispatcher.textScaleFactorTestValue = scale;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          onboardingPrefsProvider.overrideWith(FakeOnboardingPrefs.new),
          localRuntimeProvider.overrideWith(() => runtime),
          localRuntimeLogsProvider.overrideWith(_Logs.new),
          runtimeBridgeProvider.overrideWithValue(bridge),
          diagnosticsChannelProvider.overrideWithValue(native),
          phoneChannelProvider.overrideWithValue(_Phone()),
          settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true, autoStartLocal: true))),
          localFootprintProvider.overrideWith((ref) async => const LocalFootprint()),
          activeHostProvider.overrideWith(() => _Active(host)),
          activeConnectionProvider.overrideWith((ref) {
            activeConnectionReads++;
            return const AsyncData<HostConnection?>(null);
          }),
          localConnectionProvider.overrideWith(() => _NoConnection(() => localConnectionReads++)),
          hostLinkProvider.overrideWith((ref, host) {
            linkBuilds++;
            throw StateError('diagnostics must not initialize a link');
          }),
          diagnosticsExporterProvider.overrideWith((ref) {
            exporterBuilds++;
            return exporter = _ObservedExporter(
              collect: (at) => collectDiagnostics(ref, at),
              files: files,
              cacheRoot: () async => cache,
              clock: () => _at,
              share: (params) async {
                shared.add((params: params, bytes: await params.files!.single.readAsBytes()));
                return ShareResultStatus.success;
              },
            );
          }),
        ],
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: withTestFonts(buildLightTheme()),
          locale: const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: MirroredSideInsets(child: child!),
          ),
          home: rootGate
              ? const RootGate(home: Scaffold(body: Text('finished-home')))
              : RuntimeSetupPage(onDone: () => completed++, onRemote: () => remoteChoices++),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  void expectNoExportSideEffects({List<String> earlierMutations = const []}) {
    expect(runtime.mutations, earlierMutations);
    expect(activeConnectionReads, 0);
    expect(localConnectionReads, 0);
    expect(linkBuilds, 0);
    expect(remoteChoices, 0);
    expect(completed, 0);
  }

  Future<void> export(WidgetTester tester, String action) async {
    // Real file I/O is awaited in a real-async zone. The observed operation
    // includes the save's finally cleanup; no wall-clock sleeps are used.
    await tester.runAsync(() async {
      await tester.tap(find.text(action));
      expect(exporterBuilds, 1);
      expect(exporter.operation, isNotNull);
      await exporter.operation;
    });
    await tester.pumpAndSettle();
  }
}

Finder get _exportEntry => find.widgetWithText(TextButton, '导出诊断包');

Future<void> _openExport(WidgetTester tester) async {
  expect(_exportEntry, findsOneWidget);
  await tester.ensureVisible(_exportEntry);
  await tester.tap(_exportEntry);
  await tester.pumpAndSettle();
  expect(find.byType(DiagnosticsExportCard), findsOneWidget);
  expect(find.text('存到「下载」'), findsOneWidget);
  expect(find.text('分享诊断包'), findsOneWidget);
}

Map<String, String> _unzip(Uint8List bytes) => {
  for (final entry in readZip(bytes)) entry.name: utf8.decode(entry.data),
};

void _expectBundle(
  Uint8List bytes, {
  required RuntimeStatus status,
  required String log,
  required bool hasNativeFacts,
}) {
  final entries = _unzip(bytes);
  expect(entries.keys, containsAll(['summary.json', 'settings.json', 'engine.log']));
  expect(entries, isNot(contains('crash.json')));
  final summary = jsonDecode(entries['summary.json']!) as Map;
  expect(summary['generatedAt'], _at.toIso8601String());
  expect(summary['connection'], containsPair('host', 'not_observed'));
  expect(summary['connection'], containsPair('state', 'not_observed'));
  final runtime = summary['runtime'] as Map;
  expect(runtime['phase'], status.phase.name);
  expect(runtime['installedVersion'], status.installedVersion);
  expect(runtime['bundledVersion'], status.bundledVersion);
  expect(runtime['error'], status.error);
  expect(runtime['baseUrl'], isNull);
  expect(runtime, isNot(contains('token')));
  if (hasNativeFacts) {
    expect((summary['app'] as Map)['versionName'], 'test-app');
    expect(summary['device'], {'model': 'test-phone'});
    expect(summary['manifest'], {'runtimeVersion': _newRuntime});
  } else {
    expect(summary['device'], isEmpty);
    expect(summary['manifest'], isEmpty);
  }
  expect(entries['engine.log'], contains(log));
  expect(entries.values.join(), isNot(contains(_fakeSecret)));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('RootGate first-install failure saves real diagnostics without starting or connecting', (tester) async {
    const status = RuntimeStatus(phase: RuntimePhase.error, bundledVersion: _newRuntime, error: _installError);
    final fixture = _Fixture(status);
    await fixture.pump(tester, rootGate: true);
    expect(find.byType(RuntimeSetupPage), findsOneWidget);
    expect(find.text('finished-home'), findsNothing);
    await _openExport(tester);
    await fixture.export(tester, '存到「下载」');

    final saved = fixture.files.saved.single;
    expect(saved.name, 'dsh-go-diagnostics-20261105-123456.zip');
    expect(saved.mime, 'application/zip');
    _expectBundle(saved.bytes, status: status, log: _diskLog, hasNativeFacts: true);
    expect(fixture.native.infoReads, 1);
    expect(fixture.native.logReads, 1);
    expect(fixture.bridge.logReads, 0);
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('已存到 下载/DSH-Go/${saved.name}'), findsOneWidget);
    expect(fixture.cache.listSync(recursive: true).whereType<File>(), isEmpty);
    expect(find.byType(RuntimeSetupPage), findsOneWidget);
    fixture.expectNoExportSideEffects();
    expect(tester.takeException(), isNull);
  });

  testWidgets('failed upgrade shares a real ZIP using memory fallback while a remote host is unobserved', (
    tester,
  ) async {
    const status = RuntimeStatus(
      phase: RuntimePhase.error,
      bundledVersion: _newRuntime,
      installedVersion: 'test-old-runtime',
      error: _installError,
    );
    final fixture = _Fixture(status, failReads: true);
    await fixture.pump(tester, host: const HostRef.ssh('unobserved-test-host'));
    final container = ProviderScope.containerOf(tester.element(find.byType(RuntimeSetupPage)));
    expect(container.read(activeHostProvider), const HostRef.ssh('unobserved-test-host'));
    await _openExport(tester);
    await fixture.export(tester, '分享诊断包');

    final shared = fixture.shared.single;
    expect(shared.params.files!.single.mimeType, 'application/zip');
    expect(shared.params.fileNameOverrides, ['dsh-go-diagnostics-20261105-123456.zip']);
    _expectBundle(shared.bytes, status: status, log: _memoryLog, hasNativeFacts: false);
    expect(fixture.native.infoReads, 1);
    expect(fixture.native.logReads, 1);
    expect(fixture.bridge.logReads, 1);
    expect(fixture.files.saved, isEmpty);
    expect(find.byType(BottomSheet), findsNothing);
    fixture.expectNoExportSideEffects();
    expect(tester.takeException(), isNull);
  });

  testWidgets('kept-file restore failure opens and cancels diagnostics before any retry or discard', (tester) async {
    final fixture = _Fixture(
      const RuntimeStatus(
        phase: RuntimePhase.error,
        bundledVersion: _newRuntime,
        error: 'install failed: keep: could not restore retained files',
      ),
    );
    await fixture.pump(tester);
    expect(find.text('没能放回保留的内容'), findsOneWidget);
    expect(find.widgetWithText(TextButton, '不保留，继续安装'), findsOneWidget);
    await _openExport(tester);
    await tester.tap(find.byType(SheetDragHandle));
    await tester.pumpAndSettle();

    expect(find.byType(BottomSheet), findsNothing);
    expect(find.widgetWithText(OutlinedButton, '查看日志'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '重试'), findsOneWidget);
    expect(find.widgetWithText(TextButton, '不保留，继续安装'), findsOneWidget);
    expect(fixture.exporterBuilds, 0);
    expect(fixture.native.infoReads, 0);
    fixture.expectNoExportSideEffects();
    expect(tester.takeException(), isNull);
  });

  testWidgets('install request rejected before a native phase report can export without another install', (
    tester,
  ) async {
    const status = RuntimeStatus(phase: RuntimePhase.notInstalled, bundledVersion: _newRuntime);
    final fixture = _Fixture(status, rejectInstall: true);
    await fixture.pump(tester);
    expect(fixture.runtime.mutations, ['install']);
    expect(find.widgetWithText(FilledButton, '重试'), findsOneWidget);
    await _openExport(tester);
    await fixture.export(tester, '存到「下载」');

    _expectBundle(fixture.files.saved.single.bytes, status: status, log: _diskLog, hasNativeFacts: true);
    fixture.expectNoExportSideEffects(earlierMutations: ['install']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the failure export entry stays reachable on a narrow page with large text', (tester) async {
    final fixture = _Fixture(
      const RuntimeStatus(phase: RuntimePhase.error, bundledVersion: _newRuntime, error: _installError),
    );
    await fixture.pump(tester, size: const Size(320, 640), scale: 2);
    expect(_exportEntry, findsOneWidget);
    await tester.ensureVisible(_exportEntry);
    await tester.pumpAndSettle();

    expect(_exportEntry.hitTestable(), findsOneWidget);
    final entry = tester.getRect(_exportEntry);
    final retry = tester.getRect(find.widgetWithText(FilledButton, '重试'));
    expect(entry.left, greaterThanOrEqualTo(24));
    expect(entry.right, lessThanOrEqualTo(320 - 24));
    expect(entry.top, greaterThanOrEqualTo(retry.bottom));
    expect(fixture.exporterBuilds, 0);
    fixture.expectNoExportSideEffects();
    expect(tester.takeException(), isNull);
  });

  testWidgets('an install in progress retains its existing progress and log actions', (tester) async {
    final fixture = _Fixture(const RuntimeStatus(phase: RuntimePhase.installing, bundledVersion: _newRuntime));
    await fixture.pump(tester);
    expect(_exportEntry, findsNothing);
    expect(find.widgetWithText(TextButton, '查看日志'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '重试'), findsNothing);
    expect(fixture.exporterBuilds, 0);
    fixture.expectNoExportSideEffects();
    expect(tester.takeException(), isNull);
  });

  testWidgets('an engine error with the current runtime still finishes setup instead of becoming an install failure', (
    tester,
  ) async {
    final fixture = _Fixture(
      const RuntimeStatus(
        phase: RuntimePhase.error,
        bundledVersion: _newRuntime,
        installedVersion: _newRuntime,
        error: 'DSH exited unexpectedly (code 1)',
      ),
    );
    await fixture.pump(tester);
    expect(_exportEntry, findsNothing);
    expect(find.widgetWithText(FilledButton, '重试'), findsNothing);
    await tester.pump(const Duration(seconds: 1));
    expect(fixture.completed, 1);
    expect(fixture.runtime.mutations, isEmpty);
    expect(fixture.exporterBuilds, 0);
    expect(tester.takeException(), isNull);
  });
}
