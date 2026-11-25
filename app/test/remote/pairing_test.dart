import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/android_features.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/remote_pairing_state.dart';
import 'package:dsh_app/ui/remote/pairing_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../account/support.dart' show FixedAccount;
import '../chat/support/harness.dart';

const _code = 'https://dsh.r2049.cn/pair#v1.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const _fingerprint = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

/// The pairing half of the Remote backend, scripted by the test.
class _Backend extends UnavailableRelayBackend implements RelayPairingBackend {
  _Backend();

  final resolved = <String>[];
  final claims = <String?>[];
  Object? resolveError;
  final phases = StreamController<RelayPairingPhase>.broadcast();
  final completed = Completer<RelayHost>();
  var cancels = 0;
  final paused = <bool>[];

  @override
  bool get available => true;

  @override
  String get serverLabel => 'dsh.r2049.cn';

  @override
  Future<bool> supportsPairing() async => true;

  @override
  Future<RelayPairingOffer> resolvePairing(String scanned) async {
    resolved.add(scanned);
    if (resolveError case final e?) throw e;
    return const RelayPairingOffer(
      server: 'https://dsh.r2049.cn',
      hostName: 'Studio Mac',
      hostPlatform: 'desktop',
      fingerprint: _fingerprint,
      token: Object(),
    );
  }

  @override
  Future<RelayPairingSession> claimPairing(RelayPairingOffer offer, {String? deepseekUserId}) async {
    claims.add(deepseekUserId);
    return RelayPairingSession(
      code: '00123456',
      codeExpiresAt: DateTime.now().add(const Duration(minutes: 3)),
      phases: phases.stream,
      completed: completed.future,
      onPause: paused.add,
      onCancel: () async {
        cancels++;
        if (!completed.isCompleted) {
          completed.completeError(const RelayPairingError(RelayPairingErrorKind.cancelled, '配对已取消'));
        }
      },
    );
  }
}

