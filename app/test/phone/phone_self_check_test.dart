import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/diagnostics/diagnostics_markdown.dart' show diagnosticsMarkdownBytes;
import 'package:dsh_app/phone/phone_self_check.dart';
import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/ui/phone/phone_self_check_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../shell/golden_harness.dart';
import 'harness.dart' show openPhoneFold;

const _phone = MethodChannel('dsh/phone');
const _files = MethodChannel('dsh/files');
Map<String, Object?> _reply(String state, {String? handle, String? reason, String? profile, List<Object?>? steps}) => {
  'v': 1,
  'accepted': true,
  'coverage': 'partial',
  'state': state,
  'runHandle': ?handle,
  'reason': ?reason,
  'profile': ?profile,
  'steps':
      steps ??
      [
        for (final stage in phoneSelfCheckStages) {'stage': stage, 'state': 'not_run', 'observed': false},
      ],
};
Map<String, Object?> _step(String stage, String state, Object observed, {Object? reason, Object? duration}) => {
  'stage': stage,
  'state': state,
  'observed': observed,
  'reason': ?reason,
  'durationMs': ?duration,
};

class _RecordingReport extends PhoneSelfCheckReport {
  final done = Completer<void>();
  final saved = <PhoneSelfCheckSnapshot>[];
  @override
  Future<void> save(PhoneSelfCheckSnapshot snapshot) {
    saved.add(snapshot);
    return done.future;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_files, null);
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_files, null);
  });

  test('strict response types and unknown versions never become available', () {
    for (final field in ['v', 'accepted', 'coverage', 'state', 'steps']) {
      expect(PhoneSelfCheckSnapshot.parse(_reply('done')..remove(field)).available, isFalse);
    }
    for (final version in <Object?>[null, true, '1', 1.0, 2]) {
      expect(PhoneSelfCheckSnapshot.parse(_reply('done')..['v'] = version).available, isFalse);
    }
    expect(PhoneSelfCheckSnapshot.parse(_reply('done')..['accepted'] = 'true').available, isFalse);
    expect(PhoneSelfCheckSnapshot.parse(_reply('future-state')).available, isFalse);
    expect(PhoneSelfCheckSnapshot.parse(_reply('running')).available, isFalse);
    expect(PhoneSelfCheckSnapshot.parse(_reply('running', handle: 'x' * 257)).available, isFalse);
  });

  test('pass requires actual observation and no contradictory fault', () {
    for (final step in [
      _step('input_probe', 'pass', false),
      _step('input_probe', 'pass', 'true'),
      _step('input_probe', 'pass', true, reason: 'unrecognized private error'),
      _step('input_probe', 'pass', true, reason: 'inputRejected'),
      _step('input_probe', 'pass', true, duration: -1),
      _step('input_probe', 'pass', true, duration: 2.0),
      _step('input_probe', 'future-state', true),
    ]) {
      final snapshot = PhoneSelfCheckSnapshot.parse(_reply('done', steps: [step]));
      expect(snapshot.steps.firstWhere((s) => s.stage == 'input_probe').state, 'unknown');
    }
    final good = PhoneSelfCheckSnapshot.parse(_reply('done', steps: [_step('input_probe', 'pass', true, duration: 8)]));
    expect(good.steps.firstWhere((s) => s.stage == 'input_probe').state, 'pass');
  });

  test('unsupported and future stages cannot claim coverage', () {
    final snapshot = PhoneSelfCheckSnapshot.parse(
      _reply(
        'done',
        steps: [_step('ocr', 'pass', true), _step('text_zh', 'pass', true), _step('future-stage', 'pass', true)],
      ),
    );
    expect(snapshot.steps.where((s) => s.state == 'pass'), isEmpty);
    expect(snapshot.steps.firstWhere((s) => s.stage == 'ocr').state, 'not_run');
    expect(snapshot.steps.firstWhere((s) => s.stage == 'text_zh').observed, isFalse);
    expect(snapshot.steps.map((s) => s.stage), phoneSelfCheckStages);
    expect(
      PhoneSelfCheckSnapshot.parse(
        _reply('done', steps: [_step('device', 'pass', true), _step('device', 'fail', true)]),
      ).available,
      isFalse,
    );
  });

  test('native profile alone controls coverage and missing profile remains B', () {
    final allPassed = [for (final stage in phoneSelfCheckStages) _step(stage, 'pass', true)];
    final legacy = PhoneSelfCheckSnapshot.parse(_reply('done', steps: allPassed));
    expect(legacy.profile, 'probe_b');
    expect(legacy.steps.where((s) => s.state == 'pass').map((s) => s.stage), [
      'device',
      'channel',
      'display',
      'input_probe',
      'cleanup',
    ]);
    final target = PhoneSelfCheckSnapshot.parse(_reply('done', profile: 'target_c1', steps: allPassed));
    expect(target.profile, 'target_c1');
    expect(target.steps.where((s) => s.state == 'pass').map((s) => s.stage), [
      'device',
      'channel',
      'display',
      'launch',
      'tree',
      'tap',
      'cleanup',
    ]);
    for (final stage in ['input_probe', 'scroll', 'back', 'text_ascii', 'text_zh', 'capture', 'continuity', 'ocr']) {
      expect(target.steps.firstWhere((s) => s.stage == stage).state, 'not_run');
    }
    for (final profile in <Object?>[null, true, 1, '', 'future', 'target_c1 private']) {
      final unknown = PhoneSelfCheckSnapshot.parse(_reply('done')..['profile'] = profile);
      expect(unknown.available, isFalse);
      expect(unknown.profile, isNull);
      expect(unknown.steps.where((s) => s.state == 'pass'), isEmpty);
    }
  });

  test('C1 MAIN only accepts observed wrong-main failure and never a pass', () {
    for (final step in [
      _step('main', 'pass', true),
      _step('main', 'pass', false),
      _step('main', 'fail', false, reason: 'targetWrongMain'),
      _step('main', 'fail', true, reason: 'targetChanged'),
      _step('main', 'fail', true, reason: 'targetWrongMain', duration: -1),
    ]) {
      final target = PhoneSelfCheckSnapshot.parse(_reply('done', profile: 'target_c1', steps: [step]));
      expect(target.steps.firstWhere((s) => s.stage == 'main').state, 'unknown');
    }
    final actual = _step('main', 'fail', true, reason: 'targetWrongMain', duration: 1);
    final target = PhoneSelfCheckSnapshot.parse(_reply('done', profile: 'target_c1', steps: [actual]));
    final main = target.steps.firstWhere((s) => s.stage == 'main');
    expect(main.state, 'fail');
    expect(main.observed, isTrue);
    expect(main.reason, 'targetWrongMain');
    expect(
      PhoneSelfCheckSnapshot.parse(_reply('done', profile: 'target_c1')).steps
          .firstWhere((s) => s.stage == 'main')
          .state,
      'not_run',
    );
    expect(
      PhoneSelfCheckSnapshot.parse(_reply('done', steps: [actual])).steps.firstWhere((s) => s.stage == 'main').state,
      'not_run',
    );
  });

  test('C1 fixed reasons and report preserve coverage without target identities', () {
    const reasons = {
      'targetUnavailable': 'target_unavailable',
      'targetChanged': 'target_changed',
      'targetCleanupPending': 'target_cleanup',
      'targetWrongMain': 'target_main',
      'targetReadbackMismatch': 'target_readback',
      'treeCleanupPending': 'tree_cleanup',
      'targetLaunchDenied': 'target_launch',
    };
    for (final entry in reasons.entries) {
      final snapshot = PhoneSelfCheckSnapshot.parse(
        _reply(
          'done',
          profile: 'target_c1',
          handle: 'private-handle',
          reason: entry.key,
          steps: [_step('cleanup', 'fail', true, reason: entry.key)],
        ),
      );
      expect(phoneSelfCheckReasonGroup(snapshot.reason), entry.value);
      expect(phoneSelfCheckReasonGroup(snapshot.steps.last.reason), entry.value);
    }
    final snapshot = PhoneSelfCheckSnapshot.parse(
      _reply(
          'done',
          profile: 'target_c1',
          handle: 'private-handle',
          steps: [
            _step('tap', 'pass', true),
            _step('main', 'fail', true, reason: 'targetWrongMain'),
            _step('input_probe', 'pass', true),
          ],
        )
        ..['targetRun'] = 'private-marker'
        ..['stepNonce'] = 'private-nonce'
        ..['component'] = 'private-component',
    );
    final report = phoneSelfCheckMarkdown(snapshot);
    expect(report, contains('Profile: target_c1'));
    expect(report, contains('ordinary display'));
    expect(report, contains('| tap | pass | true |'));
    expect(report, contains('| main | fail | true | target_main |'));
    expect(report, contains('| input_probe | not_run | false |'));
    expect(report, isNot(contains('private-')));
    expect(utf8.encode(report).length, lessThanOrEqualTo(diagnosticsMarkdownBytes));
  });

  test('report is a bounded whitelist with no handles or raw content', () {
    const private = 'private-token-account-ocr-screen-data';
    final snapshot = PhoneSelfCheckSnapshot.parse(
      _reply(
          'done',
          handle: private,
          reason: private,
          steps: [
            _step('input_probe', 'pass', true, duration: 9),
            _step('cleanup', 'fail', true, reason: private),
          ],
        )
        ..['screen'] = private
        ..['engineLog'] = private
        ..['settings'] = private,
    );
    final report = phoneSelfCheckMarkdown(snapshot);
    expect(report, contains('Coverage: partial'));
    expect(report, contains('| input_probe | pass | true |'));
    expect(report, contains('| cleanup | fail | true | other |'));
    expect(report, isNot(contains(private)));
    expect(report, isNot(contains('runHandle')));
    expect(utf8.encode(report).length, lessThanOrEqualTo(diagnosticsMarkdownBytes));
  });

  test('very large unknown strings and times never escape the report budget', () {
    final raw = _reply(
      'done',
      reason: 'secret' * 10000,
      steps: [
        for (final stage in phoneSelfCheckStages)
          _step(stage, 'fail', true, reason: 'secret' * 10000, duration: 9223372036854775807),
      ],
    );
    final text = phoneSelfCheckMarkdown(PhoneSelfCheckSnapshot.parse(raw));
    expect(text, isNot(contains('secret')));
    expect(utf8.encode(text).length, lessThanOrEqualTo(diagnosticsMarkdownBytes));
  });

  test('real channel sends only fixed methods and exact original handle', () async {
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      calls.add(call);
      return _reply('idle');
    });
    const channel = PhoneSelfCheckChannel();
    await channel.status();
    await channel.start();
    await channel.cancel('original');
    expect(calls.map((c) => c.method), [
      'phoneSelfCheckStatus',
      'startPhoneSelfCheck',
      'cancelPhoneSelfCheck',
    ]);
    expect(calls[0].arguments, isNull);
    expect(calls[1].arguments, {'v': 1});
    expect(calls[2].arguments, {'v': 1, 'runHandle': 'original'});
  });

  test('C1 start sends only its fixed profile and invalid choices send nothing', () async {
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      calls.add(call);
      return _reply('running', profile: 'target_c1', handle: 'one');
    });
    const channel = PhoneSelfCheckChannel();
    final snapshot = await channel.start(profile: 'target_c1');
    expect(snapshot.profile, 'target_c1');
    expect(calls.single.method, 'startPhoneSelfCheck');
    expect(calls.single.arguments, {'v': 1, 'profile': 'target_c1'});
    expect((await channel.start(profile: 'future')).available, isFalse);
    expect(calls.length, 1);
  });

  testWidgets('same run cannot change profile and cancellation keeps its original handle', (tester) async {
    var reads = 0;
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      calls.add(call);
      if (call.method == 'cancelPhoneSelfCheck') return _reply('cleaning', profile: 'target_c1', handle: 'one');
      return ++reads == 1 ? _reply('running', profile: 'target_c1', handle: 'one') : _reply('done', handle: 'one');
    });
    final controller = PhoneSelfCheckController();
    await controller.refresh();
    await controller.refresh();
    expect(controller.readFailed, isTrue);
    expect(controller.snapshot.profile, 'target_c1');
    expect(controller.snapshot.state, 'running');
    expect(controller.canStart, isFalse);
    await controller.start(profile: 'probe_b');
    await controller.cancel();
    expect(calls.where((c) => c.method == 'startPhoneSelfCheck'), isEmpty);
    expect(calls.singleWhere((c) => c.method == 'cancelPhoneSelfCheck').arguments, {'v': 1, 'runHandle': 'one'});
    controller.dispose();
  });

  testWidgets('C1 unknown reply does not restart and a late old B read cannot replace new C1', (tester) async {
    final old = Completer<Object?>();
    var reads = 0, starts = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      if (call.method == 'startPhoneSelfCheck') {
        starts++;
        return null;
      }
      if (++reads == 1) return _reply('idle');
      if (reads == 2) return old.future;
      return _reply('running', profile: 'target_c1', handle: 'new-c');
    });
    final controller = PhoneSelfCheckController();
    await controller.refresh();
    unawaited(controller.refresh());
    await tester.pump();
    await controller.start(profile: 'target_c1');
    await controller.start(profile: 'probe_b');
    expect(starts, 1);
    expect(controller.canStart, isFalse);
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pump();
    expect(controller.snapshot.profile, 'target_c1');
    old.complete(_reply('done', handle: 'old-b'));
    await tester.pump();
    expect(controller.snapshot.runHandle, 'new-c');
    expect(controller.snapshot.profile, 'target_c1');
    controller.dispose();
  });

  test('missing or failing native uses fixed unavailable result', () async {
    expect((await const PhoneSelfCheckChannel().status()).available, isFalse);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (_) async {
      throw PlatformException(code: 'private', message: 'private body');
    });
    final snapshot = await const PhoneSelfCheckChannel().start();
    expect(snapshot.available, isFalse);
    expect(phoneSelfCheckMarkdown(snapshot), isNot(contains('private')));
  });

  testWidgets('late pre-action status cannot overwrite a newly started run', (tester) async {
    final old = Completer<Object?>();
    var reads = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      if (call.method == 'startPhoneSelfCheck') return _reply('running', handle: 'new');
      if (++reads == 1) return _reply('idle');
      if (reads == 2) return old.future;
      return _reply('done', handle: 'new');
    });
    final controller = PhoneSelfCheckController();
    await controller.refresh();
    unawaited(controller.refresh());
    await tester.pump();
    await controller.start();
    expect(controller.snapshot.runHandle, 'new');
    old.complete(_reply('done', handle: 'old'));
    await tester.pump();
    expect(controller.snapshot.runHandle, 'new');
    expect(controller.snapshot.state, 'running');
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pump();
    expect(controller.snapshot.state, 'done');
    controller.dispose();
  });

  testWidgets('unknown start reply prevents a second start until fresh status', (tester) async {
    var starts = 0, reads = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      if (call.method == 'startPhoneSelfCheck') {
        starts++;
        return null;
      }
      return ++reads == 1 ? _reply('idle') : _reply('running', handle: 'accepted-late');
    });
    final controller = PhoneSelfCheckController();
    await controller.refresh();
    await controller.start();
    await controller.start();
    expect(starts, 1);
    expect(controller.canStart, isFalse);
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pump();
    expect(controller.snapshot.runHandle, 'accepted-late');
    controller.dispose();
  });

  testWidgets('dispose stops polls and ignores a pending native result', (tester) async {
    final late = Completer<Object?>();
    var calls = 0, notifications = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (_) async {
      calls++;
      return calls == 1 ? _reply('running', handle: 'one') : late.future;
    });
    final controller = PhoneSelfCheckController()..addListener(() => notifications++);
    await controller.refresh();
    await tester.pump(const Duration(milliseconds: 800));
    final before = notifications;
    controller.dispose();
    late.complete(_reply('done', handle: 'late'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    expect(calls, 2);
    expect(notifications, before);
    expect(tester.takeException(), isNull);
  });

  testWidgets('hidden app pauses polling without cancelling native work', (tester) async {
    var calls = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      expect(call.method, 'phoneSelfCheckStatus');
      calls++;
      return _reply('running', handle: 'one');
    });
    final controller = PhoneSelfCheckController();
    await controller.refresh();
    controller.setVisible(false);
    await tester.pump(const Duration(seconds: 3));
    expect(calls, 1);
    controller.setVisible(true);
    await tester.pump();
    expect(calls, 2);
    controller.dispose();
  });

  test('explicit report uses real FilesChannel and deletes temp after native copy reply', () async {
    final root = await Directory.systemTemp.createTemp('self-check-test-');
    final copied = Completer<void>(), reply = Completer<String>();
    String? path;
    String? content;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_files, (call) async {
      expect(call.method, 'saveToDownloads');
      final args = call.arguments as Map;
      expect(args['name'], 'dsh-phone-self-check.md');
      expect(args['mime'], 'text/markdown');
      path = args['path'] as String;
      content = await File(path!).readAsString();
      copied.complete();
      return reply.future;
    });
    final exporter = PhoneSelfCheckReport(cacheRoot: () async => root);
    final done = exporter.save(PhoneSelfCheckSnapshot.parse(_reply('done', handle: 'never-export')));
    await copied.future;
    expect(await File(path!).exists(), isTrue);
    expect(content, isNot(contains('never-export')));
    reply.complete('Download/DSH-Go/dsh-phone-self-check.md');
    await done;
    expect(await File(path!).exists(), isFalse);
    expect(await root.list().toList(), isEmpty);
    await root.delete();
  });

  test('failed native copy still deletes only its own temp operation', () async {
    final root = await Directory.systemTemp.createTemp('self-check-test-');
    final sibling = await File('${root.path}/keep.txt').writeAsString('unrelated');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_files, (_) async {
      throw PlatformException(code: 'copyFailed', message: 'private');
    });
    final exporter = PhoneSelfCheckReport(cacheRoot: () async => root);
    await expectLater(exporter.save(PhoneSelfCheckSnapshot.parse(_reply('done'))), throwsA(isA<PlatformException>()));
    expect(await root.list().map((f) => f.path).toList(), [sibling.path]);
    await root.delete(recursive: true);
  });

  testWidgets('unobserved channel failure stays visible outside technical details', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      _phone,
      (_) async => _reply(
        'done',
        steps: [
          for (final stage in phoneSelfCheckStages)
            stage == 'channel'
                ? _step(stage, 'unknown', false, reason: 'channelUnavailable')
                : _step(stage, 'not_run', false),
        ],
      ),
    );
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        home: const Scaffold(body: SingleChildScrollView(child: PhoneSelfCheckPanel())),
      ),
    );
    await tester.pump();
    await tester.pump();
    final context = tester.element(find.byType(PhoneSelfCheckPanel));
    expect(find.text(context.l10n.phoneSelfCheckReason('unavailable')), findsOneWidget);
    expect(find.byKey(const ValueKey('self-check-reason-channel')), findsNothing);
    expect(find.text('channelUnavailable'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('actual failed step shows a fixed next-step explanation without a top reason', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      _phone,
      (_) async => _reply('done', steps: [_step('input_probe', 'unknown', true, reason: 'inputUnconfirmed')]),
    );
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        home: const Scaffold(body: SingleChildScrollView(child: PhoneSelfCheckPanel())),
      ),
    );
    await tester.pump();
    await tester.pump();
    final context = tester.element(find.byType(PhoneSelfCheckPanel));
    await openPhoneFold(tester, 'self-check-details');
    final reason = tester.widget<Text>(find.byKey(const ValueKey('self-check-reason-input_probe')));
    expect(reason.data, context.l10n.phoneSelfCheckReason('input'));
    expect(find.text('inputUnconfirmed'), findsNothing);
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-state'))).data,
      context.l10n.phoneSelfCheckRunState('done'),
    );
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-step-ocr'))).data,
      context.l10n.phoneSelfCheckStepState('not_run'),
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Save button is explicit and a late export cannot revive a disposed panel', (tester) async {
    final report = _RecordingReport();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      _phone,
      (_) async => _reply('done'),
    );
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        home: Scaffold(
          body: SingleChildScrollView(child: PhoneSelfCheckPanel(report: report)),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(report.saved, isEmpty);
    await openPhoneFold(tester, 'self-check-details');
    await tester.ensureVisible(find.byKey(const ValueKey('self-check-save')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('self-check-save')));
    await tester.pump();
    expect(report.saved.length, 1);
    expect(report.saved.single.state, 'done');
    await tester.pumpWidget(const SizedBox());
    report.done.complete();
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('panel only queries until a person starts or explicitly saves', (tester) async {
    final calls = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      calls.add(call.method);
      return call.method == 'startPhoneSelfCheck' ? _reply('running', handle: 'hidden-id') : _reply('idle');
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_files, (_) async {
      fail('No explicit Save was requested');
    });
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        home: const Scaffold(body: SingleChildScrollView(child: PhoneSelfCheckPanel())),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(calls, ['phoneSelfCheckStatus']);
    expect(find.byKey(const ValueKey('self-check-profile')), findsNothing);
    expect(find.byKey(const ValueKey('self-check-report-profile')), findsNothing);
    expect(find.byKey(const ValueKey('self-check-step-device')), findsNothing);
    expect(find.byKey(const ValueKey('self-check-save')), findsNothing);
    expect(find.textContaining('hidden-id'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('self-check-start')));
    await tester.pump();
    await tester.pump();
    expect(calls.where((c) => c == 'startPhoneSelfCheck').length, 1);
    expect(find.byKey(const ValueKey('self-check-cancel')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    final count = calls.length;
    await tester.pump(const Duration(seconds: 2));
    expect(calls.length, count);
    expect(tester.takeException(), isNull);
  });
  testWidgets('profile selection only changes next start, never legacy native facts', (tester) async {
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      calls.add(call);
      return call.method == 'startPhoneSelfCheck'
          ? _reply('done', handle: 'legacy-b', steps: [_step('launch', 'pass', true)])
          : _reply('idle');
    });
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        home: const Scaffold(body: SingleChildScrollView(child: PhoneSelfCheckPanel())),
      ),
    );
    await tester.pump();
    await tester.pump();
    final l10n = tester.element(find.byType(PhoneSelfCheckPanel)).l10n;
    await openPhoneFold(tester, 'self-check-details');
    await tester.tap(find.byKey(const ValueKey('self-check-profile')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(l10n.phoneSelfCheckProfile('target_c1')).last);
    await tester.pumpAndSettle();
    expect(calls.where((c) => c.method == 'startPhoneSelfCheck'), isEmpty);
    await tester.ensureVisible(find.byKey(const ValueKey('self-check-start')));
    await tester.tap(find.byKey(const ValueKey('self-check-start')));
    await tester.pump();
    await tester.pump();
    expect(calls.singleWhere((c) => c.method == 'startPhoneSelfCheck').arguments, {'v': 1, 'profile': 'target_c1'});
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-report-profile'))).data,
      l10n.phoneSelfCheckReportProfile('probe_b'),
    );
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-step-launch'))).data,
      l10n.phoneSelfCheckStepState('not_run'),
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('C1 panel shows actual MAIN failure and explicit save captures native C1 profile', (tester) async {
    final report = _RecordingReport();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      _phone,
      (_) async => _reply(
        'done',
        profile: 'target_c1',
        handle: 'private-handle',
        steps: [
          _step('main', 'fail', true, reason: 'targetWrongMain'),
          _step('tap', 'pass', true),
        ],
      ),
    );
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        home: Scaffold(
          body: SingleChildScrollView(child: PhoneSelfCheckPanel(report: report)),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    final l10n = tester.element(find.byType(PhoneSelfCheckPanel)).l10n;
    await openPhoneFold(tester, 'self-check-details');
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-report-profile'))).data,
      l10n.phoneSelfCheckReportProfile('target_c1'),
    );
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-step-main'))).data,
      l10n.phoneSelfCheckStepState('fail'),
    );
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-reason-main'))).data,
      l10n.phoneSelfCheckReason('target_main'),
    );
    expect(report.saved, isEmpty);
    expect(find.textContaining('private-handle'), findsNothing);
    await tester.ensureVisible(find.byKey(const ValueKey('self-check-save')));
    await tester.tap(find.byKey(const ValueKey('self-check-save')));
    await tester.pump();
    expect(report.saved.single.profile, 'target_c1');
    expect(phoneSelfCheckMarkdown(report.saved.single), contains('| main | fail | true | target_main |'));
    await tester.pumpWidget(const SizedBox());
    report.done.complete();
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  test('C2 covers only its native fixed stages and never grants MAIN or OCR a pass', () {
    final snapshot = PhoneSelfCheckSnapshot.parse(
      _reply(
        'done',
        profile: 'target_c2',
        steps: [for (final stage in phoneSelfCheckStages) _step(stage, 'pass', true)],
      ),
    );
    expect(snapshot.profile, 'target_c2');
    expect(snapshot.steps.where((step) => step.state == 'pass').map((step) => step.stage), [
      'device',
      'channel',
      'display',
      'launch',
      'tree',
      'tap',
      'text_ascii',
      'text_zh',
      'capture',
      'continuity',
      'cleanup',
    ]);
    for (final stage in ['input_probe', 'scroll', 'back']) {
      expect(snapshot.steps.firstWhere((step) => step.stage == stage).state, 'not_run');
    }
    for (final stage in ['main', 'ocr']) {
      expect(snapshot.steps.firstWhere((step) => step.stage == stage).state, 'unknown');
    }
    for (final stage in ['text_ascii', 'text_zh', 'capture', 'continuity']) {
      for (final bad in [
        _step(stage, 'pass', false),
        _step(stage, 'pass', true, reason: 'private-fault'),
        _step(stage, 'pass', true, duration: -1),
        _step(stage, 'pass', 'true'),
      ]) {
        final parsed = PhoneSelfCheckSnapshot.parse(_reply('done', profile: 'target_c2', steps: [bad]));
        expect(parsed.steps.firstWhere((step) => step.stage == stage).state, 'unknown');
      }
    }
  });

  test('C2 MAIN only accepts the finite sample matrix and actual wrong MAIN', () {
    final valid = [
      _step('main', 'fail', true, reason: 'targetWrongMain'),
      _step('main', 'fail', true, reason: 'mainSamplesChanged'),
      _step('main', 'unknown', true, reason: 'mainSamplesUnchanged'),
      _step('main', 'unknown', true, reason: 'mainSamplesIncomplete'),
      _step('main', 'unknown', false, reason: 'mainSamplesIncomplete'),
    ];
    for (final raw in valid) {
      final parsed = PhoneSelfCheckStep.parse('main', raw, profile: 'target_c2');
      expect(parsed.state, raw['state']);
      expect(parsed.observed, raw['observed']);
      expect(parsed.reason, raw['reason']);
    }
    for (final raw in [
      _step('main', 'pass', true),
      _step('main', 'fail', false, reason: 'mainSamplesChanged'),
      _step('main', 'unknown', false, reason: 'mainSamplesUnchanged'),
      _step('main', 'pass', true, reason: 'mainSamplesUnchanged'),
      _step('main', 'unknown', true, reason: 'targetWrongMain'),
      _step('main', 'fail', true, reason: 'mainSamplesIncomplete'),
      _step('main', 'unknown', true, reason: 'private-main-state'),
      _step('main', 'not_run', false, duration: -1),
    ]) {
      final parsed = PhoneSelfCheckStep.parse('main', raw, profile: 'target_c2');
      expect(parsed.state, 'unknown');
      expect(parsed.reason, 'invalidResponse');
      expect(parsed.observed, isFalse);
    }
    expect(PhoneSelfCheckStep.parse('main', valid[1], profile: 'target_c1').reason, 'invalidResponse');
  });

  test('only C2 accepts an explicit uninstalled OCR reason without recognition evidence', () {
    final valid = _step('ocr', 'not_run', false, reason: 'notInstalled');
    final parsed = PhoneSelfCheckStep.parse('ocr', valid, profile: 'target_c2');
    expect(parsed.state, 'not_run');
    expect(parsed.observed, isFalse);
    expect(parsed.reason, 'notInstalled');
    for (final raw in [
      null,
      _step('ocr', 'not_run', false),
      _step('ocr', 'not_run', true, reason: 'notInstalled'),
      _step('ocr', 'pass', true, reason: 'notInstalled'),
      _step('ocr', 'unknown', false, reason: 'notInstalled'),
      _step('ocr', 'not_run', false, reason: 'private-ocr'),
      _step('ocr', 'not_run', false, reason: 'notInstalled', duration: 1.0),
    ]) {
      final bad = PhoneSelfCheckStep.parse('ocr', raw, profile: 'target_c2');
      expect(bad.state, 'unknown');
      expect(bad.reason, 'invalidResponse');
    }
    for (final profile in ['probe_b', 'target_c1']) {
      expect(PhoneSelfCheckStep.parse('ocr', valid, profile: profile).reason, isNull);
    }
    expect(
      PhoneSelfCheckStep.parse(
        'capture',
        _step('capture', 'not_run', false, reason: 'notInstalled'),
        profile: 'target_c2',
      ).reason,
      'invalidResponse',
    );
  });

  test('C2 report keeps finite scope and fixed reasons within the old privacy whitelist', () {
    const reasons = {
      'targetFrameUnavailable': 'frame_unavailable',
      'targetFrameMismatch': 'frame_mismatch',
      'targetContinuityUnconfirmed': 'continuity',
      'mainSamplesChanged': 'main_changed',
      'mainSamplesUnchanged': 'main_unchanged',
      'mainSamplesIncomplete': 'main_incomplete',
      'notInstalled': 'not_installed',
    };
    for (final reason in reasons.entries) {
      expect(phoneSelfCheckReasonGroup(reason.key), reason.value);
    }
    final raw =
        _reply(
            'done',
            profile: 'target_c2',
            handle: 'private-handle',
            steps: [
              _step('text_zh', 'pass', true),
              _step('capture', 'unknown', true, reason: 'targetFrameMismatch'),
              _step('main', 'unknown', true, reason: 'mainSamplesUnchanged'),
              _step('ocr', 'not_run', false, reason: 'notInstalled'),
            ],
          )
          ..['targetRun'] = 'private-run'
          ..['frame'] = 'private-image'
          ..['text'] = 'private-ocr'
          ..['mainVector'] = 'private-app'
          ..['releaseNonce'] = 'private-nonce'
          ..['acquisitionCount'] = 999;
    final text = phoneSelfCheckMarkdown(PhoneSelfCheckSnapshot.parse(raw));
    expect(text, contains('Profile: target_c2'));
    expect(text, contains('ACTION_SET_TEXT'));
    expect(text, contains('does not test FPS'));
    expect(text, contains('MAIN never passes'));
    expect(text, contains('| main | unknown | true | main_unchanged |'));
    expect(text, contains('| ocr | not_run | false | not_installed |'));
    expect(text, isNot(contains('private-')));
    expect(text, isNot(contains('acquisitionCount')));
    expect(utf8.encode(text).length, lessThanOrEqualTo(diagnosticsMarkdownBytes));
  });

  test('C2 real channel sends only the fixed profile and original cleanup handle', () async {
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      calls.add(call);
      return _reply('cleaning', profile: 'target_c2', handle: 'c2-original');
    });
    const channel = PhoneSelfCheckChannel();
    expect((await channel.start(profile: 'target_c2')).profile, 'target_c2');
    await channel.cancel('c2-original');
    expect(calls[0].arguments, {'v': 1, 'profile': 'target_c2'});
    expect(calls[1].arguments, {'v': 1, 'runHandle': 'c2-original'});
  });

  testWidgets('C2 same handle cannot downgrade profile and cleanup keeps the original identity', (tester) async {
    var reads = 0;
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      calls.add(call);
      return ++reads == 1
          ? _reply('cleaning', profile: 'target_c2', handle: 'original')
          : _reply('done', profile: 'target_c1', handle: 'original');
    });
    final controller = PhoneSelfCheckController();
    await controller.refresh();
    await controller.refresh();
    expect(controller.readFailed, isTrue);
    expect(controller.snapshot.profile, 'target_c2');
    expect(controller.canStart, isFalse);
    await controller.start(profile: 'target_c2');
    expect(calls.where((call) => call.method == 'startPhoneSelfCheck'), isEmpty);
    controller.dispose();
  });

  testWidgets('late C1 poll cannot replace new C2 and unknown start does not auto replay', (tester) async {
    final old = Completer<Object?>();
    var reads = 0, starts = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      if (call.method == 'startPhoneSelfCheck') {
        starts++;
        return null;
      }
      if (++reads == 1) return _reply('idle');
      if (reads == 2) return old.future;
      return _reply('running', profile: 'target_c2', handle: 'new-c2');
    });
    final controller = PhoneSelfCheckController();
    await controller.refresh();
    unawaited(controller.refresh());
    await tester.pump();
    await controller.start(profile: 'target_c2');
    await controller.start(profile: 'target_c2');
    expect(starts, 1);
    expect(controller.canStart, isFalse);
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pump();
    old.complete(_reply('done', profile: 'target_c1', handle: 'old-c1'));
    await tester.pump();
    expect(controller.snapshot.profile, 'target_c2');
    expect(controller.snapshot.runHandle, 'new-c2');
    controller.dispose();
  });

  testWidgets('C2 panel starts explicitly and displays finite MAIN plus uninstalled OCR before explicit save', (
    tester,
  ) async {
    final calls = <MethodCall>[];
    final report = _RecordingReport();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_phone, (call) async {
      calls.add(call);
      if (call.method != 'startPhoneSelfCheck') return _reply('idle');
      return _reply(
        'done',
        profile: 'target_c2',
        handle: 'private-c2',
        steps: [
          _step('text_ascii', 'pass', true),
          _step('text_zh', 'pass', true),
          _step('capture', 'pass', true),
          _step('continuity', 'pass', true),
          _step('main', 'unknown', true, reason: 'mainSamplesUnchanged'),
          _step('ocr', 'not_run', false, reason: 'notInstalled'),
        ],
      );
    });
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        home: Scaffold(
          body: SingleChildScrollView(child: PhoneSelfCheckPanel(report: report)),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    final l10n = tester.element(find.byType(PhoneSelfCheckPanel)).l10n;
    await openPhoneFold(tester, 'self-check-details');
    await tester.tap(find.byKey(const ValueKey('self-check-profile')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(l10n.phoneSelfCheckProfile('target_c2')).last);
    await tester.pumpAndSettle();
    expect(calls.where((call) => call.method == 'startPhoneSelfCheck'), isEmpty);
    await tester.ensureVisible(find.byKey(const ValueKey('self-check-start')));
    await tester.tap(find.byKey(const ValueKey('self-check-start')));
    await tester.pump();
    await tester.pump();
    expect(calls.singleWhere((call) => call.method == 'startPhoneSelfCheck').arguments, {
      'v': 1,
      'profile': 'target_c2',
    });
    expect(find.text(l10n.phoneSelfCheckTargetC2Scope), findsOneWidget);
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-step-main'))).data,
      l10n.phoneSelfCheckStepState('unknown'),
    );
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-reason-main'))).data,
      l10n.phoneSelfCheckReason('main_unchanged'),
    );
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('self-check-reason-ocr'))).data,
      l10n.phoneSelfCheckReason('not_installed'),
    );
    expect(report.saved, isEmpty);
    expect(find.textContaining('private-c2'), findsNothing);
    await tester.ensureVisible(find.byKey(const ValueKey('self-check-save')));
    await tester.tap(find.byKey(const ValueKey('self-check-save')));
    await tester.pump();
    expect(report.saved.single.profile, 'target_c2');
    expect(phoneSelfCheckMarkdown(report.saved.single), contains('finite task and focus samples'));
    await tester.pumpWidget(const SizedBox());
    report.done.complete();
    await tester.pump();
    expect(tester.takeException(), isNull);
  });
}
