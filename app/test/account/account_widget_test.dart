// Onboarding choice, signing-in state and account page, driven through the UI
// with the real controller against an in-memory Host.

import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/onboarding_state.dart';
import 'package:dsh_app/ui/account/account_page.dart';
import 'package:dsh_app/ui/account/account_widgets.dart';
import 'package:dsh_app/ui/common/app_sheet.dart';
import 'package:dsh_app/ui/onboarding/api_key_page.dart';
import 'package:dsh_app/ui/onboarding/connect_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
}

ProviderContainer _containerOf(WidgetTester tester, Type type) =>
    ProviderScope.containerOf(tester.element(find.byType(type)));

void main() {
  group('onboarding connect step', () {
    late FakeAccountApi api;
    late FakeBrowser browser;
    late int done;

    Future<void> pumpConnect(WidgetTester tester) async {
      usePhoneSurface(tester);
      await tester.pumpWidget(
        accountApp(
          home: ConnectPage(onDone: () => done++),
          overrides: accountOverrides(api: api, browser: browser),
        ),
      );
      await _settle(tester);
    }

    setUp(() {
      api = FakeAccountApi();
      browser = FakeBrowser();
      done = 0;
    });

    testWidgets('account sign-in is the primary choice; cancel returns to it', (tester) async {
      await pumpConnect(tester);
      expect(find.widgetWithText(FilledButton, '用 DeepSeek 账号登录'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, '使用 API Key'), findsOneWidget);
      expect(find.text('稍后设置'), findsOneWidget);

      await tester.tap(find.text('用 DeepSeek 账号登录'));
      await _settle(tester);
      expect(api.calls, contains('startSignIn:web'));
      expect(find.text('正在准备登录'), findsOneWidget);

      api.emit(signedOutView(attempt: attempt(SignInPhase.waitingBrowser)));
      await _settle(tester);
      expect(find.text('在浏览器中完成登录'), findsOneWidget);
      expect(browser.opened.single.queryParameters['theme'], 'light');
      expect(find.text('重新打开登录页'), findsOneWidget);

      await tester.tap(find.text('取消登录'));
      await _settle(tester);
      expect(api.calls, contains('cancelSignIn:att-1'));
      expect(find.text('连接 DeepSeek'), findsOneWidget);
      expect(find.text('登录没有完成'), findsNothing, reason: 'cancelling is not an error');
      expect(done, 0);
    });

    testWidgets('success shows a short confirmation, then continues and stops asking', (tester) async {
      await pumpConnect(tester);
      await tester.tap(find.text('用 DeepSeek 账号登录'));
      await _settle(tester);
      api.emit(signedOutView(attempt: attempt(SignInPhase.waitingBrowser)));
      await _settle(tester);
      api.emit(signedInView(attempt: attempt(SignInPhase.succeeded)));
      await _settle(tester);

      expect(find.text('登录成功'), findsOneWidget);
      expect(find.text('欢迎，雾蓝'), findsOneWidget);
      expect(done, 0);
      await tester.pump(const Duration(seconds: 1));
      expect(done, 1);
      expect(_containerOf(tester, ConnectPage).read(onboardingPrefsProvider).keySkipped, isTrue);
      expect(api.calls, contains('initializeDefaultModel'));
    });

    testWidgets('a failure is explained inline and can be dismissed', (tester) async {
      api.onStart = () async => throw const DshRemoteException('gateway/internal', 'account: no-response');
      await pumpConnect(tester);
      await tester.tap(find.text('用 DeepSeek 账号登录'));
      await _settle(tester);
      expect(find.text('连不上 DeepSeek'), findsOneWidget);
      expect(find.text('检查手机网络后重试'), findsOneWidget);

      await tester.tap(find.byTooltip('关闭'));
      await _settle(tester);
      expect(find.text('连不上 DeepSeek'), findsNothing);
    });

    testWidgets('returning without a result offers to reopen the page', (tester) async {
      await pumpConnect(tester);
      await tester.tap(find.text('用 DeepSeek 账号登录'));
      await _settle(tester);
      api.emit(signedOutView(attempt: attempt(SignInPhase.waitingBrowser)));
      await _settle(tester);

      _containerOf(tester, ConnectPage).read(accountProvider.notifier).noteAppResumed();
      await tester.pump(const Duration(seconds: 2));
      await _settle(tester);
      expect(find.text('还没收到登录结果'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, '重新打开登录页'));
      await _settle(tester);
      expect(browser.opened, hasLength(2));
      await tester.tap(find.text('取消登录'));
      await _settle(tester);
    });

    testWidgets('"使用 API Key" keeps the key path, with a way back', (tester) async {
      await pumpConnect(tester);
      await tester.tap(find.text('使用 API Key'));
      await _settle(tester);
      expect(find.byType(ApiKeyPage), findsOneWidget);
      expect(find.text('保存并继续'), findsOneWidget);

      await tester.tap(find.byTooltip('返回'));
      await _settle(tester);
      expect(find.byType(ApiKeyPage), findsNothing);
      expect(find.text('用 DeepSeek 账号登录'), findsOneWidget);

      await tester.tap(find.text('使用 API Key'));
      await _settle(tester);
      await tester.enterText(find.byType(TextField), 'sk-0123456789abcdef0123456789');
      await tester.pump();
      await tester.tap(find.text('保存并继续'));
      await _settle(tester);
      expect(done, 1);
    });

    testWidgets('system back returns from key entry without finishing', (tester) async {
      await pumpConnect(tester);
      expect(tester.widget<PopScope<void>>(find.byType(PopScope<void>)).canPop, isTrue);
      await tester.tap(find.text('使用 API Key'));
      await _settle(tester);
      await tester.binding.handlePopRoute();
      await _settle(tester);
      expect(find.byType(ApiKeyPage), findsNothing);
      expect(find.text('连接 DeepSeek'), findsOneWidget);
      expect(done, 0);
    });

    testWidgets('system back cancels a pending browser sign-in', (tester) async {
      await pumpConnect(tester);
      await tester.tap(find.text('用 DeepSeek 账号登录'));
      await _settle(tester);
      api.emit(signedOutView(attempt: attempt(SignInPhase.waitingBrowser)));
      await _settle(tester);
      await tester.binding.handlePopRoute();
      await _settle(tester);
      expect(api.calls, contains('cancelSignIn:att-1'));
      expect(find.text('连接 DeepSeek'), findsOneWidget);
      expect(done, 0);
    });

    testWidgets('"稍后设置" continues without signing in', (tester) async {
      await pumpConnect(tester);
      await tester.tap(find.text('稍后设置'));
      await _settle(tester);
      expect(done, 1);
      expect(_containerOf(tester, ConnectPage).read(onboardingPrefsProvider).keySkipped, isTrue);
      expect(api.calls.where((c) => c.startsWith('startSignIn')), isEmpty);
    });
  });

  group('account page', () {
    Future<(FakeAccountApi, FakeBrowser)> pumpPage(WidgetTester tester, FakeAccountApi api) async {
      final browser = FakeBrowser();
      usePhoneSurface(tester);
      await tester.pumpWidget(
        accountApp(
          home: const AccountPage(),
          overrides: accountOverrides(api: api, browser: browser),
        ),
      );
      await _settle(tester);
      return (api, browser);
    }

    testWidgets('shows profile and both wallets; top-up opens the Host\'s link', (tester) async {
      final (api, browser) = await pumpPage(tester, FakeAccountApi(initial: signedInView()));
      expect(find.text('雾蓝'), findsOneWidget);
      expect(find.text('138****5678'), findsOneWidget);
      expect(find.text('¥128.45'), findsOneWidget);
      expect(find.text('¥10.00'), findsOneWidget);

      await tester.tap(find.text('去充值'));
      await _settle(tester);
      expect(browser.opened.single.toString(), links.topUpUrl);
      expect(api.calls.where((c) => c == 'getBalance'), hasLength(1));
    });

    testWidgets('sign-out asks first, then lands on the sign-in panel', (tester) async {
      final (api, _) = await pumpPage(tester, FakeAccountApi(initial: signedInView()));
      await tester.tap(find.text('退出登录'));
      await _settle(tester);
      expect(find.text('退出 DeepSeek 账号？'), findsOneWidget);
      expect(find.textContaining('API Key 都会保留'), findsOneWidget);

      await tester.tap(find.widgetWithText(TextButton, '取消'));
      await _settle(tester);
      expect(api.calls, isNot(contains('signOut')));

      await tester.tap(find.text('退出登录'));
      await _settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, '退出登录'));
      await _settle(tester);
      expect(api.calls, contains('signOut'));
      expect(find.text('登录后无需 API Key'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '用 DeepSeek 账号登录'), findsOneWidget);
    });

    testWidgets('sign-out confirms in the danger colours', (tester) async {
      usePhoneSurface(tester);
      await tester.pumpWidget(
        accountApp(
          home: const AccountPage(),
          brightness: Brightness.dark,
          overrides: accountOverrides(api: FakeAccountApi(initial: signedInView())),
        ),
      );
      await _settle(tester);
      await tester.ensureVisible(find.text('退出登录'));
      await tester.tap(find.text('退出登录'));
      await _settle(tester);
      final finder = find.widgetWithText(FilledButton, '退出登录');
      final button = tester.widget<FilledButton>(finder);
      final colors = DshColors.of(tester.element(finder));
      expect(button.style!.backgroundColor!.resolve({}), colors.danger);
      expect(button.style!.foregroundColor!.resolve({}), colors.onDanger);
    });

    testWidgets('sign-out warns when account tasks are running', (tester) async {
      await pumpPage(tester, FakeAccountApi(initial: signedInView())..runningTasks = true);
      await tester.tap(find.text('退出登录'));
      await _settle(tester);
      expect(find.textContaining('退出会立即中断它们'), findsOneWidget);
    });

    testWidgets('a wallet failure keeps the page usable', (tester) async {
      await pumpPage(
        tester,
        FakeAccountApi(initial: signedInView())..balanceError = const AccountQueryFailed('balance'),
      );
      expect(find.text('余额暂时读不到'), findsOneWidget);
      expect(find.text('雾蓝'), findsOneWidget);
    });

    testWidgets('signed out: signs in from the page', (tester) async {
      final (api, browser) = await pumpPage(tester, FakeAccountApi());
      await tester.tap(find.widgetWithText(FilledButton, '用 DeepSeek 账号登录'));
      await _settle(tester);
      api.emit(signedOutView(attempt: attempt(SignInPhase.waitingBrowser)));
      await _settle(tester);
      expect(find.text('在浏览器中完成登录'), findsOneWidget);
      expect(browser.opened, hasLength(1));
      api.emit(signedInView(attempt: attempt(SignInPhase.succeeded)));
      await _settle(tester);
      expect(find.text('¥128.45'), findsOneWidget);
      expect(find.text('已登录 DeepSeek 账号'), findsOneWidget);
    });
  });

  group('small screen, large text: nothing overflows', () {
    const waiting = AccountState(
      phase: AccountPhase.signingIn,
      stage: SignInStage.waitingBrowser,
      authorizeUrl: authorizeUrl,
      connected: true,
      browserHint: BrowserHint.returned,
    );
    final screens = <String, (Widget Function(), AccountState)>{
      'connect': (
        () => ConnectPage(onDone: () {}),
        const AccountState(
          phase: AccountPhase.signedOut,
          connected: true,
          failure: SignInFailure(SignInFailureKind.interrupted),
        ),
      ),
      'connect waiting': (() => ConnectPage(onDone: () {}), waiting),
      'account signed in': (
        () => const AccountPage(),
        const AccountState(
          phase: AccountPhase.signedIn,
          connected: true,
          links: links,
          profile: AccountProfile(
            id: 'u',
            name: '一个名字特别特别特别长的 DeepSeek 用户',
            contact: 'someone.with.a.long.mail@example.com',
          ),
        ),
      ),
      'account signed out': (() => const AccountPage(), const AccountState(phase: AccountPhase.signedOut)),
      'account waiting': (() => const AccountPage(), waiting),
    };
    for (final MapEntry(key: name, value: (build, state)) in screens.entries) {
      testWidgets(name, (tester) async {
        tester.view.devicePixelRatio = 2;
        tester.view.physicalSize = const Size(320 * 2, 568 * 2);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          accountApp(
            home: Builder(
              builder: (context) => MediaQuery(
                data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.3)),
                child: build(),
              ),
            ),
            overrides: [
              ...accountOverrides(),
              accountProvider.overrideWith(() => FixedAccount(state)),
              accountBalanceProvider.overrideWith(
                (ref) async => const AccountBalance(
                  recharge: [AccountWallet(currency: 'CNY', balance: '123456789.99')],
                  bonus: [
                    AccountWallet(currency: 'CNY', balance: '20'),
                    AccountWallet(currency: 'USD', balance: '3.5'),
                  ],
                ),
              ),
            ],
          ),
        );
        await _settle(tester);
        expect(tester.takeException(), isNull);
      });
    }
  });

  testWidgets('AccountTile reflects the account and opens the page', (tester) async {
    usePhoneSurface(tester);
    final api = FakeAccountApi();
    await tester.pumpWidget(
      accountApp(
        home: const Scaffold(
          body: SafeArea(child: SheetGroup(children: [AccountTile()])),
        ),
        overrides: accountOverrides(api: api),
      ),
    );
    await _settle(tester);
    expect(find.text('未登录'), findsOneWidget);

    api.emit(signedInView());
    await _settle(tester);
    expect(find.text('雾蓝'), findsOneWidget);
    expect(find.text('138****5678'), findsOneWidget);

    await tester.tap(find.byType(AccountTile));
    await _settle(tester);
    expect(find.byType(AccountPage), findsOneWidget);
  });
}