const _signedIn = AccountState(
  phase: AccountPhase.signedIn,
  profile: AccountProfile(id: 'ds-user-42', name: 'Chimney'),
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('flow', () {
    late _Backend backend;
    late ProviderContainer container;
    PairingFlowState state() => container.read(remotePairingProvider);
    PairingFlowController flow() => container.read(remotePairingProvider.notifier);

    setUp(() {
      backend = _Backend();
      container = ProviderContainer(overrides: [relayBackendProvider.overrideWithValue(backend)]);
      addTearDown(container.dispose);
      // Keep the auto-dispose flow alive for the whole test.
      container.listen(remotePairingProvider, (_, _) {}, fireImmediately: true);
    });

    test('scan, confirm, code, approved, done', () async {
      await flow().scanned(_code);
      expect(state().step, PairingStep.confirming);
      expect(state().offer!.hostName, 'Studio Mac');
      expect(backend.claims, isEmpty, reason: 'nothing is claimed before the person confirms');

      unawaited(flow().confirm(deepseekUserId: 'ds-user-42'));
      await pumpEventQueue();
      expect(backend.claims, ['ds-user-42']);
      expect(state().step, PairingStep.showingCode);
      expect(state().session!.code, '00123456');

      flow().setPaused(true);
      flow().setPaused(false);
      expect(backend.paused, [true, false]);

      backend.phases.add(RelayPairingPhase.approved);
      await pumpEventQueue();
      expect(state().approved, isTrue);

      backend.completed.complete(const RelayHost(id: 'host-1', name: 'Studio Mac', online: true));
      await pumpEventQueue();
      expect(state().step, PairingStep.done);
      expect(state().host!.id, 'host-1');
      expect(state().session, isNull, reason: 'the code is gone once paired');
    });

    test('a code claimed while the app is in the background starts paused', () async {
      await flow().scanned(_code);
      flow().setPaused(true);
      unawaited(flow().confirm());
      await pumpEventQueue();
      expect(state().step, PairingStep.showingCode);
      expect(backend.paused, [true]);
      flow().setPaused(false);
      expect(backend.paused, [true, false]);
    });

    test('a second code while one is being read is ignored', () async {
      final first = flow().scanned(_code);
      await flow().scanned('$_code#again');
      await first;
      expect(backend.resolved, [_code]);
    });

    test('a wrong code on the computer ends in a failure that needs a new code', () async {
      await flow().scanned(_code);
      unawaited(flow().confirm());
      await pumpEventQueue();
      backend.completed.completeError(const RelayPairingError(RelayPairingErrorKind.codeRejected, '电脑上输入的验证码不对'));
      await pumpEventQueue();
      expect(state().step, PairingStep.failed);
      expect(state().error!.needsNewCode, isTrue);
      expect(state().session, isNull);
    });

    test('scanning again gives up a shown code and tells the Server', () async {
      await flow().scanned(_code);
      unawaited(flow().confirm());
      await pumpEventQueue();
      flow().restart();
      await pumpEventQueue();
      expect(backend.cancels, 1);
      expect(state().step, PairingStep.scanning);
    });

    test('a code for another Server switches only when asked, then reads the same code there', () async {
      backend.resolveError = const RelayPairingError(
        RelayPairingErrorKind.otherServer,
        'other',
        server: 'https://relay.example.com',
      );
      await flow().scanned(_code);
      expect(state().step, PairingStep.failed);
      expect(state().error!.server, 'https://relay.example.com');
      expect(container.read(relayServerProvider), isNull, reason: 'nothing switched yet');

      backend.resolveError = null;
      await flow().switchServerAndRetry();
      expect(container.read(relayServerProvider), 'https://relay.example.com');
      expect(backend.resolved, [_code, _code]);
      expect(state().step, PairingStep.confirming);
    });

    test('leaving the page gives up a shown code', () async {
      final scoped = ProviderContainer(overrides: [relayBackendProvider.overrideWithValue(backend)]);
      final sub = scoped.listen(remotePairingProvider, (_, _) {});
      await scoped.read(remotePairingProvider.notifier).scanned(_code);
      unawaited(scoped.read(remotePairingProvider.notifier).confirm());
      await pumpEventQueue();
      sub.close();
      await pumpEventQueue();
      scoped.dispose();
      expect(backend.cancels, 1);
    });
  });

  group('page', () {
    Widget app(_Backend backend, {AccountState account = _signedIn}) => testApp(
      const RemotePairingPage(),
      overrides: [
        relayBackendProvider.overrideWithValue(backend),
        accountProvider.overrideWith(() => FixedAccount(account)),
        pairingScannerProvider.overrideWithValue(
          (context, onCode) => Center(
            child: TextButton(onPressed: () => onCode(_code), child: const Text('stand-in camera')),
          ),
        ),
      ],
    );

    testWidgets('without a DeepSeek sign-in the camera stays closed', (tester) async {
      usePhoneView(tester);
      await tester.pumpWidget(app(_Backend(), account: const AccountState(phase: AccountPhase.signedOut)));
      await tester.pumpAndSettle();
      expect(find.text('先登录 DeepSeek 账号'), findsOneWidget);
      expect(find.text('stand-in camera'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Harmony scan failure leaves paste reachable across desktop window resizing', (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 720);
      addTearDown(tester.view.reset);
      final messenger = tester.binding.defaultBinaryMessenger;
      const appChannel = MethodChannel('dsh/app');
      var scans = 0;
      var pastes = 0;
      messenger.setMockMethodCallHandler(appChannel, (call) async {
        expect(call.method, 'scanQrCode');
        scans++;
        throw PlatformException(code: 'unavailable');
      });
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method != 'Clipboard.getData') return null;
        pastes++;
        return {'text': _code};
      });
      addTearDown(() {
        messenger.setMockMethodCallHandler(appChannel, null);
        messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      });

      final backend = _Backend();
      await tester.pumpWidget(
        testApp(
          const RemotePairingPage(),
          overrides: [
            relayBackendProvider.overrideWithValue(backend),
            accountProvider.overrideWith(() => FixedAccount(_signedIn)),
            operatingSystemProvider.overrideWithValue('ohos'),
          ],
        ),
      );
      await tester.pumpAndSettle();
      final scan = find.widgetWithText(FilledButton, '扫码');
      final paste = find.widgetWithText(TextButton, '粘贴配对链接');
      expect(scan.hitTestable(), findsOneWidget);
      expect(paste.hitTestable(), findsOneWidget);

      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: tester.getCenter(scan));
      await mouse.down(tester.getCenter(scan));
      await mouse.up();
      await tester.pumpAndSettle();
      final unavailable = find.text('二维码识别器不可用。可以粘贴配对链接继续配对。');
      expect(unavailable, findsOneWidget);

      for (final size in [const Size(1366, 480), const Size(500, 580)]) {
        tester.view.physicalSize = size;
        await tester.pumpAndSettle();
        expect(scan.hitTestable(), findsOneWidget);
        expect(paste.hitTestable(), findsOneWidget);
        expect(unavailable, findsOneWidget);
        expect(tester.takeException(), isNull);
      }
      await mouse.removePointer();
      for (var step = 0; step < 3; step++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        final focused = FocusManager.instance.primaryFocus?.context;
        if (focused?.findAncestorWidgetOfExactType<TextButton>() != null) break;
      }
      expect(
        FocusManager.instance.primaryFocus?.context?.findAncestorWidgetOfExactType<TextButton>(),
        same(tester.widget(paste)),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(scans, 1);
      expect(pastes, 1);
      expect(backend.resolved, [_code]);
      expect(find.text('要连接这台电脑吗？'), findsOneWidget);
    });

    testWidgets('confirm shows the computer and its whole fingerprint, then the code digit by digit', (tester) async {
      usePhoneView(tester);
      final semantics = tester.ensureSemantics();
      final clipboard = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method.startsWith('Clipboard.')) clipboard.add(call);
        return null;
      });
      final backend = _Backend();
      await tester.pumpWidget(app(backend));
      await tester.pumpAndSettle();
      await tester.tap(find.text('stand-in camera'));
      await tester.pumpAndSettle();

      expect(find.text('要连接这台电脑吗？'), findsOneWidget);
      expect(find.text('Studio Mac'), findsOneWidget);
      expect(find.text('https://dsh.r2049.cn'), findsOneWidget);
      expect(
        find.textContaining('0f1e 2d3c 4b5a 6978\n8796 a5b4 c3d2 e1f0\n'),
        findsOneWidget,
        reason: 'all 64 digits, 4 groups a line',
      );
      expect(find.textContaining('c3d2 e1f0'), findsOneWidget);

      await tester.tap(find.text('确认是这台电脑，开始配对'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(backend.claims, ['ds-user-42'], reason: 'only the DeepSeek account id goes along');
      for (final d in ['0', '1', '2', '3', '4', '5', '6']) {
        expect(find.text(d), findsWidgets);
      }
      expect(find.bySemanticsLabel(RegExp('验证码 0 0 1 2 3 4 5 6')), findsOneWidget);
      expect(find.textContaining('只有一次机会'), findsOneWidget);
      expect(find.textContaining('等电脑确认'), findsOneWidget);

      backend.phases.add(RelayPairingPhase.approved);
      await tester.pump();
      expect(find.text('电脑已确认，正在完成绑定…'), findsOneWidget);
      expect(clipboard, isEmpty, reason: 'the code never reaches the clipboard');

      // Leaving gives the code up.
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      expect(backend.cancels, 1);
      semantics.dispose();
    });

    testWidgets('a code for another Server asks before switching', (tester) async {
      usePhoneView(tester);
      final backend = _Backend()
        ..resolveError = const RelayPairingError(
          RelayPairingErrorKind.otherServer,
          'other',
          server: 'https://relay.example.com',
        );
      await tester.pumpWidget(app(backend));
      await tester.pumpAndSettle();
      await tester.tap(find.text('stand-in camera'));
      await tester.pumpAndSettle();
      expect(find.textContaining('https://relay.example.com'), findsOneWidget);
      expect(find.text('切换服务器并继续'), findsOneWidget);
      expect(find.text('重新扫码'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
