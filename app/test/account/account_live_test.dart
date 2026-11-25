// Live check of the account flow against a real `dsh web` (DSH 0.2.1-rc.2).
// Skipped unless DSH_LIVE_LAUNCH_URL is set; plain `test`s (no widget binding),
// so dart:io HTTP reaches the Host for real.
//
//   DSH_LIVE_LAUNCH_URL='http://127.0.0.1:38433/?token=…' DSH_LIVE_MODE=mock \
//     flutter test test/account/account_live_test.dart
//
// mode=mock  the Host's deepseek-account row points at a loopback mock Platform:
//            the "browser" follows the authorization redirects through the Host's
//            /oauth/callback, so the whole sign-in, profile, wallets, models and
//            sign-out run end to end.
// mode=real  default platform.deepseek.com: runs up to the real authorization
//            URL, probes the callback route with a bogus state, then cancels.
//            Never completes a sign-in.

import 'dart:async';
import 'dart:io';

import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

final _launch = Platform.environment['DSH_LIVE_LAUNCH_URL'];
final _mode = Platform.environment['DSH_LIVE_MODE'] ?? 'real';

/// Stands in for the Custom Tab: GET the page and follow redirects like a browser.
class _RedirectFollowingBrowser implements AccountBrowser {
  final opened = <Uri>[];
  final landed = <Uri>[];
  final _visits = <Future<void>>[];
  bool follow = true;

  /// Completes when every opened page finished loading.
  Future<void> get settled => Future.wait(_visits);

  @override
  Future<bool> open(Uri url) async {
    opened.add(url);
    if (!follow) return true;
    final visit = _visit(url);
    _visits.add(visit);
    await visit;
    return true;
  }

  Future<void> _visit(Uri url) async {
    final http = HttpClient();
    try {
      var target = url;
      for (var hop = 0; hop < 6; hop++) {
        final request = await http.getUrl(target)
          ..followRedirects = false;
        final response = await request.close();
        await response.drain<void>();
        final location = response.headers.value('location');
        if (response.isRedirect && location != null) {
          target = target.resolve(location);
          continue;
        }
        landed.add(target.replace(queryParameters: {...target.queryParameters, '_status': '${response.statusCode}'}));
        break;
      }
    } finally {
      http.close(force: true);
    }
  }
}

Future<T> _until<T>(ProviderContainer c, bool Function(AccountState) ok, T Function(AccountState) pick) async {
  final done = Completer<T>();
  final sub = c.listen<AccountState>(accountProvider, (_, next) {
    if (ok(next) && !done.isCompleted) done.complete(pick(next));
  }, fireImmediately: true);
  try {
    return await done.future.timeout(const Duration(seconds: 30));
  } finally {
    sub.close();
  }
}

void main() {
  final skip = _launch == null ? 'set DSH_LIVE_LAUNCH_URL to run against a live dsh web' : null;

  test(
    'account flow against a live Host ($_mode)',
    () async {
      final launch = DshLaunchUrl.tryParse(_launch!)!;
      final client = await DshClient.connect(launchUrl: _launch);
      addTearDown(client.close);
      final origin = loopbackCallbackOrigin(launch.baseUri.toString())!;
      final api = DshAccountApi(client, callbackOrigin: origin);
      final browser = _RedirectFollowingBrowser()..follow = _mode == 'mock';
      final container = ProviderContainer(
        overrides: [
          accountApiProvider.overrideWithValue(api),
          accountBrowserProvider.overrideWithValue(browser),
          accountEngineStarterProvider.overrideWithValue(() async {}),
        ],
      );
      addTearDown(container.dispose);
      final account = container.read(accountProvider.notifier);

      var initial = await _until(container, (s) => s.phase != AccountPhase.unknown, (s) => s);
      if (initial.signedIn) {
        // Left over from an earlier run.
        await account.signOut();
        initial = container.read(accountProvider);
      }
      expect(initial.phase, AccountPhase.signedOut);
      expect(initial.links?.topUpUrl, endsWith('/top_up'));
      // ignore: avoid_print
      print('signed out; topUpUrl=${initial.links?.topUpUrl}');

      final catalogBefore = await client.listModels();
      // ignore: avoid_print
      print('catalog before: ${catalogBefore.models.map((m) => '${m.provider}/${m.id}').toList()}');

      final result = account.signIn();
      final url = await _until(
        container,
        (s) => s.stage == SignInStage.waitingBrowser && s.authorizeUrl != null,
        (s) => s.authorizeUrl!,
      );
      final u = Uri.parse(url);
      // ignore: avoid_print
      print('authorizeUrl: ${u.origin}${u.path}?<${u.queryParameters.keys.join(',')}>');
      expect(Uri.parse(url).path, '/dsh/authorize');

      if (_mode == 'real') {
        expect(browser.opened, hasLength(1));
        // The callback route is registered while waiting; a bogus state is refused
        // without cookie auth and leaves the attempt alone.
        final http = HttpClient();
        final probe = await (await http.getUrl(Uri.parse('$origin/oauth/callback?code=x&state=bogus'))).close();
        await probe.drain<void>();
        http.close(force: true);
        expect(probe.statusCode, 400);
        expect(container.read(accountProvider).stage, SignInStage.waitingBrowser);
        await account.cancel();
        expect(await result, SignInResult.cancelled);
        expect(container.read(accountProvider).phase, AccountPhase.signedOut);
        expect(container.read(accountProvider).failure, isNull);
        final after = await api.getState();
        expect(after.attempt?.phase, SignInPhase.cancelled);
        // ignore: avoid_print
        print('bogus callback -> 400, cancel -> ${after.attempt?.phase}');
        return;
      }

      expect(await result, SignInResult.success);
      await browser.settled;
      expect(browser.landed.single.path, '/dsh/authorized');
      expect(browser.landed.single.queryParameters['login_source'], 'web');
      // ignore: avoid_print
      print('browser landed on ${browser.landed.single}');

      final profile = await _until(container, (s) => s.profile != null, (s) => s.profile!);
      // ignore: avoid_print
      print('profile: name=${profile.name} contact=${profile.contact} id=${profile.id}');
      expect(profile.contact, contains('****'));

      final balance = (await account.balance())!;
      // ignore: avoid_print
      print(
        'recharge: ${balance.recharge.map((w) => '${w.currency} ${w.balance} -> ${formatWalletAmount(w.balance)}')}',
      );
      // ignore: avoid_print
      print('bonus: ${balance.bonus.map((w) => '${w.currency} ${w.balance} -> ${formatWalletAmount(w.balance)}')}');
      expect(balance.bonus, isNotEmpty);

      // initializeDefaultModel runs right after success; give it a moment.
      await Future<void>.delayed(const Duration(milliseconds: 500));
      final catalog = await client.listModels();
      final accountModels = catalog.models.where((m) => m.provider == 'deepseek-account').map((m) => m.id).toList();
      // ignore: avoid_print
      print('catalog after: ${catalog.models.map((m) => '${m.provider}/${m.id}').toList()}');
      expect(accountModels, isNotEmpty);

      await account.signOut();
      expect(container.read(accountProvider).phase, AccountPhase.signedOut);
      final catalogAfter = await client.listModels();
      expect(catalogAfter.models.where((m) => m.provider == 'deepseek-account'), isEmpty);
      // ignore: avoid_print
      print('signed out; account models gone');
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
